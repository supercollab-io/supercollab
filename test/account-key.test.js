import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'supercollab.js');
const MCP = path.join(ROOT, 'bin', 'supercollab-mcp.js');
const KEY_PATTERN = /^scak_[A-Za-z0-9_-]{43}$/;
const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk.toString(); });
    request.once('error', reject);
    request.once('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); }
    });
  });
}

function runCli(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

async function callMcpTool({ home, configFile, serverUrl, profile, name, arguments: toolArguments }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP],
    cwd: home,
    env: {
      HOME: home,
      PATH: process.env.PATH,
      SUPERCOLLAB_CONFIG: configFile,
      SUPERCOLLAB_URL: serverUrl,
      ...(profile ? { SUPERCOLLAB_PROFILE: profile } : {}),
      SUPERCOLLAB_WORKDIR: home,
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const client = new Client({ name: 'account-key-test', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: toolArguments });
    return { result, text: result.content[0].text, stderr };
  } finally {
    await client.close();
  }
}

test('public MCP entry selects an independently revocable host profile', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'supercollab-profile-entry-'));
  const configFile = path.join(home, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    serverUrl: 'http://127.0.0.1:9',
    accountKey: `scak_${Buffer.alloc(32, 4).toString('base64url')}`,
    userId: 'usr_profileUser123',
    username: 'profile_user',
    agentId: 'ag_defaultAgent12',
    agentLabel: 'Default host',
    agentFingerprint: 'ed25519:default',
    agentPrivateKeyPem: 'default-private',
    agentProfiles: {
      codex: {
        agentId: 'ag_codexAgent1234',
        agentLabel: 'Codex host',
        agentFingerprint: 'ed25519:codex',
        agentPrivateKeyPem: 'codex-private',
      },
    },
  }), { mode: 0o600 });

  const status = await callMcpTool({
    home,
    configFile,
    serverUrl: 'http://127.0.0.1:9',
    profile: 'codex',
    name: 'supercollab_status',
    arguments: {},
  });
  assert.equal(status.result.isError, undefined, status.text);
  const payload = JSON.parse(status.text);
  assert.equal(payload.agent_id, 'ag_codexAgent1234');
  assert.equal(payload.agent_fingerprint, 'ed25519:codex');
});

function callSetup(options) {
  return callMcpTool({
    ...options,
    name: 'supercollab_setup',
    arguments: { username: 'first_user', agent_label: 'Codex test' },
  });
}

test('version commands are quiet and successful', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'supercollab-version-'));
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex') };
  for (const args of [['--version'], ['-v'], ['version']]) {
    const result = await runCli(args, { cwd: home, env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${PACKAGE_VERSION}\n`);
  }
});

test('MCP setup creates one account and agent without returning either private key', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'supercollab-key-setup-'));
  const configFile = path.join(home, '.supercollab', 'config.json');
  const calls = [];
  let accountKey = null;

  const server = http.createServer(async (request, response) => {
    calls.push(`${request.method} ${request.url}`);
    try {
      if (request.method === 'GET' && request.url === '/v1/auth/config') {
        return json(response, 200, {
          mode: 'account_key',
          signup_enabled: true,
          account_key: { generated_by_client: true, prefix: 'scak_', entropy_bits: 256 },
        });
      }
      if (request.method === 'POST' && request.url === '/v1/auth/register') {
        const body = await readJson(request);
        assert.equal(body.username, 'first_user');
        assert.match(body.account_key, KEY_PATTERN);
        accountKey = body.account_key;
        return json(response, 200, { user_id: 'usr_firstUser1234', username: body.username, created: true });
      }
      if (request.method === 'POST' && request.url === '/v1/agents/register') {
        assert.equal(request.headers.authorization, `Bearer ${accountKey}`);
        const body = await readJson(request);
        assert.equal(body.label, 'Codex test');
        assert.match(body.public_key_pem, /BEGIN PUBLIC KEY/);
        return json(response, 200, {
          agent_id: 'ag_firstAgent1234',
          label: body.label,
          fingerprint: 'ed25519:first-agent',
        });
      }
      if (request.method === 'GET' && request.url === '/v1/me') {
        assert.equal(request.headers.authorization, `Bearer ${accountKey}`);
        return json(response, 200, {
          actor: { type: 'user', user_id: 'usr_firstUser1234', username: 'first_user', auth_method: 'account_key' },
        });
      }
      return json(response, 404, { detail: 'not found' });
    } catch (error) {
      return json(response, 500, { detail: error.message });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const serverUrl = `http://127.0.0.1:${server.address().port}`;

  const first = await callSetup({ home, configFile, serverUrl });
  assert.equal(first.result.isError, undefined);
  const firstResult = JSON.parse(first.text);
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.created, true);
  assert.equal(firstResult.account_key_returned, false);
  assert.equal(first.text.includes(accountKey), false);
  assert.equal(first.text.includes('PRIVATE KEY'), false);
  assert.equal(first.stderr.includes(accountKey), false);

  const saved = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(saved.accountKey, accountKey);
  assert.equal(saved.userId, 'usr_firstUser1234');
  assert.equal(saved.agentId, 'ag_firstAgent1234');
  assert.match(saved.agentPrivateKeyPem, /BEGIN PRIVATE KEY/);
  assert.equal(saved.pendingAccountSetup, undefined);
  assert.equal(statSync(configFile).mode & 0o777, 0o600);

  const second = await callSetup({ home, configFile, serverUrl });
  assert.equal(second.result.isError, undefined);
  const secondResult = JSON.parse(second.text);
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.created, false);
  assert.equal(second.text.includes(accountKey), false);
  assert.equal(second.stderr.includes(accountKey), false);
  assert.equal(calls.filter((call) => call === 'POST /v1/auth/register').length, 1);
  assert.equal(calls.filter((call) => call === 'POST /v1/agents/register').length, 1);

  saved.roomKeys = { room_private1234: `sck_${Buffer.alloc(32, 7).toString('base64url')}` };
  writeFileSync(configFile, JSON.stringify(saved), { mode: 0o600 });
  const activated = await callMcpTool({
    home,
    configFile,
    serverUrl,
    name: 'workspace_activate',
    arguments: { room_id: 'room_private1234' },
  });
  assert.equal(activated.result.isError, undefined);
  assert.equal(JSON.parse(activated.text).sharing_mode, 'manual');

  const unapproved = await callMcpTool({
    home,
    configFile,
    serverUrl,
    name: 'chat_send',
    arguments: { message: 'ambient conversation must not be sent' },
  });
  assert.equal(unapproved.result.isError, true);
  assert.match(unapproved.text, /explicit user request/i);
  assert.equal(calls.some((call) => call.includes('/messages')), false);
});

test('account-key rotation replaces the key without exposing it or replacing agents', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'supercollab-key-rotate-'));
  const configFile = path.join(home, 'config.json');
  const oldKey = `scak_${Buffer.alloc(32, 3).toString('base64url')}`;
  let acceptedKey = oldKey;
  let proposedKey = null;
  writeFileSync(configFile, JSON.stringify({
    serverUrl: '',
    accountKey: oldKey,
    userId: 'usr_rotateUser123',
    username: 'rotate_user',
    accountBindingUserId: 'usr_rotateUser123',
    accountBindingUsername: 'rotate_user',
    agentId: 'ag_keepAgent12345',
    agentPrivateKeyPem: 'keep-this-private-key',
  }), { mode: 0o600 });

  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/me') {
      if (request.headers.authorization !== `Bearer ${acceptedKey}`) {
        return json(response, 401, { detail: 'invalid or expired token' });
      }
      return json(response, 200, { actor: { type: 'user', user_id: 'usr_rotateUser123', username: 'rotate_user' } });
    }
    if (request.method === 'POST' && request.url === '/v1/auth/rotate') {
      assert.equal(request.headers.authorization, `Bearer ${oldKey}`);
      const body = await readJson(request);
      assert.match(body.new_account_key, KEY_PATTERN);
      proposedKey = body.new_account_key;
      acceptedKey = proposedKey;
      return json(response, 200, { ok: true, rotated: true });
    }
    return json(response, 404, { detail: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.serverUrl = serverUrl;
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });

  const unconfirmed = await callMcpTool({
    home,
    configFile,
    serverUrl,
    name: 'account_rotate_key',
    arguments: { confirmed_by_user: false },
  });
  assert.equal(unconfirmed.result.isError, true);
  assert.equal(proposedKey, null);

  const result = await callMcpTool({
    home,
    configFile,
    serverUrl,
    name: 'account_rotate_key',
    arguments: { confirmed_by_user: true },
  });
  assert.equal(result.result.isError, undefined, result.text);
  assert.match(proposedKey, KEY_PATTERN);
  assert.equal(result.text.includes(oldKey), false);
  assert.equal(result.text.includes(proposedKey), false);
  assert.equal(result.stderr.includes(oldKey), false);
  assert.equal(result.stderr.includes(proposedKey), false);

  const saved = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(saved.accountKey, proposedKey);
  assert.equal(saved.pendingKeyRotation, undefined);
  assert.equal(saved.agentId, 'ag_keepAgent12345');
  assert.equal(saved.agentPrivateKeyPem, 'keep-this-private-key');
  assert.equal(statSync(configFile).mode & 0o777, 0o600);
});

test('credential config must be a private regular file', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'supercollab-private-config-'));
  const configFile = path.join(home, 'config.json');
  const accountKey = `scak_${Buffer.alloc(32, 9).toString('base64url')}`;
  writeFileSync(configFile, JSON.stringify({ accountKey }), { mode: 0o600 });
  chmodSync(configFile, 0o644);

  const exposed = await runCli(['account', 'status', '--local', '--config', configFile], {
    cwd: home,
    env: { ...process.env, HOME: home },
  });
  assert.notEqual(exposed.status, 0);
  assert.match(exposed.stderr, /chmod 600/);
  assert.equal(exposed.stderr.includes(accountKey), false);

  chmodSync(configFile, 0o600);
  const symlinkFile = path.join(home, 'linked-config.json');
  symlinkSync(configFile, symlinkFile);
  const linked = await runCli(['account', 'status', '--local', '--config', symlinkFile], {
    cwd: home,
    env: { ...process.env, HOME: home },
  });
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /symlinked SuperCollab config/);
  assert.equal(linked.stderr.includes(accountKey), false);
});

test('untrusted room identifiers cannot escape the local chat directory', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'supercollab-room-path-'));
  const configFile = path.join(home, 'config.json');
  const escapeTarget = path.join(home, 'escape', 'chat.sqlite');
  writeFileSync(configFile, JSON.stringify({
    serverUrl: 'http://127.0.0.1:9',
    accountKey: `scak_${Buffer.alloc(32, 8).toString('base64url')}`,
    agentId: 'ag_pathTest1234',
    agentPrivateKeyPem: 'not-used',
    roomKeys: { '../../escape': `sck_${Buffer.alloc(32, 7).toString('base64url')}` },
  }), { mode: 0o600 });

  const result = await runCli(['chat', 'read', '--room', '../../escape', '--config', configFile], {
    cwd: home,
    env: { ...process.env, HOME: home },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid SuperCollab room ID/);
  assert.equal(existsSync(escapeTarget), false);
});
