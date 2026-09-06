import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOM = 'room_syncFixture';

async function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'supercollab-receive-'));
  const rows = [];
  const requests = [];
  const clients = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push({ method: request.method, after: url.searchParams.get('after') });
    if (url.pathname !== `/v1/rooms/${ROOM}/messages`) {
      response.writeHead(404).end();
      return;
    }
    let data;
    if (request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const id = rows.length + 1;
      const message = {
        ...JSON.parse(body), id, room_id: ROOM,
        message_id: `msg_fixture${String(id).padStart(8, '0')}`,
        actor_type: 'agent', actor_id: 'ag_fixture1234',
        user_id: 'usr_fixture1234', sender_label: 'fixture agent',
        content_hash: 'fixture', created_at: new Date().toISOString(),
      };
      rows.push(message);
      data = { message };
    } else {
      const after = Number(url.searchParams.get('after') || 0);
      const messages = rows.filter((row) => row.id > after)
        .slice(0, Number(url.searchParams.get('limit') || 100));
      data = { messages, next_after: messages.at(-1)?.id || after };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(data));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const client of clients) await client.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const roomKey = `sck_${crypto.randomBytes(32).toString('base64url')}`;
  const workspace = path.join(directory, 'workspace');
  mkdirSync(workspace);

  function configFor(name) {
    const accountDirectory = path.join(directory, name);
    mkdirSync(accountDirectory, { mode: 0o700 });
    const file = path.join(accountDirectory, 'config.json');
    writeFileSync(file, JSON.stringify({
      serverUrl: `http://127.0.0.1:${server.address().port}`,
      accountKey: `scak_${crypto.randomBytes(32).toString('base64url')}`,
      userId: `usr_${name}Fixture1234`, username: name,
      agentId: `ag_${name}Fixture1234`, agentPrivateKeyPem: 'unused with cached fixture session',
      agentSessionToken: `fixture-${name}`, agentSessionExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      roomKeys: { [ROOM]: roomKey },
      activations: { [workspace]: { roomId: ROOM, enabled: true, sharingMode: 'manual' } },
    }), { mode: 0o600 });
    return file;
  }

  async function connect(file, cwd = workspace) {
    mkdirSync(cwd, { recursive: true });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', path.join(ROOT, 'test/fixtures/register-embedding-loader.mjs'), path.join(ROOT, 'bin/supercollab-mcp.js')],
      cwd,
      env: { PATH: process.env.PATH, SUPERCOLLAB_CONFIG: file, SUPERCOLLAB_WORKDIR: cwd },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'room-regression', version: '1.0.0' }, { capabilities: {} });
    clients.push(client);
    await client.connect(transport);
    return client;
  }
  return { directory, rows, requests, workspace, configFor, connect };
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

test('sending before reading preserves earlier peer messages through MCP and local search', async (t) => {
  const f = await fixture(t);
  const alice = await f.connect(f.configFor('alice'));
  const bob = await f.connect(f.configFor('bob'));
  await call(bob, 'chat_send', { message: 'The API decision is cursor pagination.', confirmed_by_user: true });
  await call(alice, 'chat_send', { message: 'Frontend work has started.', confirmed_by_user: true });
  const read = await call(alice, 'chat_read');
  assert.equal(read.messages.length, 2);
  assert.equal(read.messages[0].body, 'The API decision is cursor pagination.');
  const search = await call(alice, 'chat_search', { query: 'pagination', mode: 'keyword' });
  assert.equal(search.results[0].body, read.messages[0].body);
  assert.deepEqual(f.requests.filter((r) => r.method === 'GET').map((r) => r.after), ['0', '2']);
  assert.equal(f.rows.some((row) => row.body.includes('pagination')), false);
});

test('upgraded clients backfill a legacy cursor that had advanced past unseen messages', async (t) => {
  const f = await fixture(t);
  const aliceConfig = f.configFor('alice');
  const alice = await f.connect(aliceConfig);
  const bob = await f.connect(f.configFor('bob'));
  await call(bob, 'chat_send', { message: 'Previously skipped decision.', confirmed_by_user: true });
  await call(alice, 'chat_send', { message: 'Previously cached local message.', confirmed_by_user: true });
  const db = new Database(path.join(path.dirname(aliceConfig), 'chats', ROOM, 'chat.sqlite'));
  try {
    db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run('last_message_id', '2');
  } finally {
    db.close();
  }
  const read = await call(alice, 'chat_read');
  assert.deepEqual(read.messages.map((message) => message.body), [
    'Previously skipped decision.', 'Previously cached local message.',
  ]);
  assert.equal((await call(alice, 'chat_read')).messages.length, 2);
});

test('a child workspace stays off across restarts while its parent and sibling remain active', async (t) => {
  const f = await fixture(t);
  const file = f.configFor('alice');
  const childDirectory = path.join(f.workspace, 'child');
  const child = await f.connect(file, childDirectory);
  const alreadyRunning = await f.connect(file, childDirectory);
  assert.equal((await call(child, 'supercollab_status')).active, true);
  assert.equal((await call(child, 'workspace_deactivate')).active, false);
  assert.equal((await call(child, 'supercollab_status')).active, false);
  assert.equal((await call(alreadyRunning, 'supercollab_status')).active, false);
  const prompt = await alreadyRunning.getPrompt({ name: 'supercollab_workspace_context' });
  assert.match(prompt.messages[0].content.text, /OFF/);
  for (const [name, args] of [
    ['chat_read', {}], ['chat_sync', {}], ['chat_search', { query: 'decision' }],
    ['chat_send', { message: 'Must not leave this workspace.', confirmed_by_user: true }],
  ]) {
    const result = await child.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, /OFF/);
  }
  const restarted = await f.connect(file, childDirectory);
  assert.equal((await call(restarted, 'supercollab_status')).active, false);
  const descendant = await f.connect(file, path.join(childDirectory, 'nested'));
  assert.equal((await call(descendant, 'supercollab_status')).active, false);
  const sibling = await f.connect(file, path.join(f.workspace, 'sibling'));
  assert.equal((await call(sibling, 'supercollab_status')).active, true);
  assert.equal(f.requests.length, 0);
  await call(restarted, 'workspace_activate', { room_id: ROOM });
  assert.equal((await call(restarted, 'supercollab_status')).active, true);
});
