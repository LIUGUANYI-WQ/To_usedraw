/**
 * 语音绘图工具 — 主入口
 * PR 2.2: 集成 CommandParser，打通中文语音 → 绘图闭环
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
  let isListening = false;
  let recognition = null;
  let restartDelayId = null;      // onend 延迟重启定时器
  let consecutiveRestarts = 0;    // 连续重启计数
  const MAX_RESTARTS = 5;         // 连续重启上限
  const RESTART_DELAY = 300;      // 重启延迟（毫秒）

  /** @type {DrawingEngine} */
  let engine = null;

  /** @type {CommandParser} */
  let parser = null;

  /** @type {LLMService} */
  let llmSvc = null;

  function initCanvas() {
    if (!canvas) {
      console.error('Canvas 元素未找到');
      return false;
    }
    engine = new DrawingEngine(canvas);
    parser = new CommandParser();
    llmSvc = new LLMService();
    window.engine = engine;
    window.parser = parser;
    window.llm = llmSvc;
    console.log('DrawingEngine + CommandParser + LLM 初始化完成');
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
  // ===========================
  // 指令执行 & 反馈
  // ===========================

  /**
   * 执行解析后的绘图指令
   * @param {object} cmd - CommandParser 返回的命令对象
   * @param {string} rawText - 原始语音文本
   * @param {number} confidence - 识别置信度
   */
  function executeCommand(cmd, rawText, confidence) {
    console.log('[指令]', cmd.action, cmd.params);
    console.log('  命中策略:', cmd.matchedStrategy);
    console.log('  识别文本: "' + rawText + '"');
    console.log('  置信度:', (confidence * 100).toFixed(0) + '%');

    switch (cmd.action) {
      case 'draw_shape':
        engine.drawShape(cmd.params.shape, cmd.params);
        canvasPlaceholder.textContent = '已绘制: ' + rawText;
        break;

      case 'clear_canvas':
        engine.clear();
        canvasPlaceholder.textContent = '画布已清空';
        break;

      default:
        console.warn('未知指令类型:', cmd.action);
        canvasPlaceholder.textContent = '未识别的指令: "' + rawText + '"';
        return;
    }
  }

  /**
   * 无法识别时的反馈
   */
  function showUnrecognized(text, confidence) {
    console.log('[未识别] "' + text + '" (置信度: ' + (confidence * 100).toFixed(0) + '%  )');
    canvasPlaceholder.textContent = '未识别: "' + text + '"';
  }

  function showLLMThinking() {
    statusText.textContent = 'AI 思考中...';
    statusDot.className = 'status-dot status-dot--listening';
  }

  function hideLLMThinking() {
    if (isListening) { statusText.textContent = '监听中...'; }
    else { statusText.textContent = '等待中'; statusDot.className = 'status-dot status-dot--idle'; }
  }

  /**
   * 显示 AI 解析结果
   */
  function showParsedResult(result) {
    // 展示纠正后文字和 Prompt 摘要
    transcriptContent.innerHTML =
      '<div class="transcript-final">"' + escapeHtml(result.correctedText || '') + '"</div>' +
      '<div class="prompt-preview">' +
        '<span class="prompt-label">Prompt:</span> ' +
        '<span class="prompt-text">' + escapeHtml(result.englishPrompt || '') + '</span>' +
      '</div>' +
      '<div class="prompt-meta">' +
        'Style: ' + escapeHtml(result.style || 'auto') +
        ' &middot; ' + escapeHtml(result.analysis || '') +
      '</div>';
    canvasPlaceholder.textContent = 'AI 已理解: ' + (result.correctedText || '');
  }

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
    const rec = _createRawRecognition();
    recognition = rec;
    return rec;
  }

  /**
   * 创建原始 SpeechRecognition 实例（不替换全局 recognition）
   * 供 createRecognition 和 onend 自动重启使用
   */
  function _createRawRecognition() {
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
        const txt = final.trim();
        showFinal(txt, confidence);

        // 策略1: 正则优先（本地，0ms）
        const cmd = parser.parse(txt);
        if (cmd) {
          executeCommand(cmd, txt, confidence);
          return;
        }

        // 策略2: LLM 兜底（调后端 /api/parse → DeepSeek）
        if (llmSvc) {
          showLLMThinking();
          llmSvc.parse(txt).then(result => {
            hideLLMThinking();
            if (result && result.englishPrompt) {
              console.log('AI 理解:', result);
              canvasPlaceholder.textContent = 'AI: ' + (result.correctedText || txt);
              showParsedResult(result);
            } else {
              showUnrecognized(txt, confidence);
            }
          }).catch(e => {
            hideLLMThinking();
            console.error('LLM 解析失败:', e);
            showUnrecognized(txt, confidence);
          });
        } else {
          showUnrecognized(txt, confidence);
        }
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
      console.log('语音识别会话结束');
      if (!isListening) {
        setListeningState(false);
        return;
      }

      // 连续重启超出上限 → 放弃，提示用户手动重试
      if (consecutiveRestarts >= MAX_RESTARTS) {
        console.error('连续重启超过 ' + MAX_RESTARTS + ' 次，停止自动恢复');
        stopListening(true);
        showError('语音识别频繁中断，请检查网络后重新点击开始');
        return;
      }

      // 延迟重启，避免和浏览器内部状态冲突
      consecutiveRestarts++;
      console.log('将在 ' + RESTART_DELAY + 'ms 后自动重启（第 ' + consecutiveRestarts + ' 次）...');
      restartDelayId = setTimeout(() => {
        restartDelayId = null;
        if (!isListening) return;

        // 重建 recognition 实例（旧实例可能处于 broken 状态）
        try { rec.abort(); } catch (_) {}
        const freshRec = _createRawRecognition();
        recognition = freshRec;

        try {
          freshRec.start();
          console.log('语音识别已自动重启');
        } catch (e) {
          console.error('重启失败:', e);
          stopListening(true);
          showError('语音识别意外中断，请点击按钮重新开始');
        }
      }, RESTART_DELAY);
    };

    return rec;
  }

  function startListening() {
    if (!recognition) recognition = createRecognition();
    isListening = true;
    consecutiveRestarts = 0;   // 重置重启计数
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
    consecutiveRestarts = 0;  // 重置计数器

    // 清除延迟重启定时器
    if (restartDelayId) {
      clearTimeout(restartDelayId);
      restartDelayId = null;
    }

    if (recognition) {
      try { recognition.abort(); } catch (_) {}
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
    console.log('支持指令:', parser.getSupportedCommands()
      .map(c => c.examples.join(', ')).join('\n          '));
    console.log('💡 点击"开始监听"后对麦克风说中文');
    console.log('💡 试试说: "画一个圆"、"画一个红色正方形"、"清空画布"');
    console.log('💡 控制台: drawTest() 手动绘图 / parser.parse("画一个圆") 测试解析');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
