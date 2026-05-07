// brain-client.js
const WebSocket = require('ws');

class BrainClient {
    constructor(apiKey, options = {}) {
        this.apiKey = apiKey || process.env.BRAIN_API_KEY;
        if (!this.apiKey) {
            console.error('[BrainClient] ERROR: No API key provided!');
            process.exit(1);
        }

        this.agentId = this.apiKey;
        this.ws = null;
        this.isConnected = false;

        this.options = {
            autoReconnect: true,
            reconnectDelay: 3000,
            ...options
        };

        // Client-side rate tracking to help respect server throttling
        this.lastGenericSendTime = new Map();

        this.onConnect = null;
        this.onDisconnect = null;
        this.onVideo = null;
        this.onAudio = null;
        this.onMessage = null;
    }

    connect() {
        const url = `ws://localhost:3000/ws?key=${encodeURIComponent(this.apiKey)}`;

        console.log(`[BrainClient] Connecting to brain with key: ${this.apiKey.substring(0, 12)}...`);

        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
            this.isConnected = true;
            console.log(`[BrainClient] ✅ Connected successfully`);

            // Send join with recommended generic throttling config
            this.ws.send(JSON.stringify({
                type: 'join',
                agentId: this.agentId,
                genericConfig: {
                    imus: 5,      // Allow up to ~200 Hz IMU
                    text: 50,     // Text thoughts
                    stat: 1000,   // Status updates
                    sens: 20      // Generic sensors
                }
            }));

            if (this.onConnect) this.onConnect();
        });

        this.ws.on('message', (data) => {
            if (typeof data === 'string') {
                try {
                    const msg = JSON.parse(data);
                    if (this.onMessage) this.onMessage(msg);
                } catch (e) { }
                return;
            }

            const buf = Buffer.from(data);
            if (buf.length < 4) return;

            const header = buf.toString('utf8', 0, 4);

            if (header === 'VIDO' && this.onVideo) {
                this.onVideo(buf);
            } else if (header === 'AUDO' && this.onAudio) {
                const audioData = new Float32Array(buf.buffer, buf.byteOffset + 4);
                this.onAudio(audioData);
            }
        });

        this.ws.on('close', () => {
            this.isConnected = false;
            console.log('[BrainClient] Disconnected');
            if (this.onDisconnect) this.onDisconnect();

            if (this.options.autoReconnect) {
                console.log(`[BrainClient] Reconnecting in ${this.options.reconnectDelay}ms...`);
                setTimeout(() => this.connect(), this.options.reconnectDelay);
            }
        });

        this.ws.on('error', (err) => {
            console.error('[BrainClient] Error:', err.message);
        });
    }

    // ====================== SEND DATA ======================

    /**
     * Send video frame to the brain.
     * 
     * IMPORTANT: Only send 32x32 RGBA frames!
     * - Buffer length must be exactly 4096 bytes (32 * 32 * 4).
     * - Format: RGBA (4 bytes per pixel, no padding).
     */
    sendVideo(rgbaBuffer) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        if (rgbaBuffer.length !== 4096) {
            console.warn(`[BrainClient ⚠️] sendVideo: Expected 4096 bytes, got ${rgbaBuffer.length}`);
        }

        const header = Buffer.from('VIDE');
        this.ws.send(Buffer.concat([header, Buffer.from(rgbaBuffer)]));
        console.log(`[Client 📤] sendVideo | 4096 bytes`);
    }

    sendAudio(float32Array) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const header = Buffer.from('AUIO');
        const audioBuf = Buffer.from(float32Array.buffer);
        this.ws.send(Buffer.concat([header, audioBuf]));
        console.log(`[Client 📤] sendAudio | ${audioBuf.length} bytes`);
    }

    /**
     * General sensor / data stimulus (uses IMUS header)
     */
    sendStimulus(type, data = {}) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const now = Date.now();
        const last = this.lastGenericSendTime.get(type) || 0;

        // Light client-side warning if sending too fast
        if (now - last < 5) {
            console.warn(`[Client ⚠️] Sending "${type}" very frequently - server may throttle`);
        }

        this.lastGenericSendTime.set(type, now);

        const payload = {
            type: type.toLowerCase(),
            timestamp: now,
            ...data
        };

        const header = Buffer.from('IMUS');
        const jsonBuf = Buffer.from(JSON.stringify(payload));
        const totalSize = header.length + jsonBuf.length;

        const inferFlag = data.infer ? ' (infer)' : '';
        console.log(`[Client 📤] sendStimulus('${type}') | ${totalSize} bytes${inferFlag}`);

        this.ws.send(Buffer.concat([header, jsonBuf]));
    }

    /**
     * Dedicated Text Stimulus (uses TEXT header)
     */
    sendText(text, extra = {}) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const payload = {
            type: 'text',
            content: text,
            timestamp: Date.now(),
            ...extra
        };

        const header = Buffer.from('TEXT');
        const jsonBuf = Buffer.from(JSON.stringify(payload));
        const totalSize = header.length + jsonBuf.length;

        const inferFlag = extra.infer ? ' (infer)' : '';
        console.log(`[Client 📤] sendText() | ${totalSize} bytes${inferFlag}`);

        const short = text.length > 70 ? text.substring(0, 67) + '...' : text;
        console.log(`[Client] Sent text: "${short}"`);

        this.ws.send(Buffer.concat([header, jsonBuf]));
    }

    /**
     * Advanced: Send stimulus with custom 4-character header
     */
    sendStimulusWithHeader(headerStr, type, data = {}) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const now = Date.now();
        this.lastGenericSendTime.set(type, now);

        const payload = {
            type: type.toLowerCase(),
            timestamp: now,
            ...data
        };

        const header = Buffer.from(headerStr.toUpperCase().substring(0, 4).padEnd(4, ' '));
        const jsonBuf = Buffer.from(JSON.stringify(payload));
        const totalSize = header.length + jsonBuf.length;

        console.log(`[Client 📤] sendStimulusWithHeader('${headerStr}', '${type}') | ${totalSize} bytes`);

        this.ws.send(Buffer.concat([header, jsonBuf]));
    }

    // ====================== UTILS ======================
    disconnect() {
        if (this.ws) this.ws.close();
    }
}

module.exports = BrainClient;