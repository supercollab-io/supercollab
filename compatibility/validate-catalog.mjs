#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const catalog = readJson('web/assets/agents.json');
const logoSources = readJson('web/assets/agents/SOURCES.json');
const pkg = readJson('package.json');
const errors = [];
const ids = new Set();
const expectedIds = new Set([
  'claude-code',
  'codex',
  'gemini-cli',
  'opencode',
  'github-copilot',
  'cline',
  'cursor',
  'factory-droid',
]);
const forbiddenCatalogKeys = new Set([
  'featured',
  'verification',
  'verification_label',
  'verified_at',
  'client_version',
  'config_tested_at',
  'config_tested_version',
  'config_tested_note',
  'verify',
]);

function expect(condition, message) {
  if (!condition) errors.push(message);
}

expect(catalog.schema_version === 2, 'catalog schema_version must be 2');
expect(catalog.runtime?.package === pkg.name, 'catalog runtime package must match package.json');
expect(catalog.runtime?.version === pkg.version, 'catalog runtime version must match package.json');
expect(catalog.runtime?.protocol === 'mcp', 'public runtime protocol must be MCP');
expect(catalog.runtime?.transport === 'stdio', 'public runtime transport must be stdio');
expect(pkg.homepage === 'https://supercollab.io', 'package homepage must use the canonical domain');
expect(Array.isArray(catalog.agents), 'catalog agents must be an array');
expect(logoSources.schema_version === 1, 'logo source manifest schema_version must be 1');
expect(Array.isArray(logoSources.assets), 'logo source manifest assets must be an array');

const logoSourceByFile = new Map((logoSources.assets || []).map((asset) => [asset.file, asset]));

const runtimeSpec = `${pkg.name}@${pkg.version}`;
const runtimeSource = fs.readFileSync(path.join(root, 'bin/supercollab.js'), 'utf8');
const siteHtml = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const siteScript = fs.readFileSync(path.join(root, 'web/assets/app.js'), 'utf8');
expect(
  runtimeSource.includes(`const VERSION = '${pkg.version}';`),
  'runtime source version must match package.json',
);
expect(
  runtimeSource.includes(`'${pkg.homepage}'`),
  'runtime default relay must use the canonical domain',
);
expect(
  siteHtml.includes(`/assets/styles.css?v=${pkg.version}`)
    && siteHtml.includes(`/assets/app.js?v=${pkg.version}`),
  'frontend entry assets must be cache-busted with package.json version',
);
expect(
  siteScript.includes(`const SITE_RELEASE = '${pkg.version}';`)
    && siteScript.includes("versionedLocalUrl('/assets/agents.json')"),
  'frontend catalog fetch must be cache-busted with package.json version',
);

for (const [index, agent] of (catalog.agents || []).entries()) {
  const label = agent?.id || `agent[${index}]`;
  expect(/^[a-z0-9-]+$/.test(agent?.id || ''), `${label}: invalid id`);
  expect(!ids.has(agent?.id), `${label}: duplicate id`);
  ids.add(agent?.id);
  expect(expectedIds.has(agent?.id), `${label}: agent is not in the supported host set`);
  expect(typeof agent?.name === 'string' && agent.name.length > 1, `${label}: missing name`);
  expect(typeof agent?.short_name === 'string' && agent.short_name.length > 0, `${label}: missing short_name`);
  expect(agent?.transport === 'stdio', `${label}: supported hosts must use local stdio`);
  expect(agent?.integration_label === 'Native stdio MCP', `${label}: incorrect integration label`);
  expect(typeof agent?.access === 'string' && agent.access.length > 20, `${label}: host boundary is missing`);
  expect(typeof agent?.summary === 'string' && agent.summary.length > 30, `${label}: summary is missing`);
  expect(typeof agent?.next_step === 'string' && agent.next_step.length > 30, `${label}: next step is missing`);

  for (const key of forbiddenCatalogKeys) {
    expect(!(key in (agent || {})), `${label}: public catalog must not contain ${key}`);
  }

  expect(/^\/assets\/agents\/[a-z0-9-]+\.(?:png|svg)$/.test(agent.logo || ''), `${label}: missing or unsafe logo path`);
  const logoFile = path.join(root, 'web', String(agent.logo || '').replace(/^\//, ''));
  expect(fs.existsSync(logoFile), `${label}: logo file does not exist`);
  const logoName = path.basename(logoFile);
  const logoSource = logoSourceByFile.get(logoName);
  expect(Boolean(logoSource), `${label}: logo source manifest entry is missing`);
  expect(/^https:\/\//.test(logoSource?.source || ''), `${label}: logo source must use HTTPS`);
  if (fs.existsSync(logoFile) && logoSource?.sha256) {
    const logoHash = crypto.createHash('sha256').update(fs.readFileSync(logoFile)).digest('hex');
    expect(logoHash === logoSource.sha256, `${label}: logo does not match its recorded upstream asset`);
  }

  expect(Array.isArray(agent.setups) && agent.setups.length > 0, `${label}: at least one native setup is required`);
  for (const [setupIndex, setup] of (agent.setups || []).entries()) {
    const setupLabel = `${label}: setup[${setupIndex}]`;
    expect(typeof setup?.label === 'string' && setup.label.length > 3, `${setupLabel}: label is missing`);
    expect(['command', 'json'].includes(setup?.format), `${setupLabel}: invalid format`);
    expect(typeof setup?.target === 'string' && setup.target.length > 0, `${setupLabel}: target is missing`);
    expect(typeof setup?.value === 'string' && setup.value.includes(runtimeSpec), `${setupLabel}: must pin ${runtimeSpec}`);
    expect(!setup?.value?.includes('@latest'), `${setupLabel}: must not use @latest`);
    expect(!setup?.value?.includes('@supercollab/cli'), `${setupLabel}: exposes the retired CLI package`);
  }

  expect(/^\/skills\/connect-supercollab\/references\/[a-z0-9-]+\.md$/.test(agent?.skill_reference || ''), `${label}: invalid skill reference`);
  const referenceFile = path.join(root, String(agent?.skill_reference || '').replace(/^\//, ''));
  expect(fs.existsSync(referenceFile), `${label}: skill reference does not exist`);
  if (fs.existsSync(referenceFile)) {
    const reference = fs.readFileSync(referenceFile, 'utf8');
    expect(reference.includes(runtimeSpec), `${label}: skill reference must pin ${runtimeSpec}`);
  }

  expect(Array.isArray(agent.docs) && agent.docs.length > 0, `${label}: official docs are missing`);
  for (const [docsIndex, source] of (agent.docs || []).entries()) {
    const docsLabel = `${label}: docs[${docsIndex}]`;
    expect(typeof source?.label === 'string' && source.label.length > 3, `${docsLabel}: label is missing`);
    expect(/^https:\/\//.test(source?.url || ''), `${docsLabel}: URL must use HTTPS`);
  }
}

expect(ids.size === expectedIds.size, `catalog must contain exactly ${expectedIds.size} supported agents`);
for (const id of expectedIds) expect(ids.has(id), `catalog is missing ${id}`);
expect(logoSourceByFile.size === expectedIds.size, `logo source manifest must contain exactly ${expectedIds.size} assets`);
expect(fs.existsSync(path.join(root, 'web/assets/agents/ATTRIBUTION.md')), 'logo attribution is missing');
expect(!fs.existsSync(path.join(root, 'skills/connect-supercollab/references/compatibility-lab.md')), 'compatibility lab reference must not remain');

const publicSurface = [
  'web/index.html',
  'web/assets/app.js',
  'web/assets/styles.css',
  'web/assets/agents.json',
].map((name) => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');
expect(!/\bverified\b|verification|compatibility[ -]lab|data-lab|lab-item/i.test(publicSurface), 'frontend must not expose verification or lab state');

if (errors.length) {
  process.stderr.write(`Compatibility catalog failed (${errors.length}):\n- ${errors.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Compatibility catalog OK: ${catalog.agents.length} agents, local stdio MCP, runtime ${runtimeSpec}\n`);
}
