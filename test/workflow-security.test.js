import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');
const SHA_PIN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.\/-]+)?@[0-9a-f]{40}$/;

test('workflows pin actions and do not consume repository secrets', () => {
  const files = readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'));
  assert.ok(files.length >= 4);

  for (const file of files) {
    const body = readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
    assert.equal(body.includes('pull_request_target:'), false, `${file}: pull_request_target is forbidden`);
    assert.equal(body.includes('secrets.'), false, `${file}: use OIDC or github.token, not repository secrets`);

    for (const line of body.split('\n')) {
      const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/);
      if (!match || match[1].startsWith('./')) continue;
      assert.match(match[1], SHA_PIN, `${file}: action must use a full commit SHA: ${match[1]}`);
    }
  }
});
