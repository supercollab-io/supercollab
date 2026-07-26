const SITE_RELEASE = '0.7.0-alpha.7';
const versionedLocalUrl = (path) => `${path}?v=${encodeURIComponent(SITE_RELEASE)}`;

const track = document.querySelector('[data-panel-track]');
const panels = Array.from(track?.querySelectorAll('.panel') || []);
const tabs = Array.from(document.querySelectorAll('[data-panel-tab]'));
const dots = Array.from(document.querySelectorAll('[data-panel-dot]'));
const previousButton = document.querySelector('[data-panel-prev]');
const nextButton = document.querySelector('[data-panel-next]');
let activePanel = 0;

function setPanel(index, { scroll = true, focus = false } = {}) {
  const next = Math.max(0, Math.min(index, panels.length - 1));
  activePanel = next;
  tabs.forEach((tab, tabIndex) => {
    const selected = tabIndex === next;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  dots.forEach((dot, dotIndex) => dot.classList.toggle('active', dotIndex === next));
  if (previousButton) previousButton.disabled = next === 0;
  if (nextButton) nextButton.disabled = next === panels.length - 1;
  panels.forEach((panel, panelIndex) => {
    panel.toggleAttribute('inert', panelIndex !== next);
    panel.setAttribute('aria-hidden', String(panelIndex !== next));
  });
  if (scroll && track) {
    track.scrollTo({ left: track.clientWidth * next, behavior: 'smooth' });
  }
  if (focus) tabs[next]?.focus();
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => setPanel(index));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') return setPanel(0, { focus: true });
    if (event.key === 'End') return setPanel(tabs.length - 1, { focus: true });
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    setPanel((index + delta + tabs.length) % tabs.length, { focus: true });
  });
});

previousButton?.addEventListener('click', () => setPanel(activePanel - 1));
nextButton?.addEventListener('click', () => setPanel(activePanel + 1));

let scrollFrame = null;
track?.addEventListener('scroll', () => {
  if (scrollFrame) cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(() => {
    const index = Math.round(track.scrollLeft / Math.max(track.clientWidth, 1));
    if (index !== activePanel) setPanel(index, { scroll: false });
  });
}, { passive: true });

for (const link of document.querySelectorAll('[data-open-panel]')) {
  link.addEventListener('click', () => {
    const index = Number(link.dataset.openPanel || 0);
    window.setTimeout(() => setPanel(index), 80);
  });
}

setPanel(0, { scroll: false });

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function addLogo(parent, agent, className) {
  const wrap = make('span', className);
  if (agent.logo) {
    const image = document.createElement('img');
    image.src = versionedLocalUrl(agent.logo);
    image.alt = '';
    image.width = 24;
    image.height = 24;
    wrap.append(image);
  } else {
    wrap.textContent = agent.short_name.slice(0, 1).toUpperCase();
  }
  parent.append(wrap);
  return wrap;
}

async function copyText(value, button) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = 'Copied';
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    button.textContent = 'Copied';
  }
  window.setTimeout(() => { button.textContent = original; }, 1500);
}

function copyBox(value, kind = 'prompt') {
  const box = make('div', kind === 'prompt' ? 'prompt-box' : 'setup-box');
  if (kind === 'prompt') {
    box.append(make('code', '', value));
  } else {
    const pre = document.createElement('pre');
    pre.textContent = value;
    box.append(pre);
  }
  const copy = make('button', 'copy-button', 'Copy');
  copy.type = 'button';
  copy.setAttribute('aria-label', `Copy ${kind}`);
  copy.addEventListener('click', () => copyText(value, copy));
  box.append(copy);
  return box;
}

function onboardingStep(number, title, text) {
  const row = make('div', 'onboarding-step');
  row.append(make('span', '', number));
  const content = make('div');
  content.append(make('h4', '', title), make('p', '', text));
  row.append(content);
  return { row, content };
}

function renderAgentDetail(agent) {
  const detail = document.querySelector('[data-agent-detail]');
  if (!detail) return;
  detail.replaceChildren();

  const heading = make('div', 'detail-heading');
  addLogo(heading, agent, 'detail-icon');
  const headingCopy = make('div', 'detail-heading-copy');
  headingCopy.append(make('h3', '', agent.name));
  const status = make('div', 'status-row');
  status.append(make('span', 'integration-meta', `${agent.integration_label} · local process`));
  headingCopy.append(status);
  heading.append(headingCopy);
  detail.append(heading, make('p', 'detail-summary', agent.summary));

  const steps = make('div', 'onboarding-steps');
  const first = onboardingStep('01', 'Give this to your agent', 'It identifies the host and changes only that host’s MCP configuration.');
  const skillUrl = `${window.location.origin}${versionedLocalUrl('/skill.md')}`;
  const prompt = `Read ${skillUrl} and connect Super Collab to this workspace using ${agent.name}. Keep sharing off until I choose or join a room.`;
  first.content.append(copyBox(prompt));
  steps.append(first.row);

  const second = onboardingStep('02', 'Use the agent-specific setup file', `The shared safety skill uses ${agent.name}’s dedicated host instructions and preserves the same privacy boundary.`);
  for (const setup of agent.setups) {
    const technical = make('details', 'technical-setup');
    technical.append(make('summary', '', setup.label));
    const target = make('p', 'setup-target', setup.target);
    technical.append(target, copyBox(setup.value, 'setup'));
    second.content.append(technical);
  }
  steps.append(second.row);

  steps.append(onboardingStep('03', 'Restart, then use natural language', agent.next_step).row);
  detail.append(steps);

  const access = make('p', 'access-note');
  const accessStrong = make('strong', '', 'Client access: ');
  access.append(accessStrong, document.createTextNode(agent.access));
  detail.append(access);

  const docs = make('div', 'docs-links');
  const guide = make('a', 'docs-link', `${agent.name} setup file`);
  guide.href = versionedLocalUrl(agent.skill_reference);
  docs.append(guide);
  for (const source of agent.docs) {
    const link = make('a', 'docs-link', `${source.label} ↗`);
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    docs.append(link);
  }
  detail.append(docs);
}

function renderCatalog(catalog) {
  const grid = document.querySelector('[data-agent-grid]');
  const count = document.querySelector('[data-matrix-count]');
  if (!grid || !count) return;

  const agents = catalog.agents;
  count.textContent = `${agents.length} agents · local stdio MCP`;
  grid.replaceChildren();

  const cards = agents.map((agent, index) => {
    const card = make('button', `agent-card${index === 0 ? ' active' : ''}`);
    card.type = 'button';
    card.dataset.agentId = agent.id;
    card.setAttribute('aria-pressed', String(index === 0));
    addLogo(card, agent, 'agent-icon');
    const copy = make('span', 'agent-card-copy');
    copy.append(
      make('strong', '', agent.name),
      make('small', '', agent.integration_label),
    );
    card.append(copy);
    card.addEventListener('click', () => {
      cards.forEach((other) => {
        const selected = other === card;
        other.classList.toggle('active', selected);
        other.setAttribute('aria-pressed', String(selected));
      });
      renderAgentDetail(agent);
    });
    grid.append(card);
    return card;
  });

  if (agents[0]) renderAgentDetail(agents[0]);
}

fetch(versionedLocalUrl('/assets/agents.json'), { headers: { accept: 'application/json' } })
  .then((response) => {
    if (!response.ok) throw new Error(`agent catalog returned ${response.status}`);
    return response.json();
  })
  .then(renderCatalog)
  .catch((error) => {
    const grid = document.querySelector('[data-agent-grid]');
    const detail = document.querySelector('[data-agent-detail]');
    const message = make('p', 'load-error', `${error.message}. The setup-file links remain available.`);
    if (grid) grid.insertAdjacentElement('afterend', message);
    if (detail) detail.dataset.catalogError = 'true';
  });
