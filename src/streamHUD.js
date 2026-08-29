// streamHud.js
export function createStreamHud({ media, getPreviewCanvas }) {
  const root = document.createElement('div');
  root.id = 'stream-hud';
  root.innerHTML = `
      <div class="preview-wrap">
        <div class="cam-label">HEAD CAM</div>
        <canvas id="head-preview"></canvas>
        <canvas id="video-buffer-canvas" class="overlay-canvas" hidden></canvas>
        <div class="hud-toggles">
          <button id="toggleVideoBtn" class="hud-icon" type="button" title="Video" aria-label="Toggle video"></button>
          <button id="toggleAudioBtn" class="hud-icon" type="button" title="Audio" aria-label="Toggle audio"></button>
        </div>
      </div>
    `;
  document.body.appendChild(root);

  const previewDest = root.querySelector('#head-preview');
  const overlay = root.querySelector('#video-buffer-canvas');
  const videoBtn = root.querySelector('#toggleVideoBtn');
  const audioBtn = root.querySelector('#toggleAudioBtn');

  const ICON_CAM_ON = `<svg viewBox="0 0 24 24"><path d="M15 10l4.5-2.5v9L15 14"/><rect x="3" y="6" width="12" height="12" rx="2"/></svg>`;
  const ICON_CAM_OFF = `<svg viewBox="0 0 24 24"><path d="M15 10l4.5-2.5v9L15 14"/><rect x="3" y="6" width="12" height="12" rx="2"/><path d="M3 3l18 18"/></svg>`;
  const ICON_MIC_ON = `<svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"/><path d="M19 11a7 7 0 0 1-14 0"/><path d="M12 18v3"/></svg>`;
  const ICON_MIC_OFF = `<svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"/><path d="M19 11a7 7 0 0 1-14 0"/><path d="M12 18v3"/><path d="M3 3l18 18"/></svg>`;

  media.attachOverlayCanvas(overlay);

  function paintVideo(on) {
    videoBtn.innerHTML = on ? ICON_CAM_ON : ICON_CAM_OFF;
    videoBtn.classList.toggle('active', on);
    videoBtn.title = on ? 'Video: ON' : 'Video: OFF';
    videoBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function paintAudio(on) {
    audioBtn.innerHTML = on ? ICON_MIC_ON : ICON_MIC_OFF;
    audioBtn.classList.toggle('active', on);
    audioBtn.title = on ? 'Audio: ON' : 'Audio: OFF';
    audioBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  paintVideo(media.isVideoEnabled());
  paintAudio(media.isAudioEnabled());

  videoBtn.addEventListener('click', async () => {
    const on = await media.setVideoEnabled(!media.isVideoEnabled());
    paintVideo(on);
  });

  audioBtn.addEventListener('click', async () => {
    const on = await media.setAudioEnabled(!media.isAudioEnabled());
    paintAudio(on);
  });

  function blitPreview() {
    const src = getPreviewCanvas?.();
    if (!src) return;
    if (previewDest.width !== src.width) previewDest.width = src.width;
    if (previewDest.height !== src.height) previewDest.height = src.height;
    previewDest.getContext('2d').drawImage(src, 0, 0);
  }

  return {
    blitPreview,
    showBrainOverlay(show) {
      overlay.hidden = !show;
    },
    paintVideo,
    paintAudio,
    dispose() {
      root.remove();
    },
  };
}