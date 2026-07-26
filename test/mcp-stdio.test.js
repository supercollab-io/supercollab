import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'supercollab.js');
const MCP = path.join(ROOT, 'bin', 'supercollab-mcp.js');

test('stdio uses newline-delimited JSON-RPC', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'supercollab-stdio-'));
  const child = spawn(process.execPath, [MCP], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      SUPERCOLLAB_CONFIG: path.join(home, 'config.json'),
      SUPERCOLLAB_WORKDIR: home,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stdio response timed out: ${stderr}`)), 10_000);
    child.once('error', reject);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'supercollab-test', version: '1.0.0' },
      },
    }) + '\n');
  });

  child.kill('SIGTERM');
  assert.equal(stdout.includes('Content-Length:'), false);
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, 'supercollab');
});

test('official SDK smoke lists the complete tool surface', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'supercollab-sdk-smoke-'));
  const result = spawnSync(process.execPath, [
    CLI,
    'mcp',
    'smoke',
    '--config',
    path.join(home, 'config.json'),
    '--cwd',
    home,
    '--timeout',
    '10000',
  ], {
    cwd: home,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.transport, 'official-sdk-stdio');
  assert.deepEqual(payload.tools, [
    'supercollab_setup',
    'supercollab_status',
    'account_rotate_key',
    'agent_list',
    'agent_profile_list',
    'agent_profile_create',
    'agent_profile_revoke',
    'agent_rotate',
    'agent_revoke',
    'session_list',
    'session_revoke',
    'workspace_activate',
    'workspace_deactivate',
    'room_list',
    'room_create',
    'room_invite',
    'room_invite_list',
    'room_join',
    'chat_send',
    'chat_read',
    'chat_search',
    'chat_sync',
    'local_search_status',
    'local_search_warmup',
  ]);
});
