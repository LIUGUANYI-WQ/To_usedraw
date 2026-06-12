/**
 * 语音绘图工具 — 脚手架 v0.1
 * Phase 1: Web Speech API 集成 + Canvas 基础布局
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
  // 状态
  // ===========================
  let isListening = false;
  let recognition = null;
  let ctx = null;

  // ===========================
  // Canvas 初始化
  // ===========================
  function initCanvas() {
    if (!canvas) {
      console.error('Canvas 元素未找到');
      return false;
    }
    ctx = canvas.getContext('2d');
    if (!ctx) {
      console.error('无法获取 Canvas 2D 上下文');
      return false;
    }

    // 初始化白色背景
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 画一个占位指示
    drawPlaceholderHint();

    return true;
  }

  function drawPlaceholderHint() {
    // 画布中央画个浅灰色的十字准星，表示画布已就绪
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    // 横线
    ctx.beginPath();
    ctx.moveTo(cx - 100, cy);
    ctx.lineTo(cx + 100, cy);
    ctx.stroke();
    // 竖线
    ctx.beginPath();
    ctx.moveTo(cx, cy - 100);
    ctx.lineTo(cx, cy + 100);
    ctx.stroke();
    // 小圆
    ctx.beginPath();
    ctx.arc(cx, cy, 30, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 暴露到全局，供手动测试：
   * 在浏览器控制台执行 drawTest() 即可画一个红色测试圆
   */
  window.drawTest = function (color = '#e74c3c', radius = 60) {
    if (!ctx) {
      console.error('Canvas 未初始化');
      return;
    }
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx + 50, cy - 30, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    console.log(`✅ 测试圆已绘制 — 颜色: ${color}, 半径: ${radius}px`);
    console.log('  可通过 drawTest("颜色", 半径) 修改参数重试');
  };

  // ===========================
  // Web Speech API
  // ===========================
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  function checkSpeechSupport() {
    if (!SpeechRecognition) {
      showError(
        '⚠️ 当前浏览器不支持 Web Speech API。<br>' +
        '请使用 <strong>Chrome</strong> 或 <strong>Edge</strong> 打开此页面。<br>' +
        '（Firefox 和 Safari 目前不支持持续语音识别）'
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
    rec.lang = 'en-US';       // 英文为主（指令关键词用英文更准确）
    rec.maxAlternatives = 3;

    // --- 事件处理 ---

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

      // 显示中间结果（灰色斜体）
      if (interim) {
        showInterim(interim.trim());
      }

      // 显示最终结果
      if (final) {
        showFinal(final.trim(), confidence);
        // 打印到控制台（后续 PR 会在此处接 CommandParser）
        console.log(`🎤 [识别结果] (置信度: ${(confidence * 100).toFixed(0)}%):`, final.trim());
      }
    };

    rec.onerror = function (event) {
      console.error('语音识别错误:', event.error, event.message);

      switch (event.error) {
        case 'not-allowed':
          showError('🚫 麦克风权限被拒绝，请在浏览器设置中允许访问麦克风');
          stopListening(true);
          break;
        case 'no-speech':
          // 静默重试，不显示错误（常见情况）
          console.log('未检测到语音，继续监听...');
          break;
        case 'audio-capture':
          showError('🎙️ 未检测到麦克风设备，请检查硬件连接');
          stopListening(true);
          break;
        case 'network':
          showError('🌐 语音识别网络连接失败，请检查网络');
          break;
        case 'aborted':
          // 预期内的事件（手动停止），不处理
          break;
        default:
          console.warn('未处理的语音错误:', event.error);
      }
    };

    rec.onstart = function () {
      console.log('🎤 语音识别已启动');
      setListeningState(true);
    };

    rec.onend = function () {
      console.log('🎤 语音识别已结束');
      // 如果仍然在"监听中"状态（非用户手动停止），自动重启
      if (isListening) {
        console.log('🔄 自动重启语音识别...');
        try {
          rec.start();
        } catch (e) {
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
    if (!recognition) {
      recognition = createRecognition();
    }
    isListening = true;
    hideError();
    try {
      recognition.start();
    } catch (e) {
      // 如果已经在运行，先 stop 再 start
      console.warn('启动异常，尝试重置:', e.message);
      try { recognition.stop(); } catch (_) { /* ignore */ }
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
      try { recognition.stop(); } catch (_) { /* ignore */ }
    }
    if (!errorOccurred) {
      setListeningState(false);
    }
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
    transcriptContent.innerHTML = `<span class="transcript-interim">${escapeHtml(text)}</span>`;
    confidenceBar.hidden = true;

    // 隐藏占位文字
    const placeholder = transcriptContent.querySelector('.transcript-placeholder');
    if (placeholder) placeholder.remove();
  }

  function showFinal(text, confidence) {
    transcriptContent.innerHTML = `<span class="transcript-final">"${escapeHtml(text)}"</span>`;
    canvasPlaceholder.textContent = `听到: "${text}"`;

    // 显示置信度条
    if (confidence !== undefined) {
      confidenceBar.hidden = false;
      const pct = Math.round(confidence * 100);
      confidenceFill.style.width = pct + '%';
      // 颜色：高置信度绿色，低置信度黄色/红色
      if (pct >= 70) {
        confidenceFill.style.background = 'var(--color-success)';
      } else if (pct >= 40) {
        confidenceFill.style.background = 'var(--color-warning)';
      } else {
        confidenceFill.style.background = 'var(--color-danger)';
      }
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
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  });

  // ===========================
  // 启动
  // ===========================
  function bootstrap() {
    console.log('🚀 语音绘图工具 v0.1 — 脚手架启动');
    console.log('   浏览器:', navigator.userAgent);
    console.log('   Web Speech API:', SpeechRecognition ? '✅ 支持' : '❌ 不支持');

    if (!checkSpeechSupport()) {
      return;
    }

    if (!initCanvas()) {
      showError('Canvas 初始化失败，请刷新页面重试');
      return;
    }

    console.log('✅ Canvas 初始化完成 — 尺寸: ' + canvas.width + '×' + canvas.height);
    console.log('💡 提示: 点击"开始监听"按钮或直接在控制台执行 drawTest() 测试画布');
    console.log('💡 对准麦克风说出简单英文试试（如 "hello"），看识别结果');

    // 隐藏初始占位
    drawPlaceholderHint();
  }

  // DOM 加载完成后启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
