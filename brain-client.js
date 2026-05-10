const WebSocket = require('ws');

class BrainClient {
    constructor(brainId, options = {}) {
        this.brainId = brainId || process.env.BRAIN_ID;
        if (!this.brainId) {
            console.error('[BrainClient] ERROR: No brainId provided!');
            console.error('   → Set BRAIN_ID environment variable or pass it to constructor');
            process.exit(1);
        }

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
        const url = `ws://localhost:3000/ws?brainId=${encodeURIComponent(this.brainId)}`;

        console.log(`[BrainClient] Connecting with brainId: ${this.brainId}`);

        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
            this.isConnected = true;
            console.log(`[BrainClient] ✅ Connected successfully with brainId: ${this.brainId}`);

            // Send join with brainId (this is the new standard)
            this.ws.send(JSON.stringify({
                type: 'join',
                brainId: this.brainId,
                genericConfig: {
                    imus: 5,      // Allow high-frequency IMU
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
            console.log(`[BrainClient] Disconnected (brainId: ${this.brainId})`);

            if (this.onDisconnect) this.onDisconnect();

            if (this.options.autoReconnect) {
                console.log(`[BrainClient] Reconnecting in ${this.options.reconnectDelay}ms...`);
                setTimeout(() => this.connect(), this.options.reconnectDelay);
            }
        });

        this.ws.on('error', (err) => {
            console.error(`[BrainClient] Error for brain ${this.brainId}:`, err.message);
        });
    }

    // ====================== SEND DATA ======================

    sendVideo(rgbaBuffer) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        if (rgbaBuffer.length !== 4096) {
            console.warn(`[BrainClient ⚠️] sendVideo: Expected 4096 bytes, got ${rgbaBuffer.length}`);
        }

        const header = Buffer.from('VIDE');
        this.ws.send(Buffer.concat([header, Buffer.from(rgbaBuffer)]));
        // console.log(`[Client 📤] sendVideo | 4096 bytes`);   // uncomment for debug
    }

    sendAudio(float32Array) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const header = Buffer.from('AUIO');
        const audioBuf = Buffer.from(float32Array.buffer);
        this.ws.send(Buffer.concat([header, audioBuf]));
        // console.log(`[Client 📤] sendAudio | ${audioBuf.length} bytes`);
    }

    sendStimulus(type, data = {}) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const now = Date.now();
        const last = this.lastGenericSendTime.get(type) || 0;

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

        const inferFlag = data.infer ? ' (infer)' : '';
        console.log(`[Client 📤] sendStimulus('${type}') | ${header.length + jsonBuf.length} bytes${inferFlag}`);

        this.ws.send(Buffer.concat([header, jsonBuf]));
    }

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

        const inferFlag = extra.infer ? ' (infer)' : '';
        console.log(`[Client 📤] sendText() | ${header.length + jsonBuf.length} bytes${inferFlag}`);

        const short = text.length > 70 ? text.substring(0, 67) + '...' : text;
        console.log(`[Client] Sent text: "${short}"`);

        this.ws.send(Buffer.concat([header, jsonBuf]));
    }

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

        console.log(`[Client 📤] sendStimulusWithHeader('${headerStr}', '${type}') | ${header.length + jsonBuf.length} bytes`);

        this.ws.send(Buffer.concat([header, jsonBuf]));
    }

    disconnect() {
        if (this.ws) this.ws.close();
    }
}

module.exports = BrainClient;