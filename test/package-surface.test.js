import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('npm exposes one MCP runtime and no management CLI', () => {
  assert.equal(pkg.name, '@supercollab/mcp');
  assert.equal(pkg.homepage, 'https://supercollab.io');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository?.url, 'git+https://github.com/supercollab-io/supercollab.git');
  assert.equal(pkg.bugs?.url, 'https://github.com/supercollab-io/supercollab/issues');
  assert.deepEqual(pkg.bin, { 'supercollab-mcp': 'bin/supercollab-mcp.js' });
  assert.equal(pkg.dependencies?.['@clack/prompts'], undefined);
  assert.equal(statSync(path.join(ROOT, pkg.bin['supercollab-mcp'])).mode & 0o111, 0o111);
});

test('packed artifact contains the MCP entry and no retired CLI package metadata', () => {
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(packed.status, 0, packed.stderr);
  const parsed = JSON.parse(packed.stdout);
  const report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  assert.ok(report, 'npm pack did not return a package report');
  const files = new Set(report.files.map((file) => file.path));
  assert.equal(report.name, '@supercollab/mcp');
  assert.equal(files.has('LICENSE'), true);
  assert.equal(files.has('bin/supercollab-mcp.js'), true);
  assert.equal(files.has('web/assets/agents.json'), false);
  assert.equal(readFileSync(path.join(ROOT, 'package.json'), 'utf8').includes('@supercollab/cli'), false);
});
