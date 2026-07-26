import importlib
import json
import os
import pathlib
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException


SERVER_DIR = pathlib.Path(os.environ.get("SUPERCOLLAB_SERVER_DIR", pathlib.Path(__file__).resolve().parents[1] / "server"))
sys.path.insert(0, str(SERVER_DIR))
api = importlib.import_module("supercollab_chat")

VALID_KEY = "scak_" + ("A" * 43)
NEW_KEY = "scak_" + ("B" * 43)


class FakeRequest:
    client = SimpleNamespace(host="127.0.0.1")

    def __init__(self, payload=None, token=None):
        self.payload = payload or {}
        self.raw_body = json.dumps(self.payload).encode("utf-8")
        self.headers = {"content-length": str(len(self.raw_body))}
        if token:
            self.headers["authorization"] = f"Bearer {token}"

    async def body(self):
        return self.raw_body


class FakeCursor:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        if isinstance(self.row, list):
            return self.row[0] if self.row else None
        return self.row

    def fetchall(self):
        if self.row is None:
            return []
        return self.row if isinstance(self.row, list) else [self.row]


class FakeConnection:
    def __init__(self, select_rows):
        self.select_rows = list(select_rows)
        self.queries = []
        self.commits = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, query, params=()):
        normalized = " ".join(str(query).split())
        self.queries.append((normalized, params))
        row = self.select_rows.pop(0) if normalized.startswith("SELECT") else None
        return FakeCursor(row)

    def commit(self):
        self.commits += 1


class AccountKeyTests(unittest.IsolatedAsyncioTestCase):
    async def test_auth_config_has_one_client_generated_key_mode(self):
        config = await api.auth_config()
        self.assertEqual(config["mode"], "account_key")
        self.assertTrue(config["account_key"]["generated_by_client"])
        self.assertEqual(config["account_key"]["entropy_bits"], 256)
        for legacy in ("password", "oidc", "provider", "device_authorization_endpoint"):
            self.assertNotIn(legacy, config)

    def test_account_key_format_is_strict(self):
        self.assertEqual(api.validate_account_key(VALID_KEY), VALID_KEY)
        for invalid in (None, "", "scak_short", "scu_" + "A" * 43, VALID_KEY + "A", "scak_" + "!" * 43):
            with self.assertRaises(HTTPException) as raised:
                api.validate_account_key(invalid)
            self.assertEqual(raised.exception.status_code, 400)

    async def test_registration_stores_only_the_peppered_hash(self):
        rate_conn = FakeConnection([None, None, None, None])
        create_conn = FakeConnection([None, None, None, None])
        audits = []
        with (
            patch.object(api, "db", side_effect=[rate_conn, create_conn]),
            patch.object(api, "hash_secret", return_value="a" * 64),
            patch.object(api, "new_id", return_value="usr_accountKey123"),
            patch.object(api, "audit", side_effect=lambda *args: audits.append(args)),
        ):
            result = await api.register_account(FakeRequest({"username": "key_user", "account_key": VALID_KEY}))

        self.assertEqual(result, {"user_id": "usr_accountKey123", "username": "key_user", "created": True})
        insert = next((params for query, params in create_conn.queries if query.startswith("INSERT INTO sc.users")), None)
        self.assertEqual(insert, ("usr_accountKey123", "key_user", "a" * 64))
        serialized_queries = repr(rate_conn.queries + create_conn.queries + audits)
        self.assertNotIn(VALID_KEY, serialized_queries)
        self.assertEqual(rate_conn.commits, 1)
        self.assertEqual(create_conn.commits, 1)

    async def test_registration_retry_with_same_key_and_username_is_idempotent(self):
        rate_conn = FakeConnection([None, None, None, None])
        existing_conn = FakeConnection([
            None,
            None,
            {"id": "usr_existingKey12", "username": "key_user", "disabled_at": None},
        ])
        with (
            patch.object(api, "db", side_effect=[rate_conn, existing_conn]),
            patch.object(api, "hash_secret", return_value="a" * 64),
        ):
            result = await api.register_account(FakeRequest({"username": "key_user", "account_key": VALID_KEY}))
        self.assertEqual(result["created"], False)
        self.assertEqual(result["user_id"], "usr_existingKey12")
        self.assertFalse(any(query.startswith("INSERT INTO sc.users") for query, _ in existing_conn.queries))

    async def test_actor_authenticates_account_key_by_hash(self):
        conn = FakeConnection([{"id": "usr_keyActor1234", "username": "key_user"}])
        with (
            patch.object(api, "db", return_value=conn),
            patch.object(api, "hash_secret", return_value="c" * 64),
        ):
            actor = await api.actor_from_request(FakeRequest(token=VALID_KEY))
        self.assertEqual(actor["type"], "user")
        self.assertEqual(actor["auth_method"], "account_key")
        self.assertEqual(conn.queries[0][1], ("c" * 64,))
        self.assertNotIn(VALID_KEY, repr(conn.queries))

    async def test_rotation_replaces_hash_and_requires_account_key_actor(self):
        actor = {"type": "user", "id": "usr_rotateKey123", "user_id": "usr_rotateKey123"}
        conn = FakeConnection([None, None, None, {"token_hash": "old-hash"}, None])
        with (
            patch.object(api, "actor_from_request", AsyncMock(return_value=actor)),
            patch.object(api, "db", return_value=conn),
            patch.object(api, "hash_secret", return_value="d" * 64),
            patch.object(api, "audit"),
        ):
            result = await api.rotate_account_key(FakeRequest({"new_account_key": NEW_KEY}))
        self.assertEqual(result, {"ok": True, "rotated": True})
        update = next(params for query, params in conn.queries if query.startswith("UPDATE sc.users SET token_hash"))
        self.assertEqual(update, ("d" * 64, "usr_rotateKey123"))
        self.assertNotIn(NEW_KEY, repr(conn.queries))

        agent = {"type": "agent", "id": "ag_noRotate12345", "user_id": "usr_rotateKey123"}
        with patch.object(api, "actor_from_request", AsyncMock(return_value=agent)):
            with self.assertRaises(HTTPException) as raised:
                await api.rotate_account_key(FakeRequest({"new_account_key": NEW_KEY}))
        self.assertEqual(raised.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
