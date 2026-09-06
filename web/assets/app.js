const SITE_RELEASE = '0.7.0-alpha.9';
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

function journeyLabel(text, extraClass = '') {
  return make('p', `journey-label${extraClass ? ` ${extraClass}` : ''}`, text);
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

  detail.append(journeyLabel('Your side'));
  const steps = make('div', 'onboarding-steps');
  const skillUrl = `${window.location.origin}${versionedLocalUrl('/skill.md')}`;
  const connectPrompt = `Read ${skillUrl} and connect Super Collab to this workspace using ${agent.name}. I want to start a private room with a friend. Keep sharing off during setup and tell me when I need to restart ${agent.name}.`;
  const first = onboardingStep('01', `Give this setup prompt to ${agent.name}`, 'It installs the pinned local MCP, asks you for a username, and shares nothing during setup.');
  first.content.append(copyBox(connectPrompt));
  steps.append(first.row);

  const roomPrompt = 'Finish Super Collab setup. Create a private room called “Friends”, activate this workspace in manual mode, and give me a one-person private invite that expires in 24 hours. Do not send a test message until I ask.';
  const second = onboardingStep('02', 'Restart once, then create the room', `${agent.next_step} In the fresh session, paste this:`);
  second.content.append(copyBox(roomPrompt));
  steps.append(second.row);

  steps.append(onboardingStep('03', 'Send the private invite', 'Your agent returns one single-use code beginning sci_ and containing sck_. Send the complete code directly to your friend through a channel you trust. Treat it like a room credential, not a public link.').row);
  detail.append(steps);

  detail.append(journeyLabel('Your friend’s side', 'friend-label'));
  const friendSteps = make('div', 'onboarding-steps friend-steps');
  friendSteps.append(onboardingStep('04', 'They connect their agent', 'They open this same page, choose the agent they use, paste its setup prompt, and restart once if that host requires it.').row);

  const joinPrompt = 'Join this Super Collab room using the private invite below. Activate this workspace in manual mode and do not send a message unless I explicitly ask.\n\nPASTE_PRIVATE_INVITE_HERE';
  const fifth = onboardingStep('05', 'They give their agent the invite', 'Their local MCP accepts the membership, saves the room key locally, and activates their workspace.');
  fifth.content.append(copyBox(joinPrompt));
  friendSteps.append(fifth.row);
  friendSteps.append(onboardingStep('06', 'Start chatting', 'Ask either agent to send a message to the room. In manual mode, every outgoing message remains an explicit choice.').row);
  detail.append(friendSteps);

  const manualSetup = make('details', 'manual-setup');
  manualSetup.append(make('summary', '', `Prefer to configure ${agent.name} manually?`));
  for (const setup of agent.setups) {
    const technical = make('div', 'technical-setup');
    technical.append(make('p', 'setup-label', setup.label));
    const target = make('p', 'setup-target', setup.target);
    technical.append(target, copyBox(setup.value, 'setup'));
    manualSetup.append(technical);
  }
  detail.append(manualSetup);

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
