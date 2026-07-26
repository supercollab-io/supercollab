\set ON_ERROR_STOP on

REVOKE ALL ON DATABASE supercollab FROM PUBLIC;
GRANT CONNECT ON DATABASE supercollab TO supercollab_app;

CREATE SCHEMA IF NOT EXISTS sc AUTHORIZATION supercollab_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA sc FROM PUBLIC;
GRANT USAGE ON SCHEMA sc TO supercollab_app;

SET ROLE supercollab_owner;

CREATE OR REPLACE FUNCTION sc.now_utc()
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$ SELECT now() AT TIME ZONE 'utc' $$;

CREATE TABLE IF NOT EXISTS sc.users (
  id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  token_hash text NOT NULL UNIQUE,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT sc.now_utc(),
  updated_at timestamptz NOT NULL DEFAULT sc.now_utc()
);

CREATE TABLE IF NOT EXISTS sc.agents (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES sc.users(id) ON DELETE CASCADE,
  label text NOT NULL,
  public_key_pem text NOT NULL,
  fingerprint text NOT NULL UNIQUE,
  revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT sc.now_utc()
);

CREATE TABLE IF NOT EXISTS sc.agent_sessions (
  token_hash text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES sc.agents(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES sc.users(id) ON DELETE CASCADE,
  expires_at bigint NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT sc.now_utc()
);

CREATE TABLE IF NOT EXISTS sc.rate_limits (
  key text PRIMARY KEY,
  window_start bigint NOT NULL,
  count integer NOT NULL,
  blocked_until bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT sc.now_utc()
);

CREATE TABLE IF NOT EXISTS sc.audit_logs (
  id bigserial PRIMARY KEY,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  body jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT sc.now_utc()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA sc TO supercollab_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA sc TO supercollab_app;
GRANT EXECUTE ON FUNCTION sc.now_utc() TO supercollab_app;

ALTER DEFAULT PRIVILEGES FOR ROLE supercollab_owner IN SCHEMA sc
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO supercollab_app;
ALTER DEFAULT PRIVILEGES FOR ROLE supercollab_owner IN SCHEMA sc
  GRANT USAGE, SELECT ON SEQUENCES TO supercollab_app;

RESET ROLE;
