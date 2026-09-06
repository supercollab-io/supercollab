#!/usr/bin/env python3
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import time
import traceback
from pathlib import Path
from typing import Any

import psycopg
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from psycopg.types.json import Json
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

APP_VERSION = "0.7.0-alpha.9-key-auth"
RELEASE_VERSION = APP_VERSION.removesuffix("-key-auth")
DATA_DIR = Path(os.environ.get("SUPERCOLLAB_DATA_DIR", "/data/supercollab"))
SECRETS_DIR = Path(os.environ.get("SUPERCOLLAB_SECRETS", DATA_DIR / "secrets"))
PUBLIC_URL = os.environ.get("SUPERCOLLAB_PUBLIC_URL", "https://supercollab.io")
SOURCE_ROOT = Path(__file__).resolve().parents[1]
SKILLS_DIR = Path(os.environ.get("SUPERCOLLAB_SKILLS_DIR", SOURCE_ROOT / "skills"))
WEB_DIR = Path(os.environ.get("SUPERCOLLAB_WEB_DIR", SOURCE_ROOT / "web"))
PG_DSN = os.environ.get("SUPERCOLLAB_PG_DSN", "")
MAX_BODY_BYTES = 128 * 1024
MAX_CHAT_BYTES = 96 * 1024
SESSION_TTL_SECONDS = 12 * 60 * 60
SIGNATURE_WINDOW_SECONDS = 5 * 60
MAX_BEARER_TOKEN_BYTES = 16_384
ACCOUNT_KEY_PREFIX = "scak_"
ACCOUNT_KEY_BYTES = 32
ACCOUNT_KEY_PATTERN = re.compile(r"^scak_[A-Za-z0-9_-]{43}$")
AGENT_SESSION_PATTERN = re.compile(r"^sca_[A-Za-z0-9_-]{43}$")
INVITE_TOKEN_PATTERN = re.compile(r"^sci_[A-Za-z0-9_-]{43}$")
AGENT_ID_PATTERN = re.compile(r"^ag_[A-Za-z0-9]{8,32}$")
ROOM_ID_PATTERN = re.compile(r"^room_[A-Za-z0-9]{4,64}$")

app = FastAPI(title="SuperCollab Chat", version=APP_VERSION)
if SKILLS_DIR.is_dir():
    app.mount("/skills", StaticFiles(directory=str(SKILLS_DIR)), name="skills")
if (WEB_DIR / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=str(WEB_DIR / "assets")), name="assets")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'none'; "
        "frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
    )
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("X-Permitted-Cross-Domain-Policies", "none")
    response.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    if request.url.scheme == "https":
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    )
    if request.url.path.startswith("/v1/auth") or request.headers.get("authorization"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
    return response


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


ACCOUNT_SIGNUP_ENABLED = env_bool("SUPERCOLLAB_ACCOUNT_SIGNUP", True)


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def epoch() -> int:
    return int(time.time())


def ensure_dirs() -> None:
    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(SECRETS_DIR, 0o700)
    except PermissionError:
        pass


def read_pepper() -> bytes:
    env = os.environ.get("SUPERCOLLAB_AUTH_PEPPER")
    if env:
        return env.encode("utf-8")
    env_file = os.environ.get("SUPERCOLLAB_AUTH_PEPPER_FILE")
    if env_file:
        value = Path(env_file).read_text(encoding="utf-8").strip()
        if not value:
            raise RuntimeError("SUPERCOLLAB_AUTH_PEPPER_FILE is empty")
        return base64.urlsafe_b64decode(value.encode("ascii"))
    ensure_dirs()
    path = SECRETS_DIR / "server-pepper.b64"
    if not path.exists():
        path.write_text(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii"), encoding="utf-8")
        os.chmod(path, 0o600)
    return base64.urlsafe_b64decode(path.read_text(encoding="utf-8").strip())


def hash_secret(secret: str) -> str:
    return hmac.new(read_pepper(), secret.encode("utf-8"), hashlib.sha256).hexdigest()


def validate_account_key(value: Any) -> str:
    account_key = str(value or "")
    if not ACCOUNT_KEY_PATTERN.fullmatch(account_key):
        raise HTTPException(status_code=400, detail="invalid account key")
    return account_key


def validate_room_id(value: Any) -> str:
    room_id = str(value or "")
    if not ROOM_ID_PATTERN.fullmatch(room_id):
        raise HTTPException(status_code=400, detail="invalid room id")
    return room_id


async def read_body_limited(request: Request, limit: int = MAX_BODY_BYTES) -> bytes:
    raw_length = request.headers.get("content-length")
    if raw_length:
        try:
            content_length = int(raw_length)
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid content length")
        if content_length < 0:
            raise HTTPException(status_code=400, detail="invalid content length")
        if content_length > limit:
            raise HTTPException(status_code=413, detail="body too large")
    body = await request.body()
    if len(body) > limit:
        raise HTTPException(status_code=413, detail="body too large")
    return body


def json_object_from_body(body: bytes) -> dict[str, Any]:
    try:
        payload = json.loads(body.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="invalid JSON body")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="JSON body must be an object")
    return payload


async def read_json_object(request: Request, limit: int = MAX_BODY_BYTES) -> dict[str, Any]:
    return json_object_from_body(await read_body_limited(request, limit))


def decode_b64url_field(value: Any, field: str) -> bytes:
    encoded = str(value or "")
    if not encoded or not re.fullmatch(r"[A-Za-z0-9_-]+", encoded):
        raise HTTPException(status_code=400, detail=f"invalid encrypted-message {field}")
    padded = encoded + ("=" * ((4 - len(encoded) % 4) % 4))
    try:
        return base64.b64decode(padded.encode("ascii"), altchars=b"-_", validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail=f"invalid encrypted-message {field}")


def validate_encrypted_message(body: str, metadata: Any) -> dict[str, Any]:
    expected_metadata = {"encrypted": True, "private": True, "alg": "A256GCM", "local_search": True}
    if metadata != expected_metadata:
        raise HTTPException(status_code=400, detail="relay accepts only the standard encrypted-message metadata")
    try:
        envelope = json.loads(body)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="relay accepts encrypted message envelopes only")
    expected_fields = {"v", "alg", "iv", "tag", "ciphertext"}
    if not isinstance(envelope, dict) or set(envelope) != expected_fields:
        raise HTTPException(status_code=400, detail="invalid encrypted-message envelope")
    if envelope.get("v") != 1 or envelope.get("alg") != "A256GCM":
        raise HTTPException(status_code=400, detail="unsupported encrypted-message envelope")
    if len(decode_b64url_field(envelope.get("iv"), "iv")) != 12:
        raise HTTPException(status_code=400, detail="invalid encrypted-message iv")
    if len(decode_b64url_field(envelope.get("tag"), "tag")) != 16:
        raise HTTPException(status_code=400, detail="invalid encrypted-message tag")
    if not decode_b64url_field(envelope.get("ciphertext"), "ciphertext"):
        raise HTTPException(status_code=400, detail="invalid encrypted-message ciphertext")
    return expected_metadata


def db() -> psycopg.Connection:
    dsn = PG_DSN
    if not dsn:
        password_file = os.environ.get("SUPERCOLLAB_PG_PASSWORD_FILE")
        if not password_file:
            raise RuntimeError("SUPERCOLLAB_PG_DSN or SUPERCOLLAB_PG_PASSWORD_FILE is required")
        password = Path(password_file).read_text(encoding="utf-8").strip()
        if not password:
            raise RuntimeError("SUPERCOLLAB_PG_PASSWORD_FILE is empty")
        dsn = make_conninfo(
            host=os.environ.get("SUPERCOLLAB_PG_HOST", "postgres"),
            port=os.environ.get("SUPERCOLLAB_PG_PORT", "5432"),
            dbname=os.environ.get("SUPERCOLLAB_PG_DATABASE", "supercollab"),
            user=os.environ.get("SUPERCOLLAB_PG_USER", "supercollab_app"),
            password=password,
            connect_timeout="5",
            application_name="supercollab-api",
        )
    return psycopg.connect(dsn, row_factory=dict_row)


def new_token(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(32)}"


def new_id(prefix: str) -> str:
    clean = secrets.token_urlsafe(12).replace("-", "").replace("_", "")[:16]
    return f"{prefix}_{clean}"


def slugify(value: str) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return re.sub(r"-+", "-", value).strip("-") or "room"


def normalize_username(username: str) -> str:
    username = slugify(username).replace("-", "_")[:64]
    if not re.fullmatch(r"[a-z0-9_]{3,64}", username):
        raise HTTPException(status_code=400, detail="username must be 3-64 chars: lowercase letters, numbers, underscore")
    return username


def client_ip(request: Request) -> str:
    # Uvicorn applies Forwarded/X-Forwarded-For only from the explicitly
    # trusted Caddy addresses. Reading the raw header here would let clients
    # spoof the first hop and evade authentication rate limits.
    return (request.client.host if request.client else "unknown")[:80]


def as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def rate_limit(conn: psycopg.Connection, bucket: str, identity: str, limit: int, window_seconds: int, block_seconds: int = 0) -> None:
    now = epoch()
    ident = re.sub(r"[^A-Za-z0-9_.:@-]+", "_", identity or "unknown")[:160]
    key = f"{bucket}:{ident}"
    # Serialize each bucket so concurrent first requests cannot both create or
    # overwrite a counter at one. Callers handling unauthenticated attempts
    # commit the counter before doing work that may intentionally fail.
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (key,)).fetchone()
    row = conn.execute("SELECT * FROM sc.rate_limits WHERE key=%s", (key,)).fetchone()
    if row and as_int(row.get("blocked_until")) > now:
        retry = as_int(row["blocked_until"]) - now
        raise HTTPException(status_code=429, detail={"error": "rate_limited", "retry_after_seconds": max(1, retry)})
    if not row or now - as_int(row.get("window_start")) >= window_seconds:
        conn.execute(
            """
            INSERT INTO sc.rate_limits(key,window_start,count,blocked_until,updated_at)
            VALUES(%s,%s,%s,%s,now())
            ON CONFLICT(key) DO UPDATE
            SET window_start=excluded.window_start,count=excluded.count,blocked_until=excluded.blocked_until,updated_at=excluded.updated_at
            """,
            (key, now, 1, 0),
        )
        return
    count = as_int(row.get("count")) + 1
    blocked_until = 0
    if count > limit:
        blocked_until = now + block_seconds if block_seconds else as_int(row["window_start"]) + window_seconds
    conn.execute("UPDATE sc.rate_limits SET count=%s, blocked_until=%s, updated_at=now() WHERE key=%s", (count, blocked_until, key))
    if count > limit:
        conn.commit()
        raise HTTPException(status_code=429, detail={"error": "rate_limited", "retry_after_seconds": max(1, blocked_until - now)})


def audit(conn: psycopg.Connection, actor: dict[str, str], action: str, target_type: str, target_id: str, body: Any = None, ip: str | None = None) -> None:
    conn.execute(
        "INSERT INTO sc.audit_logs(actor_type,actor_id,action,target_type,target_id,body,ip,created_at) VALUES(%s,%s,%s,%s,%s,%s,%s,now())",
        (actor["type"], actor["id"], action, target_type, target_id, Json(body or {}), ip),
    )


def load_public_key(public_key_pem: str) -> Ed25519PublicKey:
    key = serialization.load_pem_public_key(public_key_pem.encode("utf-8"))
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError("public key must be Ed25519")
    return key


def public_key_fingerprint(public_key_pem: str) -> str:
    key = load_public_key(public_key_pem)
    raw = key.public_bytes(encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw)
    digest = hashlib.sha256(raw).digest()[:10]
    return "ed25519:" + base64.b32encode(digest).decode("ascii").rstrip("=").lower()


def verify_signature(public_key_pem: str, method: str, path: str, body: bytes, timestamp: str, nonce: str, signature_b64: str) -> None:
    try:
        ts = int(timestamp)
    except ValueError:
        raise HTTPException(status_code=401, detail="invalid timestamp")
    if abs(epoch() - ts) > SIGNATURE_WINDOW_SECONDS:
        raise HTTPException(status_code=401, detail="signature timestamp outside allowed window")
    try:
        raw = signature_b64.encode("ascii")
        raw += b"=" * ((4 - (len(raw) % 4)) % 4)
        signature = base64.urlsafe_b64decode(raw)
    except Exception:
        raise HTTPException(status_code=401, detail="invalid signature encoding")
    signed = f"{method.upper()}\n{path}\n{hashlib.sha256(body).hexdigest()}\n{timestamp}\n{nonce}".encode("utf-8")
    try:
        load_public_key(public_key_pem).verify(signature, signed)
    except (InvalidSignature, ValueError):
        raise HTTPException(status_code=401, detail="invalid signature")


def bearer_token_from_request(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    raw_token = auth.split(" ", 1)[1].strip()
    if (
        not raw_token
        or len(raw_token.encode("utf-8")) > MAX_BEARER_TOKEN_BYTES
        or not (ACCOUNT_KEY_PATTERN.fullmatch(raw_token) or AGENT_SESSION_PATTERN.fullmatch(raw_token))
    ):
        raise HTTPException(status_code=401, detail="invalid or expired token")
    return raw_token


async def actor_from_request(request: Request) -> dict[str, str]:
    raw_token = bearer_token_from_request(request)
    token_hash = hash_secret(raw_token)
    with db() as conn:
        user = conn.execute("SELECT id,username FROM sc.users WHERE token_hash=%s AND disabled_at IS NULL", (token_hash,)).fetchone()
        if user:
            return {"type": "user", "id": str(user["id"]), "user_id": str(user["id"]), "username": str(user["username"]), "auth_method": "account_key"}
        session = conn.execute(
            """
            SELECT s.agent_id,s.user_id,a.label,a.fingerprint
            FROM sc.agent_sessions s
            JOIN sc.agents a ON a.id=s.agent_id
            JOIN sc.users u ON u.id=s.user_id
            WHERE s.token_hash=%s AND s.expires_at>%s AND s.revoked_at IS NULL AND a.revoked=false AND u.disabled_at IS NULL
            """,
            (token_hash, epoch()),
        ).fetchone()
        if session:
            return {
                "type": "agent",
                "id": str(session["agent_id"]),
                "agent_id": str(session["agent_id"]),
                "user_id": str(session["user_id"]),
                "label": str(session["label"]),
                "fingerprint": str(session["fingerprint"]),
            }
    raise HTTPException(status_code=401, detail="invalid or expired token")


def require_member(conn: psycopg.Connection, room_id: str, user_id: str) -> str:
    room_id = validate_room_id(room_id)
    row = conn.execute("SELECT role FROM chat.memberships WHERE room_id=%s AND user_id=%s", (room_id, user_id)).fetchone()
    if not row:
        raise HTTPException(status_code=403, detail="not a room member")
    return str(row["role"])


def get_room(conn: psycopg.Connection, room_id: str) -> dict[str, Any]:
    room_id = validate_room_id(room_id)
    room = conn.execute("SELECT * FROM chat.rooms WHERE id=%s AND archived=false", (room_id,)).fetchone()
    if not room:
        raise HTTPException(status_code=404, detail="room not found")
    return room


def safe_channel(value: Any) -> str:
    channel = str(value or "agents").strip().lower()
    channel = re.sub(r"[^a-z0-9_.:-]+", "-", channel).strip("-")[:80]
    return channel or "agents"


def safe_kind(value: Any) -> str:
    kind = str(value or "chat.message").strip().lower()
    if not re.fullmatch(r"[a-z0-9_.:-]{1,80}", kind):
        raise HTTPException(status_code=400, detail="invalid message kind")
    return kind


def message_hash(room_id: str, channel: str, kind: str, body: str, metadata: Any) -> str:
    payload = json.dumps({"room_id": room_id, "channel": channel, "kind": kind, "body": body, "metadata": metadata or {}}, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def message_to_api(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    if isinstance(out.get("created_at"), dt.datetime):
        out["created_at"] = out["created_at"].astimezone(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return out


@app.exception_handler(Exception)
async def exception_handler(request: Request, exc: Exception):
    if isinstance(exc, HTTPException):
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    traceback.print_exc(file=sys.stderr)
    return JSONResponse(status_code=500, content={"detail": "internal server error"})


@app.get("/", include_in_schema=False)
async def root() -> FileResponse:
    index = WEB_DIR / "index.html"
    if not index.is_file():
        raise HTTPException(status_code=404, detail="homepage is not bundled")
    return FileResponse(index, media_type="text/html")


@app.get("/v1/meta")
async def service_metadata() -> dict[str, Any]:
    return {
        "service": "supercollab-chat",
        "version": APP_VERSION,
        "mode": "encrypted-relay",
        "health": "/health",
        "connect_skill": "/skill.md",
    }


@app.get("/skill.md", include_in_schema=False)
async def connect_skill() -> RedirectResponse:
    if not (SKILLS_DIR / "connect-supercollab" / "SKILL.md").is_file():
        raise HTTPException(status_code=404, detail="connection skill is not bundled")
    return RedirectResponse(url=f"/skills/connect-supercollab/SKILL.md?v={RELEASE_VERSION}", status_code=307)


@app.get("/self-host.md", include_in_schema=False)
async def self_host_skill() -> RedirectResponse:
    if not (SKILLS_DIR / "self-host-supercollab" / "SKILL.md").is_file():
        raise HTTPException(status_code=404, detail="self-hosting skill is not bundled")
    return RedirectResponse(url=f"/skills/self-host-supercollab/SKILL.md?v={RELEASE_VERSION}", status_code=307)


@app.get("/health")
async def health() -> dict[str, Any]:
    with db() as conn:
        conn.execute("SELECT 1").fetchone()
    return {
        "ok": True,
        "service": "supercollab-chat",
        "version": APP_VERSION,
        "mode": "encrypted-relay",
        "time": utc_now(),
        "database": "ready",
    }


@app.get("/v1/auth/config")
async def auth_config() -> dict[str, Any]:
    return {
        "mode": "account_key",
        "signup_enabled": ACCOUNT_SIGNUP_ENABLED,
        "account_key": {
            "generated_by_client": True,
            "prefix": ACCOUNT_KEY_PREFIX,
            "entropy_bits": ACCOUNT_KEY_BYTES * 8,
        },
        "agent_auth": {
            "algorithm": "Ed25519",
            "session_ttl_seconds": SESSION_TTL_SECONDS,
        },
    }


@app.post("/v1/auth/register")
async def register_account(request: Request) -> dict[str, Any]:
    if not ACCOUNT_SIGNUP_ENABLED:
        raise HTTPException(status_code=404, detail="account signup is disabled")
    payload = await read_json_object(request)
    username = normalize_username(str(payload.get("username", "")))
    account_key = validate_account_key(payload.get("account_key"))
    token_hash = hash_secret(account_key)
    username_hash = hashlib.sha256(username.encode("utf-8")).hexdigest()

    with db() as conn:
        rate_limit(conn, "account_register_ip", client_ip(request), 10, 3600, 3600)
        rate_limit(conn, "account_register_username", username_hash, 3, 3600, 3600)
        conn.commit()

    with db() as conn:
        # Lock both unique identities in a deterministic order. Retrying after
        # a crash is safe when the same locally generated key and username are
        # supplied again.
        for lock_key in sorted((f"account-key:{token_hash}", f"account-name:{username_hash}")):
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (lock_key,)).fetchone()
        existing_key = conn.execute(
            "SELECT id,username,disabled_at FROM sc.users WHERE token_hash=%s",
            (token_hash,),
        ).fetchone()
        if existing_key:
            if existing_key.get("disabled_at"):
                raise HTTPException(status_code=403, detail="account access disabled")
            if str(existing_key["username"]) != username:
                raise HTTPException(status_code=409, detail="account key is already registered")
            return {
                "user_id": str(existing_key["id"]),
                "username": str(existing_key["username"]),
                "created": False,
            }
        if conn.execute("SELECT id FROM sc.users WHERE username=%s", (username,)).fetchone():
            raise HTTPException(status_code=409, detail="username already exists")
        user_id = new_id("usr")
        conn.execute(
            "INSERT INTO sc.users(id,username,token_hash,created_at,updated_at) VALUES(%s,%s,%s,now(),now())",
            (user_id, username, token_hash),
        )
        audit(conn, {"type": "system", "id": "account-key"}, "account_created", "user", user_id, {"username": username}, client_ip(request))
        conn.commit()
    return {"user_id": user_id, "username": username, "created": True}


@app.post("/v1/auth/rotate")
async def rotate_account_key(request: Request) -> dict[str, Any]:
    actor = await actor_from_request(request)
    if actor["type"] != "user":
        raise HTTPException(status_code=403, detail="account key rotation requires account-key auth")
    payload = await read_json_object(request)
    new_account_key = validate_account_key(payload.get("new_account_key"))
    new_hash = hash_secret(new_account_key)

    with db() as conn:
        rate_limit(conn, "account_rotate_user", actor["user_id"], 5, 3600, 3600)
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"account-key:{new_hash}",)).fetchone()
        current = conn.execute("SELECT token_hash FROM sc.users WHERE id=%s FOR UPDATE", (actor["user_id"],)).fetchone()
        if not current:
            raise HTTPException(status_code=401, detail="invalid or expired token")
        if str(current["token_hash"]) == new_hash:
            return {"ok": True, "rotated": False}
        if conn.execute("SELECT 1 FROM sc.users WHERE token_hash=%s", (new_hash,)).fetchone():
            raise HTTPException(status_code=409, detail="new account key is already registered")
        conn.execute("UPDATE sc.users SET token_hash=%s,updated_at=now() WHERE id=%s", (new_hash, actor["user_id"]))
        audit(conn, actor, "account_key_rotated", "user", actor["user_id"], {}, client_ip(request))
        conn.commit()
    return {"ok": True, "rotated": True}


@app.get("/v1/me")
async def me(request: Request) -> dict[str, Any]:
    return {"actor": await actor_from_request(request)}


@app.post("/v1/agents/register")
async def register_agent(request: Request) -> dict[str, Any]:
    actor = await actor_from_request(request)
    if actor["type"] != "user":
        raise HTTPException(status_code=403, detail="agent registration requires user auth")
    payload = await read_json_object(request)
    label = str(payload.get("label", "agent")).strip()[:120] or "agent"
    public_key_pem = str(payload.get("public_key_pem", ""))
    try:
        fingerprint = public_key_fingerprint(public_key_pem)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"invalid public key: {exc}")
    agent_id = new_id("ag")
    with db() as conn:
        rate_limit(conn, "agent_register_user", actor["user_id"], 30, 3600, 3600)
        conn.execute(
            "INSERT INTO sc.agents(id,user_id,label,public_key_pem,fingerprint,created_at) VALUES(%s,%s,%s,%s,%s,now())",
            (agent_id, actor["user_id"], label, public_key_pem, fingerprint),
        )
        audit(conn, actor, "agent_registered", "agent", agent_id, {"label": label, "fingerprint": fingerprint}, client_ip(request))
        conn.commit()
    return {"agent_id": agent_id, "label": label, "fingerprint": fingerprint}


@app.get("/v1/agents")
async def list_agents(request: Request) -> dict[str, Any]:
    actor = await actor_from_request(request)
    if actor["type"] != "user":
        raise HTTPException(status_code=403, detail="agent management requires user auth")
    with db() as conn:
        rows = conn.execute(
            """
            SELECT id AS agent_id,label,fingerprint,revoked,created_at
            FROM sc.agents
            WHERE user_id=%s
            ORDER BY created_at DESC
            """,
            (actor["user_id"],),
        ).fetchall()
    return {"agents": [message_to_api(row) for row in rows]}


@app.delete("/v1/agents/{agent_id}")
async def revoke_agent(agent_id: str, request: Request) -> dict[str, Any]:
    actor = await actor_from_request(request)
    if actor["type"] != "user":
        raise HTTPException(status_code=403, detail="agent management requires user auth")
    if not re.fullmatch(r"ag_[A-Za-z0-9]{8,32}", agent_id):
        raise HTTPException(status_code=400, detail="invalid agent id")
    with db() as conn:
        agent = conn.execute(
            "SELECT id,label,fingerprint,revoked FROM sc.agents WHERE id=%s AND user_id=%s",
            (agent_id, actor["user_id"]),
        ).fetchone()
        if not agent:
            raise HTTPException(status_code=404, detail="agent not found")
        if not agent["revoked"]:
            conn.execute("UPDATE sc.agents SET revoked=true WHERE id=%s", (agent_id,))
            conn.execute("UPDATE sc.agent_sessions SET revoked_at=now() WHERE agent_id=%s AND revoked_at IS NULL", (agent_id,))
            audit(
                conn,
                actor,
                "agent_revoked",
                "agent",
                agent_id,
                {"label": agent["label"], "fingerprint": agent["fingerprint"]},
                client_ip(request),
            )
            conn.commit()
    return {"ok": True, "agent_id": agent_id, "revoked": True}


@app.post("/v1/agent-sessions")
async def create_agent_session(request: Request) -> dict[str, Any]:
    body = await read_body_limited(request)
    payload = json_object_from_body(body)
    agent_id = str(payload.get("agent_id", ""))
    timestamp = request.headers.get("x-supercollab-timestamp", "")
    nonce = request.headers.get("x-supercollab-nonce", "")
    signature = request.headers.get("x-supercollab-signature", "")
    if (
        not AGENT_ID_PATTERN.fullmatch(agent_id)
        or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", nonce)
        or not re.fullmatch(r"[0-9]{1,16}", timestamp)
        or len(signature) > 256
        or not re.fullmatch(r"[A-Za-z0-9_-]+={0,2}", signature)
    ):
        raise HTTPException(status_code=401, detail="missing signature headers")
    with db() as conn:
        rate_limit(conn, "agent_session_ip", client_ip(request), 120, 300, 300)
        rate_limit(conn, "agent_session_agent", agent_id, 60, 300, 300)
        conn.commit()
        agent = conn.execute(
            """
            SELECT a.*
            FROM sc.agents a
            JOIN sc.users u ON u.id=a.user_id
            WHERE a.id=%s AND a.revoked=false AND u.disabled_at IS NULL
            """,
            (agent_id,),
        ).fetchone()
        if not agent:
            raise HTTPException(status_code=401, detail="unknown or revoked agent")
        verify_signature(str(agent["public_key_pem"]), "POST", "/v1/agent-sessions", body, timestamp, nonce, signature)
        try:
            conn.execute("INSERT INTO sc.agent_nonces(agent_id,nonce,created_at) VALUES(%s,%s,%s)", (agent_id, nonce, epoch()))
        except psycopg.errors.UniqueViolation:
            conn.rollback()
            raise HTTPException(status_code=401, detail="replayed nonce")
        conn.execute("DELETE FROM sc.agent_nonces WHERE created_at<%s", (epoch() - 24 * 60 * 60,))
        token = new_token("sca")
        expires_at = epoch() + SESSION_TTL_SECONDS
        conn.execute(
            "INSERT INTO sc.agent_sessions(token_hash,agent_id,user_id,expires_at,created_at) VALUES(%s,%s,%s,%s,now())",
            (hash_secret(token), agent_id, agent["user_id"], expires_at),
        )
        audit(conn, {"type": "agent", "id": agent_id}, "agent_session_issued", "agent", agent_id, {"expires_at": expires_at}, client_ip(request))
        conn.commit()
    return {"token": token, "expires_at": expires_at, "agent_id": agent_id}


@app.get("/v1/agent-sessions")
async def list_agent_sessions(request: Request) -> dict[str, Any]:
    actor = await actor_from_request(request)
    if actor["type"] != "user":
        raise HTTPException(status_code=403, detail="session management requires user auth")
    with db() as conn:
        rows = conn.execute(
            """
            SELECT substr(s.token_hash,1,20) AS session_id,s.agent_id,a.label,a.fingerprint,s.expires_at,s.created_at,s.revoked_at
            FROM sc.agent_sessions s JOIN sc.agents a ON a.id=s.agent_id
            WHERE s.user_id=%s
            ORDER BY s.created_at DESC
            LIMIT 100
            """,
            (actor["user_id"],),
        ).fetchall()
    now = epoch()
    return {"sessions": [{**message_to_api(row), "active": bool(row["revoked_at"] is None and int(row["expires_at"]) > now)} for row in rows]}


@app.delete("/v1/agent-sessions/{session_id}")
async def revoke_agent_session(session_id: str, request: Request) -> dict[str, Any]:
    actor = await actor_from_request(request)
    if actor["type"] != "user":
        raise HTTPException(status_code=403, detail="session management requires user auth")
    if not re.fullmatch(r"[0-9a-f]{12,64}", session_id):
        raise HTTPException(status_code=400, detail="invalid session id")
    with db() as conn:
        rows = conn.execute("SELECT token_hash,agent_id,revoked_at FROM sc.agent_sessions WHERE user_id=%s AND token_hash LIKE %s", (actor["user_id"], f"{session_id}%")).fetchall()
        if not rows:
            raise HTTPException(status_code=404, detail="session not found")
        if len(rows) > 1:
            raise HTTPException(status_code=409, detail="session id prefix is ambiguous")
        if not rows[0]["revoked_at"]:
            conn.execute("UPDATE sc.agent_sessions SET revoked_at=now() WHERE token_hash=%s", (rows[0]["token_hash"],))
            audit(conn, actor, "agent_session_revoked", "agent_session", session_id, {"agent_id": rows[0]["agent_id"]}, client_ip(request))
            conn.commit()
    return {"ok": True, "session_id": session_id}


@app.get("/v1/rooms")
async def list_rooms(request: Request) -> dict[str, Any]:
    actor = await actor_from_request(request)
    with db() as conn:
        rows = conn.execute(
            """
            SELECT r.id,r.slug,r.title,r.goal,r.created_at,m.role
            FROM chat.rooms r
            JOIN chat.memberships m ON m.room_id=r.id
            WHERE m.user_id=%s AND r.archived=false
            ORDER BY r.created_at DESC
            """,
            (actor["user_id"],),
        ).fetchall()
    return {"rooms": [message_to_api(row) for row in rows]}


@app.post("/v1/rooms")
async def create_room(request: Request) -> dict[str, Any]:
    actor = await actor_from_request(request)
    payload = await read_json_object(request)
    title = str(payload.get("title", "SuperCollab Chat")).strip()[:160] or "SuperCollab Chat"
    goal = str(payload.get("goal", "Agent collaboration chat.")).strip()[:4000]
    base_slug = slugify(str(payload.get("slug") or title))[:120]
    room_id = new_id("room")
    with db() as conn:
        rate_limit(conn, "room_create_user", actor["user_id"], 60, 3600, 3600)
        slug = base_slug
        suffix = 2
        while conn.execute("SELECT 1 FROM chat.rooms WHERE slug=%s", (slug,)).fetchone():
            slug = f"{base_slug}-{suffix}"
            suffix += 1
        conn.execute("INSERT INTO chat.rooms(id,slug,title,goal,owner_user_id,created_at) VALUES(%s,%s,%s,%s,%s,now())", (room_id, slug, title, goal, actor["user_id"]))
        conn.execute("INSERT INTO chat.memberships(room_id,user_id,role,created_at) VALUES(%s,%s,'owner',now())", (room_id, actor["user_id"]))
        audit(conn, actor, "room_created", "room", room_id, {"slug": slug}, client_ip(request))
        conn.commit()
    return {"room_id": room_id, "id": room_id, "slug": slug, "title": title, "goal": goal}


@app.get("/v1/rooms/{room_id}")
async def get_room_route(room_id: str, request: Request) -> dict[str, Any]:
    actor = await actor_from_request(request)
    with db() as conn:
        room = get_room(conn, room_id)
        role = require_member(conn, room_id, actor["user_id"])
    return {"room": {**message_to_api(room), "role": role}}


@app.post("/v1/rooms/{room_id}/invites")
async def create_invite(room_id: str, request: Request) -> dict[str, Any]:
    actor = await actor_from_request(request)
    payload = await read_json_object(request)
    role = str(payload.get("role", "member"))
    if role not in {"owner", "member", "observer"}:
        raise HTTPException(status_code=400, detail="invalid role")
    try:
        ttl_seconds = max(300, min(int(payload.get("ttl_seconds", 86400)), 7 * 86400))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="invalid invite lifetime")
    expected_fingerprint = payload.get("expected_fingerprint")
    if expected_fingerprint is not None and not re.fullmatch(r"ed25519:[a-z2-7]{16}", str(expected_fingerprint)):
        raise HTTPException(status_code=400, detail="invalid expected fingerprint")
    if expected_fingerprint is not None:
        expected_fingerprint = str(expected_fingerprint)
    token = new_token("sci")
    invite_id = new_id("in")
    with db() as conn:
        get_room(conn, room_id)
        current_role = require_member(conn, room_id, actor["user_id"])
        if current_role not in {"owner", "member"}:
            raise HTTPException(status_code=403, detail="role cannot create invites")
        if role == "owner" and current_role != "owner":
            raise HTTPException(status_code=403, detail="only owners can create owner invites")
        if current_role == "member" and role not in {"member", "observer"}:
            raise HTTPException(status_code=403, detail="members can only invite member or observer roles")
        rate_limit(conn, "invite_create_user", actor["user_id"], 60, 3600, 3600)
        expires_at = epoch() + ttl_seconds
        conn.execute(
            "INSERT INTO chat.invites(id,room_id,token_hash,role,expires_at,expected_fingerprint,created_by_user_id,created_at) VALUES(%s,%s,%s,%s,%s,%s,%s,now())",
            (invite_id, room_id, hash_secret(token), role, expires_at, expected_fingerprint, actor["user_id"]),
        )
        audit(conn, actor, "invite_created", "room", room_id, {"invite_id": invite_id, "role": role}, client_ip(request))
        conn.commit()
    return {"invite_id": invite_id, "invite_token": token, "expires_at": expires_at, "role": role}


@app.get("/v1/rooms/{room_id}/invites")
async def list_invites(room_id: str, request: Request) -> dict[str, Any]:
    actor = await actor_from_request(request)
    with db() as conn:
        get_room(conn, room_id)
        current_role = require_member(conn, room_id, actor["user_id"])
        if current_role == "owner":
            rows = conn.execute(
                """
                SELECT i.id,i.room_id,i.role,i.expires_at,i.expected_fingerprint,
                       i.accepted_at,i.accepted_by_user_id,i.revoked_at,
                       i.revoked_by_user_id,i.created_by_user_id,i.created_at,
                       u.username AS created_by_username
                FROM chat.invites i JOIN sc.users u ON u.id=i.created_by_user_id
                WHERE i.room_id=%s
                ORDER BY i.created_at DESC LIMIT 100
                """,
                (room_id,),
            ).fetchall()
        elif current_role == "member":
            rows = conn.execute(
                """
                SELECT i.id,i.room_id,i.role,i.expires_at,i.expected_fingerprint,
                       i.accepted_at,i.accepted_by_user_id,i.revoked_at,
                       i.revoked_by_user_id,i.created_by_user_id,i.created_at,
                       u.username AS created_by_username
                FROM chat.invites i JOIN sc.users u ON u.id=i.created_by_user_id
                WHERE i.room_id=%s AND i.created_by_user_id=%s
                ORDER BY i.created_at DESC LIMIT 100
                """,
                (room_id, actor["user_id"]),
            ).fetchall()
        else:
            raise HTTPException(status_code=403, detail="role cannot list invites")
    now = epoch()
    invites = []
    for row in rows:
        item = message_to_api(row)
        item["status"] = "revoked" if row["revoked_at"] else "accepted" if row["accepted_at"] else "expired" if int(row["expires_at"]) < now else "pending"
        invites.append(item)
    return {"invites": invites}


@app.post("/v1/invites/accept")
async def accept_invite(request: Request) -> dict[str, Any]:
    actor = await actor_from_request(request)
    payload = await read_json_object(request)
    token = str(payload.get("token", ""))
    if not INVITE_TOKEN_PATTERN.fullmatch(token):
        raise HTTPException(status_code=400, detail="invalid invite token")
    fingerprint = payload.get("fingerprint")
    with db() as conn:
        rate_limit(conn, "invite_accept_ip", client_ip(request), 60, 900, 900)
        conn.commit()
        invite = conn.execute("SELECT * FROM chat.invites WHERE token_hash=%s FOR UPDATE", (hash_secret(token),)).fetchone()
        if not invite:
            raise HTTPException(status_code=404, detail="invite not found")
        if invite["revoked_at"]:
            raise HTTPException(status_code=410, detail="invite revoked")
        if invite["accepted_at"]:
            raise HTTPException(status_code=409, detail="invite already accepted")
        if int(invite["expires_at"]) < epoch():
            raise HTTPException(status_code=410, detail="invite expired")
        if invite["expected_fingerprint"] and invite["expected_fingerprint"] != fingerprint:
            raise HTTPException(status_code=403, detail="fingerprint does not match invite")
        conn.execute(
            """
            INSERT INTO chat.memberships(room_id,user_id,role,created_at)
            VALUES(%s,%s,%s,now())
            ON CONFLICT(room_id,user_id) DO UPDATE SET role=excluded.role
            """,
            (invite["room_id"], actor["user_id"], invite["role"]),
        )
        conn.execute("UPDATE chat.invites SET accepted_at=now(), accepted_by_user_id=%s WHERE id=%s", (actor["user_id"], invite["id"]))
        audit(conn, actor, "invite_accepted", "room", invite["room_id"], {"invite_id": invite["id"], "role": invite["role"]}, client_ip(request))
        conn.commit()
    return {"room_id": invite["room_id"], "role": invite["role"]}


@app.post("/v1/rooms/{room_id}/messages")
async def send_message(room_id: str, request: Request) -> dict[str, Any]:
    actor = await actor_from_request(request)
    payload = await read_json_object(request)
    body = str(payload.get("body", payload.get("text", ""))).strip()
    if not body:
        raise HTTPException(status_code=400, detail="message body required")
    if len(body.encode("utf-8")) > MAX_CHAT_BYTES:
        raise HTTPException(status_code=413, detail=f"message too large; max {MAX_CHAT_BYTES} bytes")
    channel = safe_channel(payload.get("channel"))
    kind = safe_kind(payload.get("kind"))
    metadata = payload.get("metadata") or {}
    metadata = validate_encrypted_message(body, metadata)
    message_id = str(payload.get("message_id") or new_id("msg"))
    if not re.fullmatch(r"msg_[A-Za-z0-9_-]{8,80}", message_id):
        raise HTTPException(status_code=400, detail="invalid message_id")
    sender = actor.get("label") or actor.get("username") or actor["id"]
    content_hash = message_hash(room_id, channel, kind, body, metadata)
    with db() as conn:
        get_room(conn, room_id)
        role = require_member(conn, room_id, actor["user_id"])
        if role == "observer":
            raise HTTPException(status_code=403, detail="observers cannot send messages")
        rate_limit(conn, "chat_send_user", actor["user_id"], 120, 60, 60)
        try:
            row = conn.execute(
                """
                INSERT INTO chat.messages(room_id,message_id,channel,kind,actor_type,actor_id,user_id,agent_id,sender_label,body,metadata,content_hash,created_at)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())
                RETURNING id,message_id,channel,kind,actor_type,actor_id,user_id,agent_id,sender_label,body,metadata,content_hash,created_at
                """,
                (room_id, message_id, channel, kind, actor["type"], actor["id"], actor["user_id"], actor.get("agent_id"), sender, body, Json(metadata), content_hash),
            ).fetchone()
        except psycopg.errors.UniqueViolation:
            conn.rollback()
            row = conn.execute("SELECT id,message_id,channel,kind,actor_type,actor_id,user_id,agent_id,sender_label,body,metadata,content_hash,created_at FROM chat.messages WHERE room_id=%s AND message_id=%s", (room_id, message_id)).fetchone()
        audit(conn, actor, "chat_message_sent", "room", room_id, {"message_id": message_id, "channel": channel, "kind": kind}, client_ip(request))
        conn.commit()
    return {"message": message_to_api(row)}


@app.get("/v1/rooms/{room_id}/messages")
async def list_messages(room_id: str, request: Request, after: int = 0, limit: int = 100, channel: str | None = None) -> dict[str, Any]:
    actor = await actor_from_request(request)
    after = max(0, int(after))
    limit = max(1, min(int(limit), 500))
    params: list[Any] = [room_id, after]
    channel_sql = ""
    if channel:
        channel_sql = " AND channel=%s"
        params.append(safe_channel(channel))
    params.append(limit)
    with db() as conn:
        get_room(conn, room_id)
        require_member(conn, room_id, actor["user_id"])
        rows = conn.execute(
            f"""
            SELECT id,message_id,channel,kind,actor_type,actor_id,user_id,agent_id,sender_label,body,metadata,content_hash,created_at
            FROM chat.messages
            WHERE room_id=%s AND id>%s {channel_sql}
            ORDER BY id ASC
            LIMIT %s
            """,
            params,
        ).fetchall()
    next_after = int(rows[-1]["id"]) if rows else after
    return {"room_id": room_id, "after": after, "next_after": next_after, "messages": [message_to_api(row) for row in rows]}


@app.get("/v1/rooms/{room_id}/search")
async def search_messages(room_id: str, request: Request, q: str, limit: int = 20) -> dict[str, Any]:
    actor = await actor_from_request(request)
    with db() as conn:
        get_room(conn, room_id)
        require_member(conn, room_id, actor["user_id"])
    raise HTTPException(status_code=410, detail="hosted search is disabled for encrypted rooms; sync locally and use MCP chat_search")
