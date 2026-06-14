/**
 * PCM Processor — AudioWorklet 处理器
 * 采集原始 Float32 音频，转 Int16 PCM，发送到主线程
 *
 * 使用方法：
 *   await audioCtx.audioWorklet.addModule('/js/pcm-processor.js');
 *   const node = new AudioWorkletNode(audioCtx, 'pcm-processor');
 */

class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const float32 = input[0];
    if (!float32 || float32.length === 0) return true;

    // Float32 → Int16
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    // 发送到主线程
    this.port.postMessage(int16.buffer, [int16.buffer]);

    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
