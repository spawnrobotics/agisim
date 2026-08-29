// mediaStreaming.js
import workletUrl from './audio-processor.js?url';
import CONFIG from './config.js';

export function createMediaStreaming({
    getHeadCam,
    isWsOpen,
    sendBinary,
    onStatus = () => { },
    videoFps = 10,
    frameSize = CONFIG.frameSize || 32,
    visualIndex = 1,
    auditoryIndex = 1,
    videoHeader = null,
    audioHeader = null,
}) {
    const visIdx = Math.max(1, Math.min(9, Math.floor(Number(visualIndex) || 1)));
    const audIdx = Math.max(1, Math.min(9, Math.floor(Number(auditoryIndex) || 1)));
    const VIDEO_HEADER = String(videoHeader || `VIS${visIdx}`).slice(0, 4);
    const AUDIO_HEADER = String(audioHeader || `AUD${audIdx}`).slice(0, 4);

    let videoEnabled = true;
    let audioEnabled = false;
    let streaming = false;

    let videoTimer = null;

    let localStream = null;
    let audioContext = null;
    let audioSource = null;
    let gainNode = null;
    let audioWorkletNode = null;
    let lastAudioSend = 0;

    let remoteAudioContext = null;
    let currentAudioSource = null;
    let audioPlaybackTimeout = null;
    let micWasOnBeforePlayback = false;

    let videoBufferTimer = null;
    let currentVideoBuffer = null;
    let currentFrameIndex = 0;
    let overlayCanvas = null;

    function setStatus(msg, color) {
        onStatus(msg, color);
    }

    function isReady() {
        return typeof isWsOpen === 'function' ? isWsOpen() : false;
    }

    function encodeHeader(tag) {
        const s = String(tag || '').toUpperCase().padEnd(4, ' ').slice(0, 4);
        return new TextEncoder().encode(s);
    }

    // ── local mic ────────────────────────────────────────────
    async function ensureMic() {
        if (localStream?.getAudioTracks().length) return localStream;
        setStatus('Requesting microphone…', '#ffaa00');
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
            video: false,
        });
        localStream.getAudioTracks().forEach((t) => { t.enabled = false; });
        setStatus('Microphone ready', '#60a5fa');
        return localStream;
    }

    async function setupAudioProcessing(restart = false) {
        if (!localStream || !audioEnabled) return;

        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 48000,
            });
        }
        if (audioContext.state === 'suspended') await audioContext.resume();

        if (!audioContext._pcmWorkletLoaded) {
            await audioContext.audioWorklet.addModule(workletUrl);
            audioContext._pcmWorkletLoaded = true;
        }

        if (restart || audioSource) {
            audioSource?.disconnect();
            gainNode?.disconnect();
            audioWorkletNode?.disconnect();
        }

        audioSource = audioContext.createMediaStreamSource(localStream);
        gainNode = audioContext.createGain();
        audioWorkletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
        gainNode.gain.value = audioEnabled ? 1 : 0;

        const minInterval = 1000 / 60;
        audioWorkletNode.port.onmessage = (event) => {
            if (!streaming || !audioEnabled || !isReady()) return;
            const float32Data = event.data;
            if (!float32Data?.length) return;

            const now = performance.now();
            if (now - lastAudioSend < minInterval) return;
            lastAudioSend = now;

            const header = encodeHeader(AUDIO_HEADER);
            const packed = new Uint8Array(header.length + float32Data.byteLength);
            packed.set(header, 0);
            packed.set(new Uint8Array(float32Data.buffer), header.length);
            sendBinary(packed.buffer);
        };

        audioSource.connect(gainNode);
        gainNode.connect(audioWorkletNode);
    }

    function startVideoLoop() {
        stopVideoLoop();
        const interval = 1000 / Math.max(1, videoFps);

        videoTimer = setInterval(() => {
            if (!streaming || !videoEnabled || !isReady()) return;
            const headCam = getHeadCam?.();
            if (!headCam?.grabRgbaFrame) return;

            const imageData = headCam.grabRgbaFrame();
            if (!imageData) return;

            const header = encodeHeader(VIDEO_HEADER);
            const packed = new Uint8Array(header.length + imageData.data.length);
            packed.set(header, 0);
            packed.set(imageData.data, header.length);
            sendBinary(packed.buffer);
        }, interval);
    }

    function stopVideoLoop() {
        if (videoTimer) {
            clearInterval(videoTimer);
            videoTimer = null;
        }
    }

    function startStreaming() {
        if (streaming || !isReady()) return;
        if (!videoEnabled && !audioEnabled) return;
        streaming = true;
        if (videoEnabled) startVideoLoop();
        if (audioEnabled) setupAudioProcessing().catch((err) => {
            console.error('[Media] audio setup failed', err);
        });
        setStatus('Streaming active', '#60a5fa');
    }

    function stopStreaming() {
        streaming = false;
        stopVideoLoop();
        if (gainNode) gainNode.gain.value = 0;
        if (localStream) {
            localStream.getAudioTracks().forEach((t) => { t.enabled = false; });
        }
        setStatus('Streaming stopped', '#ffaa00');
    }

    function syncStreaming() {
        const want = videoEnabled || audioEnabled;
        if (want && !streaming && isReady()) startStreaming();
        else if (!want && streaming) stopStreaming();
        else if (streaming && videoEnabled && !videoTimer) startVideoLoop();
    }

    async function setVideoEnabled(on) {
        videoEnabled = !!on;
        syncStreaming();
        return videoEnabled;
    }

    async function setAudioEnabled(on) {
        const next = !!on;
        if (next) {
            try {
                await ensureMic();
            } catch (err) {
                console.error('[Media] mic denied', err);
                setStatus('Microphone permission denied', '#e24a4a');
                audioEnabled = false;
                return false;
            }
            localStream.getAudioTracks().forEach((t) => { t.enabled = true; });
        } else if (localStream) {
            localStream.getAudioTracks().forEach((t) => { t.enabled = false; });
        }

        audioEnabled = next;
        if (gainNode) gainNode.gain.value = next ? 1 : 0;

        if (next && streaming && isReady()) {
            await setupAudioProcessing(true);
        }
        syncStreaming();
        return audioEnabled;
    }

    // ── inbound VIDO / VIS1 ──────────────────────────────────
    function attachOverlayCanvas(canvas) {
        overlayCanvas = canvas;
    }

    function handleVideoBuffer(newVideoBuffer) {
        if (!overlayCanvas || !newVideoBuffer?.data) return;

        const ctx = overlayCanvas.getContext('2d');
        const size = newVideoBuffer.width || frameSize;
        const bytesPerFrame = size * size * 4;
        const frameCount = Math.min(
            newVideoBuffer.frameCount || 1,
            Math.floor(newVideoBuffer.data.length / bytesPerFrame)
        );
        if (frameCount < 1) return;

        currentVideoBuffer = newVideoBuffer;
        currentFrameIndex = 0;
        if (videoBufferTimer) clearTimeout(videoBufferTimer);

        const playNext = () => {
            const offset = currentFrameIndex * bytesPerFrame;
            const frameData = currentVideoBuffer.data.slice(offset, offset + bytesPerFrame);
            const imageData = new ImageData(new Uint8ClampedArray(frameData), size, size);

            if (overlayCanvas.width !== size) overlayCanvas.width = size;
            if (overlayCanvas.height !== size) overlayCanvas.height = size;

            ctx.imageSmoothingEnabled = false;
            ctx.putImageData(imageData, 0, 0);
            currentFrameIndex = (currentFrameIndex + 1) % frameCount;
            videoBufferTimer = setTimeout(playNext, 70);
        };
        playNext();
    }

    // ── inbound AUDO / AUD1 ──────────────────────────────────
    function cleanupAudioPlayback(restoreMic) {
        if (currentAudioSource) {
            try { currentAudioSource.stop(0); } catch (_) { }
            currentAudioSource = null;
        }
        if (audioPlaybackTimeout) {
            clearTimeout(audioPlaybackTimeout);
            audioPlaybackTimeout = null;
        }
        if (restoreMic && localStream) {
            setAudioEnabled(true);
        }
    }

    async function playAudioImmediately(float32Array) {
        if (!float32Array || float32Array.length < 300) return;

        if (currentAudioSource) {
            try { currentAudioSource.stop(0); } catch (_) { }
            currentAudioSource = null;
        }
        if (audioPlaybackTimeout) {
            clearTimeout(audioPlaybackTimeout);
            audioPlaybackTimeout = null;
        }

        const wasMicOn = audioEnabled;
        if (wasMicOn) {
            micWasOnBeforePlayback = true;
            await setAudioEnabled(false);
        }

        try {
            remoteAudioContext ||= new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 48000,
            });
            if (remoteAudioContext.state === 'suspended') {
                await remoteAudioContext.resume();
            }

            const ctx = remoteAudioContext;
            const buffer = ctx.createBuffer(1, float32Array.length, 48000);
            buffer.getChannelData(0).set(float32Array);

            const source = ctx.createBufferSource();
            const gain = ctx.createGain();
            const compressor = ctx.createDynamicsCompressor();
            source.buffer = buffer;
            gain.gain.value = 0.93;
            compressor.threshold.value = -20;
            compressor.ratio.value = 10;
            source.connect(gain);
            gain.connect(compressor);
            compressor.connect(ctx.destination);

            currentAudioSource = source;
            source.onended = () => cleanupAudioPlayback(wasMicOn);
            source.start(0);

            const durationMs = (float32Array.length / 48000) * 1000 + 150;
            audioPlaybackTimeout = setTimeout(() => cleanupAudioPlayback(wasMicOn), durationMs);
        } catch (err) {
            console.error('[Audio Playback]', err);
            cleanupAudioPlayback(wasMicOn);
        }
    }

    function dispose() {
        stopStreaming();
        if (videoBufferTimer) clearTimeout(videoBufferTimer);
        cleanupAudioPlayback(false);
        localStream?.getTracks().forEach((t) => t.stop());
        localStream = null;
        audioContext?.close?.();
        remoteAudioContext?.close?.();
    }

    return {
        startStreaming,
        stopStreaming,
        syncStreaming,
        setVideoEnabled,
        setAudioEnabled,
        isVideoEnabled: () => videoEnabled,
        isAudioEnabled: () => audioEnabled,
        isStreaming: () => streaming,
        handleVideoBuffer,
        playAudioImmediately,
        attachOverlayCanvas,
        getVideoHeader: () => VIDEO_HEADER,
        getAudioHeader: () => AUDIO_HEADER,
        dispose,
    };
}