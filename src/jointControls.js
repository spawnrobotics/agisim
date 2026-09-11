// jointControls.js - MuJoCo joint / actuator control panel

export function createJointControls({ mujoco, model, data }) {
    const panel = document.createElement('div');
    panel.id = 'joint-controls';
    panel.innerHTML = `
    <h3>Joint Controls (${model.nu})</h3>
    <div class="actions"></div>
    <div class="sliders"></div>
  `;
    document.body.appendChild(panel);

    const actionsEl = panel.querySelector('.actions');
    const slidersEl = panel.querySelector('.sliders');

    function getActuatorName(i) {
        try {
            const name = model.actuator(i)?.name;
            if (name) return name;
        } catch (_) { }

        try {
            const name = mujoco.mj_id2name(
                model,
                mujoco.mjtObj.mjOBJ_ACTUATOR.value,
                i
            );
            if (name) return name;
        } catch (_) { }

        return `actuator_${i}`;
    }

    function getCtrlRange(i) {
        const low = model.actuator_ctrlrange[i * 2];
        const high = model.actuator_ctrlrange[i * 2 + 1];
        if (low === 0 && high === 0) {
            return { min: -3.14, max: 3.14 };
        }
        return { min: low, max: high };
    }

    const sliders = [];

    for (let i = 0; i < model.nu; i++) {
        const name = getActuatorName(i);
        const { min, max } = getCtrlRange(i);
        const current = data.ctrl[i];

        const row = document.createElement('div');
        row.className = 'joint-row';
        row.innerHTML = `
      <label title="${name}">${name.replace(/_joint$/, '')}</label>
      <div class="value">${current.toFixed(2)}</div>
      <input type="range"
             min="${min}"
             max="${max}"
             step="0.01"
             value="${current}"
             data-index="${i}" />
    `;
        slidersEl.appendChild(row);

        const input = row.querySelector('input');
        const valueEl = row.querySelector('.value');

        input.addEventListener('input', () => {
            const v = parseFloat(input.value);
            data.ctrl[i] = v;
            valueEl.textContent = v.toFixed(2);
        });

        sliders.push({ input, valueEl, index: i });
    }

    function addAction(label, fn) {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.addEventListener('click', fn);
        actionsEl.appendChild(btn);
    }

    addAction('Zero', () => {
        for (let i = 0; i < model.nu; i++) {
            data.ctrl[i] = 0;
            sliders[i].input.value = 0;
            sliders[i].valueEl.textContent = '0.00';
        }
    });

    addAction('From Pose', () => {
        const qposOffset = 7;
        for (let i = 0; i < model.nu; i++) {
            const v = data.qpos[qposOffset + i] ?? 0;
            data.ctrl[i] = v;
            sliders[i].input.value = v;
            sliders[i].valueEl.textContent = v.toFixed(2);
        }
    });

    function syncFromData() {
        for (const s of sliders) {
            const v = data.ctrl[s.index];
            s.input.value = v;
            s.valueEl.textContent = v.toFixed(2);
        }
    }

    return { syncFromData };
}