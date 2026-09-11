// ui.js
export function createUI({
    mujoco,
    model,
    data,
    robots = [],
    activeRobotId = null,
    onSelectRobot = null,
    onCtrlChanged = () => { },
    onResume = () => { },
    onPause = () => { },
    onReset = null,
}) {
    const ICON_PAUSE = `<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>`;
    const ICON_PLAY = `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
    const ICON_RESET = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 9 8 9"/></svg>`;
    const ICON_JOINTS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="6" cy="12" r="3"/><circle cx="18" cy="12" r="3"/><path d="M9 12h6"/></svg>`;

    const panel = document.createElement('div');
    panel.id = 'control-panel';
    panel.innerHTML = `
      <button id="ctrl-pause" class="ctrl-icon" style="display: none" type="button" title="Pause"></button>
      <button id="ctrl-joints" class="ctrl-icon" type="button" title="Joint controls"></button>
      <button id="ctrl-reset" class="ctrl-icon" type="button" title="Reset to stand"></button>
      <button id="ctrl-robot" class="ctrl-icon ctrl-robot" style="display: none" type="button" title="Switch robot"></button>
      <div class="status" id="ctrl-status"></div>
    `;
    document.body.appendChild(panel);

    let paused = false;
    let jointsVisible = false;
    let resetting = false;
    let switching = false;

    const pauseBtn = panel.querySelector('#ctrl-pause');
    const resetBtn = panel.querySelector('#ctrl-reset');
    const jointsBtn = panel.querySelector('#ctrl-joints');
    const robotBtn = panel.querySelector('#ctrl-robot');
    const statusEl = panel.querySelector('#ctrl-status');

    function setStatus(text) {
        statusEl.textContent = text;
    }

    function familyOf(r) {
        return String(r?.family || r?.id || '').toLowerCase();
    }

    function uniqRobots() {
        const raw = Array.isArray(robots) ? robots : [];
        const out = [];
        const seen = new Set();
        for (const r of raw) {
            if (!r?.id) continue;
            const fam = familyOf(r);
            if (seen.has(fam)) continue;
            seen.add(fam);
            out.push(r);
        }
        if (!out.some((r) => familyOf(r).includes('duck'))) {
            out.push({ id: 'microduck', name: 'MicroDuck', family: 'microduck' });
        }
        if (!out.some((r) => familyOf(r) === 'g1')) {
            out.push({ id: 'g1', name: 'G1', family: 'g1' });
        }
        return out.slice(0, 2);
    }

    function otherRobot() {
        const list = uniqRobots();
        const cur = String(activeRobotId || '').toLowerCase();
        return list.find((r) => familyOf(r) !== cur && String(r.id).toLowerCase() !== cur) || null;
    }

    const ICON_G1 = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="7" y="4" width="10" height="8" rx="2"/>
    <circle cx="10" cy="8" r="1.1" fill="currentColor" stroke="none"/>
    <circle cx="14" cy="8" r="1.1" fill="currentColor" stroke="none"/>
    <path d="M9 12v3M15 12v3M8 15h8M9 18v2M15 18v2M6 9H4M20 9h-2"/>
  </svg>`;

    const ICON_DUCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="9.2" cy="8.2" r="3.1"/>
    <circle cx="10.2" cy="7.4" r="0.7" fill="currentColor" stroke="none"/>
    <path d="M12.2 8.4h3.4c.9 0 1.4.7 1.1 1.4L16 11"/>
    <path d="M6.2 12.2c.4 3.4 3.2 6.3 7.1 6.3 3.2 0 5.5-1.8 6.2-4.2-2.1.2-4.2-.6-5.6-2.1-1.6 1.6-3.9 2.2-6.1 1.6z"/>
  </svg>`;

    function paintRobot() {
        const next = otherRobot();
        if (!next) {
            robotBtn.hidden = true;
            return;
        }
        const duck = familyOf(next).includes('duck');
        robotBtn.hidden = false;
        robotBtn.dataset.robot = next.id;
        robotBtn.innerHTML = duck ? ICON_DUCK : ICON_G1;
        robotBtn.setAttribute('aria-label', `Switch to ${next.name || next.id}`);
        robotBtn.title = `Switch to ${next.name || next.id}`;
    }

    function paintPause() {
        pauseBtn.innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
        pauseBtn.title = paused ? 'Resume' : 'Pause';
        pauseBtn.classList.toggle('active', paused);
        pauseBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
    }

    function setJointControlsVisible(visible) {
        jointsVisible = !!visible;
        const el = document.getElementById('joint-controls');
        if (el) el.style.display = jointsVisible ? '' : 'none';
        jointsBtn.classList.toggle('active', jointsVisible);
        jointsBtn.title = jointsVisible ? 'Hide joint controls' : 'Show joint controls';
        jointsBtn.setAttribute('aria-pressed', jointsVisible ? 'true' : 'false');
    }

    async function applyReset() {
        if (resetting || switching) return;
        resetting = true;
        resetBtn.disabled = true;
        setStatus('Resetting to stand…');
        try {
            const reset = onReset || onResume;
            await reset();
            onCtrlChanged();
            setStatus('Standing');
        } catch (err) {
            console.warn('[ui] reset failed', err);
            setStatus('Reset failed');
        } finally {
            resetting = false;
            resetBtn.disabled = false;
        }
    }

    pauseBtn.innerHTML = ICON_PAUSE;
    resetBtn.innerHTML = ICON_RESET;
    jointsBtn.innerHTML = ICON_JOINTS;
    paintPause();
    paintRobot();

    pauseBtn.addEventListener('click', () => {
        if (switching) return;
        const wasPaused = paused;
        paused = !paused;
        paintPause();
        if (wasPaused && !paused) {
            onResume();
            setStatus('Physics running');
        } else if (!wasPaused && paused) {
            onPause();
            setStatus('Physics paused');
        }
    });

    resetBtn.addEventListener('click', () => {
        void applyReset();
    });

    jointsBtn.addEventListener('click', () => {
        setJointControlsVisible(!jointsVisible);
        setStatus(jointsVisible ? 'Joint controls visible' : 'Joint controls hidden');
    });

    robotBtn.addEventListener('click', () => {
        const next = otherRobot();
        if (!next || switching || typeof onSelectRobot !== 'function') return;
        switching = true;
        robotBtn.disabled = true;
        setStatus(`Switching to ${next.name || next.id}…`);
        Promise.resolve(onSelectRobot(next.id)).catch((err) => {
            console.warn('[ui] robot switch failed', err);
            switching = false;
            robotBtn.disabled = false;
            setStatus('Switch failed');
        });
    });

    requestAnimationFrame(() => setJointControlsVisible(false));

    queueMicrotask(() => {
        onResume();
        setStatus('Physics running');
    });

    return {
        shouldStep() {
            return !paused && !resetting && !switching;
        },
        isPaused() {
            return paused;
        },
        reset: applyReset,
        setStatus,
        setJointControlsVisible,
        isJointControlsVisible() {
            return jointsVisible;
        },
    };
}

export default createUI;