// brain-client.js
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

class BrainClient {
    constructor(apiKey, options = {}) {
        this.apiKey = apiKey || process.env.BRAIN_API_KEY;
        if (!this.apiKey) {
            console.error('[BrainClient] ERROR: No API key provided!');
            process.exit(1);
        }

        this.agentId = this.apiKey;
        this.ws = null;
        this.reconnectInterval = null;
        this.isConnected = false;

        this.options = {
            autoReconnect: true,
            reconnectDelay: 3000,
            ...options
        };

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

            this.ws.send(JSON.stringify({
                type: 'join',
                agentId: this.agentId
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

    sendVideo(rgbaBuffer) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const header = Buffer.from('VIDE');
        this.ws.send(Buffer.concat([header, Buffer.from(rgbaBuffer)]));
    }

    sendAudio(float32Array) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const header = Buffer.from('AUIO');
        const audioBuf = Buffer.from(float32Array.buffer);
        this.ws.send(Buffer.concat([header, audioBuf]));
    }

    sendStimulus(type, data = {}) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const payload = {
            type: type.toLowerCase(),
            timestamp: Date.now(),
            ...data
        };

        const header = Buffer.from('IMUS');
        const jsonBuf = Buffer.from(JSON.stringify(payload));
        this.ws.send(Buffer.concat([header, jsonBuf]));
    }

    // ====================== UTILS ======================
    disconnect() {
        if (this.ws) this.ws.close();
    }
}

module.exports = BrainClient;