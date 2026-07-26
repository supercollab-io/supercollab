import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'supercollab.js');
const ACCOUNT_KEY = `scak_${Buffer.alloc(32, 9).toString('base64url')}`;

function runCli(args, options = {}) {
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

test('agent profiles isolate client identities without duplicating account state', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'supercollab-profiles-'));
  const configFile = path.join(home, '.supercollab', 'config.json');
  const baseConfig = {
    serverUrl: '',
    userId: 'usr_test',
    username: 'tester',
    accountKey: ACCOUNT_KEY,
    agentId: 'ag_legacyAgent1',
    agentLabel: 'legacy-agent',
    agentFingerprint: 'ed25519:legacy',
    agentPrivateKeyPem: 'legacy-private-key',
    roomKeys: { room_test: `sck_${Buffer.alloc(32, 7).toString('base64url')}` },
    activations: { [home]: { roomId: 'room_test', enabled: true } },
  };

  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/agents/register');
    assert.equal(request.headers.authorization, `Bearer ${ACCOUNT_KEY}`);
    let raw = '';
    request.on('data', (chunk) => { raw += chunk.toString(); });
    request.on('end', () => {
      const body = JSON.parse(raw);
      assert.equal(body.label, 'Codex laptop');
      assert.match(body.public_key_pem, /BEGIN PUBLIC KEY/);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        agent_id: 'ag_codexProfile1',
        label: body.label,
        fingerprint: 'ed25519:codex-profile',
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  baseConfig.serverUrl = `http://127.0.0.1:${server.address().port}`;
  mkdirSync(path.dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify(baseConfig), { mode: 0o600 });

  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex') };
  const created = await runCli([
    'profile', 'create',
    '--name', 'codex',
    '--label', 'Codex laptop',
    '--config', configFile,
  ], { cwd: home, env });
  assert.equal(created.status, 0, created.stderr);
  const output = JSON.parse(created.stdout);
  assert.equal(output.profile.name, 'codex');
  assert.equal(output.profile.agent_id, 'ag_codexProfile1');
  assert.equal(created.stdout.includes('PRIVATE KEY'), false);

  const saved = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(saved.accountKey, ACCOUNT_KEY);
  assert.equal(saved.agentId, 'ag_legacyAgent1');
  assert.equal(saved.agentPrivateKeyPem, 'legacy-private-key');
  assert.equal(saved.agentProfiles.codex.agentId, 'ag_codexProfile1');
  assert.match(saved.agentProfiles.codex.agentPrivateKeyPem, /BEGIN PRIVATE KEY/);
  assert.equal(saved.agentProfiles.codex.agentSessionToken, undefined);
  assert.equal(statSync(configFile).mode & 0o777, 0o600);

  const listed = await runCli(['profile', 'list', '--config', configFile], { cwd: home, env });
  assert.equal(listed.status, 0, listed.stderr);
  const list = JSON.parse(listed.stdout);
  assert.deepEqual(list.profiles.map((profile) => profile.name), ['default', 'codex']);
  assert.equal(listed.stdout.includes(ACCOUNT_KEY), false);
  assert.equal(listed.stdout.includes('PRIVATE KEY'), false);

  const smoke = await runCli([
    'mcp', 'smoke',
    '--config', configFile,
    '--profile', 'codex',
    '--cwd', home,
    '--timeout', '10000',
  ], { cwd: home, env });
  assert.equal(smoke.status, 0, smoke.stderr);
  assert.equal(JSON.parse(smoke.stdout).ok, true);
});

test('MCP dry-run installers preserve the selected profile for Codex and Claude', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'supercollab-install-plan-'));
  const configFile = path.join(home, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    serverUrl: 'https://example.invalid',
    accountKey: ACCOUNT_KEY,
    activations: {},
    agentProfiles: {
      codex: {
        agentId: 'ag_codexProfile1',
        agentLabel: 'codex',
        agentFingerprint: 'ed25519:codex',
        agentPrivateKeyPem: 'unused-by-status',
      },
    },
  }), { mode: 0o600 });
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex') };

  for (const client of ['codex', 'claude-code']) {
    const result = await runCli([
      'mcp', 'install',
      '--client', client,
      '--dry-run',
      '--config', configFile,
      '--profile', 'codex',
      '--cwd', home,
    ], { cwd: home, env });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.ok, true);
    assert.equal(data.dry_run, true);
    assert.equal(data.profile, 'codex');
    assert.match(data.install_command, /--profile codex/);
    assert.equal(data.remove_command, null);
  }
});

test('agent register refuses to overwrite an identity without an explicit replacement', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'supercollab-register-guard-'));
  const configFile = path.join(home, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    serverUrl: 'https://example.invalid',
    accountKey: ACCOUNT_KEY,
    agentId: 'ag_existingAgent1',
    agentPrivateKeyPem: 'existing-private-key',
  }), { mode: 0o600 });
  const result = await runCli([
    'agent', 'register',
    '--label', 'replacement',
    '--config', configFile,
  ], { cwd: home, env: { ...process.env, HOME: home } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already has agent/);
  assert.match(result.stderr, /--replace/);
});

test('profile revoke disables the server agent before removing the local key', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'supercollab-profile-revoke-'));
  const configFile = path.join(home, 'config.json');
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'DELETE');
    assert.equal(request.url, '/v1/agents/ag_codexProfile1');
    assert.equal(request.headers.authorization, `Bearer ${ACCOUNT_KEY}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, agent_id: 'ag_codexProfile1', revoked: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  writeFileSync(configFile, JSON.stringify({
    serverUrl: `http://127.0.0.1:${server.address().port}`,
    accountKey: ACCOUNT_KEY,
    agentProfiles: {
      codex: {
        agentId: 'ag_codexProfile1',
        agentPrivateKeyPem: 'profile-private-key',
      },
    },
  }), { mode: 0o600 });

  const result = await runCli([
    'profile', 'revoke', '--name', 'codex', '--config', configFile,
  ], { cwd: home, env: { ...process.env, HOME: home } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.local_profile_removed, true);
  assert.equal(output.agent_id, 'ag_codexProfile1');
  assert.equal(result.stdout.includes('profile-private-key'), false);
  const saved = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(saved.agentProfiles.codex, undefined);
});

test('explicit agent replacement registers the new key before revoking the old agent', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'supercollab-agent-rotate-'));
  const configFile = path.join(home, 'config.json');
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    assert.equal(request.headers.authorization, `Bearer ${ACCOUNT_KEY}`);
    if (request.method === 'GET' && request.url === '/v1/agents') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ agents: [{ agent_id: 'ag_oldAgent12345' }] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/agents/register') {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          agent_id: 'ag_newAgent12345',
          label: 'rotated',
          fingerprint: 'ed25519:new',
        }));
      });
      return;
    }
    if (request.method === 'DELETE' && request.url === '/v1/agents/ag_oldAgent12345') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, agent_id: 'ag_oldAgent12345', revoked: true }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  writeFileSync(configFile, JSON.stringify({
    serverUrl: `http://127.0.0.1:${server.address().port}`,
    accountKey: ACCOUNT_KEY,
    agentId: 'ag_oldAgent12345',
    agentLabel: 'old',
    agentFingerprint: 'ed25519:old',
    agentPrivateKeyPem: 'old-private-key',
  }), { mode: 0o600 });

  const result = await runCli([
    'agent', 'register', '--replace', '--label', 'rotated', '--config', configFile,
  ], { cwd: home, env: { ...process.env, HOME: home } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.agent_id, 'ag_newAgent12345');
  assert.equal(output.replaced_agent_id, 'ag_oldAgent12345');
  assert.deepEqual(requests, [
    'GET /v1/agents',
    'POST /v1/agents/register',
    'DELETE /v1/agents/ag_oldAgent12345',
  ]);
  const saved = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(saved.agentId, 'ag_newAgent12345');
  assert.match(saved.agentPrivateKeyPem, /BEGIN PRIVATE KEY/);
  assert.equal(saved.agentSessionToken, undefined);
});

test('failed old-agent revocation restores the previous local identity', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'supercollab-agent-rotate-rollback-'));
  const configFile = path.join(home, 'config.json');
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ agents: [] }));
      return;
    }
    if (request.method === 'POST') {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ agent_id: 'ag_newAgent12345', label: 'new', fingerprint: 'ed25519:new' }));
      });
      return;
    }
    if (request.url === '/v1/agents/ag_oldAgent12345') {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ detail: 'injected failure' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  writeFileSync(configFile, JSON.stringify({
    serverUrl: `http://127.0.0.1:${server.address().port}`,
    accountKey: ACCOUNT_KEY,
    agentId: 'ag_oldAgent12345',
    agentLabel: 'old',
    agentFingerprint: 'ed25519:old',
    agentPrivateKeyPem: 'old-private-key',
    agentSessionToken: 'old-session',
    agentSessionExpiresAt: 9999999999,
  }), { mode: 0o600 });

  const result = await runCli([
    'agent', 'register', '--replace', '--label', 'new', '--config', configFile,
  ], { cwd: home, env: { ...process.env, HOME: home } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /previous local identity restored/i);
  const saved = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(saved.agentId, 'ag_oldAgent12345');
  assert.equal(saved.agentPrivateKeyPem, 'old-private-key');
  assert.equal(saved.agentSessionToken, 'old-session');
  assert.deepEqual(requests, [
    'GET /v1/agents',
    'POST /v1/agents/register',
    'DELETE /v1/agents/ag_oldAgent12345',
    'DELETE /v1/agents/ag_newAgent12345',
  ]);
});

test('failed Codex replacement restores the exact prior client config', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'supercollab-codex-rollback-'));
  const codexHome = path.join(home, '.codex');
  const codexConfig = path.join(codexHome, 'config.toml');
  const supercollabConfig = path.join(home, 'supercollab.json');
  const fakeCodex = path.join(home, 'fake-codex.mjs');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(codexConfig, 'original-codex-config\n', { mode: 0o600 });
  writeFileSync(supercollabConfig, JSON.stringify({
    serverUrl: 'https://example.invalid',
    activations: {},
    accountKey: ACCOUNT_KEY,
    agentId: 'ag_testAgent1234',
    agentPrivateKeyPem: 'test-key',
  }), { mode: 0o600 });
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const config = process.env.CODEX_HOME + '/config.toml';
if (args[0] === '--version') { console.log('codex-test'); process.exit(0); }
if (args[0] === 'mcp' && args[1] === 'get') {
  console.log(JSON.stringify({name:'supercollab',transport:{type:'stdio',command:'/wrong',args:[],env:{}}}));
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'remove') { fs.writeFileSync(config, 'removed\\n'); process.exit(0); }
if (args[0] === 'mcp' && args[1] === 'add') { fs.writeFileSync(config, 'broken\\n'); console.error('injected add failure'); process.exit(9); }
process.exit(1);
`, { mode: 0o700 });
  chmodSync(fakeCodex, 0o700);

  const result = await runCli([
    'mcp', 'install',
    '--client', 'codex',
    '--replace',
    '--codex', fakeCodex,
    '--config', supercollabConfig,
    '--cwd', home,
  ], { cwd: home, env: { ...process.env, HOME: home, CODEX_HOME: codexHome } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Previous Codex configuration restored/);
  assert.equal(readFileSync(codexConfig, 'utf8'), 'original-codex-config\n');
  assert.equal(statSync(codexConfig).mode & 0o777, 0o600);
});

test('failed Claude replacement restores the exact prior client config', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'supercollab-claude-rollback-'));
  const claudeConfig = path.join(home, '.claude.json');
  const supercollabConfig = path.join(home, 'supercollab.json');
  const fakeClaude = path.join(home, 'fake-claude.mjs');
  writeFileSync(claudeConfig, '{"original":true}\n', { mode: 0o600 });
  writeFileSync(supercollabConfig, JSON.stringify({
    serverUrl: 'https://example.invalid',
    activations: {},
    accountKey: ACCOUNT_KEY,
    agentId: 'ag_testAgent1234',
    agentPrivateKeyPem: 'test-key',
  }), { mode: 0o600 });
  writeFileSync(fakeClaude, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const config = process.env.HOME + '/.claude.json';
if (args[0] === '--version') { console.log('claude-test'); process.exit(0); }
if (args[0] === 'mcp' && args[1] === 'get') { console.log('supercollab: wrong entry'); process.exit(0); }
if (args[0] === 'mcp' && args[1] === 'remove') { fs.writeFileSync(config, 'removed\\n'); process.exit(0); }
if (args[0] === 'mcp' && args[1] === 'add') { fs.writeFileSync(config, 'broken\\n'); console.error('injected add failure'); process.exit(9); }
process.exit(1);
`, { mode: 0o700 });
  chmodSync(fakeClaude, 0o700);

  const result = await runCli([
    'mcp', 'install',
    '--client', 'claude-code',
    '--scope', 'local',
    '--replace',
    '--claude', fakeClaude,
    '--config', supercollabConfig,
    '--cwd', home,
  ], { cwd: home, env: { ...process.env, HOME: home } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Previous Claude Code configuration restored/);
  assert.equal(readFileSync(claudeConfig, 'utf8'), '{"original":true}\n');
  assert.equal(statSync(claudeConfig).mode & 0o777, 0o600);
});
