/**
 * 语音绘图工具 — 主入口
 * 使用 AudioCapture + 讯飞后端 WebSocket 做语音转文字
 * PR2: 历史记录 | PR3: 新建对话 | PR4: 迭代调整
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
  const newChatBtn = document.getElementById('newChatBtn');
  const refineBtn = document.getElementById('refineBtn');
  const historyList = document.getElementById('historyList');
  const toggleHistoryBtn = document.getElementById('toggleHistoryBtn');

  // ===========================
  // 状态
  // ===========================
  let isListening = false;

  /** @type {DrawingEngine} */
  let engine = null;

  /** @type {CommandParser} */
  let parser = null;

  /** @type {LLMService} */
  let llmSvc = null;

  /** @type {AudioCapture} */
  let audioCapture = null;

  /** 累计识别文本 */
  let accumulatedText = '';

  /** 是否已处理过最终结果（防止 VAD 自动结束 + 手动停止重复触发） */
  let finalProcessed = false;

  /** 当前对话上下文：最后一次成功的生成结果 */
  let lastGenResult = null;
  let lastParseResult = null;

  /** 历史记录缓存 */
  let historyCache = [];

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
   * 控制台测试函数
   */
  window.drawTest = function (color = '#e74c3c', radius = 80) {
    if (!engine) { console.error('DrawingEngine 未初始化'); return; }
    engine.drawCircle({ fillColor: color, radius: radius });
    console.log('测试圆 — 颜色:', color, '半径:', radius);
  };

  // ===========================
  // 指令执行 & 反馈
  // ===========================

  function executeCommand(cmd, rawText, confidence) {
    console.log('[指令]', cmd.action, cmd.params);
    console.log('  命中策略:', cmd.matchedStrategy);
    console.log('  识别文本: "' + rawText + '"');

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

  function showUnrecognized(text) {
    console.log('[未识别] "' + text + '"');
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

  function showParsedResult(result) {
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

  // ===========================
  // 图片生成（统一入口，供 processFinalText 和 refine 复用）
  // ===========================

  function generateImage(parseResult) {
    const overlay = document.getElementById('loadingOverlay');
    const timerEl = document.getElementById('loadingTimer');
    const loadText = document.getElementById('loadingText');
    const modelSelect = document.getElementById('modelSelect');
    const selectedModel = modelSelect ? modelSelect.value : 'flux-schnell';
    let elapsed = 0;
    const startTime = Date.now();
    const timerId = setInterval(() => {
      elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (timerEl) timerEl.textContent = '已等待 ' + elapsed + ' 秒';
      if (loadText && elapsed > 5) loadText.textContent = '还在生成中，请耐心等候...';
    }, 200);

    if (overlay) overlay.style.display = 'flex';
    statusText.textContent = 'AI 生成图片中...';
    canvasPlaceholder.textContent = '生成中...';

    // 传递 correctedText 和 model 以便后端选择模型
    return llmSvc.generate(
      parseResult.englishPrompt,
      parseResult.negativePrompt || '',
      parseResult.correctedText || '',
      selectedModel
    ).then(genResult => {
      clearInterval(timerId);
      if (overlay) overlay.style.display = 'none';
      hideLLMThinking();
      if (genResult && (genResult.imageUrl || genResult.localPath)) {
        const imgUrl = genResult.localPath || genResult.imageUrl;
        engine.displayImage(imgUrl);
        canvasPlaceholder.textContent = '✅ ' + (parseResult.correctedText || '') + ' （耗时 ' + elapsed + 's）';
        // 保存上下文用于迭代调整
        lastGenResult = genResult;
        lastParseResult = parseResult;
        refineBtn.style.display = 'flex';
        // 刷新历史
        loadHistory();
      } else {
        canvasPlaceholder.textContent = '生成失败，请重试';
      }
    }).catch(err => {
      clearInterval(timerId);
      if (overlay) overlay.style.display = 'none';
      hideLLMThinking();
      throw err;
    });
  }

  // ===========================
  // AudioCapture 回调
  // ===========================

  function onCaptureText(data) {
    const text = data.text;
    const isFinal = data.isFinal;
    const confidence = data.confidence;

    if (isFinal) {
      // 防止重复处理最终结果
      if (finalProcessed) return;
      finalProcessed = true;

      // 最终结果：追加到累计文本
      accumulatedText += text;
      showFinal(accumulatedText, confidence);
      processFinalText(accumulatedText, confidence);
      accumulatedText = '';  // 重置

      // VAD 自动结束或手动停止，停止录音避免继续发空音频
      if (isListening) stopListening();
    } else {
      // 中间结果：显示当前片段
      showInterim(accumulatedText + text);
    }
  }

  function processFinalText(text, confidence) {
    // 策略1: 正则优先（本地，0ms）
    const cmd = parser.parse(text);
    if (cmd) {
      executeCommand(cmd, text, confidence);
      return;
    }

    // 策略2: LLM 全链路 — parse → generate → 展示图片
    if (llmSvc) {
      showLLMThinking();
      statusText.textContent = 'AI 理解中...';
      llmSvc.parse(text).then(parseResult => {
        if (!parseResult || !parseResult.englishPrompt) {
          hideLLMThinking();
          showUnrecognized(text);
          return;
        }
        console.log('AI 理解:', parseResult);
        canvasPlaceholder.textContent = 'AI: ' + (parseResult.correctedText || text);
        showParsedResult(parseResult);
        return generateImage(parseResult);
      }).catch(e => {
        hideLLMThinking();
        console.error('AI 链路失败:', e);
        canvasPlaceholder.textContent = '错误: ' + e.message;
      });
    } else {
      showUnrecognized(text);
    }
  }

  // ===========================
  // PR3: 新建对话
  // ===========================

  function newChat() {
    // 清空当前画布和上下文
    if (engine) engine.clear();
    lastGenResult = null;
    lastParseResult = null;
    accumulatedText = '';
    finalProcessed = false;
    refineBtn.style.display = 'none';

    // 重置 UI
    transcriptContent.innerHTML = '<span class="transcript-placeholder">语音识别内容将实时显示在这里...</span>';
    canvasPlaceholder.textContent = '🎤 说出你想要的画面，AI 帮你画出来';
    confidenceBar.hidden = true;
    hideError();

    console.log('[新对话] 已清空');
  }

  // ===========================
  // PR4: 迭代调整图片
  // ===========================

  function refineImage() {
    if (!lastParseResult || !llmSvc) return;

    // 提示用户说话来描述调整
    transcriptContent.innerHTML =
      '<div class="transcript-final">请说出你想要的调整...</div>' +
      '<div class="prompt-meta">基于上一张图继续优化</div>';

    // 开始监听
    startListening();
  }

  // ===========================
  // PR2: 历史记录
  // ===========================

  async function loadHistory() {
    try {
      const resp = await fetch('/api/history');
      if (!resp.ok) return;
      historyCache = await resp.json();
      renderHistory();
    } catch (e) {
      console.warn('加载历史失败:', e.message);
    }
  }

  function renderHistory() {
    if (!historyCache || historyCache.length === 0) {
      historyList.innerHTML = '<span class="history-placeholder">暂无历史记录</span>';
      return;
    }

    historyList.innerHTML = historyCache.map(item =>
      '<div class="history-item" data-id="' + escapeHtml(item.id) + '">' +
        '<img class="history-thumb" src="' + escapeHtml(item.localPath) + '" alt="历史图片" loading="lazy">' +
        '<div class="history-info">' +
          '<div class="history-prompt">' + escapeHtml(item.correctedText || item.prompt) + '</div>' +
          '<div class="history-time">' + escapeHtml(item.timestamp) + ' · ' + escapeHtml(item.provider) + '</div>' +
        '</div>' +
      '</div>'
    ).join('');

    // 点击历史项 → 显示该图片
    historyList.querySelectorAll('.history-item').forEach(el => {
      el.addEventListener('click', function () {
        const id = this.dataset.id;
        const item = historyCache.find(h => h.id === id);
        if (item && item.localPath) {
          engine.displayImage(item.localPath);
          canvasPlaceholder.textContent = '历史: ' + (item.correctedText || item.prompt);
          // 设置为当前上下文，方便继续调整
          lastParseResult = {
            englishPrompt: item.prompt,
            negativePrompt: item.negativePrompt || '',
            correctedText: item.correctedText || '',
          };
          lastGenResult = { localPath: item.localPath };
          refineBtn.style.display = 'flex';
        }
      });
    });
  }

  // ===========================
  // 监听控制
  // ===========================

  function checkAudioSupport() {
    if (!AudioCapture.isSupported()) {
      showError(
        '当前浏览器不支持音频采集。<br>' +
        '请使用 <strong>Chrome</strong> 或 <strong>Edge</strong> 打开此页面。'
      );
      micBtn.disabled = true;
      micBtn.classList.add('mic-btn--error');
      return false;
    }
    return true;
  }

  function startListening() {
    if (isListening) return;

    // 每次监听创建新的 AudioCapture 实例
    audioCapture = new AudioCapture({
      uploadUrl: '/api/speech',
      chunkInterval: 400,
      onStart: () => {
        isListening = true;
        accumulatedText = '';
        finalProcessed = false;
        setListeningState(true);
        hideError();
      },
      onStop: () => {
        isListening = false;
        setListeningState(false);
      },
      onError: (err) => {
        console.error('AudioCapture 错误:', err);
        if (err.type === 'mic-denied') {
          showError('麦克风权限被拒绝，请在浏览器设置中允许访问麦克风');
          stopListening();
        }
      },
      onText: onCaptureText,
    });

    audioCapture.start();
  }

  function stopListening() {
    isListening = false;
    if (audioCapture) {
      audioCapture.stop();
      audioCapture = null;
    }
    setListeningState(false);
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

    if (confidence !== undefined && confidence > 0) {
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

  newChatBtn.addEventListener('click', newChat);
  refineBtn.addEventListener('click', refineImage);

  toggleHistoryBtn.addEventListener('click', function () {
    const collapsed = historyList.classList.toggle('collapsed');
    toggleHistoryBtn.textContent = collapsed ? '展开' : '收起';
  });

  // ===========================
  // 用户认证
  // ===========================

  function initAuth() {
    const userInfoEl = document.getElementById('userInfo');
    const userAvatarEl = document.getElementById('userAvatar');
    const userNameEl = document.getElementById('userName');
    const logoutBtn = document.getElementById('logoutBtn');

    if (!window.auth) return;

    auth.requireAuth().then(user => {
      if (!user) return;  // requireAuth 会自动跳转
      // 显示用户信息
      userInfoEl.style.display = 'flex';
      const displayName = user.nickname || user.username;
      userNameEl.textContent = displayName;
      userAvatarEl.textContent = displayName.charAt(0).toUpperCase();
    });

    if (logoutBtn) {
      logoutBtn.addEventListener('click', async function () {
        await auth.logout();
        window.location.href = '/login.html';
      });
    }
  }

  // ===========================
  // 启动
  // ===========================
  function bootstrap() {
    console.log('语音绘图工具 — 启动（讯飞模式）');
    console.log('AudioCapture:', AudioCapture.isSupported() ? '支持' : '不支持');

    // 先检查登录
    initAuth();

    if (!checkAudioSupport()) return;

    if (!initCanvas()) {
      showError('Canvas 初始化失败，请刷新页面重试');
      return;
    }

    // 加载历史记录
    loadHistory();

    console.log('画布尺寸:', canvas.width + '×' + canvas.height);
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
