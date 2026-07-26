#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const catalog = readJson('web/assets/agents.json');
const pkg = readJson('package.json');
const evidenceSchema = readJson('compatibility/evidence.schema.json');
const errors = [];
const allowedVerification = new Set(['verified', 'config_ready', 'plan_review', 'adapter_planned']);
const allowedMcp = new Set(['native', 'adapter']);
const ids = new Set();

function expect(condition, message) {
  if (!condition) errors.push(message);
}

expect(catalog.schema_version === 1, 'catalog schema_version must be 1');
expect(catalog.runtime?.package === pkg.name, 'catalog runtime package must match package.json');
expect(catalog.runtime?.version === pkg.version, 'catalog runtime version must match package.json');
expect(catalog.runtime?.transport === 'stdio', 'public runtime transport must be stdio');
expect(pkg.homepage === 'https://supercollab.io', 'package homepage must use the canonical domain');
expect(Array.isArray(catalog.agents), 'catalog agents must be an array');

const runtimeSpec = `${pkg.name}@${pkg.version}`;
const runtimeSource = fs.readFileSync(path.join(root, 'bin/supercollab.js'), 'utf8');
expect(
  runtimeSource.includes(`const VERSION = '${pkg.version}';`),
  'runtime source version must match package.json',
);
expect(
  runtimeSource.includes(`'${pkg.homepage}'`),
  'runtime default relay must use the canonical domain',
);
for (const [index, agent] of (catalog.agents || []).entries()) {
  const label = agent?.id || `agent[${index}]`;
  expect(/^[a-z0-9-]+$/.test(agent?.id || ''), `${label}: invalid id`);
  expect(!ids.has(agent?.id), `${label}: duplicate id`);
  ids.add(agent?.id);
  expect(typeof agent?.name === 'string' && agent.name.length > 1, `${label}: missing name`);
  expect(typeof agent?.short_name === 'string' && agent.short_name.length > 0, `${label}: missing short_name`);
  expect(typeof agent?.featured === 'boolean', `${label}: featured must be boolean`);
  expect(allowedMcp.has(agent?.mcp), `${label}: unsupported mcp type`);
  expect(allowedVerification.has(agent?.verification), `${label}: unsupported verification state`);
  expect(typeof agent?.verification_label === 'string', `${label}: missing verification label`);
  expect(typeof agent?.access === 'string' && agent.access.length > 10, `${label}: access terms are missing`);
  expect(typeof agent?.summary === 'string' && agent.summary.length > 20, `${label}: summary is missing`);
  expect(typeof agent?.verify === 'string' && agent.verify.length > 20, `${label}: verification guidance is missing`);
  expect(/^https:\/\//.test(agent?.docs || ''), `${label}: docs must use HTTPS`);

  if (agent.logo !== null) {
    expect(/^\/assets\/agents\/[a-z0-9-]+\.svg$/.test(agent.logo || ''), `${label}: unsafe logo path`);
    const logoFile = path.join(root, 'web', String(agent.logo || '').replace(/^\//, ''));
    expect(fs.existsSync(logoFile), `${label}: logo file does not exist`);
  }

  if (agent.featured) {
    expect(agent.mcp === 'native', `${label}: featured clients must use native MCP`);
    expect(Boolean(agent.setup), `${label}: featured clients need a setup recipe`);
  }

  if (agent.setup) {
    expect(['command', 'json'].includes(agent.setup.format), `${label}: invalid setup format`);
    expect(typeof agent.setup.target === 'string' && agent.setup.target.length > 0, `${label}: setup target is missing`);
    expect(typeof agent.setup.value === 'string' && agent.setup.value.includes(runtimeSpec), `${label}: setup must pin ${runtimeSpec}`);
    expect(!agent.setup.value.includes('@latest'), `${label}: setup must not use @latest`);
    expect(!agent.setup.value.includes('@supercollab/cli'), `${label}: setup exposes the retired CLI package`);
  }

  if (agent.verification === 'verified') {
    expect(/^\d{4}-\d{2}-\d{2}$/.test(agent.verified_at || ''), `${label}: verified clients need a verification date`);
    expect(typeof agent.client_version === 'string' && agent.client_version.length > 0, `${label}: verified clients need a client version`);
    expect(Boolean(agent.setup), `${label}: verified clients need a setup recipe`);
  } else {
    expect(agent.verified_at === null, `${label}: unverified clients must have verified_at null`);
  }

  if (agent.config_tested_at !== undefined) {
    expect(agent.verification === 'config_ready', `${label}: config smoke evidence belongs only on config_ready clients`);
    expect(/^\d{4}-\d{2}-\d{2}$/.test(agent.config_tested_at || ''), `${label}: invalid config smoke date`);
    expect(typeof agent.config_tested_version === 'string' && agent.config_tested_version.length > 0, `${label}: config smoke needs a client version`);
    expect(typeof agent.config_tested_note === 'string' && agent.config_tested_note.length > 20, `${label}: config smoke needs an evidence note`);
  }
}

const featured = (catalog.agents || []).filter((agent) => agent.featured);
expect(featured.length === 6, `core catalog must contain exactly 6 clients, found ${featured.length}`);
expect(featured.filter((agent) => agent.verification === 'verified').length >= 2, 'core catalog must retain at least two real-client verification anchors');
expect(fs.existsSync(path.join(root, 'web/assets/agents/ATTRIBUTION.md')), 'logo attribution is missing');
expect(
  evidenceSchema.properties?.runtime?.const === runtimeSpec,
  'compatibility evidence schema must pin the release runtime',
);
expect(
  evidenceSchema.$id?.startsWith(`${pkg.homepage}/`),
  'compatibility evidence schema must use the canonical domain',
);
const labLauncher = path.join(root, 'compatibility/launch-lab.sh');
expect(fs.existsSync(labLauncher), 'compatibility lab launcher is missing');
if (fs.existsSync(labLauncher) && process.platform !== 'win32') {
  expect((fs.statSync(labLauncher).mode & 0o111) !== 0, 'compatibility lab launcher must be executable');
}

if (errors.length) {
  process.stderr.write(`Compatibility catalog failed (${errors.length}):\n- ${errors.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Compatibility catalog OK: ${featured.length} core, ${catalog.agents.length - featured.length} lab, runtime ${runtimeSpec}\n`);
}
