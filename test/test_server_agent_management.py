import base64
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


class FakeRequest:
    client = SimpleNamespace(host="127.0.0.1")

    def __init__(self, payload=None):
        self.payload = payload or {}
        self.raw_body = json.dumps(self.payload).encode("utf-8")
        self.headers = {"content-length": str(len(self.raw_body))}

    async def body(self):
        return self.raw_body


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
        rows = self.select_rows.pop(0) if normalized.startswith("SELECT") else []
        return FakeCursor(rows)

    def commit(self):
        self.commits += 1


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows if isinstance(rows, list) else [rows]

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None


class AgentManagementTests(unittest.IsolatedAsyncioTestCase):
    async def test_public_homepage_and_bundled_skills_are_available(self):
        root = await api.root()
        self.assertEqual(root.media_type, "text/html")
        self.assertTrue(pathlib.Path(root.path).is_file())
        response = await api.connect_skill()
        self.assertEqual(response.status_code, 307)
        self.assertEqual(response.headers["location"], "/skills/connect-supercollab/SKILL.md")
        self_host = await api.self_host_skill()
        self.assertEqual(self_host.status_code, 307)
        self.assertEqual(self_host.headers["location"], "/skills/self-host-supercollab/SKILL.md")

        metadata = await api.service_metadata()
        self.assertEqual(metadata["connect_skill"], "/skill.md")

    async def test_public_health_does_not_disclose_product_counts(self):
        conn = FakeConnection([[{"ready": 1}]])
        with patch.object(api, "db", return_value=conn):
            result = await api.health()
        self.assertEqual(result["database"], "ready")
        self.assertNotIn("users", result)
        self.assertNotIn("rooms", result)
        self.assertNotIn("messages", result)

    async def test_invite_response_does_not_advertise_raw_token_url(self):
        actor = {"type": "user", "id": "usr_test", "user_id": "usr_test"}
        conn = FakeConnection([None, None])
        with (
            patch.object(api, "actor_from_request", AsyncMock(return_value=actor)),
            patch.object(api, "db", return_value=conn),
            patch.object(api, "get_room"),
            patch.object(api, "require_member", return_value="owner"),
            patch.object(api, "new_token", return_value="sci_private_token"),
            patch.object(api, "new_id", return_value="in_testInvite1234"),
            patch.object(api, "hash_secret", return_value="hashed"),
            patch.object(api, "audit"),
        ):
            result = await api.create_invite("room_test", FakeRequest({"role": "member"}))
        self.assertEqual(result["invite_token"], "sci_private_token")
        self.assertNotIn("url", result)

    def test_relay_rejects_plaintext_and_metadata_sidecars(self):
        b64 = lambda value: base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")
        envelope = json.dumps({
            "v": 1,
            "alg": "A256GCM",
            "iv": b64(b"i" * 12),
            "tag": b64(b"t" * 16),
            "ciphertext": b64(b"encrypted"),
        })
        metadata = {"encrypted": True, "private": True, "alg": "A256GCM", "local_search": True}
        self.assertEqual(api.validate_encrypted_message(envelope, metadata), metadata)
        with self.assertRaises(HTTPException):
            api.validate_encrypted_message("plaintext", metadata)
        with self.assertRaises(HTTPException):
            api.validate_encrypted_message(envelope, {**metadata, "plaintext_hint": "secret"})

    async def test_agent_registration_rejects_agent_session_auth(self):
        actor = {"type": "agent", "id": "ag_parent", "user_id": "usr_test"}
        with patch.object(api, "actor_from_request", AsyncMock(return_value=actor)):
            with self.assertRaises(HTTPException) as raised:
                await api.register_agent(FakeRequest())
        self.assertEqual(raised.exception.status_code, 403)

    async def test_list_agents_is_scoped_to_authenticated_user(self):
        actor = {"type": "user", "id": "usr_test", "user_id": "usr_test"}
        conn = FakeConnection([[
            {
                "agent_id": "ag_CodexAgent1234",
                "label": "Codex",
                "fingerprint": "ed25519:codex",
                "revoked": False,
                "created_at": "2026-07-23T00:00:00Z",
            }
        ]])
        with (
            patch.object(api, "actor_from_request", AsyncMock(return_value=actor)),
            patch.object(api, "db", return_value=conn),
        ):
            result = await api.list_agents(FakeRequest())
        self.assertEqual(result["agents"][0]["agent_id"], "ag_CodexAgent1234")
        self.assertEqual(conn.queries[0][1], ("usr_test",))

    async def test_revoke_agent_revokes_every_session_and_audits(self):
        actor = {"type": "user", "id": "usr_test", "user_id": "usr_test"}
        conn = FakeConnection([{
            "id": "ag_CodexAgent1234",
            "label": "Codex",
            "fingerprint": "ed25519:codex",
            "revoked": False,
        }])
        audits = []

        def capture_audit(*args):
            audits.append(args)

        with (
            patch.object(api, "actor_from_request", AsyncMock(return_value=actor)),
            patch.object(api, "db", return_value=conn),
            patch.object(api, "audit", capture_audit),
        ):
            result = await api.revoke_agent("ag_CodexAgent1234", FakeRequest())

        self.assertEqual(result, {"ok": True, "agent_id": "ag_CodexAgent1234", "revoked": True})
        statements = [query for query, _ in conn.queries]
        self.assertTrue(any("UPDATE sc.agents SET revoked=true" in query for query in statements))
        self.assertTrue(any("UPDATE sc.agent_sessions SET revoked_at=now()" in query for query in statements))
        self.assertEqual(conn.commits, 1)
        self.assertEqual(audits[0][2:5], ("agent_revoked", "agent", "ag_CodexAgent1234"))


if __name__ == "__main__":
    unittest.main()
