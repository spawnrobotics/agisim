# brain-client

**Official JavaScript/WebSocket client for connecting to your Brain.**

Designed for robots, embedded systems, external applications, or any system requiring cross-model long-term memory. 

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

## Persistence & Inactivity

- Brains are **automatically deleted after 30 days of inactivity** to keep server resources sustainable.
- Using an API key helps identify your brain, but **activity is still required** to prevent deletion.

**Tip**: To keep your brain alive longer, send occasional status updates or sensor data (even just once every few days).

---

## Constraints

To ensure stability and prevent abuse, the brain server enforces the following limits:

### Message Size Limits
- **Generic / Sensor data** (`IMUS`, `TEXT`, `status`, etc.): **Maximum 512 KB** per message
- **Video frames** (`VIDE`): Must be **exactly 4096 bytes** (32×32 RGBA)
- **Audio frames** (`AUIO`): Recommended under **64 KB** per chunk

### Rate Limiting (Throttling)

| Type                  | Recommended Rate          | Server Hard Limit          | Notes |
|-----------------------|---------------------------|----------------------------|-------|
| IMU / Sensors (`imus`) | ≤ 200 Hz                  | ~200 Hz                    | Default 5ms |
| Text / Thoughts       | ≤ 1 message every 5s      | ~20 Hz                     | - |
| Status / Heartbeat    | ≤ 1 message every 10s     | 1 Hz                       | - |
| Generic Stimuli       | -                         | **300 messages/sec** total | Global safety limit |
| Video                 | 10 FPS                    | 10 FPS                     | Enforced |
| Audio                 | 30 FPS                    | 30 FPS                     | Enforced |

### Other Limits
- **Maximum unique modalities** (custom sensor types): **32**
- Messages sent faster than allowed are **silently dropped** by the server
- Excessively large or rapid messages may result in temporary rate limiting

### Best Practices
- Always respect the recommended rates in the table above.
- Send the **latest state** rather than every tiny change (the brain keeps only the most recent value per type).
- Use the `genericConfig` option in the `join` message to request custom throttling.
- Monitor your client console — look for `[Client 📤]` logs and `⚠️` warnings.

---

## Quick Start

```js
const BrainClient = require('brain-client');

const client = new BrainClient(process.env.BRAIN_API_KEY);

client.onConnect = () => {
    console.log('🤖 Connected to Cortex Brain');
    client.sendText("Hello, I am now online.");
};

client.connect();