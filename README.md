# brain-client

**Official JavaScript/WebSocket client for connecting to your Brain.**

Designed for robots, embedded systems, and external applications to interact with a persistent, living AI brain.

---

## Usage Policy

- **Free for personal, educational, and non-commercial use**
- **Commercial use, production deployments, or high-volume usage requires explicit permission**

Please [contact me](mailto:max.power.spawn@gmail.com) before using this client in any commercial project. 

---

## Features

### What the Brain Provides
- **Long-term Memory** — Persistent memory across sessions and days
- **Continual Learning** — Learns and improves from real-world interaction in real time
- **Cross-Modal Associations** — Connects vision, sound, and sensor data intelligently

### Client Capabilities
- Real-time video streaming (`VIDE`)
- Real-time audio streaming (`AUIO`)
- Rich sensor & stimulus support (`IMUS`, GPS, battery, temperature, etc.)
- Optimized for Linux / embedded devices (Raspberry Pi, Jetson, etc.)

## Persistence & Inactivity

- Brains are **automatically deleted after 7 days of inactivity** to keep server resources sustainable.
- Using a persistent API key helps identify your brain, but **activity is still required** to prevent deletion.

**Tip**: To keep your brain alive longer, send occasional status updates or sensor data (even just once every few days).

---

## Quick Start

```js
const BrainClient = require('brain-client');

const client = new BrainClient(process.env.BRAIN_API_KEY);

client.onConnect = () => {
    console.log('🤖 Connected to persistent Cortex Brain');

    client.sendStimulus('status', { 
        state: 'online', 
        platform: 'raspberry-pi-5' 
    });
};

client.onVideo = (buffer) => {
    console.log(`📹 Brain sent visualization (${buffer.length} bytes)`);
};

client.onAudio = (audio) => {
    console.log(`🔊 Brain responded with audio (${audio.length} samples)`);
};

client.connect();

// Send sensor data
setInterval(() => {
    client.sendStimulus('imu', {
        accel: [0.1, -0.4, 9.82],
        gyro: [1.5, -2.1, 0.8],
        temp: 35.2
    });
}, 2500);