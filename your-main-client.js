// your-main-client.js
const BrainClient = require('brain-client');

// Use BRAIN_ID environment variable
const client = new BrainClient(
    process.env.BRAIN_ID || 'your-brain-id-here'
);

let inferenceCounter = 0;
let textThoughtCounter = 0;
let genericSendCounter = 0;

// ====================== CONNECTION ======================
client.onConnect = () => {
    console.log('🤖 Connected to Cortex Brain');
    console.log(`   Brain ID: ${client.brainId}`);

    client.sendStimulus('status', {
        state: 'online',
        platform: 'raspberry-pi-5'
    });

    setTimeout(() => client.sendText("I am now connected and aware."), 800);
    setTimeout(() => client.sendText("Beginning continuous environmental monitoring."), 1500);
};

// ====================== RECEIVE ======================
client.onVideo = (buffer) => {
    console.log(`📹 Received visualization frame (${buffer.length} bytes)`);
};

client.onAudio = (audioData) => {
    console.log(`🔊 Received audio (${audioData.length} samples)`);
};

// ====================== IMU STREAM + INFERENCE ======================
setInterval(() => {
    inferenceCounter++;
    genericSendCounter++;

    const shouldInfer = (inferenceCounter % 8 === 0); // Forces brain to quickly output associations

    client.sendStimulus('imu', {
        accel: [
            (Math.random() - 0.5) * 2,
            (Math.random() - 0.5) * 2,
            9.8 + (Math.random() - 0.5) * 0.8
        ],
        gyro: [
            (Math.random() - 0.5) * 50,
            (Math.random() - 0.5) * 50,
            (Math.random() - 0.5) * 50
        ],
        temp: 23.5 + (Math.random() - 0.5) * 3,
        infer: shouldInfer
    });

    if (shouldInfer) {
        console.log(`[Client] ⚡ IMU sent with inference trigger (#${inferenceCounter})`);
    }
}, 2000);

// ====================== PERIODIC TEXT THOUGHTS ======================
setInterval(() => {
    textThoughtCounter++;
    genericSendCounter++;

    const thoughts = [
        "The room feels calm.",
        "Movement patterns are steady.",
        "Temperature is stable.",
        "I sense a quiet presence.",
        "The environment has a gentle rhythm.",
        "Maintaining full awareness.",
        "Everything is functioning within expected parameters."
    ];

    const thought = thoughts[Math.floor(Math.random() * thoughts.length)];

    client.sendText(thought, {
        infer: Math.random() < 0.28
    });
}, 10000);

// ====================== STATUS HEARTBEAT ======================
setInterval(() => {
    client.sendStimulus('status', {
        state: 'active',
        uptime: Math.floor(process.uptime()),
        inferenceCount: inferenceCounter,
        textThoughtsSent: textThoughtCounter,
        totalGenericSent: genericSendCounter
    });
}, 30000);

// ====================== MANUAL DEBUG ======================
global.triggerInference = () => {
    console.log(`[Client] Manual inference trigger activated`);
    client.sendStimulus('imu', { infer: true });
};

client.connect();

console.log(`[Client] Brain client initialized`);
console.log(`   → IMU every 2s`);
console.log(`   → Inference trigger every ~16s`);
console.log(`   → Using brainId: ${process.env.BRAIN_ID || 'your-brain-id-here'}`);