const BrainClient = require('brain-client');

const client = new BrainClient(process.env.BRAIN_API_KEY || 'your-api-key-here');

client.onConnect = () => {
    console.log('🤖 Connected to Cortex Brain');

    client.sendStimulus('status', {
        state: 'online',
        platform: 'raspberry-pi-5'
    });
};

client.onVideo = (buffer) => {
    console.log(`📹 Received visualization frame (${buffer.length} bytes)`);
};

client.onAudio = (audioData) => {
    console.log(`🔊 Received audio (${audioData.length} samples)`);
};

// Connect to brain
client.connect();

// Send IMU data every 2 seconds
setInterval(() => {
    client.sendStimulus('imu', {
        accel: [0.12, -0.45, 9.78],
        gyro: [2.3, -1.8, 0.9],
        temp: 34.2
    });
}, 2000);