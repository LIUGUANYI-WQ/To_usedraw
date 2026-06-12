/**
 * 语音绘图工具 — 主入口
 * PR 2.1: 集成 DrawingEngine，语音识别仍只打印结果
 */

(function () {
  'use strict';

  // ===========================
  // DOM 引用
  // ===========================
  const micBtn = document.getElementById('micBtn');
  const micLabel = document.getElementById('micLabel');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const transcriptContent = document.getElementById('transcriptContent');
  const confidenceBar = document.getElementById('confidenceBar');
  const confidenceFill = document.getElementById('confidenceFill');
  const errorArea = document.getElementById('errorArea');
  const errorMessage = document.getElementById('errorMessage');
  const canvas = document.getElementById('drawCanvas');
  const canvasPlaceholder = document.getElementById('canvasPlaceholder');

  // ===========================
  // DrawingEngine
  // ===========================
  /** @type {DrawingEngine} */
  let engine = null;

  function initCanvas() {
    if (!canvas) {
      console.error('Canvas 元素未找到');
      return false;
    }
    engine = new DrawingEngine(canvas);
    window.engine = engine;   // 暴露到全局，方便控制台测试
    console.log('✅ DrawingEngine 初始化完成');
    return true;
  }

  /**
   * 控制台测试函数：
   *   drawTest()                         → 默认红色测试圆
   *   drawTest('blue')                   → 蓝色圆
   *   engine.drawRectangle({ fillColor: '#3498db' })   → 蓝色矩形
   *   engine.drawTriangle({ fillColor: '#f1c40f' })    → 黄色三角形
   *   engine.clear()                     → 清空画布
   */
  window.drawTest = function (color = '#e74c3c', radius = 80) {
    if (!engine) { console.error('DrawingEngine 未初始化'); return; }
    engine.drawCircle({ fillColor: color, radius: radius });
    console.log('✅ 测试圆 — 颜色:', color, '半径:', radius);
    console.log('   试试: engine.drawRectangle({ fillColor: "#3498db" })');
    console.log('   试试: engine.drawTriangle({ fillColor: "#f1c40f" })');
    console.log('   试试: engine.clear()');
  };

  // ===========================
  // Web Speech API
  // ===========================
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  function checkSpeechSupport() {
    if (!SpeechRecognition) {
      showError(
        '当前浏览器不支持 Web Speech API。<br>' +
        '请使用 <strong>Chrome</strong> 或 <strong>Edge</strong> 打开此页面。'
      );
      micBtn.disabled = true;
      micBtn.classList.add('mic-btn--error');
      return false;
    }
    return true;
  }

  function createRecognition() {
    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'zh-CN';
    rec.maxAlternatives = 3;

    rec.onresult = function (event) {
      let interim = '';
      let final = '';
      let confidence = 0;

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript.trim();
        if (result.isFinal) {
          final += transcript + ' ';
          confidence = result[0].confidence;
        } else {
          interim += transcript + ' ';
        }
      }

      if (interim) showInterim(interim.trim());

      if (final) {
        showFinal(final.trim(), confidence);
        // TODO PR 2.2: 这里接入 CommandParser，把语音转成绘图指令
        console.log('[识别结果] (置信度: ' + (confidence * 100).toFixed(0) + '%):', final.trim());
        console.log('  (PR 2.2 将在此处接入 CommandParser → DrawingEngine)');
      }
    };

    rec.onerror = function (event) {
      console.error('语音识别错误:', event.error, event.message);
      switch (event.error) {
        case 'not-allowed':
          showError('麦克风权限被拒绝，请在浏览器设置中允许访问麦克风');
          stopListening(true);
          break;
        case 'no-speech':
          console.log('未检测到语音，继续监听...');
          break;
        case 'audio-capture':
          showError('未检测到麦克风设备，请检查硬件连接');
          stopListening(true);
          break;
        case 'network':
          showError('语音识别网络连接失败，请检查网络');
          break;
        case 'aborted':
          break;
        default:
          console.warn('未处理的语音错误:', event.error);
      }
    };

    rec.onstart = function () {
      console.log('语音识别已启动');
      setListeningState(true);
    };

    rec.onend = function () {
      console.log('语音识别已结束');
      if (isListening) {
        console.log('自动重启语音识别...');
        try { rec.start(); } catch (e) {
          console.error('重启失败:', e);
          stopListening(true);
          showError('语音识别意外中断，请点击按钮重新开始');
        }
      } else {
        setListeningState(false);
      }
    };

    return rec;
  }

  function startListening() {
    if (!recognition) recognition = createRecognition();
    isListening = true;
    hideError();
    try {
      recognition.start();
    } catch (e) {
      console.warn('启动异常，尝试重置:', e.message);
      try { recognition.stop(); } catch (_) {}
      setTimeout(() => {
        try { recognition.start(); } catch (e2) {
          console.error('重试启动失败:', e2);
          stopListening(true);
          showError('无法启动语音识别，请刷新页面重试');
        }
      }, 200);
    }
  }

  function stopListening(errorOccurred = false) {
    isListening = false;
    if (recognition) {
      try { recognition.stop(); } catch (_) {}
    }
    if (!errorOccurred) setListeningState(false);
  }

  // ===========================
  // UI 更新
  // ===========================
  function setListeningState(listening) {
    if (listening) {
      micLabel.textContent = '停止监听';
      micBtn.classList.remove('mic-btn--idle');
      micBtn.classList.add('mic-btn--listening');
      micBtn.classList.remove('mic-btn--error');
      statusDot.className = 'status-dot status-dot--listening';
      statusText.textContent = '监听中...';
    } else {
      micLabel.textContent = '开始监听';
      micBtn.classList.remove('mic-btn--listening');
      micBtn.classList.add('mic-btn--idle');
      micBtn.classList.remove('mic-btn--error');
      statusDot.className = 'status-dot status-dot--idle';
      statusText.textContent = '等待中';
    }
  }

  function showInterim(text) {
    transcriptContent.innerHTML = '<span class="transcript-interim">' + escapeHtml(text) + '</span>';
    confidenceBar.hidden = true;
    const placeholder = transcriptContent.querySelector('.transcript-placeholder');
    if (placeholder) placeholder.remove();
  }

  function showFinal(text, confidence) {
    transcriptContent.innerHTML = '<span class="transcript-final">"' + escapeHtml(text) + '"</span>';
    canvasPlaceholder.textContent = '听到: "' + text + '"';

    if (confidence !== undefined) {
      confidenceBar.hidden = false;
      const pct = Math.round(confidence * 100);
      confidenceFill.style.width = pct + '%';
      if (pct >= 70) confidenceFill.style.background = 'var(--color-success)';
      else if (pct >= 40) confidenceFill.style.background = 'var(--color-warning)';
      else confidenceFill.style.background = 'var(--color-danger)';
    }
  }

  function showError(message) {
    errorMessage.innerHTML = message;
    errorArea.hidden = false;
    statusDot.className = 'status-dot status-dot--error';
    statusText.textContent = '错误';
    micBtn.classList.remove('mic-btn--listening');
    micBtn.classList.add('mic-btn--error');
  }

  function hideError() {
    errorArea.hidden = true;
    errorMessage.innerHTML = '';
    micBtn.classList.remove('mic-btn--error');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ===========================
  // 事件绑定
  // ===========================
  micBtn.addEventListener('click', function () {
    if (isListening) stopListening();
    else startListening();
  });

  // ===========================
  // 启动
  // ===========================
  function bootstrap() {
    console.log('语音绘图工具 — 启动');
    console.log('Web Speech API:', SpeechRecognition ? '支持' : '不支持');

    if (!checkSpeechSupport()) return;

    if (!initCanvas()) {
      showError('Canvas 初始化失败，请刷新页面重试');
      return;
    }

    console.log('画布尺寸:', canvas.width + '×' + canvas.height);
    console.log('💡 点击"开始监听"后对麦克风说中文');
    console.log('💡 在控制台执行 drawTest() 测试画布绘图');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
