/**
 * 语音绘图工具 — 主入口（微信风格聊天界面）
 */

(function () {
  'use strict';

  // ===========================
  // DOM 引用
  // ===========================
  const micBtn = document.getElementById('micBtn');
  const sendBtn = document.getElementById('sendBtn');
  const textInput = document.getElementById('textInput');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const chatMessages = document.getElementById('chatMessages');
  const newChatBtn = document.getElementById('newChatBtn');
  const sidebarToggle = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('sidebar');
  const sessionList = document.getElementById('sessionList');
  const chatHeaderTitle = document.getElementById('chatHeaderTitle');

  // ===========================
  // 状态
  // ===========================
  let isListening = false;

  /** @type {ChatEngine} */
  let chatEngine = null;

  /** @type {CommandParser} */
  let parser = null;

  /** @type {LLMService} */
  let llmSvc = null;

  /** @type {AudioCapture} */
  let audioCapture = null;

  /** 累计识别文本 */
  let accumulatedText = '';

  /** 是否已处理过最终结果 */
  let finalProcessed = false;

  /** 当前对话上下文 */
  let lastGenResult = null;
  let lastParseResult = null;

  /** 历史记录缓存 */
  let historyCache = [];

  /** 当前加载行（用于替换为图片） */
  let currentLoadingRow = null;

  // ===========================
  // 初始化
  // ===========================

  function initChat() {
    chatEngine = new ChatEngine(chatMessages);
    parser = new CommandParser();
    llmSvc = new LLMService();
    window.chatEngine = chatEngine;
    window.parser = parser;
    window.llm = llmSvc;
    console.log('ChatEngine + CommandParser + LLM 初始化完成');
    return true;
  }

  // ===========================
  // 消息处理
  // ===========================

  function processUserInput(text) {
    if (!text || !text.trim()) return;
    text = text.trim();

    // 显示用户消息
    const userName = document.getElementById('userName');
    chatEngine.addUserMessage(text, { avatar: userName ? userName.textContent.charAt(0) : '我' });

    // 策略1: 正则优先
    const cmd = parser.parse(text);
    if (cmd) {
      executeCommand(cmd, text);
      return;
    }

    // 策略2: LLM 全链路
    if (llmSvc) {
      statusText.textContent = 'AI 理解中...';
      statusDot.className = 'status-dot status-dot--listening';

      // 先显示 AI 思考气泡
      const thinkingBubble = chatEngine.addAIMessage('思考中...');

      llmSvc.parse(text).then(parseResult => {
        if (!parseResult || !parseResult.englishPrompt) {
          thinkingBubble.textContent = '抱歉，没有理解你的意思，请换种说法试试';
          statusDot.className = 'status-dot status-dot--idle';
          statusText.textContent = '等待中';
          return;
        }

        // 更新思考气泡为解析结果
        thinkingBubble.textContent = '正在生成: ' + (parseResult.correctedText || text);

        return generateImage(parseResult, thinkingBubble);
      }).catch(e => {
        thinkingBubble.textContent = '出错了: ' + e.message;
        statusDot.className = 'status-dot status-dot--idle';
        statusText.textContent = '等待中';
        console.error('AI 链路失败:', e);
      });
    }
  }

  function executeCommand(cmd, rawText) {
    switch (cmd.action) {
      case 'clear_canvas':
        chatEngine.addAIMessage('画布已清空（Canvas 绘图功能在聊天模式下暂不可用）');
        break;
      default:
        chatEngine.addAIMessage('指令已收到: ' + rawText + '（Canvas 绘图功能在聊天模式下暂不可用）');
    }
  }

  // ===========================
  // 图片生成
  // ===========================

  function generateImage(parseResult, thinkingBubble) {
    const modelSelect = document.getElementById('modelSelect');
    const selectedModel = modelSelect ? modelSelect.value : 'flux-schnell';
    const startTime = Date.now();

    statusText.textContent = 'AI 生成图片中...';

    // 替换思考气泡为加载动画
    if (thinkingBubble) {
      thinkingBubble.innerHTML =
        '<div class="msg-loading">' +
          '<div class="dot-anim"><span></span><span></span><span></span></div>' +
          '<span>图片生成中...</span>' +
        '</div>';
      currentLoadingRow = thinkingBubble.closest('.msg-row');
    }

    return llmSvc.generate(
      parseResult.englishPrompt,
      parseResult.negativePrompt || '',
      parseResult.correctedText || '',
      selectedModel
    ).then(genResult => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (genResult && (genResult.imageUrl || genResult.localPath)) {
        const imgUrl = genResult.localPath || genResult.imageUrl;
        const caption = (parseResult.correctedText || '') + ' (' + elapsed + 's)';

        // 替换加载为图片
        if (currentLoadingRow) {
          chatEngine.replaceLoadingWithImage(currentLoadingRow, imgUrl, caption);
          currentLoadingRow = null;
        } else {
          chatEngine.addAIImage(imgUrl, caption);
        }

        // 保存上下文
        lastGenResult = genResult;
        lastParseResult = parseResult;

        // 更新侧边栏
        updateSessionPreview(parseResult.correctedText || '');
        loadHistory();
      } else {
        if (currentLoadingRow) {
          chatEngine.replaceLoadingWithText(currentLoadingRow, '生成失败，请重试');
          currentLoadingRow = null;
        } else {
          chatEngine.addAIMessage('生成失败，请重试');
        }
      }

      statusDot.className = 'status-dot status-dot--idle';
      statusText.textContent = '等待中';
    }).catch(err => {
      if (currentLoadingRow) {
        chatEngine.replaceLoadingWithText(currentLoadingRow, '生成出错: ' + err.message);
        currentLoadingRow = null;
      }
      statusDot.className = 'status-dot status-dot--idle';
      statusText.textContent = '等待中';
      throw err;
    });
  }

  // ===========================
  // 语音输入
  // ===========================

  function onCaptureText(data) {
    const text = data.text;
    const isFinal = data.isFinal;

    if (isFinal) {
      if (finalProcessed) return;
      finalProcessed = true;

      accumulatedText += text;
      // 语音最终结果 → 当作用户输入处理
      processUserInput(accumulatedText);
      accumulatedText = '';

      if (isListening) stopListening();
    } else {
      // 中间结果：显示在输入框
      textInput.value = accumulatedText + text;
    }
  }

  function startListening() {
    if (isListening) return;

    audioCapture = new AudioCapture({
      uploadUrl: '/api/speech',
      chunkInterval: 400,
      onStart: () => {
        isListening = true;
        accumulatedText = '';
        finalProcessed = false;
        setListeningState(true);
        textInput.placeholder = '正在听...';
      },
      onStop: () => {
        isListening = false;
        setListeningState(false);
        textInput.placeholder = '输入文字或点击麦克风语音输入...';
      },
      onError: (err) => {
        console.error('AudioCapture 错误:', err);
        if (err.type === 'mic-denied') {
          chatEngine.addAIMessage('麦克风权限被拒绝，请在浏览器设置中允许访问麦克风');
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
    textInput.placeholder = '输入文字或点击麦克风语音输入...';
  }

  // ===========================
  // 侧边栏
  // ===========================

  function updateSessionPreview(text) {
    chatHeaderTitle.textContent = text.slice(0, 20) || '新对话';

    // 更新或创建侧边栏当前会话
    let activeItem = sessionList.querySelector('.session-item--active');
    if (!activeItem) {
      activeItem = document.createElement('div');
      activeItem.className = 'session-item session-item--active';
      activeItem.innerHTML =
        '<div class="session-icon">🎨</div>' +
        '<div class="session-info">' +
          '<div class="session-name">当前对话</div>' +
          '<div class="session-preview"></div>' +
        '</div>';
      sessionList.prepend(activeItem);
    }
    const preview = activeItem.querySelector('.session-preview');
    if (preview) preview.textContent = text.slice(0, 30);
    const name = activeItem.querySelector('.session-name');
    if (name && text) name.textContent = text.slice(0, 15);
  }

  async function loadHistory() {
    try {
      const resp = await fetch('/api/history');
      if (!resp.ok) return;
      historyCache = await resp.json();
    } catch (e) {
      console.warn('加载历史失败:', e.message);
    }
  }

  function newChat() {
    chatEngine.clear();
    lastGenResult = null;
    lastParseResult = null;
    accumulatedText = '';
    finalProcessed = false;
    currentLoadingRow = null;
    chatHeaderTitle.textContent = '新对话';
    textInput.value = '';

    // 重置侧边栏
    const activeItem = sessionList.querySelector('.session-item--active');
    if (activeItem) activeItem.remove();

    console.log('[新对话] 已清空');
  }

  // ===========================
  // UI 更新
  // ===========================

  function setListeningState(listening) {
    if (listening) {
      micBtn.classList.remove('mic-btn--idle');
      micBtn.classList.add('mic-btn--listening');
      micBtn.classList.remove('mic-btn--error');
      statusDot.className = 'status-dot status-dot--listening';
      statusText.textContent = '监听中...';
    } else {
      micBtn.classList.remove('mic-btn--listening');
      micBtn.classList.add('mic-btn--idle');
      micBtn.classList.remove('mic-btn--error');
      statusDot.className = 'status-dot status-dot--idle';
      statusText.textContent = '等待中';
    }
  }

  function checkAudioSupport() {
    if (!AudioCapture.isSupported()) {
      chatEngine.addAIMessage('当前浏览器不支持音频采集，请使用 Chrome 或 Edge。你可以使用文字输入。');
      micBtn.disabled = true;
      micBtn.classList.add('mic-btn--error');
      return false;
    }
    return true;
  }

  // ===========================
  // 事件绑定
  // ===========================

  // 麦克风按钮
  micBtn.addEventListener('click', function () {
    if (isListening) stopListening();
    else startListening();
  });

  // 发送按钮
  sendBtn.addEventListener('click', function () {
    const text = textInput.value.trim();
    if (!text) return;
    processUserInput(text);
    textInput.value = '';
  });

  // 回车发送
  textInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = textInput.value.trim();
      if (!text) return;
      processUserInput(text);
      textInput.value = '';
    }
  });

  // 新建对话
  newChatBtn.addEventListener('click', newChat);

  // 侧边栏切换
  sidebarToggle.addEventListener('click', function () {
    sidebar.classList.toggle('collapsed');
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
      if (!user) return;
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
    console.log('语音绘图工具 — 启动（微信聊天模式）');

    // 先检查登录
    initAuth();

    if (!initChat()) {
      chatEngine.addAIMessage('初始化失败，请刷新页面重试');
      return;
    }

    checkAudioSupport();

    // 加载历史
    loadHistory();

    console.log('💡 点击麦克风语音输入，或在输入框打字后按回车');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
