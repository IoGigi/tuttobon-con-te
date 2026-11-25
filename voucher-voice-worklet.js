class VoiceCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) this.port.postMessage(channel);
    return true;
  }
}

registerProcessor('voice-capture', VoiceCapture);
