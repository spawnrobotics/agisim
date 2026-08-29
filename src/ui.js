// ui.js
export function createUI({
    mujoco,
    model,
    data,
    onCtrlChanged = () => { },
    onResume = () => { },
    onPause = () => { },
}) {
    const ICON_PAUSE = `<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>`;
    const ICON_PLAY = `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
    const ICON_RESET = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 9 8 9"/></svg>`;
    const ICON_JOINTS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="6" cy="12" r="3"/><circle cx="18" cy="12" r="3"/><path d="M9 12h6"/></svg>`;

    const panel = document.createElement('div');
    panel.id = 'control-panel';
    panel.innerHTML = `
      <button id="ctrl-pause" class="ctrl-icon" type="button" title="Pause"></button>
      <button id="ctrl-reset" class="ctrl-icon" type="button" title="Reset"></button>
      <button id="ctrl-joints" class="ctrl-icon" type="button" title="Joint controls"></button>
      <div class="status" id="ctrl-status"></div>
    `;
    document.body.appendChild(panel);

    let paused = false;
    let jointsVisible = false;

    const pauseBtn = panel.querySelector('#ctrl-pause');
    const resetBtn = panel.querySelector('#ctrl-reset');
    const jointsBtn = panel.querySelector('#ctrl-joints');
    const statusEl = panel.querySelector('#ctrl-status');

    function setStatus(text) {
        statusEl.textContent = text;
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

    pauseBtn.innerHTML = ICON_PAUSE;
    resetBtn.innerHTML = ICON_RESET;
    jointsBtn.innerHTML = ICON_JOINTS;
    paintPause();

    pauseBtn.addEventListener('click', () => {
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
        mujoco.mj_resetData(model, data);
        onCtrlChanged();
        setStatus('Reset to initial state');
    });

    jointsBtn.addEventListener('click', () => {
        setJointControlsVisible(!jointsVisible);
        setStatus(jointsVisible ? 'Joint controls visible' : 'Joint controls hidden');
    });

    requestAnimationFrame(() => setJointControlsVisible(false));

    queueMicrotask(() => {
        onResume();
        setStatus('Physics running');
    });

    return {
        shouldStep() {
            return !paused;
        },
        isPaused() {
            return paused;
        },
        setJointControlsVisible,
        isJointControlsVisible() {
            return jointsVisible;
        },
    };
}