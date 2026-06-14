/**
 * AudioCapture — 音频采集与分片上传模块
 * 使用 Web Audio API + AudioWorklet 采集原始 PCM (16kHz/16bit/mono)，发二进制到后端 /api/speech
 *
 * 流程：
 *   1. getUserMedia 获取麦克风
 *   2. AudioContext + AudioWorklet 采集 Float32 音频
 *   3. 重采样到 16kHz，转 Int16 PCM
 *   4. 每 400ms 发送一个 PCM 块到 /api/speech (binary POST)
 *   5. 停止时发 /api/speech?end=1 通知后端结束
 */

class AudioCapture {
  constructor(options = {}) {
    /** 上传地址 */
    this.uploadUrl = options.uploadUrl || '/api/speech';

    /** 分片间隔（毫秒） */
    this.chunkInterval = options.chunkInterval || 400;

    /** 目标采样率（讯飞要求 16kHz） */
    this.targetSampleRate = 16000;

    /** @type {AudioContext|null} */
    this.audioCtx = null;

    /** @type {MediaStream|null} */
    this.stream = null;

    /** @type {AudioWorkletNode|null} */
    this.workletNode = null;

    /** 录制状态 */
    this.isCapturing = false;

    /** PCM 缓冲区 */
    this._pcmBuffer = [];

    /** 定时发送 */
    this._timerId = null;

    /** 会话 ID */
    this._sessionId = 'sess_' + Date.now();

    /** 是否已收到最终结果（防止重复触发） */
    this._gotFinal = false;

    /** 事件回调 */
    this.callbacks = {
      onStart:  options.onStart  || (() => {}),
      onStop:   options.onStop   || (() => {}),
      onError:  options.onError  || (() => {}),
      onText:   options.onText   || (() => {}),
    };
  }

  /**
   * 检查浏览器是否支持
   */
  static isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
              (window.AudioContext || window.webkitAudioContext));
  }

  /**
   * 开始采集
   */
  async start() {
    if (this.isCapturing) return;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (e) {
      console.error('AudioCapture: 麦克风获取失败', e);
      this.callbacks.onError({ type: 'mic-denied', message: '麦克风权限被拒绝' });
      return;
    }

    // 创建 AudioContext
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AudioCtx({ sampleRate: this.targetSampleRate });

    // 注册 AudioWorklet 处理器
    try {
      await this.audioCtx.audioWorklet.addModule('/js/pcm-processor.js');
    } catch (e) {
      console.error('AudioCapture: AudioWorklet 加载失败，回退到 ScriptProcessor', e);
      // 回退到 ScriptProcessor（兼容旧浏览器）
      this._startWithScriptProcessor();
      return;
    }

    const source = this.audioCtx.createMediaStreamSource(this.stream);

    // AudioWorklet 采集原始 PCM
    this.workletNode = new AudioWorkletNode(this.audioCtx, 'pcm-processor');
    this.workletNode.port.onmessage = (e) => {
      if (!this.isCapturing) return;
      const int16 = new Int16Array(e.data);
      this._pcmBuffer.push(...int16);
    };

    source.connect(this.workletNode);
    this.workletNode.connect(this.audioCtx.destination);

    this.isCapturing = true;
    this.callbacks.onStart();

    // 定时发送 PCM 分片
    this._timerId = setInterval(() => this._sendChunk(), this.chunkInterval);

    console.log('AudioCapture: 开始采集(AudioWorklet), sampleRate=' + this.audioCtx.sampleRate);
  }

  /**
   * ScriptProcessor 回退方案（兼容不支持 AudioWorklet 的浏览器）
   */
  _startWithScriptProcessor() {
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    const processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      if (!this.isCapturing) return;
      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = this._float32ToInt16(float32);
      this._pcmBuffer.push(...int16);
    };
    source.connect(processor);
    processor.connect(this.audioCtx.destination);
    this._processor = processor;

    this.isCapturing = true;
    this.callbacks.onStart();
    this._timerId = setInterval(() => this._sendChunk(), this.chunkInterval);
    console.log('AudioCapture: 开始采集(ScriptProcessor回退), sampleRate=' + this.audioCtx.sampleRate);
  }

  /**
   * 停止采集
   */
  async stop() {
    if (!this.isCapturing) return;

    this.isCapturing = false;

    // 停止定时器
    if (this._timerId) {
      clearInterval(this._timerId);
      this._timerId = null;
    }

    // 发送剩余数据
    if (this._pcmBuffer.length > 0) {
      await this._sendChunk();
    }

    // 通知后端结束
    try {
      const resp = await fetch(this.uploadUrl + '?end=1&session=' + this._sessionId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new ArrayBuffer(0),
      });
      // 处理结束请求的响应，获取最终文本（如果之前没收到 isFinal）
      if (resp.ok && !this._gotFinal) {
        const data = await resp.json().catch(() => ({}));
        if (data.text && data.text.trim()) {
          this.callbacks.onText({
            text: data.text.trim(),
            isFinal: true,
            confidence: data.confidence || 0.9,
          });
        }
      }
    } catch (e) {
      console.warn('AudioCapture: 发送结束标志失败', e.message);
    }

    // 清理音频资源
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this._processor) {
      this._processor.disconnect();
      this._processor = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }

    this.callbacks.onStop();
    console.log('AudioCapture: 采集已停止');
  }

  /**
   * 发送 PCM 分片到后端
   */
  async _sendChunk() {
    if (this._pcmBuffer.length === 0) return;

    // 取出缓冲区数据
    const pcmData = new Int16Array(this._pcmBuffer);
    this._pcmBuffer = [];

    try {
      const resp = await fetch(this.uploadUrl + '?session=' + this._sessionId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: pcmData.buffer,
      });

      if (resp.ok) {
        const data = await resp.json().catch(() => ({}));
        if (data.text && data.text.trim()) {
          if (data.isFinal) this._gotFinal = true;
          this.callbacks.onText({
            text: data.text.trim(),
            isFinal: data.isFinal || false,
            confidence: data.confidence || 0,
          });
        }
      }
    } catch (e) {
      console.warn('AudioCapture: 分片上传失败', e.message);
    }
  }

  /**
   * Float32 → Int16 转换（ScriptProcessor 回退用）
   */
  _float32ToInt16(float32) {
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16;
  }
}

if (typeof window !== 'undefined') {
  window.AudioCapture = AudioCapture;
}
