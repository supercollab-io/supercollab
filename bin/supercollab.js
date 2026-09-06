#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const VERSION = '0.7.0-alpha.9';
const CLI_ENTRY = fileURLToPath(import.meta.url);
const DEFAULT_SERVER = process.env.SUPERCOLLAB_URL || 'https://supercollab.io';
const DEFAULT_CONFIG = process.env.SUPERCOLLAB_CONFIG || path.join(os.homedir(), '.supercollab', 'config.json');
const SESSION_TTL_SKEW = 60;
const ACCOUNT_KEY_PATTERN = /^scak_[A-Za-z0-9_-]{43}$/;
const ROOM_ID_PATTERN = /^room_[A-Za-z0-9]{4,64}$/;
const INVITE_TOKEN_PATTERN = /^sci_[A-Za-z0-9_-]{43}$/;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_ENCRYPTED_ENVELOPE_BYTES = 96 * 1024;
const MAX_CONFIG_BYTES = 5 * 1024 * 1024;
const EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5';
const EMBEDDING_DTYPE = 'q8';
const EMBEDDING_DIMS = 384;
const EMBEDDING_CHUNK_CHARS = 3200;
const EMBEDDING_CHUNK_OVERLAP = 480;
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const AGENT_PROFILE_FIELDS = Object.freeze([
  'agentId',
  'agentLabel',
  'agentFingerprint',
  'agentPrivateKeyPem',
  'agentSessionToken',
  'agentSessionExpiresAt',
]);
const ACCOUNT_FIELDS = Object.freeze([
  'accountKey',
  'userId',
  'username',
  'accountBindingUserId',
  'accountBindingUsername',
]);
const EMBEDDING_PROFILE = Object.freeze({
  id: 'lean-memory-bge-small-en-v1.5-q8-mean-normalized-v1',
  model: EMBEDDING_MODEL,
  backend: '@huggingface/transformers',
  dtype: EMBEDDING_DTYPE,
  dims: EMBEDDING_DIMS,
  pooling: 'mean',
  normalize: true,
  query_prefix: 'Represent this sentence for searching relevant passages: ',
  chunk_chars: EMBEDDING_CHUNK_CHARS,
  chunk_overlap_chars: EMBEDDING_CHUNK_OVERLAP,
  local_only: true,
});

function printHelp() {
  console.log(`SuperCollab CLI ${VERSION}

Usage:
  supercollab menu
  supercollab setup
  supercollab doctor [--json] [--skip-model]
  supercollab account create --username NAME [--label LABEL]
  supercollab account status [--local]
  supercollab account rotate-key
  supercollab whoami
  supercollab agent list
  supercollab agent register [--label LABEL] [--replace]
  supercollab agent revoke --agent ID
  supercollab profile list
  supercollab profile create --name NAME [--label LABEL]
  supercollab profile revoke --name NAME
  supercollab room list
  supercollab room create --title TITLE --goal GOAL [--slug SLUG]
  supercollab room invite --room ID [--role member]
  supercollab room invites --room ID
  supercollab room join --invite TOKEN
  supercollab room key --room ID
  supercollab chat send --room ID --text TEXT [--channel agents]
  supercollab chat read --room ID [--after 0] [--limit 50]
  supercollab chat search --room ID --query TEXT [--mode hybrid|keyword|vector] [--limit 20]
  supercollab sync --room ID
  supercollab activate --room ID [--cwd PATH] [--sharing manual|progress]
  supercollab deactivate [--cwd PATH]
  supercollab active [--cwd PATH]
  supercollab session list
  supercollab session revoke --session ID
  supercollab embeddings status
  supercollab embeddings warmup
  supercollab mcp stdio
  supercollab mcp install --client codex|claude-code [--scope local] [--cwd PATH] [--replace]
  supercollab mcp print-config --client codex
  supercollab mcp smoke [--timeout 5000]
  supercollab config path

Options:
  --config PATH       Config path, default ~/.supercollab/config.json
  --profile NAME      Select an isolated local agent identity from this config
  --server URL        SuperCollab API URL, default ${DEFAULT_SERVER}

Environment:
  SUPERCOLLAB_CONFIG can override config path.
  SUPERCOLLAB_MODEL_CACHE can override the local Hugging Face model cache.
  SUPERCOLLAB_WORKDIR sets the local workspace directory for MCP activation checks.
`);
}

function parse(argv) {
  const positionals = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i++;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, opts };
}

function configPath(opts = {}) {
  return opts.config || DEFAULT_CONFIG;
}

function assertPrivateConfigFile(file) {
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`refusing non-regular or symlinked SuperCollab config: ${file}`);
  }
  if (stat.size > MAX_CONFIG_BYTES) throw new Error(`SuperCollab config exceeds ${MAX_CONFIG_BYTES} bytes`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`SuperCollab config must not be accessible by group or others: chmod 600 ${file}`);
  }
}

function ensureConfigDir(file) {
  const dir = path.dirname(file);
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Do not chmod an arbitrary existing project/home directory supplied via
  // --config. The dedicated default directory is owned by SuperCollab and is
  // always tightened; newly created custom directories start private.
  if (!existed || path.basename(dir) === '.supercollab') {
    try { fs.chmodSync(dir, 0o700); } catch {}
  }
}

function normalizeProfileName(value) {
  if (value === true) throw new Error('missing --profile value');
  const name = String(value || '').trim().toLowerCase();
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new Error('profile name must be 1-32 lowercase letters, numbers, underscores, or hyphens');
  }
  return name;
}

function profileCliArgs(opts = {}) {
  return opts.profile ? ['--profile', normalizeProfileName(opts.profile)] : [];
}

function loadConfig(file = DEFAULT_CONFIG, profileName = null) {
  assertPrivateConfigFile(file);
  let raw = { serverUrl: DEFAULT_SERVER };
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('SuperCollab config must contain a JSON object');
    }
    raw = { serverUrl: DEFAULT_SERVER, ...parsed };
  }
  if (!profileName) return raw;
  const name = normalizeProfileName(profileName);
  const profile = raw.agentProfiles?.[name];
  if (!profile) {
    throw new Error(`unknown agent profile ${name}; reconnect this MCP with an existing profile or create a new local identity through SuperCollab tools`);
  }
  const selected = { ...raw };
  for (const field of AGENT_PROFILE_FIELDS) delete selected[field];
  Object.assign(selected, profile);
  Object.defineProperty(selected, '__profileName', { value: name, writable: true, configurable: true, enumerable: false });
  return selected;
}

function saveConfig(config, file = DEFAULT_CONFIG) {
  ensureConfigDir(file);
  const tmp = `${file}.${process.pid}.tmp`;
  const serializable = { ...config };
  delete serializable.__configFile;
  if (serializable.userId && !serializable.accountBindingUserId) {
    serializable.accountBindingUserId = serializable.userId;
  }
  if (serializable.username && !serializable.accountBindingUsername) {
    serializable.accountBindingUsername = serializable.username;
  }
  const profileName = config.__profileName || null;
  if (profileName) {
    const profile = {};
    for (const field of AGENT_PROFILE_FIELDS) {
      if (serializable[field] !== undefined) profile[field] = serializable[field];
      delete serializable[field];
    }
    serializable.agentProfiles = { ...(serializable.agentProfiles || {}), [profileName]: profile };
  }
  fs.writeFileSync(tmp, JSON.stringify(serializable, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function attachRuntimeConfig(config, file) {
  Object.defineProperty(config, '__configFile', { value: file, writable: true, configurable: true, enumerable: false });
  return config;
}

function requireValue(opts, key) {
  if (!opts[key] || opts[key] === true) throw new Error(`missing --${key}`);
  return String(opts[key]);
}

async function api(config, method, endpoint, body, token = undefined) {
  const server = safeServerUrl(config.serverUrl || DEFAULT_SERVER);
  const headers = { 'content-type': 'application/json', 'user-agent': `supercollab-mcp/${VERSION}` };
  const auth = token === null ? null : (token || config.accountKey || config.agentSessionToken);
  if (auth) headers.authorization = `Bearer ${auth}`;
  const res = await fetch(server + endpoint, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { text }; }
  }
  if (!res.ok) {
    const detail = data.detail ? JSON.stringify(data.detail) : text;
    throw new Error(`HTTP ${res.status} ${endpoint}: ${detail}`);
  }
  return data;
}

function safeServerUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch { throw new Error('invalid SuperCollab server URL'); }
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('SuperCollab requires HTTPS except for a loopback self-hosted relay');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('SuperCollab server URL cannot contain credentials, query parameters, or fragments');
  }
  return parsed.toString().replace(/\/$/, '');
}

async function supercollabAuthConfig(config) {
  const result = await api(config, 'GET', '/v1/auth/config', undefined, null);
  if (result.mode !== 'account_key') {
    throw new Error(`unsupported SuperCollab authentication mode: ${result.mode || 'unknown'}`);
  }
  return result;
}

function bindConfigToAccount(config, newUserId, newUsername = null) {
  const boundUserId = config.accountBindingUserId || config.userId || null;
  const boundUsername = config.accountBindingUsername || config.username || null;
  const hasAgentIdentity = Boolean(config.agentId || Object.keys(config.agentProfiles || {}).length);
  if (boundUserId && boundUserId !== newUserId) {
    throw new Error(`this config is cryptographically bound to ${boundUserId}; use a different --config file for account ${newUserId}`);
  }
  if (!boundUserId && hasAgentIdentity) {
    throw new Error('this config has agent keys but no verifiable account binding; preserve it and use a new --config file');
  }
  if (boundUsername && newUsername && boundUsername !== newUsername) {
    throw new Error(`this config is bound to ${boundUsername}; use a different --config file for ${newUsername}`);
  }
  config.accountBindingUserId = newUserId;
  if (newUsername) config.accountBindingUsername = newUsername;
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withAuthFileLock(file, callback) {
  ensureConfigDir(file);
  const lockFile = `${file}.account.lock`;
  const owner = `${process.pid}:${Date.now()}:${crypto.randomBytes(12).toString('hex')}`;
  const deadline = Date.now() + 15000;
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(fd, `${owner}\n`, 'utf8');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const observed = fs.readFileSync(lockFile, 'utf8');
        const age = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (age > 45000 && fs.readFileSync(lockFile, 'utf8') === observed) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch (lockErr) {
        if (lockErr.code === 'ENOENT') continue;
        throw lockErr;
      }
      if (Date.now() >= deadline) throw new Error('timed out waiting for another SuperCollab account update');
      await waitMs(100);
    }
  }
  try {
    return await callback();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try {
      if (fs.readFileSync(lockFile, 'utf8').trim() === owner) fs.unlinkSync(lockFile);
    } catch {}
  }
}

function generateAccountKey() {
  return `scak_${crypto.randomBytes(32).toString('base64url')}`;
}

function normalizeAccountUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,64}$/.test(username)) {
    throw new Error('username must be 3-64 lowercase letters, numbers, or underscores');
  }
  return username;
}

function ensureAccountKey(config) {
  if (!ACCOUNT_KEY_PATTERN.test(String(config.accountKey || ''))) {
    throw new Error('no local account key; ask the user for a username, then call the supercollab_setup MCP tool');
  }
  return config.accountKey;
}

async function apiAsUser(config, method, endpoint, body) {
  return api(config, method, endpoint, body, ensureAccountKey(config));
}

function syncSavedConfig(target, source) {
  for (const field of ['serverUrl', ...ACCOUNT_FIELDS, ...AGENT_PROFILE_FIELDS, 'agentProfiles', 'roomKeys', 'activations', 'pendingAccountSetup', 'pendingKeyRotation']) {
    if (source[field] === undefined) delete target[field];
    else target[field] = source[field];
  }
}

async function doAccountSetup(config, file, opts = {}) {
  if (config.__profileName) throw new Error('create an account from the base config without --profile');
  config.serverUrl = opts.server || config.serverUrl || DEFAULT_SERVER;
  const requestedUsername = normalizeAccountUsername(requireValue(opts, 'username'));
  const label = String(opts.label || 'SuperCollab agent').trim().slice(0, 120) || 'SuperCollab agent';
  const serverAuth = await supercollabAuthConfig(config);
  if (!serverAuth.signup_enabled && !config.accountKey) {
    throw new Error('this SuperCollab relay has disabled new account creation');
  }

  return withAuthFileLock(file, async () => {
    const latest = attachRuntimeConfig(loadConfig(file), file);
    latest.serverUrl = config.serverUrl;
    if (latest.username && latest.username !== requestedUsername) {
      throw new Error(`this config is already bound to ${latest.username}; use a different --config file for ${requestedUsername}`);
    }

    let created = false;
    if (!latest.userId) {
      if (!latest.accountKey) {
        if (latest.accountBindingUserId || latest.agentId || Object.keys(latest.agentProfiles || {}).length) {
          throw new Error('this config contains an identity without an account key; preserve it and use a new --config file');
        }
        latest.accountKey = generateAccountKey();
      }
      ensureAccountKey(latest);
      latest.pendingAccountSetup = { username: requestedUsername, startedAt: nowIso() };
      saveConfig(latest, file);
      const registered = await api(latest, 'POST', '/v1/auth/register', {
        username: requestedUsername,
        account_key: latest.accountKey,
      }, null);
      if (!registered.user_id || !registered.username) {
        throw new Error('SuperCollab returned an invalid account-creation response');
      }
      bindConfigToAccount(latest, String(registered.user_id), String(registered.username));
      latest.userId = String(registered.user_id);
      latest.username = String(registered.username);
      created = Boolean(registered.created);
      delete latest.pendingAccountSetup;
      saveConfig(latest, file);
    } else {
      ensureAccountKey(latest);
      const actor = (await api(latest, 'GET', '/v1/me', undefined, latest.accountKey)).actor || {};
      if (actor.type !== 'user' || String(actor.user_id) !== String(latest.userId)) {
        throw new Error('the saved account key does not match this config binding');
      }
      bindConfigToAccount(latest, String(actor.user_id), String(actor.username));
      latest.username = String(actor.username);
    }

    let agent = null;
    if (!latest.agentId || !latest.agentPrivateKeyPem) {
      agent = await registerAgent(latest, label);
      saveConfig(latest, file);
    }
    syncSavedConfig(config, latest);
    return {
      ok: true,
      created,
      authentication: 'local_account_key',
      username: latest.username,
      user_id: latest.userId,
      agent_id: agent?.agent_id || latest.agentId,
      agent_fingerprint: agent?.fingerprint || latest.agentFingerprint,
      account_key_created_locally: true,
      account_key_returned: false,
      config_permissions: process.platform === 'win32' ? 'platform-managed' : '600',
      config: file,
    };
  });
}

async function accountStatus(config, file, opts = {}) {
  const server = opts.local ? null : await supercollabAuthConfig(config);
  let actor = null;
  let error = null;
  if (config.accountKey && !opts.local) {
    try {
      actor = (await api(config, 'GET', '/v1/me', undefined, ensureAccountKey(config))).actor || null;
    } catch (err) {
      error = err.message || String(err);
    }
  }
  return {
    account_key_present: Boolean(config.accountKey),
    usable: Boolean(actor) || Boolean(opts.local && config.accountKey),
    authentication: config.accountKey ? 'local_account_key' : null,
    user_id: config.userId || null,
    account_binding_user_id: config.accountBindingUserId || config.userId || null,
    account_binding_username: config.accountBindingUsername || config.username || null,
    username: config.username || null,
    agent_id: config.agentId || null,
    agent_fingerprint: config.agentFingerprint || null,
    pending_setup: Boolean(config.pendingAccountSetup),
    pending_key_rotation: Boolean(config.pendingKeyRotation),
    actor,
    error,
    server,
    config: file,
  };
}

async function rotateAccountKey(config, file) {
  if (config.__profileName) throw new Error('rotate the account key from the base config without --profile');
  return withAuthFileLock(file, async () => {
    const latest = attachRuntimeConfig(loadConfig(file), file);
    const oldAccountKey = latest.pendingKeyRotation?.oldAccountKey || ensureAccountKey(latest);
    const newAccountKey = latest.pendingKeyRotation?.newAccountKey || generateAccountKey();
    if (!ACCOUNT_KEY_PATTERN.test(oldAccountKey) || !ACCOUNT_KEY_PATTERN.test(newAccountKey)) {
      throw new Error('invalid pending account-key rotation state');
    }
    latest.pendingKeyRotation = { oldAccountKey, newAccountKey, startedAt: nowIso() };
    saveConfig(latest, file);

    let alreadyRotated = false;
    try {
      const me = await api(latest, 'GET', '/v1/me', undefined, newAccountKey);
      alreadyRotated = String(me.actor?.user_id || '') === String(latest.userId || '');
    } catch {}
    if (!alreadyRotated) {
      await api(latest, 'POST', '/v1/auth/rotate', { new_account_key: newAccountKey }, oldAccountKey);
    }
    latest.accountKey = newAccountKey;
    delete latest.pendingKeyRotation;
    saveConfig(latest, file);
    syncSavedConfig(config, latest);
    return {
      ok: true,
      rotated: !alreadyRotated,
      recovered_pending_rotation: alreadyRotated,
      account_key_returned: false,
      agent_identities_preserved: true,
      config: file,
    };
  });
}

function generateAgentKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const raw = publicKey.export({ type: 'spki', format: 'der' });
  const digest = crypto.createHash('sha256').update(raw).digest().subarray(0, 10);
  const fingerprint = 'ed25519:' + digest.toString('base64url').toLowerCase();
  return { publicKeyPem, privateKeyPem, fingerprint };
}

function signRequest(privateKeyPem, method, endpoint, bodyString, timestamp, nonce) {
  const bodyHash = crypto.createHash('sha256').update(bodyString).digest('hex');
  const signing = Buffer.from(`${method.toUpperCase()}\n${endpoint}\n${bodyHash}\n${timestamp}\n${nonce}`);
  const sig = crypto.sign(null, signing, crypto.createPrivateKey(privateKeyPem)).toString('base64url');
  return sig + '='.repeat((4 - (sig.length % 4)) % 4);
}

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function fromB64url(value) {
  return Buffer.from(String(value), 'base64url');
}

function sha256Tag(data) {
  return `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;
}

function newRoomKey() {
  return `sck_${crypto.randomBytes(32).toString('base64url')}`;
}

function roomKeyBytes(roomKey) {
  const raw = String(roomKey || '').startsWith('sck_') ? String(roomKey).slice(4) : String(roomKey || '');
  const key = fromB64url(raw);
  if (key.length !== 32) throw new Error('invalid room key');
  return key;
}

function normalizeRoomId(value) {
  const roomId = String(value || '').trim();
  if (!ROOM_ID_PATTERN.test(roomId)) throw new Error('invalid SuperCollab room ID');
  return roomId;
}

function normalizeInviteToken(value) {
  const token = String(value || '').trim();
  if (!INVITE_TOKEN_PATTERN.test(token)) throw new Error('invalid SuperCollab invite token');
  return token;
}

function ensureRoomKey(config, roomId) {
  roomId = normalizeRoomId(roomId);
  const key = config.roomKeys?.[roomId];
  if (!key) throw new Error(`missing local room key for ${roomId}; join with a complete private invite on this device`);
  return key;
}

function storeRoomKey(config, roomId, key) {
  roomId = normalizeRoomId(roomId);
  roomKeyBytes(key);
  config.roomKeys = config.roomKeys || {};
  config.roomKeys[roomId] = key.startsWith('sck_') ? key : `sck_${key}`;
}

function encryptForRoom(config, roomId, plaintext) {
  const key = roomKeyBytes(ensureRoomKey(config, roomId));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const raw = Buffer.from(JSON.stringify(plaintext), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = {
    v: 1,
    alg: 'A256GCM',
    iv: b64url(iv),
    tag: b64url(tag),
    ciphertext: b64url(ciphertext),
  };
  const encoded = JSON.stringify(envelope);
  return { encoded, hash: sha256Tag(encoded) };
}

function decryptForRoom(config, roomId, encoded) {
  const key = roomKeyBytes(ensureRoomKey(config, roomId));
  const envelope = JSON.parse(encoded);
  const fields = envelope && typeof envelope === 'object' && !Array.isArray(envelope) ? Object.keys(envelope).sort() : [];
  if (envelope?.alg !== 'A256GCM' || envelope?.v !== 1 || fields.join(',') !== 'alg,ciphertext,iv,tag,v') {
    throw new Error('unsupported encrypted message envelope');
  }
  const iv = fromB64url(envelope.iv);
  const tag = fromB64url(envelope.tag);
  const ciphertext = fromB64url(envelope.ciphertext);
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error('invalid encrypted message envelope');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const raw = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(raw.toString('utf8'));
}

function parsePrivateInvite(value) {
  const raw = String(value || '').trim();
  const [token, key] = raw.split('.sck_', 2);
  if (key) {
    const roomKey = `sck_${key}`;
    roomKeyBytes(roomKey);
    return { token: normalizeInviteToken(token), roomKey };
  }
  const hashIdx = raw.indexOf('#key=');
  if (hashIdx >= 0) {
    const roomKey = raw.slice(hashIdx + 5);
    roomKeyBytes(roomKey);
    return { token: normalizeInviteToken(raw.slice(0, hashIdx)), roomKey };
  }
  return { token: normalizeInviteToken(raw), roomKey: null };
}

function makePrivateInvite(inviteToken, roomKey) {
  roomKeyBytes(roomKey);
  return `${normalizeInviteToken(inviteToken)}.${roomKey}`;
}

async function ensureAgentSession(config) {
  const now = Math.floor(Date.now() / 1000);
  if (config.agentSessionToken && config.agentSessionExpiresAt && config.agentSessionExpiresAt - SESSION_TTL_SKEW > now) {
    return config.agentSessionToken;
  }
  if (!config.agentId || !config.agentPrivateKeyPem) throw new Error('no local agent identity; call supercollab_setup or reconnect with an initialized local config');
  const endpoint = '/v1/agent-sessions';
  const bodyString = JSON.stringify({ agent_id: config.agentId });
  const timestamp = String(now);
  const nonce = crypto.randomBytes(18).toString('base64url');
  const signature = signRequest(config.agentPrivateKeyPem, 'POST', endpoint, bodyString, timestamp, nonce);
  const server = safeServerUrl(config.serverUrl || DEFAULT_SERVER);
  const res = await fetch(server + endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': `supercollab-mcp/${VERSION}`,
      'x-supercollab-timestamp': timestamp,
      'x-supercollab-nonce': nonce,
      'x-supercollab-signature': signature,
    },
    body: bodyString,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`agent session failed: ${JSON.stringify(data)}`);
  config.agentSessionToken = data.token;
  config.agentSessionExpiresAt = data.expires_at;
  saveConfig(config, config.__configFile || DEFAULT_CONFIG);
  return data.token;
}

async function apiAsAgent(config, method, endpoint, body) {
  const token = await ensureAgentSession(config);
  return api(config, method, endpoint, body, token);
}

async function createAgentCredentials(config, label) {
  ensureAccountKey(config);
  const keys = generateAgentKeypair();
  const data = await apiAsUser(config, 'POST', '/v1/agents/register', { label, public_key_pem: keys.publicKeyPem });
  return {
    agentId: data.agent_id,
    agentLabel: label,
    agentFingerprint: data.fingerprint,
    agentPrivateKeyPem: keys.privateKeyPem,
  };
}

async function registerAgent(config, label, options = {}) {
  if (config.agentId && config.agentPrivateKeyPem && !options.replace) {
    const selected = config.__profileName ? `profile ${config.__profileName}` : 'this config';
    throw new Error(`${selected} already has agent ${config.agentId}; use profile create for a separate identity or pass --replace to rotate this identity`);
  }
  const credentials = await createAgentCredentials(config, label);
  Object.assign(config, credentials);
  delete config.agentSessionToken;
  delete config.agentSessionExpiresAt;
  return {
    agent_id: credentials.agentId,
    label: credentials.agentLabel,
    fingerprint: credentials.agentFingerprint,
  };
}

async function rotateAgent(config, file, label) {
  ensureAccountKey(config);
  if (!config.agentId || !config.agentPrivateKeyPem) throw new Error('no existing agent identity to replace');
  await apiAsUser(config, 'GET', '/v1/agents');
  const previous = Object.fromEntries(AGENT_PROFILE_FIELDS.map((field) => [field, config[field]]));
  const previousAgentId = config.agentId;
  const credentials = await createAgentCredentials(config, label);
  Object.assign(config, credentials);
  delete config.agentSessionToken;
  delete config.agentSessionExpiresAt;
  saveConfig(config, file);
  try {
    await apiAsUser(config, 'DELETE', `/v1/agents/${encodeURIComponent(previousAgentId)}`);
  } catch (error) {
    for (const field of AGENT_PROFILE_FIELDS) {
      if (previous[field] === undefined) delete config[field];
      else config[field] = previous[field];
    }
    saveConfig(config, file);
    await apiAsUser(config, 'DELETE', `/v1/agents/${encodeURIComponent(credentials.agentId)}`).catch(() => {});
    throw new Error(`agent rotation failed while revoking ${previousAgentId}; previous local identity restored: ${error.message}`);
  }
  return {
    agent_id: credentials.agentId,
    label: credentials.agentLabel,
    fingerprint: credentials.agentFingerprint,
    replaced_agent_id: previousAgentId,
  };
}

function publicProfile(profile, name) {
  return {
    name,
    agent_id: profile?.agentId || null,
    label: profile?.agentLabel || null,
    fingerprint: profile?.agentFingerprint || null,
    configured: Boolean(profile?.agentId && profile?.agentPrivateKeyPem),
  };
}

function listAgentProfiles(config) {
  const profiles = Object.entries(config.agentProfiles || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, profile]) => publicProfile(profile, name));
  if (!config.__profileName && (config.agentId || config.agentPrivateKeyPem)) {
    profiles.unshift(publicProfile(config, 'default'));
  }
  return { profiles, selected: config.__profileName || 'default' };
}

async function createAgentProfile(config, file, opts = {}) {
  if (config.__profileName) throw new Error('create profiles from the base config without --profile');
  ensureAccountKey(config);
  const name = normalizeProfileName(requireValue(opts, 'name'));
  if (name === 'default') throw new Error('default is reserved for the base agent identity');
  config.agentProfiles = config.agentProfiles || {};
  if (config.agentProfiles[name]) throw new Error(`agent profile ${name} already exists`);
  const label = String(opts.label || `${name} agent`).trim().slice(0, 120) || `${name} agent`;
  const credentials = await createAgentCredentials(config, label);
  config.agentProfiles[name] = credentials;
  saveConfig(config, file);
  return { ok: true, profile: publicProfile(credentials, name), config: file };
}

async function revokeAgentProfile(config, file, opts = {}) {
  if (config.__profileName) throw new Error('revoke profiles from the base config without --profile');
  ensureAccountKey(config);
  const name = normalizeProfileName(requireValue(opts, 'name'));
  if (name === 'default') throw new Error('revoke the base identity with agent revoke --agent ID');
  const profile = config.agentProfiles?.[name];
  if (!profile?.agentId) throw new Error(`agent profile ${name} does not exist or has no registered agent`);
  const result = await apiAsUser(config, 'DELETE', `/v1/agents/${encodeURIComponent(profile.agentId)}`);
  delete config.agentProfiles[name];
  saveConfig(config, file);
  return { ok: true, profile: name, agent_id: profile.agentId, server: result, local_profile_removed: true };
}

function commandExists(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    ok: result.status === 0,
    command,
    status: result.status,
    output: String(result.stdout || result.stderr || '').trim().split('\n')[0] || '',
  };
}

function installAdvice(profile, checks = {}) {
  const advice = [];
  const platform = profile.platform;
  if (!checks.node_supported?.ok) {
    advice.push('Install Node.js 20 LTS or newer, then restart the pinned @supercollab/mcp runtime from your agent.');
  }
  if (!checks.native_sqlite_vec?.ok) {
    if (profile.tools?.npm_ignore_scripts?.output === 'true') {
      advice.push('Your npm config has `ignore-scripts=true`, which prevents native SQLite from installing. Run `npm config set ignore-scripts false`, then reinstall or run `npm rebuild -g better-sqlite3 --ignore-scripts=false`.');
    }
    if (platform === 'darwin') {
      advice.push('Install Apple command line tools with `xcode-select --install`, then run `npm rebuild -g better-sqlite3`.');
    } else if (platform === 'linux') {
      advice.push('Install Python 3, make, and a C/C++ compiler, then run `npm rebuild -g better-sqlite3`.');
    } else if (platform === 'win32') {
      advice.push('Install Microsoft Visual Studio Build Tools with the C++ workload and Python, then run `npm rebuild -g better-sqlite3`.');
    } else {
      advice.push('Install a native build toolchain for your OS, then run `npm rebuild -g better-sqlite3`.');
    }
  }
  if (!checks.bge_model?.ok && checks.bge_model?.error) {
    advice.push('Check internet access to Hugging Face model downloads, then retry local semantic search so the MCP can warm the model cache.');
  }
  return advice;
}

function detectSystemProfile() {
  const cpus = os.cpus() || [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const tools = {
    npm: commandExists('npm', ['--version']),
    npm_ignore_scripts: commandExists('npm', ['config', 'get', 'ignore-scripts']),
  };
  if (process.platform === 'darwin') {
    tools.xcode_select = commandExists('xcode-select', ['-p']);
    tools.clang = commandExists('clang', ['--version']);
  } else if (process.platform === 'linux') {
    tools.python3 = commandExists('python3', ['--version']);
    tools.make = commandExists('make', ['--version']);
    tools.cc = commandExists('cc', ['--version']);
    tools.gpp = commandExists('g++', ['--version']);
  } else if (process.platform === 'win32') {
    tools.python = commandExists('python', ['--version']);
    tools.node_gyp = commandExists('node-gyp', ['--version']);
  }
  return {
    detected_at: nowIso(),
    cli_version: VERSION,
    platform: process.platform,
    arch: process.arch,
    os_type: os.type(),
    os_release: os.release(),
    hostname: os.hostname(),
    node: process.versions.node,
    node_modules_abi: process.versions.modules,
    node_supported: nodeMajor >= 20,
    cpu_model: cpus[0]?.model || null,
    cpu_count: cpus.length,
    tools,
  };
}

let nativeSqlitePromise = null;

async function loadNativeSqlite() {
  if (!nativeSqlitePromise) {
    nativeSqlitePromise = Promise.all([
      import('better-sqlite3'),
      import('sqlite-vec'),
    ]).then(([sqliteMod, sqliteVec]) => ({
      Database: sqliteMod.default || sqliteMod,
      sqliteVec,
    }));
  }
  return nativeSqlitePromise;
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function chatRoot(config, file, roomId) {
  const base = path.resolve(config.chatDir || path.join(path.dirname(file), 'chats'));
  return path.join(base, normalizeRoomId(roomId));
}

function chatDbPath(config, file, roomId) {
  return path.join(chatRoot(config, file, roomId), 'chat.sqlite');
}

function dbRun(db, sql, params = []) {
  return db.prepare(sql).run(...params);
}

function dbAll(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

function dbGet(db, sql, params = []) {
  return db.prepare(sql).get(...params) || null;
}

function setMeta(db, key, value) {
  dbRun(db, 'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, String(value)]);
}

function getMeta(db, key, fallback = '') {
  const row = dbGet(db, 'SELECT value FROM meta WHERE key=?', [key]);
  return row ? String(row.value) : fallback;
}

function tableColumns(db, table) {
  try {
    return dbAll(db, `PRAGMA table_info(${table})`).map((row) => String(row.name));
  } catch {
    return [];
  }
}

function verifySqliteVecLoaded(db) {
  const row = db.prepare('SELECT vec_version() AS version').get();
  if (!row?.version) throw new Error('sqlite-vec extension did not load');
}

function ensureMessageVectorTable(db) {
  const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='message_vectors'").get();
  if (tableInfo?.sql) {
    const match = String(tableInfo.sql).match(/float\[(\d+)\]/);
    const hasCosine = String(tableInfo.sql).includes('distance_metric=cosine');
    const dims = match?.[1] ? Number(match[1]) : null;
    if (dims === EMBEDDING_DIMS && hasCosine) return false;
    db.exec('DROP TABLE IF EXISTS message_vectors');
    db.exec('DELETE FROM message_embeddings WHERE profile = ' + JSON.stringify(EMBEDDING_PROFILE.id));
  }
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS message_vectors USING vec0(message_seq TEXT PRIMARY KEY, embedding float[${EMBEDDING_DIMS}] distance_metric=cosine)`);
  return true;
}

function initChatSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE,
      room_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      kind TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      user_id TEXT,
      agent_id TEXT,
      sender_label TEXT NOT NULL,
      body TEXT NOT NULL,
      metadata TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id, id);
    CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel, created_at);
  `);
  const embeddingColumns = tableColumns(db, 'message_embeddings');
  if (embeddingColumns.length > 0 && (!embeddingColumns.includes('seq') || !embeddingColumns.includes('profile') || embeddingColumns.includes('vector'))) {
    db.exec('DROP TABLE IF EXISTS message_embeddings');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_embeddings (
      message_id TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      pos INTEGER NOT NULL DEFAULT 0,
      dims INTEGER NOT NULL,
      model TEXT NOT NULL,
      profile TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(message_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_message_embeddings_profile ON message_embeddings(profile);
  `);
  ensureMessageVectorTable(db);
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(message_id UNINDEXED, channel UNINDEXED, sender_label, body, metadata, tokenize='porter')");
    setMeta(db, 'fts5', '1');
  } catch {
    setMeta(db, 'fts5', '0');
  }
  setMeta(db, 'embedding_profile', EMBEDDING_PROFILE.id);
}

let embeddingPipelinePromise = null;

async function getEmbeddingPipeline() {
  if (!embeddingPipelinePromise) {
    embeddingPipelinePromise = (async () => {
      const mod = await import('@huggingface/transformers');
      const { pipeline, env } = mod;
      if (process.env.SUPERCOLLAB_MODEL_CACHE && env) {
        fs.mkdirSync(process.env.SUPERCOLLAB_MODEL_CACHE, { recursive: true });
        env.cacheDir = process.env.SUPERCOLLAB_MODEL_CACHE;
      }
      return pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: EMBEDDING_DTYPE });
    })();
  }
  return embeddingPipelinePromise;
}

function formatQueryForEmbedding(query) {
  return `${EMBEDDING_PROFILE.query_prefix}${query}`;
}

function formatDocForEmbedding(text, title = '') {
  return title ? `${title}\n${text}` : text;
}

function chunkText(content, maxChars = EMBEDDING_CHUNK_CHARS, overlapChars = EMBEDDING_CHUNK_OVERLAP) {
  const text = String(content || '');
  if (text.length <= maxChars) return [{ text, pos: 0 }];
  const chunks = [];
  let charPos = 0;
  while (charPos < text.length) {
    let endPos = Math.min(charPos + maxChars, text.length);
    if (endPos < text.length) {
      const slice = text.slice(charPos, endPos);
      const searchStart = Math.floor(slice.length * 0.7);
      const searchSlice = slice.slice(searchStart);
      let breakOffset = -1;
      const paragraphBreak = searchSlice.lastIndexOf('\n\n');
      if (paragraphBreak >= 0) {
        breakOffset = searchStart + paragraphBreak + 2;
      } else {
        const sentenceEnd = Math.max(
          searchSlice.lastIndexOf('. '),
          searchSlice.lastIndexOf('.\n'),
          searchSlice.lastIndexOf('? '),
          searchSlice.lastIndexOf('?\n'),
          searchSlice.lastIndexOf('! '),
          searchSlice.lastIndexOf('!\n'),
        );
        if (sentenceEnd >= 0) {
          breakOffset = searchStart + sentenceEnd + 2;
        } else {
          const lineBreak = searchSlice.lastIndexOf('\n');
          if (lineBreak >= 0) {
            breakOffset = searchStart + lineBreak + 1;
          } else {
            const spaceBreak = searchSlice.lastIndexOf(' ');
            if (spaceBreak >= 0) breakOffset = searchStart + spaceBreak + 1;
          }
        }
      }
      if (breakOffset > 0) endPos = charPos + breakOffset;
    }
    if (endPos <= charPos) endPos = Math.min(charPos + maxChars, text.length);
    chunks.push({ text: text.slice(charPos, endPos), pos: charPos });
    if (endPos >= text.length) break;
    charPos = endPos - overlapChars;
    const lastChunkPos = chunks.at(-1).pos;
    if (charPos <= lastChunkPos) charPos = endPos;
  }
  return chunks;
}

async function embedText(text, { isQuery = false, title = '' } = {}) {
  const extractor = await getEmbeddingPipeline();
  const formatted = isQuery ? formatQueryForEmbedding(text) : formatDocForEmbedding(text, title);
  const output = await extractor(formatted.slice(0, 4000), {
    pooling: EMBEDDING_PROFILE.pooling,
    normalize: EMBEDDING_PROFILE.normalize,
  });
  const vector = Array.from(output.data).map(Number);
  if (vector.length !== EMBEDDING_DIMS) throw new Error(`unexpected embedding dims ${vector.length}`);
  return vector;
}

async function storeEmbeddings(db, local, metadata) {
  const messageId = local.message_id;
  if (!messageId) return { embedded: false, chunks: 0 };
  const oldRows = dbAll(db, 'SELECT seq FROM message_embeddings WHERE message_id=? AND profile<>?', [messageId, EMBEDDING_PROFILE.id]);
  for (const row of oldRows) dbRun(db, 'DELETE FROM message_vectors WHERE message_seq=?', [`${messageId}:${Number(row.seq || 0)}`]);
  dbRun(db, 'DELETE FROM message_embeddings WHERE message_id=? AND profile<>?', [messageId, EMBEDDING_PROFILE.id]);
  const existing = dbGet(
    db,
    `SELECT COUNT(*) AS count
     FROM message_embeddings e
     JOIN message_vectors v ON v.message_seq = e.message_id || ':' || e.seq
     WHERE e.message_id=? AND e.profile=?`,
    [messageId, EMBEDDING_PROFILE.id],
  );
  if (Number(existing?.count || 0) > 0) return { embedded: false, chunks: Number(existing.count) };

  const body = `${local.sender_label || ''}\n${local.body || ''}\n${metadata || ''}`;
  const title = local.sender_label || local.channel || 'SuperCollab message';
  const chunks = chunkText(body);
  const updatedAt = nowIso();
  for (let seq = 0; seq < chunks.length; seq++) {
    const chunk = chunks[seq];
    const vector = await embedText(chunk.text, { title });
    const messageSeq = `${messageId}:${seq}`;
    dbRun(db, 'INSERT OR REPLACE INTO message_vectors(message_seq, embedding) VALUES(?, ?)', [messageSeq, new Float32Array(vector)]);
    dbRun(
      db,
      `INSERT INTO message_embeddings(message_id,seq,pos,dims,model,profile,updated_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(message_id, seq) DO UPDATE SET
         pos=excluded.pos,
         dims=excluded.dims,
         model=excluded.model,
         profile=excluded.profile,
         updated_at=excluded.updated_at`,
      [messageId, seq, chunk.pos, EMBEDDING_DIMS, EMBEDDING_MODEL, EMBEDDING_PROFILE.id, updatedAt],
    );
  }
  setMeta(db, 'embedding_last_ok_at', updatedAt);
  return { embedded: true, chunks: chunks.length };
}

async function tryStoreEmbeddings(db, local, metadata) {
  try {
    return await storeEmbeddings(db, local, metadata);
  } catch (err) {
    setMeta(db, 'embedding_last_error', err.message || String(err));
    return { embedded: false, chunks: 0, error: err.message || String(err) };
  }
}

async function embedMissingMessages(db, limit = 500) {
  const rows = dbAll(
    db,
    `SELECT m.*
     FROM messages m
     LEFT JOIN message_embeddings e
       ON e.message_id=m.message_id AND e.profile=?
      LEFT JOIN message_vectors v
        ON v.message_seq = e.message_id || ':' || e.seq
     WHERE e.message_id IS NULL OR v.message_seq IS NULL
     ORDER BY m.id ASC
     LIMIT ?`,
    [EMBEDDING_PROFILE.id, Math.max(1, Math.min(Number(limit || 500), 2000))],
  );
  let embedded = 0;
  for (const row of rows) {
    const result = await tryStoreEmbeddings(db, row, row.metadata || '');
    if (result.embedded) embedded += result.chunks;
  }
  return { messages_checked: rows.length, chunks_embedded: embedded };
}

async function openChatDb(config, file, roomId) {
  const { Database, sqliteVec } = await loadNativeSqlite();
  const root = chatRoot(config, file, roomId);
  const dbPath = chatDbPath(config, file, roomId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  verifySqliteVecLoaded(db);
  initChatSchema(db);
  setMeta(db, 'room_id', roomId);
  return { db, root, dbPath, roomId };
}

function saveChatDb(cap) {
  cap.db.pragma('wal_checkpoint(PASSIVE)');
  try { fs.chmodSync(cap.dbPath, 0o600); } catch {}
}

function localPlainMessage(config, roomId, msg) {
  const metadata = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata || '{}') : (msg.metadata || {});
  const metadataFields = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? Object.keys(metadata).sort() : [];
  if (
    metadata.encrypted !== true
    || metadata.private !== true
    || metadata.alg !== 'A256GCM'
    || metadata.local_search !== true
    || metadataFields.join(',') !== 'alg,encrypted,local_search,private'
  ) {
    throw new Error('relay returned a non-encrypted or non-standard message row');
  }
  const plain = decryptForRoom(config, roomId, msg.body);
  if (!plain || typeof plain !== 'object' || Array.isArray(plain) || typeof plain.text !== 'string') {
    throw new Error('decrypted message payload is invalid');
  }
  return {
    ...msg,
    body: plain.text,
    metadata: JSON.stringify(plain.metadata || {}),
    channel: plain.channel || msg.channel || 'agents',
    kind: plain.kind || msg.kind || 'chat.message',
  };
}

async function insertLocalMessage(db, msg, config = null, roomId = msg.room_id || '') {
  roomId = normalizeRoomId(roomId);
  const local = config ? localPlainMessage(config, roomId, msg) : msg;
  const numericId = Number(local.id);
  if (!Number.isSafeInteger(numericId) || numericId < 1) throw new Error('relay returned an invalid message sequence');
  if (!/^msg_[A-Za-z0-9_-]{8,80}$/.test(String(local.message_id || ''))) throw new Error('relay returned an invalid message ID');
  const metadata = typeof local.metadata === 'string' ? local.metadata : JSON.stringify(local.metadata || {});
  dbRun(
    db,
    `INSERT OR IGNORE INTO messages(id,message_id,room_id,channel,kind,actor_type,actor_id,user_id,agent_id,sender_label,body,metadata,content_hash,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      numericId, local.message_id, roomId, local.channel || 'agents', local.kind || 'chat.message',
      local.actor_type || '', local.actor_id || '', local.user_id || '', local.agent_id || '',
      local.sender_label || '', local.body || '', metadata, local.content_hash || '', local.created_at || nowIso(),
    ],
  );
  if (getMeta(db, 'fts5', '0') === '1') {
    try {
      dbRun(db, 'INSERT OR IGNORE INTO messages_fts(rowid,message_id,channel,sender_label,body,metadata) VALUES(?,?,?,?,?,?)', [
        Number(local.id), local.message_id, local.channel || 'agents', local.sender_label || '', local.body || '', metadata,
      ]);
    } catch {}
  }
  await tryStoreEmbeddings(db, local, metadata);
}

async function syncRoom(config, file, roomId, limit = 500) {
  roomId = normalizeRoomId(roomId);
  const cap = await openChatDb(config, file, roomId);
  try {
    // Older clients advanced last_message_id on send, which could skip unseen
    // messages. Start a separate receive cursor at zero so upgrades backfill
    // those gaps; inserts and embeddings are already idempotent.
    const after = Number(getMeta(cap.db, 'last_synced_message_id', '0')) || 0;
    const data = await apiAsAgent(config, 'GET', `/v1/rooms/${roomId}/messages?after=${encodeURIComponent(after)}&limit=${encodeURIComponent(limit)}`);
    for (const msg of data.messages || []) await insertLocalMessage(cap.db, { ...msg, room_id: roomId }, config, roomId);
    const embedding = await embedMissingMessages(cap.db, 500);
    setMeta(cap.db, 'last_synced_message_id', String(data.next_after || after));
    setMeta(cap.db, 'last_sync_at', nowIso());
    saveChatDb(cap);
    return { room_id: roomId, pulled: (data.messages || []).length, last_message_id: Number(data.next_after || after), db: cap.dbPath, embedding };
  } finally {
    cap.db.close();
  }
}

async function doRoomCreate(config, file, opts) {
  const data = await apiAsAgent(config, 'POST', '/v1/rooms', {
    title: requireValue(opts, 'title'),
    goal: requireValue(opts, 'goal'),
    slug: opts.slug,
  });
  const roomId = normalizeRoomId(data.room_id || data.id);
  storeRoomKey(config, roomId, newRoomKey());
  saveConfig(config, file);
  return { ...data, encrypted: true, room_key_saved: true };
}

async function doRoomInvite(config, opts) {
  const roomId = normalizeRoomId(requireValue(opts, 'room'));
  const roomKey = ensureRoomKey(config, roomId);
  const data = await apiAsAgent(config, 'POST', `/v1/rooms/${roomId}/invites`, {
    role: opts.role || 'member',
    ttl_seconds: opts.ttl || opts.ttl_seconds || 86400,
  });
  const privateInvite = makePrivateInvite(data.invite_token, roomKey);
  const { invite_token: _membershipToken, ...publicData } = data;
  return { ...publicData, private_invite: privateInvite };
}

async function doRoomJoin(config, file, opts) {
  const parsed = parsePrivateInvite(requireValue(opts, 'invite'));
  const data = await apiAsAgent(config, 'POST', '/v1/invites/accept', {
    token: parsed.token,
    fingerprint: config.agentFingerprint,
  });
  const roomId = normalizeRoomId(data.room_id);
  if (parsed.roomKey) {
    storeRoomKey(config, roomId, parsed.roomKey);
    saveConfig(config, file);
  }
  return { ...data, room_id: roomId, room_key_saved: Boolean(parsed.roomKey), encrypted: Boolean(parsed.roomKey) };
}

async function doChatSend(config, file, opts) {
  const roomId = normalizeRoomId(requireValue(opts, 'room'));
  const text = requireValue(opts, 'text');
  const messageBytes = Buffer.byteLength(text, 'utf8');
  if (messageBytes > MAX_MESSAGE_BYTES) {
    throw new Error(`message is ${messageBytes} bytes; the maximum is ${MAX_MESSAGE_BYTES} bytes`);
  }
  const channel = String(opts.channel || 'agents');
  const kind = String(opts.kind || 'chat.message');
  const encrypted = encryptForRoom(config, roomId, {
    text,
    channel,
    kind,
    metadata: { client: 'supercollab-mcp', private: true },
    sent_at: nowIso(),
  });
  if (Buffer.byteLength(encrypted.encoded, 'utf8') > MAX_ENCRYPTED_ENVELOPE_BYTES) {
    throw new Error('message expands beyond the encrypted envelope limit; shorten it before sending');
  }
  const data = await apiAsAgent(config, 'POST', `/v1/rooms/${roomId}/messages`, {
    body: encrypted.encoded,
    channel,
    kind,
    metadata: { encrypted: true, private: true, alg: 'A256GCM', local_search: true },
  });
  const cap = await openChatDb(config, file, roomId);
  try {
    await insertLocalMessage(cap.db, { ...data.message, room_id: roomId }, config, roomId);
    // A successful send says nothing about which earlier messages were read.
    saveChatDb(cap);
  } finally {
    cap.db.close();
  }
  return data;
}

async function doChatRead(config, file, opts) {
  const roomId = normalizeRoomId(requireValue(opts, 'room'));
  const sync = await syncRoom(config, file, roomId, Number(opts.limit || 200));
  const cap = await openChatDb(config, file, roomId);
  try {
    const rows = dbAll(cap.db, 'SELECT * FROM messages ORDER BY id DESC LIMIT ?', [Math.max(1, Math.min(Number(opts.limit || 50), 500))]).reverse();
    return { room_id: roomId, sync, messages: rows };
  } finally {
    cap.db.close();
  }
}

function ftsQuery(value) {
  const terms = String(value || '').match(/[A-Za-z0-9_./-]+/g) || [];
  return terms.slice(0, 12).join(' OR ');
}

async function doChatSearch(config, file, opts) {
  const roomId = normalizeRoomId(requireValue(opts, 'room'));
  const query = requireValue(opts, 'query');
  const mode = String(opts.mode || 'hybrid').toLowerCase();
  if (!['hybrid', 'keyword', 'vector'].includes(mode)) throw new Error('search --mode must be hybrid, keyword, or vector');
  await syncRoom(config, file, roomId, 500);
  const cap = await openChatDb(config, file, roomId);
  try {
    const embedding = await embedMissingMessages(cap.db, 500);
    const maxResults = Math.max(1, Math.min(Number(opts.limit || 20), 100));
    let keywordRows = [];
    if (mode !== 'vector' && getMeta(cap.db, 'fts5', '0') === '1') {
      const q = ftsQuery(query);
      if (q) {
        try {
          keywordRows = dbAll(
            cap.db,
            `SELECT m.*, bm25(messages_fts) AS score
             FROM messages_fts JOIN messages m ON m.id=messages_fts.rowid
             WHERE messages_fts MATCH ?
             ORDER BY score LIMIT ?`,
            [q, maxResults],
          );
        } catch {
          keywordRows = [];
        }
      }
    }
    if (mode !== 'vector' && !keywordRows.length) {
      keywordRows = dbAll(cap.db, 'SELECT *, 0 AS score FROM messages WHERE body LIKE ? OR metadata LIKE ? ORDER BY id DESC LIMIT ?', [
        `%${query}%`, `%${query}%`, maxResults,
      ]).map((row) => ({ ...row, keyword_fallback: true }));
    }
    let vectorRows = [];
    let vectorError = null;
    if (mode !== 'keyword') try {
      const qvec = await embedText(query, { isQuery: true });
      const k = Math.max(maxResults * 4, 50);
      const vecMatches = dbAll(
        cap.db,
        'SELECT message_seq, distance FROM message_vectors WHERE embedding MATCH ? AND k = ?',
        [new Float32Array(qvec), k],
      );
      const bestByMessage = new Map();
      if (vecMatches.length) {
        const messageSeqs = vecMatches.map((row) => String(row.message_seq));
        const distanceBySeq = new Map(vecMatches.map((row) => [String(row.message_seq), Number(row.distance)]));
        const placeholders = messageSeqs.map(() => '?').join(',');
        for (const row of dbAll(
          cap.db,
          `SELECT m.*, e.seq, e.pos, e.message_id || ':' || e.seq AS message_seq
           FROM message_embeddings e
           JOIN messages m ON m.message_id=e.message_id
           WHERE e.profile=? AND e.message_id || ':' || e.seq IN (${placeholders})`,
          [EMBEDDING_PROFILE.id, ...messageSeqs],
        )) {
          const distance = distanceBySeq.get(String(row.message_seq)) ?? 1;
          const score = 1 - distance;
          if (score <= 0) continue;
          const { message_seq, ...clean } = row;
          const prior = bestByMessage.get(row.message_id);
          if (!prior || score > prior.vector_score) {
            bestByMessage.set(row.message_id, { ...clean, vector_score: score, chunk_seq: Number(row.seq || 0), chunk_pos: Number(row.pos || 0) });
          }
        }
      }
      vectorRows = Array.from(bestByMessage.values())
        .sort((a, b) => b.vector_score - a.vector_score)
        .slice(0, mode === 'vector' ? maxResults : Math.max(maxResults, 50));
    } catch (err) {
      vectorError = err.message || String(err);
      setMeta(cap.db, 'embedding_last_error', vectorError);
    }
    const keywordRank = new Map(keywordRows.map((row, idx) => [row.message_id, idx + 1]));
    const vectorRank = new Map(vectorRows.map((row, idx) => [row.message_id, idx + 1]));
    const byMessage = new Map();
    for (const row of [...keywordRows, ...vectorRows]) {
      const existing = byMessage.get(row.message_id) || {};
      byMessage.set(row.message_id, { ...existing, ...row });
    }
    const rrfK = 60;
    const hybridRows = Array.from(byMessage.values()).map((row) => {
      const kr = keywordRank.get(row.message_id);
      const vr = vectorRank.get(row.message_id);
      const keywordScore = kr ? 1 / (rrfK + kr) : 0;
      const vectorScore = vr ? 1 / (rrfK + vr) : 0;
      return {
        ...row,
        search_sources: [kr ? (row.keyword_fallback ? 'like' : 'fts5_bm25') : null, vr ? 'bge_vector_cosine' : null].filter(Boolean),
        keyword_rank: kr || null,
        vector_rank: vr || null,
        hybrid_score: keywordScore + vectorScore,
      };
    }).sort((a, b) => b.hybrid_score - a.hybrid_score).slice(0, maxResults);
    const results = mode === 'keyword'
      ? keywordRows.slice(0, maxResults).map((row, idx) => ({ ...row, search_sources: [row.keyword_fallback ? 'like' : 'fts5_bm25'], keyword_rank: idx + 1 }))
      : mode === 'vector'
        ? vectorRows.slice(0, maxResults).map((row, idx) => ({ ...row, search_sources: ['bge_vector_cosine'], vector_rank: idx + 1 }))
        : hybridRows;
    return {
      room_id: roomId,
      query,
      search: {
        local_only: true,
        mode,
        methods: ['fts5_bm25', 'bge_vector_cosine', 'rrf_hybrid'],
        fts: getMeta(cap.db, 'fts5', '0') === '1',
        vector: EMBEDDING_PROFILE.id,
        embedding_profile: EMBEDDING_PROFILE,
        embedding,
        vector_error: vectorError,
      },
      results,
    };
  } finally {
    cap.db.close();
  }
}

function normalizeCwd(value) {
  return path.resolve(
    value
      || process.env.SUPERCOLLAB_WORKDIR
      || process.env.CLAUDE_PROJECT_DIR
      || process.cwd(),
  );
}

function activationFor(config, cwd = normalizeCwd()) {
  const activations = config.activations || {};
  let best = null;
  for (const [root, activation] of Object.entries(activations)) {
    if (!activation) continue;
    const abs = path.resolve(root);
    const prefix = abs.endsWith(path.sep) ? abs : abs + path.sep;
    if (cwd === abs || cwd.startsWith(prefix)) {
      if (!best || abs.length > best.cwd.length) best = { cwd: abs, ...activation };
    }
  }
  return best?.enabled ? best : null;
}

function normalizeSharingMode(value) {
  const mode = String(value || 'manual').trim().toLowerCase();
  if (!['manual', 'progress'].includes(mode)) throw new Error('sharing mode must be manual or progress');
  return mode;
}

function agentInstructions(active) {
  if (!active) {
    return 'SuperCollab is OFF for this local workspace. Do not send, read, or search room messages. Installation alone never shares files, prompts, responses, or chat history. Ask before activating a room.';
  }
  const mode = normalizeSharingMode(active.sharingMode);
  if (mode === 'manual') {
    return `SuperCollab is ACTIVE in manual sharing mode for room ${active.roomId}. You may read and locally search that room. Never send a message unless the user explicitly asks you to share that specific message; set confirmed_by_user=true only after that request. Never upload source files, raw prompts, raw responses, ambient chat history, or secrets.`;
  }
  return `SuperCollab is ACTIVE in progress sharing mode for room ${active.roomId}. You may send concise, newly authored progress, decision, and blocker summaries. Never upload source files, raw prompts, raw responses, ambient chat history, or secrets. Room transcripts and embeddings remain local except for encrypted message envelopes explicitly sent through chat_send.`;
}

function activate(config, file, opts) {
  const roomId = normalizeRoomId(requireValue(opts, 'room'));
  ensureRoomKey(config, roomId);
  const cwd = normalizeCwd(opts.cwd);
  const sharingMode = normalizeSharingMode(opts.sharing || opts.sharing_mode);
  config.activations = config.activations || {};
  config.activations[cwd] = { roomId, enabled: true, sharingMode, activatedAt: nowIso() };
  saveConfig(config, file);
  return { ok: true, cwd, room_id: roomId, sharing_mode: sharingMode, instructions: agentInstructions({ roomId, cwd, sharingMode }) };
}

function deactivate(config, file, opts) {
  const cwd = normalizeCwd(opts.cwd);
  config.activations = config.activations || {};
  config.activations[cwd] = {
    ...config.activations[cwd],
    enabled: false,
    deactivatedAt: nowIso(),
  };
  saveConfig(config, file);
  return { ok: true, cwd, active: false, instructions: agentInstructions(null) };
}

async function activeStatus(config, file, opts = {}) {
  const cwd = normalizeCwd(opts.cwd);
  const active = activationFor(config, cwd);
  return {
    active: Boolean(active),
    cwd,
    room_id: active?.roomId || null,
    sharing_mode: active ? normalizeSharingMode(active.sharingMode) : null,
    activation_root: active?.cwd || null,
    config: file,
    configured: isConfigured(config),
    username: config.username || null,
    agent_id: config.agentId || null,
    agent_fingerprint: config.agentFingerprint || null,
    embedding_profile: EMBEDDING_PROFILE,
    privacy: {
      project_files_read: false,
      ambient_chat_captured: false,
      upload_trigger: 'explicit_chat_send_only',
      relay_message_format: 'A256GCM_ciphertext',
      transcript_and_embeddings: 'local_only',
    },
    instructions: isConfigured(config)
      ? agentInstructions(active)
      : 'SuperCollab is connected but not initialized. Ask the user for a username, then call supercollab_setup. The account key is generated and saved locally and must never be requested or printed.',
  };
}

function requireActiveRoom(config, args = {}) {
  const active = activationFor(config);
  if (!active) throw new Error(agentInstructions(null));
  const roomId = normalizeRoomId(active.roomId);
  if (args.room_id && normalizeRoomId(args.room_id) !== roomId) {
    throw new Error(`SuperCollab is active for ${active.roomId}, not ${args.room_id}. Switch rooms with workspace_activate.`);
  }
  return roomId;
}

function requireMcpSendApproval(config, args = {}) {
  const active = activationFor(config);
  if (!active) throw new Error(agentInstructions(null));
  const mode = normalizeSharingMode(active.sharingMode);
  if (mode === 'manual' && args.confirmed_by_user !== true) {
    throw new Error('manual sharing mode requires an explicit user request; do not retry until the user asks to send this message');
  }
  return normalizeRoomId(active.roomId);
}

function toolSchema(name, description, properties = {}, required = []) {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

function mcpTools() {
  const s = { type: 'string' };
  const confirmation = { type: 'boolean' };
  return [
    toolSchema('supercollab_setup', 'Create a key-backed SuperCollab account and local agent identity without exposing the account key.', { username: s, agent_label: s }, ['username']),
    toolSchema('supercollab_status', 'Check whether SuperCollab is active for this local workspace.'),
    toolSchema('account_rotate_key', 'Rotate the local account key without returning either key.', { confirmed_by_user: confirmation }, ['confirmed_by_user']),
    toolSchema('agent_list', 'List independently revocable agents registered to this account.'),
    toolSchema('agent_profile_list', 'List local independently revocable host profiles and the selected profile.'),
    toolSchema('agent_profile_create', 'Create and save a separate local agent identity for another host.', { profile_name: s, agent_label: s, confirmed_by_user: confirmation }, ['profile_name', 'confirmed_by_user']),
    toolSchema('agent_profile_revoke', 'Revoke a saved host profile and remove its local private key.', { profile_name: s, confirmed_by_user: confirmation }, ['profile_name', 'confirmed_by_user']),
    toolSchema('agent_rotate', 'Replace this local agent identity and revoke its previous identity.', { agent_label: s, confirmed_by_user: confirmation }, ['confirmed_by_user']),
    toolSchema('agent_revoke', 'Revoke another registered agent and all of its sessions.', { agent_id: s, confirmed_by_user: confirmation }, ['agent_id', 'confirmed_by_user']),
    toolSchema('session_list', 'List recent agent sessions without returning session tokens.'),
    toolSchema('session_revoke', 'Revoke one agent session by its displayed session ID.', { session_id: s, confirmed_by_user: confirmation }, ['session_id', 'confirmed_by_user']),
    toolSchema('workspace_activate', 'Activate one private room for this local workspace. Manual sharing is the safe default.', { room_id: s, sharing_mode: s }, ['room_id']),
    toolSchema('workspace_deactivate', 'Turn SuperCollab off for this local workspace.'),
    toolSchema('room_list', 'List rooms visible to this agent.'),
    toolSchema('room_create', 'Create a new agent chat room.', { title: s, goal: s, slug: s }, ['title', 'goal']),
    toolSchema('room_invite', 'Create an invite token for a room.', { room_id: s, role: s, ttl_seconds: { type: 'integer' } }, ['room_id']),
    toolSchema('room_invite_list', 'List invite metadata for a room without returning invite secrets.', { room_id: s }, ['room_id']),
    toolSchema('room_join', 'Accept a room invite token.', { invite_token: s, fingerprint: s }, ['invite_token']),
    toolSchema('chat_send', 'Send an explicitly approved message to the active room. In manual mode confirmed_by_user must be true.', { message: s, channel: s, kind: s, confirmed_by_user: { type: 'boolean' } }, ['message']),
    toolSchema('chat_read', 'Sync and read recent messages from the active room.', { limit: { type: 'integer' } }),
    toolSchema('chat_search', 'Sync and search the active room transcript with local keyword, BGE vector, or hybrid retrieval.', { query: s, mode: s, limit: { type: 'integer' } }, ['query']),
    toolSchema('chat_sync', 'Sync the active room transcript into local SQLite.'),
    toolSchema('local_search_status', 'Report the local BGE embedding profile and cache state.'),
    toolSchema('local_search_warmup', 'Download and initialize the local BGE model without sending room data.'),
  ];
}

function requireManagementConfirmation(args, action) {
  if (args.confirmed_by_user !== true) {
    throw new Error(`${action} requires a specific user request and confirmed_by_user=true; do not retry until the user confirms this action`);
  }
}

async function revokeAgentFromMcp(config, file, args) {
  requireManagementConfirmation(args, 'agent revocation');
  const agentId = String(args.agent_id || '').trim();
  if (!/^ag_[A-Za-z0-9]{8,32}$/.test(agentId)) throw new Error('invalid agent ID');
  if (agentId === config.agentId) {
    throw new Error('cannot revoke the currently connected identity directly; use agent_rotate so a replacement is saved before the old identity is revoked');
  }
  const result = await apiAsUser(config, 'DELETE', `/v1/agents/${encodeURIComponent(agentId)}`);
  const removedProfiles = [];
  for (const [name, profile] of Object.entries(config.agentProfiles || {})) {
    if (profile?.agentId !== agentId) continue;
    delete config.agentProfiles[name];
    removedProfiles.push(name);
  }
  if (removedProfiles.length) saveConfig(config, file);
  return { ...result, local_profiles_removed: removedProfiles };
}

async function callTool(config, name, args) {
  const file = config.__configFile || DEFAULT_CONFIG;
  if (name === 'supercollab_setup') return doAccountSetup(config, file, { username: args.username, label: args.agent_label });
  if (name === 'supercollab_status') return activeStatus(config, file, {});
  if (name === 'account_rotate_key') {
    requireManagementConfirmation(args, 'account-key rotation');
    return rotateAccountKey(config, file);
  }
  if (name === 'agent_list') return apiAsUser(config, 'GET', '/v1/agents');
  if (name === 'agent_profile_list') return listAgentProfiles(config);
  if (name === 'agent_profile_create') {
    requireManagementConfirmation(args, 'agent-profile creation');
    return createAgentProfile(config, file, { name: args.profile_name, label: args.agent_label });
  }
  if (name === 'agent_profile_revoke') {
    requireManagementConfirmation(args, 'agent-profile revocation');
    return revokeAgentProfile(config, file, { name: args.profile_name });
  }
  if (name === 'agent_rotate') {
    requireManagementConfirmation(args, 'local agent rotation');
    return rotateAgent(config, file, String(args.agent_label || config.agentLabel || 'SuperCollab agent'));
  }
  if (name === 'agent_revoke') return revokeAgentFromMcp(config, file, args);
  if (name === 'session_list') return apiAsUser(config, 'GET', '/v1/agent-sessions');
  if (name === 'session_revoke') {
    requireManagementConfirmation(args, 'session revocation');
    const sessionId = String(args.session_id || '').trim();
    if (!/^[0-9a-f]{12,64}$/.test(sessionId)) throw new Error('invalid session ID');
    const result = await apiAsUser(config, 'DELETE', `/v1/agent-sessions/${encodeURIComponent(sessionId)}`);
    delete config.agentSessionToken;
    delete config.agentSessionExpiresAt;
    saveConfig(config, file);
    return result;
  }
  if (name === 'workspace_activate') return activate(config, file, { room: args.room_id, sharing_mode: args.sharing_mode || 'manual' });
  if (name === 'workspace_deactivate') return deactivate(config, file, {});
  if (name === 'room_list') return apiAsAgent(config, 'GET', '/v1/rooms');
  if (name === 'room_create') return doRoomCreate(config, file, { title: args.title, goal: args.goal, slug: args.slug });
  if (name === 'room_invite') return doRoomInvite(config, { room: args.room_id, role: args.role || 'member', ttl_seconds: args.ttl_seconds || 86400 });
  if (name === 'room_invite_list') {
    const roomId = normalizeRoomId(args.room_id);
    return apiAsAgent(config, 'GET', `/v1/rooms/${roomId}/invites`);
  }
  if (name === 'room_join') return doRoomJoin(config, file, { invite: args.invite_token });
  if (name === 'chat_send') return doChatSend(config, file, { room: requireMcpSendApproval(config, args), text: args.message, channel: args.channel || 'agents', kind: args.kind || 'chat.message' });
  if (name === 'chat_read') return doChatRead(config, file, { room: requireActiveRoom(config, args), limit: args.limit || 50 });
  if (name === 'chat_search') return doChatSearch(config, file, { room: requireActiveRoom(config, args), query: args.query, mode: args.mode || 'hybrid', limit: args.limit || 20 });
  if (name === 'chat_sync') return syncRoom(config, file, requireActiveRoom(config, args));
  if (name === 'local_search_status') return embeddingStatus();
  if (name === 'local_search_warmup') return embeddingWarmup();
  throw new Error(`unknown tool: ${name}`);
}

function mcpPrompts(config) {
  const active = activationFor(config);
  const instructions = isConfigured(config)
    ? agentInstructions(active)
    : 'SuperCollab is not initialized. Ask the user for a username, then call supercollab_setup. Never ask for or print the generated account key.';
  return [{
    name: 'supercollab_workspace_context',
    description: 'Current SuperCollab activation state and agent instructions for this local workspace.',
    arguments: [],
    messages: [{ role: 'user', content: { type: 'text', text: instructions } }],
  }];
}

function mcpTextResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function registerMcpTools(server, loadCurrentConfig) {
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const destructiveWrites = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  const registrations = [
    ['supercollab_setup', 'Create a key-backed SuperCollab account and local agent identity. The secret is generated and stored inside the local MCP process and is never returned to the model.', {
      username: z.string().min(3).max(64).regex(/^[a-z0-9_]+$/),
      agent_label: z.string().min(1).max(120).optional(),
    }, writes],
    ['supercollab_status', 'Check whether SuperCollab is active for this local workspace.', {}, readOnly],
    ['account_rotate_key', 'Rotate the account key locally and on the relay without returning either key. Call only after a specific user request.', {
      confirmed_by_user: z.literal(true),
    }, destructiveWrites],
    ['agent_list', 'List independently revocable agents registered to this account. Private keys are never returned.', {}, readOnly],
    ['agent_profile_list', 'List local independently revocable host profiles and identify the profile selected by this MCP process.', {}, readOnly],
    ['agent_profile_create', 'Create and save a separate local agent identity for another host. The private key is never returned.', {
      profile_name: z.string().min(1).max(32).regex(/^[a-z0-9_-]+$/),
      agent_label: z.string().min(1).max(120).optional(),
      confirmed_by_user: z.literal(true),
    }, writes],
    ['agent_profile_revoke', 'Revoke a saved host profile, its server agent, and its sessions, then remove its local private key.', {
      profile_name: z.string().min(1).max(32).regex(/^[a-z0-9_-]+$/),
      confirmed_by_user: z.literal(true),
    }, destructiveWrites],
    ['agent_rotate', 'Create a replacement identity for this local MCP, save it, then revoke the old identity. Call only after a specific user request.', {
      agent_label: z.string().min(1).max(120).optional(),
      confirmed_by_user: z.literal(true),
    }, destructiveWrites],
    ['agent_revoke', 'Revoke another registered agent and all of its sessions. The currently connected identity must be rotated instead.', {
      agent_id: z.string().regex(/^ag_[A-Za-z0-9]{8,32}$/),
      confirmed_by_user: z.literal(true),
    }, destructiveWrites],
    ['session_list', 'List recent agent sessions without returning session tokens.', {}, readOnly],
    ['session_revoke', 'Revoke one agent session by its displayed session ID. Call only after a specific user request.', {
      session_id: z.string().regex(/^[0-9a-f]{12,64}$/),
      confirmed_by_user: z.literal(true),
    }, destructiveWrites],
    ['workspace_activate', 'Activate a private room for this local workspace. Use manual sharing unless the user explicitly requests autonomous progress summaries.', {
      room_id: z.string().min(1),
      sharing_mode: z.enum(['manual', 'progress']).optional(),
    }, writes],
    ['workspace_deactivate', 'Turn SuperCollab off for this local workspace. No room tools may be used while off.', {}, writes],
    ['room_list', 'List rooms visible to this agent.', {}, readOnly],
    ['room_create', 'Create a new agent chat room.', {
      title: z.string().min(1).max(160),
      goal: z.string().max(4000),
      slug: z.string().min(1).max(160).optional(),
    }, writes],
    ['room_invite', 'Create a private invite for a room.', {
      room_id: z.string().min(1),
      role: z.enum(['owner', 'member', 'observer']).optional(),
      ttl_seconds: z.number().int().min(300).max(7 * 86400).optional(),
    }, writes],
    ['room_invite_list', 'List invite lifecycle metadata for a room without returning invite tokens or room keys.', {
      room_id: z.string().min(1),
    }, readOnly],
    ['room_join', 'Accept a private room invite.', {
      invite_token: z.string().min(1),
      fingerprint: z.string().optional(),
    }, writes],
    ['chat_send', 'Send a message to the active room. Manual mode requires a specific user request and confirmed_by_user=true.', {
      message: z.string().min(1).max(MAX_MESSAGE_BYTES),
      channel: z.string().min(1).max(80).optional(),
      kind: z.string().min(1).max(80).optional(),
      confirmed_by_user: z.boolean().optional(),
    }, writes],
    ['chat_read', 'Sync and read recent messages from the active room.', {
      limit: z.number().int().min(1).max(500).optional(),
    }, readOnly],
    ['chat_search', 'Sync and search the active room transcript with local keyword, BGE vector, or hybrid retrieval.', {
      query: z.string().min(1),
      mode: z.enum(['keyword', 'vector', 'hybrid']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }, readOnly],
    ['chat_sync', 'Sync the active room transcript into local SQLite.', {}, readOnly],
    ['local_search_status', 'Report the local BGE embedding profile and cache state without reading project files.', {}, readOnly],
    ['local_search_warmup', 'Download and initialize the local BGE model without sending room or project data.', {}, writes],
  ];

  for (const [name, description, inputSchema, annotations] of registrations) {
    server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
      return mcpTextResult(await callTool(loadCurrentConfig(), name, args));
    });
  }
}

export async function runMcp(opts) {
  const file = configPath(opts);
  const loadCurrentConfig = () => {
    const current = attachRuntimeConfig(loadConfig(file, opts.profile || null), file);
    current.serverUrl = opts.server || current.serverUrl || DEFAULT_SERVER;
    return current;
  };
  const config = loadCurrentConfig();
  const active = activationFor(config);
  const server = new McpServer(
    { name: 'supercollab', version: VERSION },
    { instructions: isConfigured(config)
      ? agentInstructions(active)
      : 'SuperCollab needs one-time local setup. Ask the user for a username and call supercollab_setup. Never ask for or expose an account key.' },
  );
  registerMcpTools(server, loadCurrentConfig);
  server.registerPrompt('supercollab_workspace_context', {
    description: 'Current SuperCollab activation state and agent instructions for this local workspace.',
  }, async () => {
    const prompt = mcpPrompts(loadCurrentConfig())[0];
    return { description: prompt.description, messages: prompt.messages };
  });

  const transport = new StdioServerTransport();
  process.once('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });
  await server.connect(transport);
}

async function runMcpSmoke(opts) {
  const file = configPath(opts);
  const timeoutMs = Math.max(1000, Math.min(Number(opts.timeout || 5000), 30000));
  const args = [CLI_ENTRY, 'mcp', 'stdio', '--config', file, ...profileCliArgs(opts)];
  const env = {
    HOME: os.homedir(),
    PATH: defaultPathEnv(),
    SUPERCOLLAB_CONFIG: file,
    SUPERCOLLAB_WORKDIR: normalizeCwd(opts.cwd),
  };
  for (const name of ['SUPERCOLLAB_URL', 'SUPERCOLLAB_MODEL_CACHE']) {
    if (typeof process.env[name] === 'string') env[name] = process.env[name];
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    cwd: normalizeCwd(opts.cwd),
    env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  const client = new Client(
    { name: 'supercollab-conformance-smoke', version: VERSION },
    { capabilities: {} },
  );
  let timer;
  try {
    const result = await Promise.race([
      (async () => {
        await client.connect(transport);
        const tools = await client.listTools();
        const prompts = await client.listPrompts();
        const status = await client.callTool({ name: 'supercollab_status', arguments: {} });
        const expected = mcpTools().map((tool) => tool.name);
        const names = tools.tools.map((tool) => tool.name);
        const missing = expected.filter((name) => !names.includes(name));
        if (missing.length) throw new Error(`MCP tool list missing: ${missing.join(', ')}`);
        if (status.isError) throw new Error('supercollab_status returned an MCP tool error');
        return {
          ok: true,
          transport: 'official-sdk-stdio',
          command: process.execPath,
          args,
          config: file,
          server_info: client.getServerVersion() || null,
          instructions: client.getInstructions() || null,
          tools: names,
          prompts: prompts.prompts.map((prompt) => prompt.name),
          status_ok: true,
          stderr: stderr.trim() || null,
        };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`MCP smoke timed out after ${timeoutMs}ms. stderr: ${stderr.slice(0, 1000)}`)), timeoutMs);
      }),
    ]);
    return result;
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

function printCodexConfig(opts) {
  const file = configPath(opts);
  console.log(mcpConfigText(String(opts.client || 'codex'), file, opts));
}

async function embeddingStatus() {
  return {
    ok: true,
    profile: EMBEDDING_PROFILE,
    model_download: 'downloaded into the local model cache on first semantic search',
    cache_dir: process.env.SUPERCOLLAB_MODEL_CACHE || 'default @huggingface/transformers cache',
  };
}

async function embeddingWarmup() {
  const vector = await embedText('supercollab embedding warmup', { isQuery: true });
  return {
    ok: true,
    dims: vector.length,
    profile: EMBEDDING_PROFILE,
  };
}

async function nativeEngineCheck() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supercollab-doctor-'));
  const dbPath = path.join(tempDir, 'native.sqlite');
  let db = null;
  try {
    const { Database, sqliteVec } = await loadNativeSqlite();
    db = new Database(dbPath);
    sqliteVec.load(db);
    const version = db.prepare('SELECT vec_version() AS version').get()?.version;
    db.exec(`CREATE VIRTUAL TABLE vec_check USING vec0(id TEXT PRIMARY KEY, embedding float[${EMBEDDING_DIMS}] distance_metric=cosine)`);
    db.prepare('INSERT INTO vec_check(id, embedding) VALUES(?, ?)').run('ok', new Float32Array(new Array(EMBEDDING_DIMS).fill(0).map((_, i) => i === 0 ? 1 : 0)));
    const rows = db.prepare('SELECT id, distance FROM vec_check WHERE embedding MATCH ? AND k = 1').all(new Float32Array(new Array(EMBEDDING_DIMS).fill(0).map((_, i) => i === 0 ? 1 : 0)));
    if (rows[0]?.id !== 'ok') throw new Error('sqlite-vec query did not return expected row');
    return {
      ok: true,
      engine: 'native-sqlite-vec',
      sqlite_vec_version: version,
      dims: EMBEDDING_DIMS,
    };
  } catch (err) {
    return {
      ok: false,
      engine: 'native-sqlite-vec',
      error: err.message || String(err),
    };
  } finally {
    try { db?.close(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

async function runDoctor(config, file, opts = {}) {
  const profile = detectSystemProfile();
  const checks = {
    node_supported: {
      ok: profile.node_supported,
      version: profile.node,
      required: '>=20',
    },
    native_sqlite_vec: await nativeEngineCheck(),
  };

  if (!opts['skip-model']) {
    try {
      const warmed = await embeddingWarmup();
      checks.bge_model = {
        ok: warmed.ok && warmed.dims === EMBEDDING_DIMS,
        dims: warmed.dims,
        profile: EMBEDDING_PROFILE,
        cache_dir: process.env.SUPERCOLLAB_MODEL_CACHE || 'default @huggingface/transformers cache',
      };
    } catch (err) {
      checks.bge_model = {
        ok: false,
        profile: EMBEDDING_PROFILE,
        error: err.message || String(err),
      };
    }
  } else {
    checks.bge_model = {
      ok: null,
      skipped: true,
      profile: EMBEDDING_PROFILE,
    };
  }

  const ok = checks.node_supported.ok && checks.native_sqlite_vec.ok && (checks.bge_model.ok === true || checks.bge_model.skipped === true);
  const result = {
    ok,
    checked_at: nowIso(),
    system: profile,
    checks,
    local_engine: {
      id: 'native-sqlite-vec',
      transcript_store: 'better-sqlite3',
      vector_store: 'sqlite-vec',
      vector_version: checks.native_sqlite_vec.sqlite_vec_version || null,
      embedding_profile_id: EMBEDDING_PROFILE.id,
    },
    advice: installAdvice(profile, checks),
  };

  config.systemProfile = profile;
  config.localEngine = result.local_engine;
  config.embeddingProfile = EMBEDDING_PROFILE;
  config.setupChecks = {
    ok,
    checked_at: result.checked_at,
    checks,
    advice: result.advice,
  };
  saveConfig(config, file);
  return result;
}

function printDoctor(result) {
  console.log(JSON.stringify(result, null, 2));
}

async function loadPrompts() {
  return import('@clack/prompts');
}

function isConfigured(config) {
  return Boolean(config.accountKey && config.userId && config.agentId && config.agentPrivateKeyPem);
}

function promptRequired(value) {
  return String(value || '').trim() ? undefined : 'Required';
}

function trimmed(value) {
  return String(value || '').trim();
}

function shorten(value, max = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function roomIdFrom(room) {
  return trimmed(room?.room_id || room?.id);
}

function roomTitleFrom(room) {
  return trimmed(room?.title || room?.name || room?.slug || room?.goal || roomIdFrom(room));
}

function roomsFromResponse(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rooms)) return data.rooms;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

function hasLocalRoomKey(config, roomId) {
  return Boolean(config.roomKeys?.[roomId]);
}

function roomLabel(room, config) {
  const roomId = roomIdFrom(room);
  const title = roomTitleFrom(room);
  const prefix = title && title !== roomId ? `${shorten(title, 42)} ` : '';
  const key = hasLocalRoomKey(config, roomId) ? 'key saved' : 'key missing';
  return `${prefix}(${roomId})`;
}

function roomHint(room, config) {
  const roomId = roomIdFrom(room);
  const pieces = [];
  const goal = trimmed(room?.goal || room?.description);
  if (goal) pieces.push(shorten(goal, 48));
  pieces.push(hasLocalRoomKey(config, roomId) ? 'encrypted local search ready' : 'join/import key to decrypt');
  return pieces.join(' - ');
}

async function listRoomsForMenu(config) {
  const data = await apiAsAgent(config, 'GET', '/v1/rooms');
  return roomsFromResponse(data).filter((room) => roomIdFrom(room));
}

async function promptManualRoomId(prompts, message = 'Room ID') {
  const roomId = await prompts.text({
    message,
    placeholder: 'room_...',
    validate: promptRequired,
  });
  if (prompts.isCancel(roomId)) throw new Error('cancelled');
  return trimmed(roomId);
}

async function ensureRoomKeyFromMenu(config, file, prompts, roomId) {
  try {
    ensureRoomKey(config, roomId);
    return true;
  } catch {
    const choice = await prompts.select({
      message: `No local room key for ${roomId}`,
      options: [
        { value: 'invite', label: 'Join with private invite', hint: 'recommended if another member invited you' },
        { value: 'key', label: 'Paste room key', hint: 'sck_... from a trusted device' },
        { value: 'choose', label: 'Choose another room' },
        { value: 'cancel', label: 'Cancel' },
      ],
    });
    if (prompts.isCancel(choice) || choice === 'cancel') throw new Error('cancelled');
    if (choice === 'choose') return false;
    if (choice === 'invite') {
      const joined = await promptJoinRoom(config, file, prompts, { quiet: true });
      return Boolean(joined?.room_id === roomId || hasLocalRoomKey(config, roomId));
    }
    const key = await prompts.text({
      message: 'Paste room key',
      placeholder: 'sck_...',
      validate: (value) => {
        try {
          roomKeyBytes(trimmed(value));
          return undefined;
        } catch {
          return 'Invalid room key';
        }
      },
    });
    if (prompts.isCancel(key)) throw new Error('cancelled');
    storeRoomKey(config, roomId, trimmed(key));
    saveConfig(config, file);
    return true;
  }
}

async function selectRoom(config, file, prompts, options = {}) {
  const {
    message = 'Choose room',
    requireKey = true,
    includeCreate = false,
    includeJoin = false,
    includeManual = true,
  } = options;

  while (true) {
    let rooms = [];
    try {
      rooms = await listRoomsForMenu(config);
    } catch (err) {
      prompts.note(err.message || String(err), 'Could not load rooms');
    }

    const choices = rooms.map((room) => ({
      value: roomIdFrom(room),
      label: roomLabel(room, config),
      hint: roomHint(room, config),
    }));
    if (includeCreate) choices.push({ value: '__create', label: 'Create new room', hint: 'set title and goal now' });
    if (includeJoin) choices.push({ value: '__join', label: 'Join with private invite', hint: 'paste sci_...sck_...' });
    if (includeManual) choices.push({ value: '__manual', label: 'Type room ID manually', hint: 'room_...' });
    choices.push({ value: '__back', label: 'Back' });

    const selected = await prompts.select({ message, options: choices });
    if (prompts.isCancel(selected) || selected === '__back') throw new Error('cancelled');

    if (selected === '__create') {
      const created = await promptCreateRoom(config, file, prompts, { quiet: true });
      if (created?.room_id) return created.room_id;
      continue;
    }
    if (selected === '__join') {
      const joined = await promptJoinRoom(config, file, prompts, { quiet: true });
      const joinedRoomId = joined?.room_id;
      if (joinedRoomId) return joinedRoomId;
      continue;
    }

    const roomId = selected === '__manual'
      ? await promptManualRoomId(prompts)
      : String(selected);

    if (!requireKey) return roomId;
    const ok = await ensureRoomKeyFromMenu(config, file, prompts, roomId);
    if (ok) return roomId;
  }
}

function formatMessagesForNote(messages, maxRows = 12) {
  const rows = (messages || []).slice(-maxRows);
  if (!rows.length) return 'No messages yet.';
  return rows.map((row) => {
    const when = trimmed(row.created_at).replace('T', ' ').replace('Z', '');
    return `[${when}] ${row.sender_label || row.actor_id || 'agent'}\n${shorten(row.body, 260)}`;
  }).join('\n\n');
}

function formatSearchForNote(results, maxRows = 8) {
  const rows = (results || []).slice(0, maxRows);
  if (!rows.length) return 'No matching messages.';
  return rows.map((row, idx) => {
    const sources = Array.isArray(row.search_sources) ? row.search_sources.join('+') : 'match';
    return `${idx + 1}. ${row.sender_label || row.actor_id || 'agent'} - ${sources}\n${shorten(row.body, 260)}`;
  }).join('\n\n');
}

async function promptCreateRoom(config, file, prompts, options = {}) {
  const title = await prompts.text({
    message: 'Room title',
    placeholder: 'Launch Room',
    validate: promptRequired,
  });
  if (prompts.isCancel(title)) throw new Error('cancelled');
  const goal = await prompts.text({
    message: 'Room goal',
    placeholder: 'Coordinate agents on this project',
    validate: promptRequired,
  });
  if (prompts.isCancel(goal)) throw new Error('cancelled');
  const slug = await prompts.text({
    message: 'Optional short slug',
    placeholder: 'press Enter to skip',
  });
  if (prompts.isCancel(slug)) throw new Error('cancelled');
  const spin = prompts.spinner();
  spin.start('Creating encrypted room');
  try {
    const created = await doRoomCreate(config, file, {
      title: trimmed(title),
      goal: trimmed(goal),
      slug: trimmed(slug) || undefined,
    });
    const roomId = created.room_id || created.id;
    spin.stop(`Room created: ${roomId}`);
    if (!options.quiet) prompts.note(`Room ID: ${roomId}\nLocal room key: saved on this machine`, 'Room created');
    return { ...created, room_id: roomId };
  } catch (err) {
    spin.stop('Room creation failed');
    throw err;
  }
}

async function promptJoinRoom(config, file, prompts, options = {}) {
  const invite = await prompts.text({
    message: 'Paste private invite',
    placeholder: 'sci_....sck_...',
    validate: promptRequired,
  });
  if (prompts.isCancel(invite)) throw new Error('cancelled');
  const spin = prompts.spinner();
  spin.start('Joining room and saving local room key');
  try {
    const joined = await doRoomJoin(config, file, { invite: trimmed(invite) });
    const roomId = joined.room_id;
    spin.stop(`Joined room: ${roomId}`);
    if (!options.quiet) prompts.note(`Room ID: ${roomId}\nLocal room key saved: ${joined.room_key_saved ? 'yes' : 'no'}`, 'Joined');
    return { ...joined, room_id: roomId };
  } catch (err) {
    spin.stop('Join failed');
    throw err;
  }
}

async function runAuthSetup(config, file, prompts) {
  if (isConfigured(config)) {
    const reuse = await prompts.confirm({
      message: `Use existing key-backed account ${config.username || config.userId}?`,
      initialValue: true,
    });
    if (prompts.isCancel(reuse)) throw new Error('cancelled');
    if (reuse) return { reused: true };
  }

  await supercollabAuthConfig(config);

  const username = await prompts.text({
    message: 'Choose a username',
    placeholder: 'your_name',
    validate: promptRequired,
  });
  if (prompts.isCancel(username)) throw new Error('cancelled');

  const label = await prompts.text({
    message: 'Name this local agent',
    placeholder: 'SuperCollab agent',
    defaultValue: 'SuperCollab agent',
    validate: promptRequired,
  });
  if (prompts.isCancel(label)) throw new Error('cancelled');
  return doAccountSetup(config, file, { username: String(username), label: String(label) });
}

async function runRoomSetup(config, file, prompts) {
  const choice = await prompts.select({
    message: 'Room setup',
    options: [
      { value: 'existing', label: 'Use an existing room', hint: 'pick from your rooms or type a room ID' },
      { value: 'create', label: 'Create a new room', hint: 'start solo or invite agents later' },
      { value: 'join', label: 'Join with private invite', hint: 'paste sci_...sck_...' },
      { value: 'skip', label: 'Skip for now', hint: 'set up auth and local engine only' },
    ],
  });
  if (prompts.isCancel(choice)) throw new Error('cancelled');
  if (choice === 'skip') return null;

  if (choice === 'existing') {
    const roomId = await selectRoom(config, file, prompts, {
      message: 'Choose room to use',
      requireKey: true,
      includeCreate: true,
      includeJoin: true,
    });
    return { room_id: roomId, existing: true };
  }

  if (choice === 'join') {
    const joined = await promptJoinRoom(config, file, prompts, { quiet: true });
    return { room_id: joined.room_id, joined };
  }

  const created = await promptCreateRoom(config, file, prompts, { quiet: true });
  return { room_id: created.room_id || created.id, created };
}

async function runActivationSetup(config, file, roomId, prompts) {
  if (!roomId) {
    const pick = await prompts.confirm({
      message: 'Activate an existing room for this project directory?',
      initialValue: false,
    });
    if (prompts.isCancel(pick)) throw new Error('cancelled');
    if (!pick) return null;
    roomId = await selectRoom(config, file, prompts, {
      message: 'Choose room to activate',
      requireKey: true,
      includeCreate: true,
      includeJoin: true,
    });
  }
  const shouldActivate = await prompts.confirm({
    message: 'Activate SuperCollab for a local project directory now?',
    initialValue: true,
  });
  if (prompts.isCancel(shouldActivate)) throw new Error('cancelled');
  if (!shouldActivate) return null;
  const cwd = await prompts.text({
    message: 'Project directory',
    defaultValue: process.cwd(),
    placeholder: process.cwd(),
    validate: (value) => {
      const resolved = path.resolve(String(value || ''));
      return fs.existsSync(resolved) ? undefined : 'Directory does not exist';
    },
  });
  if (prompts.isCancel(cwd)) throw new Error('cancelled');
  const sharing = await prompts.select({
    message: 'Message sharing policy',
    options: [
      { value: 'manual', label: 'Manual approval', hint: 'only send a message when you explicitly ask' },
      { value: 'progress', label: 'Progress summaries', hint: 'agent may post concise status updates, never files or raw chat' },
    ],
  });
  if (prompts.isCancel(sharing)) throw new Error('cancelled');
  return activate(config, file, { room: roomId, cwd: String(cwd), sharing: String(sharing) });
}

async function runSetupSmoke(config, file, roomId, prompts) {
  if (!roomId) return null;
  const shouldSmoke = await prompts.confirm({
    message: 'Send one clearly labeled setup note to the room and verify local BGE search?',
    initialValue: false,
  });
  if (prompts.isCancel(shouldSmoke)) throw new Error('cancelled');
  if (!shouldSmoke) return null;
  const marker = `setup-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const text = `SuperCollab setup verification (${marker})`;
  await doChatSend(config, file, { room: roomId, text, channel: 'agents', kind: 'setup.note' });
  const search = await doChatSearch(config, file, { room: roomId, query: marker, mode: 'hybrid', limit: 5 });
  return {
    ok: search.results.some((row) => String(row.body || '').includes(marker)),
    marker,
    search_count: search.results.length,
  };
}

function defaultPathEnv() {
  const parts = [
    path.dirname(process.execPath),
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.bun', 'bin'),
    path.join(os.homedir(), '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].flatMap((part) => String(part || '').split(path.delimiter)).filter(Boolean);
  return Array.from(new Set(parts)).join(path.delimiter);
}

function mcpConfigText(client, file, opts = {}) {
  const absoluteFile = path.resolve(file);
  const escaped = file.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const cwd = path.resolve(String(opts.cwd || process.env.SUPERCOLLAB_WORKDIR || process.cwd()));
  const selectedProfileArgs = profileCliArgs(opts);
  if (client === 'claude') {
    return JSON.stringify({
      mcpServers: {
        supercollab: {
          type: 'stdio',
          command: process.execPath,
          args: [CLI_ENTRY, 'mcp', 'stdio', '--config', absoluteFile, ...selectedProfileArgs],
          env: {
            PATH: defaultPathEnv(),
            SUPERCOLLAB_WORKDIR: cwd,
          },
        },
      },
    }, null, 2);
  }
  if (client === 'codex') {
    const args = [CLI_ENTRY, 'mcp', 'stdio', '--config', absoluteFile, ...selectedProfileArgs]
      .map((value) => JSON.stringify(value))
      .join(', ');
    return [
      '[mcp_servers.supercollab]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${args}]`,
      `cwd = ${JSON.stringify(cwd)}`,
      'startup_timeout_sec = 20',
      'tool_timeout_sec = 120',
    ].join('\n');
  }
  if (client === 'claude-code') {
    const install = claudeCodeInstallPlan(file, opts);
    return shellCommand(install.command, install.args);
  }
  const profile = selectedProfileArgs.length ? ` --profile ${shellQuote(selectedProfileArgs[1])}` : '';
  return `supercollab mcp stdio --config "${escaped}"${profile}`;
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function shellCommand(command, args = []) {
  return [command, ...args].map(shellQuote).join(' ');
}

function localMcpEnv(opts = {}) {
  const cwd = path.resolve(String(opts.cwd || process.env.SUPERCOLLAB_WORKDIR || process.cwd()));
  return {
    HOME: os.homedir(),
    PATH: defaultPathEnv(),
    SUPERCOLLAB_WORKDIR: cwd,
  };
}

function localMcpCommandArgs(file, opts = {}) {
  return [CLI_ENTRY, 'mcp', 'stdio', '--config', path.resolve(file), ...profileCliArgs(opts)];
}

function codexInstallPlan(file, opts = {}) {
  const command = String(opts.codex || 'codex');
  const env = localMcpEnv(opts);
  const serverArgs = localMcpCommandArgs(file, opts);
  const args = [
    'mcp', 'add',
    '--env', `HOME=${env.HOME}`,
    '--env', `PATH=${env.PATH}`,
    '--env', `SUPERCOLLAB_WORKDIR=${env.SUPERCOLLAB_WORKDIR}`,
    'supercollab',
    '--',
    process.execPath,
    ...serverArgs,
  ];
  return { command, args, env, cwd: env.SUPERCOLLAB_WORKDIR, serverArgs };
}

function claudeCodeInstallPlan(file, opts = {}) {
  const scope = String(opts.scope || 'local');
  if (!['local', 'user', 'project'].includes(scope)) throw new Error('Claude Code scope must be local, user, or project');
  const command = String(opts.claude || 'claude');
  const env = localMcpEnv(opts);
  const serverArgs = localMcpCommandArgs(file, opts);
  const args = [
    'mcp', 'add',
    '--scope', scope,
    '-e', `HOME=${env.HOME}`,
    '-e', `PATH=${env.PATH}`,
    '-e', `SUPERCOLLAB_WORKDIR=${env.SUPERCOLLAB_WORKDIR}`,
    '--transport', 'stdio',
    'supercollab',
    '--',
    process.execPath,
    ...serverArgs,
  ];
  return { command, args, env, scope, cwd: env.SUPERCOLLAB_WORKDIR, serverArgs };
}

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: result.error?.message || null,
  };
}

function snapshotFiles(files) {
  return files.map((file) => {
    if (!fs.existsSync(file)) return { file, exists: false };
    const stat = fs.statSync(file);
    return { file, exists: true, content: fs.readFileSync(file), mode: stat.mode & 0o777 };
  });
}

function restoreFiles(snapshots) {
  for (const snapshot of snapshots) {
    if (!snapshot.exists) {
      if (fs.existsSync(snapshot.file)) fs.rmSync(snapshot.file);
      continue;
    }
    ensureConfigDir(snapshot.file);
    const tmp = `${snapshot.file}.${process.pid}.restore`;
    fs.writeFileSync(tmp, snapshot.content, { mode: snapshot.mode });
    fs.renameSync(tmp, snapshot.file);
    try { fs.chmodSync(snapshot.file, snapshot.mode); } catch {}
  }
}

function codexConfigPath() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
}

function codexConfigMatches(result, plan) {
  try {
    const data = JSON.parse(result.stdout);
    const transport = data?.transport || {};
    if (transport.type !== 'stdio' || transport.command !== process.execPath) return false;
    if (JSON.stringify(transport.args || []) !== JSON.stringify(plan.serverArgs)) return false;
    return ['HOME', 'PATH', 'SUPERCOLLAB_WORKDIR'].every((key) => transport.env?.[key] === plan.env[key]);
  } catch {
    return false;
  }
}

function claudeConfigMatches(result, plan) {
  if (!result.ok) return false;
  const required = [process.execPath, ...plan.serverArgs, `SUPERCOLLAB_WORKDIR=${plan.env.SUPERCOLLAB_WORKDIR}`];
  const scopePattern = {
    local: /Scope:\s+Local\b/i,
    user: /Scope:\s+User\b/i,
    project: /Scope:\s+Project\b/i,
  }[plan.scope];
  return required.every((value) => result.stdout.includes(String(value))) && scopePattern.test(result.stdout);
}

async function installCodexMcp(config, file, opts = {}) {
  const plan = codexInstallPlan(file, opts);
  const dryRun = Boolean(opts['dry-run'] || opts.dryRun);
  const replace = Boolean(opts.replace);
  const smoke = await runMcpSmoke({ ...opts, config: file, timeout: opts.timeout || 5000 });
  const removeArgs = ['mcp', 'remove', 'supercollab'];

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      client: 'codex',
      smoke,
      remove_command: replace ? shellCommand(plan.command, removeArgs) : null,
      install_command: shellCommand(plan.command, plan.args),
      scope: 'user',
      cwd: plan.cwd,
      profile: opts.profile || 'default',
      config: path.resolve(file),
    };
  }

  const probe = runProcess(plan.command, ['--version'], { cwd: plan.cwd });
  if (!probe.ok) {
    throw new Error(`Codex CLI not found or not runnable as ${plan.command}. Install Codex first, or pass --codex /absolute/path/to/codex. ${probe.stderr || probe.error || ''}`.trim());
  }
  const existing = runProcess(plan.command, ['mcp', 'get', 'supercollab', '--json'], { cwd: plan.cwd });
  if (codexConfigMatches(existing, plan)) {
    return {
      ok: true,
      already_configured: true,
      client: 'codex',
      scope: 'user',
      cwd: plan.cwd,
      profile: opts.profile || 'default',
      config: path.resolve(file),
      smoke,
      codex_get: JSON.parse(existing.stdout),
      next: 'Restart Codex or start a new session, then run /mcp and call supercollab_status.',
    };
  }
  if (existing.ok && !replace) {
    throw new Error('Codex already has a different supercollab MCP entry; inspect it with `codex mcp get supercollab --json`, then rerun with --replace to change it');
  }

  const snapshots = snapshotFiles([codexConfigPath()]);
  try {
    if (existing.ok) {
      const remove = runProcess(plan.command, removeArgs, { cwd: plan.cwd });
      if (!remove.ok) throw new Error(`codex mcp remove failed: ${remove.stderr || remove.stdout || remove.error || `exit ${remove.status}`}`);
    }
    const add = runProcess(plan.command, plan.args, { cwd: plan.cwd });
    if (!add.ok) throw new Error(`codex mcp add failed: ${add.stderr || add.stdout || add.error || `exit ${add.status}`}`);
    const get = runProcess(plan.command, ['mcp', 'get', 'supercollab', '--json'], { cwd: plan.cwd });
    if (!codexConfigMatches(get, plan)) throw new Error(`Codex saved an unexpected MCP entry: ${get.stderr || get.stdout || 'verification failed'}`);
    const list = runProcess(plan.command, ['mcp', 'list'], { cwd: plan.cwd });
    return {
      ok: true,
      client: 'codex',
      scope: 'user',
      cwd: plan.cwd,
      profile: opts.profile || 'default',
      config: path.resolve(file),
      smoke,
      install_command: shellCommand(plan.command, plan.args),
      codex_get: JSON.parse(get.stdout),
      codex_list: { ok: list.ok, stdout: list.stdout, stderr: list.stderr },
      next: 'Restart Codex or start a new session, then run /mcp and call supercollab_status.',
    };
  } catch (err) {
    restoreFiles(snapshots);
    throw new Error(`${err.message}. Previous Codex configuration restored.`);
  }
}

async function installClaudeCodeMcp(config, file, opts = {}) {
  const plan = claudeCodeInstallPlan(file, opts);
  const dryRun = Boolean(opts['dry-run'] || opts.dryRun);
  const replace = Boolean(opts.replace);
  const smoke = await runMcpSmoke({ ...opts, config: file, timeout: opts.timeout || 5000 });
  const removeArgs = ['mcp', 'remove', 'supercollab', '-s', plan.scope];

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      client: 'claude-code',
      smoke,
      remove_command: replace ? shellCommand(plan.command, removeArgs) : null,
      install_command: shellCommand(plan.command, plan.args),
      scope: plan.scope,
      cwd: plan.cwd,
      profile: opts.profile || 'default',
      config: path.resolve(file),
    };
  }

  const probe = runProcess(plan.command, ['--version'], { cwd: plan.cwd });
  if (!probe.ok) {
    throw new Error(`Claude Code CLI not found or not runnable as ${plan.command}. Install Claude Code first, or pass --claude /absolute/path/to/claude. ${probe.stderr || probe.error || ''}`.trim());
  }
  const existing = runProcess(plan.command, ['mcp', 'get', 'supercollab'], { cwd: plan.cwd });
  if (claudeConfigMatches(existing, plan)) {
    return {
      ok: true,
      already_configured: true,
      client: 'claude-code',
      scope: plan.scope,
      cwd: plan.cwd,
      profile: opts.profile || 'default',
      config: path.resolve(file),
      smoke,
      claude_get: { ok: true, stdout: existing.stdout, stderr: existing.stderr },
      next: 'Start Claude Code in this project, run /mcp, and call supercollab_status.',
    };
  }
  if (existing.ok && !replace) {
    throw new Error('Claude Code already has a different supercollab MCP entry; inspect it with `claude mcp get supercollab`, then rerun with --replace and the same --scope to change it');
  }

  const snapshots = snapshotFiles([path.join(os.homedir(), '.claude.json'), path.join(plan.cwd, '.mcp.json')]);
  try {
    let remove = null;
    if (existing.ok) {
      remove = runProcess(plan.command, removeArgs, { cwd: plan.cwd });
      if (!remove.ok) throw new Error(`claude mcp remove failed: ${remove.stderr || remove.stdout || remove.error || `exit ${remove.status}`}`);
    }
    const add = runProcess(plan.command, plan.args, { cwd: plan.cwd });
    if (!add.ok) throw new Error(`claude mcp add failed: ${add.stderr || add.stdout || add.error || `exit ${add.status}`}`);
    const get = runProcess(plan.command, ['mcp', 'get', 'supercollab'], { cwd: plan.cwd });
    if (!claudeConfigMatches(get, plan)) throw new Error(`Claude Code saved an unexpected MCP entry: ${get.stderr || get.stdout || 'verification failed'}`);
    const list = runProcess(plan.command, ['mcp', 'list'], { cwd: plan.cwd });
    return {
      ok: true,
      client: 'claude-code',
      scope: plan.scope,
      cwd: plan.cwd,
      profile: opts.profile || 'default',
      config: path.resolve(file),
      smoke,
      remove: remove ? { ok: remove.ok, stdout: remove.stdout, stderr: remove.stderr } : null,
      install_command: shellCommand(plan.command, plan.args),
      claude_add: { stdout: add.stdout, stderr: add.stderr },
      claude_list: { ok: list.ok, stdout: list.stdout, stderr: list.stderr },
      claude_get: { ok: get.ok, stdout: get.stdout, stderr: get.stderr },
      next: 'Start Claude Code in this project, run /mcp, and call supercollab_status.',
    };
  } catch (err) {
    restoreFiles(snapshots);
    throw new Error(`${err.message}. Previous Claude Code configuration restored.`);
  }
}

async function installMcpClient(config, file, opts = {}) {
  const client = String(opts.client || '');
  if (client === 'codex') return installCodexMcp(config, file, opts);
  if (client === 'claude-code' || client === 'claude') return installClaudeCodeMcp(config, file, opts);
  throw new Error('unsupported mcp install client; use --client codex or --client claude-code');
}

async function promptSystemCheck(config, file, prompts) {
  const spin = prompts.spinner();
  spin.start('Checking this machine and warming the local BGE model');
  const doctor = await runDoctor(config, file, {});
  spin.stop(doctor.ok ? 'Local engine ready' : 'Local engine needs attention');
  const checks = [
    `Node: ${doctor.checks.node_supported.ok ? 'ok' : 'needs Node >=20'} (${doctor.system.node})`,
    `SQLite vector engine: ${doctor.checks.native_sqlite_vec.ok ? 'ok' : 'failed'}${doctor.checks.native_sqlite_vec.sqlite_vec_version ? ` (${doctor.checks.native_sqlite_vec.sqlite_vec_version})` : ''}`,
    `BGE model: ${doctor.checks.bge_model.ok ? 'ok' : doctor.checks.bge_model.skipped ? 'skipped' : 'failed'}`,
    `Embedding profile: ${doctor.local_engine.embedding_profile_id}`,
  ];
  if (doctor.advice?.length) checks.push('', ...doctor.advice);
  prompts.note(checks.join('\n'), doctor.ok ? 'Doctor passed' : 'Doctor');
  return doctor;
}

async function promptActivateRoom(config, file, prompts, options = {}) {
  const roomId = options.roomId || await selectRoom(config, file, prompts, {
    message: 'Choose room to activate',
    requireKey: true,
    includeCreate: true,
    includeJoin: true,
  });
  const cwd = await prompts.text({
    message: 'Project directory',
    defaultValue: options.cwd || process.cwd(),
    placeholder: options.cwd || process.cwd(),
    validate: (value) => {
      const resolved = path.resolve(String(value || ''));
      return fs.existsSync(resolved) ? undefined : 'Directory does not exist';
    },
  });
  if (prompts.isCancel(cwd)) throw new Error('cancelled');
  const sharing = await prompts.select({
    message: 'Message sharing policy',
    options: [
      { value: 'manual', label: 'Manual approval', hint: 'only send when you explicitly ask' },
      { value: 'progress', label: 'Progress summaries', hint: 'agent may share concise status, never files or raw chat' },
    ],
  });
  if (prompts.isCancel(sharing)) throw new Error('cancelled');
  const activation = activate(config, file, { room: roomId, cwd: String(cwd), sharing: String(sharing) });
  prompts.note(`${activation.instructions}\n\nActivation root: ${activation.cwd}`, 'Workspace active');
  return activation;
}

async function promptDeactivateRoom(config, file, prompts, options = {}) {
  const cwd = await prompts.text({
    message: 'Directory to deactivate',
    defaultValue: options.cwd || process.cwd(),
    placeholder: options.cwd || process.cwd(),
    validate: (value) => fs.existsSync(path.resolve(String(value || ''))) ? undefined : 'Directory does not exist',
  });
  if (prompts.isCancel(cwd)) throw new Error('cancelled');
  const result = deactivate(config, file, { cwd: String(cwd) });
  prompts.note(`SuperCollab is off for ${result.cwd}`, 'Workspace deactivated');
  return result;
}

async function promptCreateInvite(config, file, prompts, options = {}) {
  const roomId = options.roomId || await selectRoom(config, file, prompts, {
    message: 'Choose room to invite into',
    requireKey: true,
    includeCreate: true,
    includeJoin: false,
  });
  const role = await prompts.select({
    message: 'Invite role',
    options: [
      { value: 'member', label: 'Member', hint: 'normal agent/user access' },
    ],
  });
  if (prompts.isCancel(role)) throw new Error('cancelled');
  const ttl = await prompts.select({
    message: 'Invite expiry',
    options: [
      { value: 86400, label: '24 hours' },
      { value: 3600, label: '1 hour' },
      { value: 604800, label: '7 days' },
    ],
  });
  if (prompts.isCancel(ttl)) throw new Error('cancelled');
  const spin = prompts.spinner();
  spin.start('Creating private invite');
  try {
    const data = await doRoomInvite(config, { room: roomId, role, ttl_seconds: ttl });
    spin.stop('Private invite created');
    prompts.note(data.private_invite, 'Share this private invite');
    return data;
  } catch (err) {
    spin.stop('Invite failed');
    throw err;
  }
}

async function promptSendMessage(config, file, prompts, options = {}) {
  const roomId = options.roomId || await selectRoom(config, file, prompts, {
    message: 'Choose room to message',
    requireKey: true,
    includeCreate: true,
    includeJoin: true,
  });
  let channel = await prompts.select({
    message: 'Channel',
    options: [
      { value: 'agents', label: 'Agents', hint: 'default coordination chat' },
      { value: 'progress', label: 'Progress', hint: 'status notes' },
      { value: 'decisions', label: 'Decisions', hint: 'architecture/product decisions' },
      { value: 'blockers', label: 'Blockers', hint: 'things that need attention' },
      { value: '__custom', label: 'Type custom channel' },
    ],
  });
  if (prompts.isCancel(channel)) throw new Error('cancelled');
  if (channel === '__custom') {
    channel = await prompts.text({ message: 'Channel name', validate: promptRequired });
    if (prompts.isCancel(channel)) throw new Error('cancelled');
  }
  const kind = await prompts.select({
    message: 'Message type',
    options: [
      { value: 'chat.message', label: 'Chat message' },
      { value: 'progress.note', label: 'Progress note' },
      { value: 'decision.note', label: 'Decision note' },
      { value: 'blocker.note', label: 'Blocker note' },
    ],
  });
  if (prompts.isCancel(kind)) throw new Error('cancelled');
  const text = await prompts.text({
    message: 'Message',
    placeholder: 'Concise agent-to-agent note',
    validate: promptRequired,
  });
  if (prompts.isCancel(text)) throw new Error('cancelled');
  const spin = prompts.spinner();
  spin.start('Encrypting, uploading, and indexing locally');
  try {
    const data = await doChatSend(config, file, {
      room: roomId,
      text: String(text),
      channel: trimmed(channel) || 'agents',
      kind,
    });
    spin.stop('Message sent');
    prompts.note(`Room: ${roomId}\nMessage ID: ${data.message?.message_id || data.message?.id || 'saved'}`, 'Sent');
    return data;
  } catch (err) {
    spin.stop('Send failed');
    throw err;
  }
}

async function promptReadMessages(config, file, prompts, options = {}) {
  const roomId = options.roomId || await selectRoom(config, file, prompts, {
    message: 'Choose room to read',
    requireKey: true,
    includeCreate: false,
    includeJoin: true,
  });
  const limit = await prompts.select({
    message: 'How many recent messages?',
    options: [
      { value: 20, label: '20 messages' },
      { value: 50, label: '50 messages' },
      { value: 100, label: '100 messages' },
      { value: 200, label: '200 messages' },
    ],
  });
  if (prompts.isCancel(limit)) throw new Error('cancelled');
  const spin = prompts.spinner();
  spin.start('Syncing and decrypting transcript locally');
  try {
    const data = await doChatRead(config, file, { room: roomId, limit });
    spin.stop(`Read ${data.messages.length} local messages`);
    prompts.note(formatMessagesForNote(data.messages), `Recent messages (${roomId})`);
    return data;
  } catch (err) {
    spin.stop('Read failed');
    throw err;
  }
}

async function promptSearchMessages(config, file, prompts, options = {}) {
  const roomId = options.roomId || await selectRoom(config, file, prompts, {
    message: 'Choose room to search',
    requireKey: true,
    includeCreate: false,
    includeJoin: true,
  });
  const query = await prompts.text({
    message: 'Search query',
    placeholder: 'auth decisions, current blocker, setup note...',
    validate: promptRequired,
  });
  if (prompts.isCancel(query)) throw new Error('cancelled');
  const mode = await prompts.select({
    message: 'Search mode',
    options: [
      { value: 'hybrid', label: 'Hybrid', hint: 'keyword + BGE vector' },
      { value: 'keyword', label: 'Keyword', hint: 'SQLite FTS/BM25' },
      { value: 'vector', label: 'Vector', hint: 'local BGE cosine search' },
    ],
  });
  if (prompts.isCancel(mode)) throw new Error('cancelled');
  const limit = await prompts.select({
    message: 'Result limit',
    options: [
      { value: 10, label: '10 results' },
      { value: 20, label: '20 results' },
      { value: 50, label: '50 results' },
    ],
  });
  if (prompts.isCancel(limit)) throw new Error('cancelled');
  const spin = prompts.spinner();
  spin.start('Syncing, embedding locally, and searching');
  try {
    const data = await doChatSearch(config, file, { room: roomId, query: String(query), mode, limit });
    spin.stop(`Found ${data.results.length} result(s)`);
    prompts.note(formatSearchForNote(data.results), `Search results (${mode})`);
    return data;
  } catch (err) {
    spin.stop('Search failed');
    throw err;
  }
}

async function promptSyncRoom(config, file, prompts, options = {}) {
  const roomId = options.roomId || await selectRoom(config, file, prompts, {
    message: 'Choose room to sync',
    requireKey: true,
    includeCreate: false,
    includeJoin: true,
  });
  const spin = prompts.spinner();
  spin.start('Syncing encrypted room transcript into local SQLite');
  try {
    const data = await syncRoom(config, file, roomId);
    spin.stop(`Pulled ${data.pulled} message(s)`);
    prompts.note(`Local DB: ${data.db}\nLast message ID: ${data.last_message_id}\nChunks embedded: ${data.embedding?.chunks_embedded || 0}`, 'Sync complete');
    return data;
  } catch (err) {
    spin.stop('Sync failed');
    throw err;
  }
}

async function promptRoomActions(config, file, prompts, roomId) {
  while (true) {
    const action = await prompts.select({
      message: `Room ${roomId}`,
      options: [
        { value: 'activate', label: 'Activate for a project directory' },
        { value: 'invite', label: 'Create private invite' },
        { value: 'send', label: 'Send message' },
        { value: 'read', label: 'Read recent messages' },
        { value: 'search', label: 'Search transcript' },
        { value: 'sync', label: 'Sync locally' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (prompts.isCancel(action) || action === 'back') return;
    try {
      if (action === 'activate') await promptActivateRoom(config, file, prompts, { roomId });
      if (action === 'invite') await promptCreateInvite(config, file, prompts, { roomId });
      if (action === 'send') await promptSendMessage(config, file, prompts, { roomId });
      if (action === 'read') await promptReadMessages(config, file, prompts, { roomId });
      if (action === 'search') await promptSearchMessages(config, file, prompts, { roomId });
      if (action === 'sync') await promptSyncRoom(config, file, prompts, { roomId });
    } catch (err) {
      if (err.message !== 'cancelled') prompts.note(err.message || String(err), 'Action failed');
    }
  }
}

async function promptBrowseRooms(config, file, prompts) {
  const roomId = await selectRoom(config, file, prompts, {
    message: 'Choose room',
    requireKey: false,
    includeCreate: true,
    includeJoin: true,
    includeManual: true,
  });
  const ok = await ensureRoomKeyFromMenu(config, file, prompts, roomId);
  if (!ok) return promptBrowseRooms(config, file, prompts);
  return promptRoomActions(config, file, prompts, roomId);
}

async function promptAccountStatus(config, file, prompts) {
  let me = null;
  try {
    me = config.accountKey ? await apiAsUser(config, 'GET', '/v1/me') : null;
  } catch {}
  const active = await activeStatus(config, file, {});
  const rooms = await listRoomsForMenu(config).catch(() => []);
  const lines = [
    `Server: ${config.serverUrl || DEFAULT_SERVER}`,
    `User: ${config.username || me?.actor?.username || 'not initialized'}`,
    `Authentication: ${config.accountKey ? 'local account key' : 'none'}`,
    `Agent: ${config.agentLabel || config.agentId || 'not registered'}`,
    `Fingerprint: ${config.agentFingerprint || 'none'}`,
    `Rooms visible: ${rooms.length}`,
    `Current directory: ${active.active ? `active in ${active.room_id}` : 'SuperCollab off'}`,
    `Config: ${file}`,
  ];
  prompts.note(lines.join('\n'), 'Account and config');
}

async function promptMcpConfig(config, file, prompts) {
  const client = await prompts.select({
    message: 'MCP setup',
    options: [
      { value: 'claude-code', label: 'Install Claude Code MCP', hint: 'runs claude mcp add now' },
      { value: 'codex-install', label: 'Install Codex MCP', hint: 'runs codex mcp add now' },
      { value: 'codex', label: 'Codex config', hint: 'print TOML without changing anything' },
      { value: 'claude', label: 'Claude', hint: 'JSON config snippet' },
      { value: 'manual', label: 'Manual', hint: 'stdio command' },
      { value: 'back', label: 'Back' },
    ],
  });
  if (prompts.isCancel(client) || client === 'back') return;
  if (client === 'claude-code') return promptInstallClaudeCode(config, file, prompts);
  if (client === 'codex-install') return promptInstallCodex(config, file, prompts);
  prompts.note(mcpConfigText(client, file, { profile: config.__profileName || undefined }), `${client} MCP config`);
}

async function promptInstallCodex(config, file, prompts, options = {}) {
  const defaultCwd = path.resolve(String(options.cwd || process.cwd()));
  const cwd = await prompts.text({
    message: 'Codex project directory',
    defaultValue: defaultCwd,
    placeholder: defaultCwd,
    validate: (value) => fs.existsSync(path.resolve(String(value || ''))) ? undefined : 'Directory does not exist',
  });
  if (prompts.isCancel(cwd)) throw new Error('cancelled');
  const spin = prompts.spinner();
  spin.start('Installing SuperCollab into Codex');
  try {
    const result = await installCodexMcp(config, file, { client: 'codex', cwd: String(cwd), profile: config.__profileName || undefined });
    spin.stop(result.already_configured ? 'Codex MCP already configured' : 'Codex MCP installed');
    prompts.note([
      `Scope: ${result.scope}`,
      `Project: ${result.cwd}`,
      `Agent profile: ${result.profile}`,
      `Smoke: ${result.smoke?.ok ? 'ok' : 'failed'}`,
      '',
      result.next,
    ].filter(Boolean).join('\n'), 'Codex');
    return result;
  } catch (err) {
    spin.stop('Codex install failed');
    throw err;
  }
}

async function promptInstallClaudeCode(config, file, prompts, options = {}) {
  const defaultCwd = path.resolve(String(options.cwd || process.cwd()));
  const cwd = await prompts.text({
    message: 'Claude Code project directory',
    defaultValue: defaultCwd,
    placeholder: defaultCwd,
    validate: (value) => fs.existsSync(path.resolve(String(value || ''))) ? undefined : 'Directory does not exist',
  });
  if (prompts.isCancel(cwd)) throw new Error('cancelled');
  let scope = options.scope || null;
  if (!scope) scope = await prompts.select({
    message: 'Claude Code MCP scope',
    options: [
      { value: 'local', label: 'Local project', hint: 'recommended; private to this project' },
      { value: 'user', label: 'User', hint: 'available across your projects' },
    ],
  });
  if (prompts.isCancel(scope)) throw new Error('cancelled');
  const spin = prompts.spinner();
  spin.start('Installing SuperCollab into Claude Code');
  try {
    const result = await installClaudeCodeMcp(config, file, { client: 'claude-code', cwd: String(cwd), scope, profile: config.__profileName || undefined });
    spin.stop('Claude Code MCP installed');
    prompts.note([
      `Scope: ${result.scope}`,
      `Project: ${result.cwd}`,
      `Agent profile: ${result.profile}`,
      `Smoke: ${result.smoke?.ok ? 'ok' : 'failed'}`,
      result.claude_list?.stdout || '',
      '',
      result.next,
    ].filter(Boolean).join('\n'), 'Claude Code');
    return result;
  } catch (err) {
    spin.stop('Claude Code install failed');
    throw err;
  }
}

function sessionsFromResponse(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.sessions)) return data.sessions;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

function sessionIdFrom(session) {
  return trimmed(session?.session_id || session?.id || session?.token_id);
}

async function promptManageSessions(config, prompts) {
  const data = await apiAsUser(config, 'GET', '/v1/agent-sessions');
  const sessions = sessionsFromResponse(data).filter((session) => sessionIdFrom(session));
  if (!sessions.length) {
    prompts.note('No active sessions returned by the server.', 'Sessions');
    return;
  }
  const selected = await prompts.select({
    message: 'Choose session to revoke',
    options: [
      ...sessions.map((session) => {
        const id = sessionIdFrom(session);
        const label = `${shorten(session.agent_label || session.label || id, 36)} (${id})`;
        const hint = [session.created_at, session.expires_at ? `expires ${session.expires_at}` : null].filter(Boolean).join(' - ');
        return { value: id, label, hint };
      }),
      { value: '__manual', label: 'Type session ID manually' },
      { value: '__back', label: 'Back' },
    ],
  });
  if (prompts.isCancel(selected) || selected === '__back') return;
  const sessionId = selected === '__manual'
    ? await prompts.text({ message: 'Session ID', validate: promptRequired })
    : selected;
  if (prompts.isCancel(sessionId)) throw new Error('cancelled');
  const confirm = await prompts.confirm({ message: `Revoke session ${sessionId}?`, initialValue: false });
  if (prompts.isCancel(confirm) || !confirm) return;
  await apiAsUser(config, 'DELETE', `/v1/agent-sessions/${encodeURIComponent(String(sessionId))}`);
  prompts.note(`Revoked ${sessionId}`, 'Session revoked');
}

async function promptSetServerUrl(config, file, prompts) {
  const server = await prompts.text({
    message: 'SuperCollab server URL',
    defaultValue: config.serverUrl || DEFAULT_SERVER,
    placeholder: DEFAULT_SERVER,
    validate: (value) => {
      try {
        const parsed = new URL(String(value || ''));
        return parsed.protocol === 'https:' || parsed.hostname === 'localhost' ? undefined : 'Use https:// for remote servers';
      } catch {
        return 'Enter a valid URL';
      }
    },
  });
  if (prompts.isCancel(server)) throw new Error('cancelled');
  config.serverUrl = trimmed(server).replace(/\/$/, '');
  saveConfig(config, file);
  prompts.note(config.serverUrl, 'Server URL saved');
}

async function runRoomsMenu(config, file, prompts) {
  while (true) {
    const action = await prompts.select({
      message: 'Rooms',
      options: [
        { value: 'browse', label: 'Browse/select room', hint: 'scroll rooms or type room ID' },
        { value: 'create', label: 'Create room', hint: 'sets up backend room and local key' },
        { value: 'join', label: 'Join with private invite', hint: 'saves room key locally' },
        { value: 'invite', label: 'Create private invite' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (prompts.isCancel(action) || action === 'back') return;
    try {
      if (action === 'browse') await promptBrowseRooms(config, file, prompts);
      if (action === 'create') {
        const created = await promptCreateRoom(config, file, prompts);
        if (created?.room_id) await promptRoomActions(config, file, prompts, created.room_id);
      }
      if (action === 'join') {
        const joined = await promptJoinRoom(config, file, prompts);
        if (joined?.room_id) await promptRoomActions(config, file, prompts, joined.room_id);
      }
      if (action === 'invite') await promptCreateInvite(config, file, prompts);
    } catch (err) {
      if (err.message !== 'cancelled') prompts.note(err.message || String(err), 'Room action failed');
    }
  }
}

async function runChatMenu(config, file, prompts) {
  while (true) {
    const action = await prompts.select({
      message: 'Chat',
      options: [
        { value: 'send', label: 'Send message/note' },
        { value: 'read', label: 'Read recent messages' },
        { value: 'search', label: 'Search transcript' },
        { value: 'sync', label: 'Sync room locally' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (prompts.isCancel(action) || action === 'back') return;
    try {
      if (action === 'send') await promptSendMessage(config, file, prompts);
      if (action === 'read') await promptReadMessages(config, file, prompts);
      if (action === 'search') await promptSearchMessages(config, file, prompts);
      if (action === 'sync') await promptSyncRoom(config, file, prompts);
    } catch (err) {
      if (err.message !== 'cancelled') prompts.note(err.message || String(err), 'Chat action failed');
    }
  }
}

async function runWorkspaceMenu(config, file, prompts) {
  while (true) {
    const active = await activeStatus(config, file, {});
    const action = await prompts.select({
      message: `Workspace activation (${active.active ? `active: ${active.room_id}` : 'off'})`,
      options: [
        { value: 'status', label: 'Show current status' },
        { value: 'activate', label: 'Activate this directory' },
        { value: 'activate_other', label: 'Activate another directory' },
        { value: 'deactivate', label: 'Deactivate directory' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (prompts.isCancel(action) || action === 'back') return;
    try {
      if (action === 'status') prompts.note(active.instructions, 'Current workspace');
      if (action === 'activate') await promptActivateRoom(config, file, prompts, { cwd: process.cwd() });
      if (action === 'activate_other') await promptActivateRoom(config, file, prompts);
      if (action === 'deactivate') await promptDeactivateRoom(config, file, prompts, { cwd: process.cwd() });
    } catch (err) {
      if (err.message !== 'cancelled') prompts.note(err.message || String(err), 'Workspace action failed');
    }
  }
}

async function runSettingsMenu(config, file, prompts) {
  while (true) {
    const action = await prompts.select({
      message: 'Settings',
      options: [
        { value: 'doctor', label: 'System check / install BGE model' },
        { value: 'account', label: 'Account and config status' },
        { value: 'install_codex', label: 'Install Codex MCP' },
        { value: 'install_claude_code', label: 'Install Claude Code MCP' },
        { value: 'mcp', label: 'MCP setup/config' },
        { value: 'sessions', label: 'Manage sessions' },
        { value: 'server', label: 'Set server URL' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (prompts.isCancel(action) || action === 'back') return;
    try {
      if (action === 'doctor') await promptSystemCheck(config, file, prompts);
      if (action === 'account') await promptAccountStatus(config, file, prompts);
      if (action === 'install_codex') await promptInstallCodex(config, file, prompts);
      if (action === 'install_claude_code') await promptInstallClaudeCode(config, file, prompts);
      if (action === 'mcp') await promptMcpConfig(config, file, prompts);
      if (action === 'sessions') await promptManageSessions(config, prompts);
      if (action === 'server') await promptSetServerUrl(config, file, prompts);
    } catch (err) {
      if (err.message !== 'cancelled') prompts.note(err.message || String(err), 'Settings action failed');
    }
  }
}

async function runMainMenu(config, file, opts = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('interactive menu requires a TTY');
  }
  if (!isConfigured(config)) {
    return runSetupWizard(config, file, opts);
  }
  const prompts = await loadPrompts();
  prompts.intro(`SuperCollab ${VERSION}`);
  try {
    while (true) {
      const active = await activeStatus(config, file, {});
      const action = await prompts.select({
        message: `Main menu (${config.username || 'user'} - ${active.active ? `active ${active.room_id}` : 'workspace off'})`,
        options: [
          { value: 'rooms', label: 'Rooms', hint: 'create, join, browse, invite' },
          { value: 'chat', label: 'Chat', hint: 'send, read, search, sync' },
          { value: 'workspace', label: 'Workspace activation', hint: 'turn SuperCollab on/off for directories' },
          { value: 'settings', label: 'Settings', hint: 'doctor, MCP config, sessions, server URL' },
          { value: 'setup', label: 'Run onboarding again' },
          { value: 'exit', label: 'Exit' },
        ],
      });
      if (prompts.isCancel(action) || action === 'exit') {
        prompts.outro('Done.');
        return { ok: true };
      }
      if (action === 'rooms') await runRoomsMenu(config, file, prompts);
      if (action === 'chat') await runChatMenu(config, file, prompts);
      if (action === 'workspace') await runWorkspaceMenu(config, file, prompts);
      if (action === 'settings') await runSettingsMenu(config, file, prompts);
      if (action === 'setup') return runSetupWizard(config, file, opts);
    }
  } catch (err) {
    prompts.cancel(err.message === 'cancelled' ? 'Menu closed.' : `Menu stopped: ${err.message}`);
    throw err;
  }
}

async function runSetupWizard(config, file, opts = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('interactive setup requires a TTY; run `supercollab doctor --json` for non-interactive diagnostics');
  }
  const prompts = await loadPrompts();
  prompts.intro(`SuperCollab ${VERSION}`);
  try {
    const spin = prompts.spinner();
    spin.start('Checking this machine and installing the local BGE model');
    const doctor = await runDoctor(config, file, {});
    if (doctor.ok) {
      spin.stop(`Local engine ready: ${doctor.local_engine.id}, ${doctor.local_engine.vector_version || 'sqlite-vec'}`);
    } else {
      spin.stop('Local engine check needs attention');
      for (const line of doctor.advice || []) prompts.note(line, 'Fix');
      const cont = await prompts.confirm({ message: 'Continue setup anyway?', initialValue: false });
      if (prompts.isCancel(cont) || !cont) throw new Error('cancelled');
    }

    await runAuthSetup(config, file, prompts);
    const room = await runRoomSetup(config, file, prompts);
    const roomId = room?.room_id || null;
    const activation = await runActivationSetup(config, file, roomId, prompts);
    const smoke = await runSetupSmoke(config, file, roomId, prompts);

    const client = await prompts.select({
      message: 'MCP setup',
      options: [
        { value: 'claude-code', label: 'Install Claude Code MCP', hint: 'runs claude mcp add now' },
        { value: 'codex-install', label: 'Install Codex MCP', hint: 'runs codex mcp add now' },
        { value: 'codex', label: 'Codex config', hint: 'print TOML only' },
        { value: 'claude', label: 'Claude', hint: 'JSON config snippet' },
        { value: 'manual', label: 'Manual', hint: 'stdio command' },
        { value: 'skip', label: 'Skip', hint: 'show later with mcp print-config' },
      ],
    });
    if (prompts.isCancel(client)) throw new Error('cancelled');

    config.onboarding = {
      completed_at: nowIso(),
      cli_version: VERSION,
      room_id: roomId,
      activation_root: activation?.cwd || null,
      smoke,
    };
    saveConfig(config, file);

    if (client === 'claude-code') {
      await promptInstallClaudeCode(config, file, prompts, { cwd: activation?.cwd || process.cwd(), scope: 'local' });
    } else if (client === 'codex-install') {
      await promptInstallCodex(config, file, prompts, { cwd: activation?.cwd || process.cwd() });
    } else if (client !== 'skip') {
      prompts.note(mcpConfigText(client, file), `${client} MCP config`);
    }
    prompts.outro(`Ready. Config saved at ${file}`);
    return { ok: true, room_id: roomId, activation, smoke, config: file };
  } catch (err) {
    prompts.cancel(err.message === 'cancelled' ? 'Setup cancelled.' : `Setup stopped: ${err.message}`);
    throw err;
  }
}

async function main() {
  const { positionals, opts } = parse(process.argv.slice(2));
  const [cmd, sub] = positionals;
  if (opts.help || cmd === 'help' || cmd === '-h') { printHelp(); return; }
  if (opts.version || cmd === 'version' || cmd === '-v') { console.log(VERSION); return; }
  const file = configPath(opts);
  const config = attachRuntimeConfig(loadConfig(file, opts.profile || null), file);
  config.serverUrl = opts.server || config.serverUrl || DEFAULT_SERVER;

  if (positionals.length === 0) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      return isConfigured(config)
        ? runMainMenu(config, file, opts)
        : runSetupWizard(config, file, opts);
    }
    printHelp();
    return;
  }
  if (cmd === 'menu') return runMainMenu(config, file, opts);
  if (cmd === 'setup') return runSetupWizard(config, file, opts);
  if (cmd === 'doctor') {
    const data = await runDoctor(config, file, opts);
    if (opts.json) return console.log(JSON.stringify(data, null, 2));
    printDoctor(data);
    return;
  }
  if (cmd === 'account') {
    if (sub === 'create') return console.log(JSON.stringify(await doAccountSetup(config, file, opts), null, 2));
    if (sub === 'status') return console.log(JSON.stringify(await accountStatus(config, file, opts), null, 2));
    if (sub === 'rotate-key') return console.log(JSON.stringify(await rotateAccountKey(config, file), null, 2));
  }
  if (cmd === 'whoami') return console.log(JSON.stringify(await apiAsUser(config, 'GET', '/v1/me'), null, 2));
  if (cmd === 'config' && sub === 'path') return console.log(file);
  if (cmd === 'profile') {
    if (sub === 'list') return console.log(JSON.stringify(listAgentProfiles(config), null, 2));
    if (sub === 'create') return console.log(JSON.stringify(await createAgentProfile(config, file, opts), null, 2));
    if (sub === 'revoke') return console.log(JSON.stringify(await revokeAgentProfile(config, file, opts), null, 2));
  }
  if (cmd === 'agent') {
    if (sub === 'list') return console.log(JSON.stringify(await apiAsUser(config, 'GET', '/v1/agents'), null, 2));
    if (sub === 'revoke') return console.log(JSON.stringify(await apiAsUser(config, 'DELETE', `/v1/agents/${encodeURIComponent(requireValue(opts, 'agent'))}`), null, 2));
    if (sub === 'register') {
      const label = String(opts.label || 'SuperCollab agent');
      const data = opts.replace
        ? await rotateAgent(config, file, label)
        : await registerAgent(config, label);
      if (!opts.replace) saveConfig(config, file);
      return console.log(JSON.stringify({
        ok: true,
        agent_id: data.agent_id,
        fingerprint: data.fingerprint,
        replaced_agent_id: data.replaced_agent_id || null,
        profile: config.__profileName || 'default',
        config: file,
      }, null, 2));
    }
  }
  if (cmd === 'room') {
    if (sub === 'list') return console.log(JSON.stringify(await apiAsAgent(config, 'GET', '/v1/rooms'), null, 2));
    if (sub === 'create') return console.log(JSON.stringify(await doRoomCreate(config, file, opts), null, 2));
    if (sub === 'invite') return console.log(JSON.stringify(await doRoomInvite(config, opts), null, 2));
    if (sub === 'invites') return console.log(JSON.stringify(await apiAsAgent(config, 'GET', `/v1/rooms/${requireValue(opts, 'room')}/invites`), null, 2));
    if (sub === 'join') return console.log(JSON.stringify(await doRoomJoin(config, file, opts), null, 2));
    if (sub === 'key') return console.log(ensureRoomKey(config, requireValue(opts, 'room')));
  }
  if (cmd === 'chat') {
    if (sub === 'send') return console.log(JSON.stringify(await doChatSend(config, file, opts), null, 2));
    if (sub === 'read') return console.log(JSON.stringify(await doChatRead(config, file, opts), null, 2));
    if (sub === 'search') return console.log(JSON.stringify(await doChatSearch(config, file, opts), null, 2));
  }
  if (cmd === 'sync') return console.log(JSON.stringify(await syncRoom(config, file, requireValue(opts, 'room')), null, 2));
  if (cmd === 'activate') return console.log(JSON.stringify(activate(config, file, opts), null, 2));
  if (cmd === 'deactivate') return console.log(JSON.stringify(deactivate(config, file, opts), null, 2));
  if (cmd === 'active') return console.log(JSON.stringify(await activeStatus(config, file, opts), null, 2));
  if (cmd === 'session') {
    if (sub === 'list') return console.log(JSON.stringify(await apiAsUser(config, 'GET', '/v1/agent-sessions'), null, 2));
    if (sub === 'revoke') return console.log(JSON.stringify(await apiAsUser(config, 'DELETE', `/v1/agent-sessions/${requireValue(opts, 'session')}`), null, 2));
  }
  if (cmd === 'embeddings') {
    if (sub === 'status') return console.log(JSON.stringify(await embeddingStatus(), null, 2));
    if (sub === 'warmup') return console.log(JSON.stringify(await embeddingWarmup(), null, 2));
  }
  if (cmd === 'mcp' && sub === 'stdio') return runMcp(opts);
  if (cmd === 'mcp' && sub === 'install') return console.log(JSON.stringify(await installMcpClient(config, file, opts), null, 2));
  if (cmd === 'mcp' && sub === 'smoke') return console.log(JSON.stringify(await runMcpSmoke(opts), null, 2));
  if (cmd === 'mcp' && sub === 'print-config') return printCodexConfig(opts);
  throw new Error(`unknown command: ${positionals.join(' ')}`);
}

if (path.resolve(process.argv[1] || '') === CLI_ENTRY) {
  main().catch((err) => {
    console.error(`supercollab: ${err.message}`);
    process.exit(1);
  });
}
