// brainPanel.js
import { getWsBase, getStoredBrainId, setStoredBrainId } from './config.js';

const ICON_LINK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7L12.7 18"/></svg>`;
const ICON_UNLINK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 15l6-6"/><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7"/></svg>`;

function fmt(n, d = 2) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toFixed(d) : '—';
}

export function createBrainPanel(brainWS) {
  const panel = document.createElement('div');
  panel.id = 'brain-panel';
  panel.innerHTML = `
      <button id="brain-toggle-btn" class="ctrl-icon" type="button" title="Connect"></button>
      <div class="brain-sheet" hidden>
        <div class="row">
          <input id="brain-id-input" type="text" placeholder="brainId (optional)" />
        </div>
        <div class="hint" id="brain-ws-default"></div>
        <div class="status" id="brain-status">Connecting…</div>
      </div>
      <div class="reward-card" id="brain-reward">
        <div class="reward-line" id="brain-reward-line">w=— hd=— h=— up=— r=—</div>
        <div class="reward-flag" id="brain-reward-flag"></div>
      </div>
    `;
  document.body.appendChild(panel);

  const toggleBtn = panel.querySelector('#brain-toggle-btn');
  const sheet = panel.querySelector('.brain-sheet');
  const rewardCard = panel.querySelector('#brain-reward');
  const rewardLine = panel.querySelector('#brain-reward-line');
  const rewardFlag = panel.querySelector('#brain-reward-flag');

  const toolbar = document.getElementById('control-panel');
  const statusSlot = toolbar?.querySelector('#ctrl-status');
  if (toolbar) toolbar.insertBefore(toggleBtn, statusSlot || null);

  const idInput = panel.querySelector('#brain-id-input');
  const defaultHint = panel.querySelector('#brain-ws-default');
  const statusEl = panel.querySelector('#brain-status');

  let sheetOpen = false;
  let connected = false;

  idInput.value = getStoredBrainId() || '';
  defaultHint.textContent = `WS: ${getWsBase()}`;

  function paintToggle() {
    toggleBtn.innerHTML = connected ? ICON_LINK : ICON_UNLINK;
    toggleBtn.classList.toggle('active', connected);
    toggleBtn.title = connected ? 'Disconnect' : 'Connect';
    toggleBtn.setAttribute('aria-pressed', connected ? 'true' : 'false');
  }

  function setSheetOpen(open) {
    sheetOpen = !!open;
    sheet.hidden = !sheetOpen;
    panel.classList.toggle('sheet-open', sheetOpen);
  }

  paintToggle();

  toggleBtn.addEventListener('click', (e) => {
    if (e.shiftKey || e.altKey) {
      setSheetOpen(!sheetOpen);
      return;
    }
    if (connected) {
      brainWS.disconnect();
      return;
    }
    const id = idInput.value.trim();
    if (id) setStoredBrainId(id);
    brainWS.connect();
  });

  toggleBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    setSheetOpen(!sheetOpen);
  });

  return {
    setStatus(msg, color = '#aaa') {
      statusEl.textContent = msg;
      statusEl.style.color = color;
      const isDown = /disconnect/i.test(msg);
      const isUp = /connected/i.test(msg) && !isDown;
      if (isUp) connected = true;
      if (isDown) connected = false;
      paintToggle();
    },
    setReward(outcome) {
      if (!outcome || typeof outcome !== 'object') return;
      const w = outcome.pelvisHeight ?? outcome.waist ?? outcome.height;
      const hd = outcome.headHeight;
      const h = outcome.height;
      const up = outcome.upright;
      const r = outcome.reward;
      const dz = outcome.progressTerm;
      const gene = outcome.gene ? String(outcome.gene) : '';
      rewardLine.textContent =
        (gene ? `${gene} ` : '') +
        `w=${fmt(w)} hd=${fmt(hd)} h=${fmt(h)} up=${fmt(up)} r=${fmt(r)}` +
        (Number(dz) > 0.04 ? ` ↑${fmt(dz)}` : '');
      rewardFlag.textContent = outcome.success
        ? 'UP'
        : outcome.fallen
          ? 'FALL'
          : '';
      rewardCard.classList.toggle('fallen', !!outcome.fallen);
      rewardCard.classList.toggle('good', !!outcome.success || (!outcome.fallen && r > 0.35));
    },
  };
}