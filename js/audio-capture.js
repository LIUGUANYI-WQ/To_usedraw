/**
 * AudioCapture — 音频采集与分片上传模块
 * PR 5.1: 替换 Web Speech API，使用 MediaRecorder 采集音频
 *
 * 音频参数：16kHz / 16bit / 单声道（讯飞实时语音转写要求）
 * 分片间隔：每 400ms 发送一个音频块到后端
 */

class AudioCapture {
  constructor(options = {}) {
    /** 上传地址（C++ 后端 /api/speech） */
    this.uploadUrl = options.uploadUrl || '/api/speech';

    /** 分片间隔（毫秒），讯飞建议 200-500ms */
    this.chunkInterval = options.chunkInterval || 400;

    /** 音频约束：16kHz 单声道 */
    this.constraints = {
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        sampleSize: 16,
        echoCancellation: true,
        noiseSuppression: true,
      },
    };

    /** @type {MediaRecorder|null} */
    this.recorder = null;

    /** @type {MediaStream|null} */
    this.stream = null;

    /** 录制状态 */
    this.isCapturing = false;

    /** 事件回调 */
    this.callbacks = {
      onStart:    options.onStart    || (() => {}),
      onStop:     options.onStop     || (() => {}),
      onChunk:    options.onChunk    || (() => {}),
      onError:    options.onError    || (() => {}),
      onText:     options.onText     || (() => {}),  // 后端返回的转写文字
    };
  }

  /**
   * 检查浏览器是否支持
   */
  static isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
              (window.MediaRecorder || window.webkitMediaRecorder));
  }

  /**
   * 开始采集
   */
  async start() {
    if (this.isCapturing) {
      console.warn('AudioCapture: 已在采集中');
      return;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(this.constraints);
    } catch (e) {
      console.error('AudioCapture: 获取麦克风失败', e);
      this.callbacks.onError({
        type: 'mic-denied',
        message: '麦克风权限被拒绝或设备不可用',
      });
      return;
    }

    // 创建 MediaRecorder（audio/webm 是浏览器最通用的支持，后端转 PCM）
    const mimeType = this._pickMimeType();
    this.recorder = new MediaRecorder(this.stream, {
      mimeType: mimeType,
      audioBitsPerSecond: 256000,
    });

    // 定时分片（每 chunkInterval ms 触发一次 dataavailable）
    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this._uploadChunk(event.data);
      }
    };

    this.recorder.onerror = (event) => {
      console.error('AudioCapture: 录制错误', event.error);
      this.callbacks.onError({
        type: 'recorder-error',
        message: '音频录制异常',
      });
    };

    this.recorder.onstop = () => {
      this.isCapturing = false;
    };

    // 开始录制，每 chunkInterval ms 分片
    this.recorder.start(this.chunkInterval);
    this.isCapturing = true;
    this.callbacks.onStart();

    console.log('AudioCapture: 开始采集，分片间隔 ' + this.chunkInterval + 'ms');
  }

  /**
   * 停止采集
   */
  stop() {
    if (!this.recorder || this.recorder.state === 'inactive') return;

    this.recorder.stop();
    this.isCapturing = false;

    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }

    this.callbacks.onStop();
    console.log('AudioCapture: 采集已停止');
  }

  /**
   * 上传音频分片
   */
  async _uploadChunk(blob) {
    const formData = new FormData();
    formData.append('audio', blob, 'chunk.webm');
    formData.append('mime', this.recorder.mimeType);

    this.callbacks.onChunk(blob);

    try {
      const resp = await fetch(this.uploadUrl, {
        method: 'POST',
        body: formData,
      });

      if (resp.ok) {
        const data = await resp.json().catch(() => ({}));
        // 如果后端返回了识别文字
        if (data.text && data.text.trim()) {
          this.callbacks.onText({
            text: data.text.trim(),
            isFinal: data.isFinal || false,
            confidence: data.confidence || 0,
          });
        }
      }
    } catch (e) {
      // 静默处理上传失败（下一个分片继续）
      console.warn('AudioCapture: 分片上传失败', e.message);
    }
  }

  /**
   * 选择浏览器支持的音频编码格式
   */
  _pickMimeType() {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    for (const t of types) {
      if (MediaRecorder.isTypeSupported(t)) {
        return t;
      }
    }
    return 'audio/webm';  // 兜底
  }
}

// 挂全局
if (typeof window !== 'undefined') {
  window.AudioCapture = AudioCapture;
}
