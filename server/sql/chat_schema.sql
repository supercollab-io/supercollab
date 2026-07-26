\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS chat AUTHORIZATION supercollab_owner;

CREATE TABLE IF NOT EXISTS chat.rooms (
    id text PRIMARY KEY,
    slug text NOT NULL UNIQUE,
    title text NOT NULL,
    goal text NOT NULL DEFAULT '',
    owner_user_id text NOT NULL REFERENCES sc.users(id) ON DELETE RESTRICT,
    archived boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT sc.now_utc()
);

CREATE TABLE IF NOT EXISTS chat.memberships (
    room_id text NOT NULL REFERENCES chat.rooms(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES sc.users(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('owner', 'member', 'observer')),
    created_at timestamptz NOT NULL DEFAULT sc.now_utc(),
    PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_memberships_user ON chat.memberships(user_id, room_id);

CREATE TABLE IF NOT EXISTS chat.invites (
    id text PRIMARY KEY,
    room_id text NOT NULL REFERENCES chat.rooms(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    role text NOT NULL CHECK (role IN ('owner', 'member', 'observer')),
    expires_at bigint NOT NULL,
    expected_fingerprint text,
    accepted_at timestamptz,
    accepted_by_user_id text REFERENCES sc.users(id),
    revoked_at timestamptz,
    revoked_by_user_id text REFERENCES sc.users(id),
    created_by_user_id text NOT NULL REFERENCES sc.users(id),
    created_at timestamptz NOT NULL DEFAULT sc.now_utc()
);

CREATE INDEX IF NOT EXISTS idx_chat_invites_room ON chat.invites(room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat.messages (
    id bigserial PRIMARY KEY,
    room_id text NOT NULL REFERENCES chat.rooms(id) ON DELETE CASCADE,
    message_id text NOT NULL,
    channel text NOT NULL DEFAULT 'agents',
    kind text NOT NULL DEFAULT 'chat.message',
    actor_type text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
    actor_id text NOT NULL,
    user_id text REFERENCES sc.users(id),
    agent_id text REFERENCES sc.agents(id),
    sender_label text NOT NULL,
    body text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    content_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT sc.now_utc(),
    UNIQUE (room_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_room_id ON chat.messages(room_id, id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_room_created ON chat.messages(room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sc.agent_nonces (
    agent_id text NOT NULL REFERENCES sc.agents(id) ON DELETE CASCADE,
    nonce text NOT NULL,
    created_at bigint NOT NULL,
    PRIMARY KEY (agent_id, nonce)
);

ALTER TABLE chat.rooms OWNER TO supercollab_owner;
ALTER TABLE chat.memberships OWNER TO supercollab_owner;
ALTER TABLE chat.invites OWNER TO supercollab_owner;
ALTER TABLE chat.messages OWNER TO supercollab_owner;
ALTER TABLE sc.agent_nonces OWNER TO supercollab_owner;

GRANT USAGE ON SCHEMA chat TO supercollab_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA chat TO supercollab_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA chat TO supercollab_app;
GRANT SELECT, INSERT, DELETE ON sc.agent_nonces TO supercollab_app;

ALTER DEFAULT PRIVILEGES FOR ROLE supercollab_owner IN SCHEMA chat
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO supercollab_app;
ALTER DEFAULT PRIVILEGES FOR ROLE supercollab_owner IN SCHEMA chat
  GRANT USAGE, SELECT ON SEQUENCES TO supercollab_app;
