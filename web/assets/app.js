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
    image.src = agent.logo;
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
  status.append(
    make('span', `status-pill ${agent.verification === 'verified' ? 'verified' : ''}`, agent.verification_label),
    make('span', 'native-label', agent.mcp === 'native' ? 'Native MCP' : 'First-party adapter'),
  );
  headingCopy.append(status);
  heading.append(headingCopy);
  detail.append(heading, make('p', 'detail-summary', agent.summary));

  const steps = make('div', 'onboarding-steps');
  const first = onboardingStep('01', 'Give this to your agent', 'It identifies the host and changes only that host’s MCP configuration.');
  const skillUrl = `${window.location.origin}/skill.md`;
  const prompt = `Read ${skillUrl} and connect Super Collab to this workspace using ${agent.name}. Keep sharing off until I choose or join a room.`;
  first.content.append(copyBox(prompt));
  steps.append(first.row);

  if (agent.setup) {
    const second = onboardingStep('02', 'npm delivers the local runtime', 'The exact version is pinned. Nothing is installed globally, and there is no SuperCollab command interface to learn.');
    const technical = make('details', 'technical-setup');
    technical.append(make('summary', '', 'Show the native setup change'));
    const target = make('p', 'setup-target', agent.setup.target);
    technical.append(target, copyBox(agent.setup.value, 'setup'));
    second.content.append(technical);
    steps.append(second.row);
  } else {
    steps.append(onboardingStep('02', 'Not advertised as ready yet', agent.verify).row);
  }

  steps.append(onboardingStep('03', 'Manage it in natural language', agent.setup
    ? agent.verify
    : 'The compatibility lab will not generate an install command until the security and real-client gates pass.').row);
  detail.append(steps);

  const access = make('p', 'access-note');
  const accessStrong = make('strong', '', 'Client access: ');
  access.append(accessStrong, document.createTextNode(agent.access));
  detail.append(access);

  const docs = make('a', 'docs-link', 'View the host’s official MCP docs ↗');
  docs.href = agent.docs;
  docs.target = '_blank';
  docs.rel = 'noopener noreferrer';
  detail.append(docs);
}

function renderCatalog(catalog) {
  const grid = document.querySelector('[data-agent-grid]');
  const lab = document.querySelector('[data-lab-list]');
  const count = document.querySelector('[data-matrix-count]');
  const labCount = document.querySelector('[data-lab-count]');
  if (!grid || !lab) return;

  const featured = catalog.agents.filter((agent) => agent.featured);
  const experimental = catalog.agents.filter((agent) => !agent.featured);
  const verifiedCount = featured.filter((agent) => agent.verification === 'verified').length;
  count.textContent = `${verifiedCount} verified · ${featured.length} core`;
  labCount.textContent = `${experimental.length} tracked`;

  const cards = featured.map((agent, index) => {
    const card = make('button', `agent-card${index === 0 ? ' active' : ''}`);
    card.type = 'button';
    card.dataset.agentId = agent.id;
    card.setAttribute('aria-pressed', String(index === 0));
    addLogo(card, agent, 'agent-icon');
    const copy = make('span', 'agent-card-copy');
    copy.append(
      make('strong', '', agent.name),
      make('small', agent.verification === 'verified' ? 'verified' : '', agent.verification_label),
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

  for (const agent of experimental) {
    const item = make('button', 'lab-item');
    item.type = 'button';
    addLogo(item, agent, 'lab-icon');
    const copy = make('div');
    copy.append(make('strong', '', agent.name), make('small', '', agent.verification_label));
    item.append(copy);
    item.addEventListener('click', () => {
      cards.forEach((card) => {
        card.classList.remove('active');
        card.setAttribute('aria-pressed', 'false');
      });
      renderAgentDetail(agent);
    });
    lab.append(item);
  }

  if (featured[0]) renderAgentDetail(featured[0]);
}

fetch('/assets/agents.json', { headers: { accept: 'application/json' } })
  .then((response) => {
    if (!response.ok) throw new Error(`compatibility matrix returned ${response.status}`);
    return response.json();
  })
  .then(renderCatalog)
  .catch((error) => {
    const grid = document.querySelector('[data-agent-grid]');
    const detail = document.querySelector('[data-agent-detail]');
    if (grid) grid.textContent = 'The compatibility matrix could not be loaded.';
    if (detail) {
      detail.replaceChildren(make('p', 'load-error', `${error.message}. Use /skill.md for the setup guide.`));
    }
  });
