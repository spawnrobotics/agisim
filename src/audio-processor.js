class PCMProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const inputChannel = inputs[0]?.[0];
        if (inputChannel && inputChannel.length > 0) {
            this.port.postMessage(new Float32Array(inputChannel));
        }
        return true;
    }
}
registerProcessor('pcm-processor', PCMProcessor);