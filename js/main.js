/**
 * 语音绘图工具 — 主入口（微信风格聊天界面 + 多会话管理）
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

  /** @type {SessionService} */
  let sessionSvc = null;

  /** @type {AudioCapture} */
  let audioCapture = null;

  /** 累计识别文本 */
  let accumulatedText = '';

  /** 是否已处理过最终结果 */
  let finalProcessed = false;

  /** 当前对话上下文 */
  let lastGenResult = null;
  let lastParseResult = null;

  /** 当前加载行（用于替换为图片） */
  let currentLoadingRow = null;

  // ===========================
  // 初始化
  // ===========================

  function initChat() {
    chatEngine = new ChatEngine(chatMessages);
    parser = new CommandParser();
    llmSvc = new LLMService();
    sessionSvc = new SessionService();
    window.chatEngine = chatEngine;
    window.parser = parser;
    window.llm = llmSvc;
    window.sessionSvc = sessionSvc;
    console.log('ChatEngine + CommandParser + LLM + SessionService 初始化完成');
    return true;
  }

  // ===========================
  // 消息处理
  // ===========================

  async function processUserInput(text) {
    if (!text || !text.trim()) return;
    text = text.trim();

    // 确保有活跃会话
    const sessionId = await sessionSvc.ensureSession();

    // 显示用户消息
    const userName = document.getElementById('userName');
    chatEngine.addUserMessage(text, { avatar: userName ? userName.textContent.charAt(0) : '我' });

    // 保存用户消息到后端
    sessionSvc.addMessage(sessionId, { role: 'user', type: 'text', text: text });

    // 更新侧边栏
    renderSessionList();

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
          sessionSvc.addMessage(sessionId, { role: 'ai', type: 'text', text: '抱歉，没有理解你的意思' });
          return;
        }

        // 更新思考气泡为解析结果
        thinkingBubble.textContent = '正在生成: ' + (parseResult.correctedText || text);

        return generateImage(parseResult, thinkingBubble, sessionId);
      }).catch(e => {
        thinkingBubble.textContent = '出错了: ' + e.message;
        statusDot.className = 'status-dot status-dot--idle';
        statusText.textContent = '等待中';
        sessionSvc.addMessage(sessionId, { role: 'ai', type: 'text', text: '出错了: ' + e.message });
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

  function generateImage(parseResult, thinkingBubble, sessionId) {
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

        // 保存 AI 图片消息到后端
        if (sessionId) {
          sessionSvc.addMessage(sessionId, {
            role: 'ai',
            type: 'image',
            text: parseResult.correctedText || '',
            imageUrl: genResult.imageUrl || '',
            localPath: genResult.localPath || '',
          });
        }

        // 更新侧边栏
        renderSessionList();
      } else {
        if (currentLoadingRow) {
          chatEngine.replaceLoadingWithText(currentLoadingRow, '生成失败，请重试');
          currentLoadingRow = null;
        } else {
          chatEngine.addAIMessage('生成失败，请重试');
        }
        if (sessionId) {
          sessionSvc.addMessage(sessionId, { role: 'ai', type: 'text', text: '生成失败，请重试' });
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
      // 语音结束后自动发送
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
  // 会话管理（侧边栏）
  // ===========================

  /**
   * 渲染侧边栏会话列表
   */
  async function renderSessionList() {
    try {
      const sessions = await sessionSvc.list();
      sessionList.innerHTML = '';

      for (const s of sessions) {
        const item = document.createElement('div');
        item.className = 'session-item' + (s.id === sessionSvc.currentSessionId ? ' session-item--active' : '');
        item.dataset.sessionId = s.id;

        item.innerHTML =
          '<div class="session-icon">🎨</div>' +
          '<div class="session-info">' +
            '<div class="session-name">' + escapeHtml(s.title || '新对话') + '</div>' +
            '<div class="session-preview">' + escapeHtml(s.preview || '') + '</div>' +
          '</div>' +
          '<button class="session-delete-btn" title="删除会话">&times;</button>';

        // 点击切换会话
        item.addEventListener('click', function (e) {
          // 如果点击的是删除按钮，不切换
          if (e.target.classList.contains('session-delete-btn')) return;
          switchSession(s.id);
        });

        // 删除按钮
        const deleteBtn = item.querySelector('.session-delete-btn');
        deleteBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          deleteSession(s.id);
        });

        sessionList.appendChild(item);
      }
    } catch (e) {
      console.warn('渲染会话列表失败:', e.message);
    }
  }

  /**
   * 切换到指定会话
   */
  async function switchSession(sessionId) {
    if (sessionSvc.currentSessionId === sessionId) return;

    try {
      const session = await sessionSvc.get(sessionId);
      sessionSvc.currentSessionId = sessionId;

      // 清空聊天区并加载历史消息
      chatEngine.clear();
      chatHeaderTitle.textContent = session.title || '新对话';

      if (session.messages && session.messages.length > 0) {
        for (const msg of session.messages) {
          if (msg.role === 'user') {
            chatEngine.addUserMessage(msg.text);
          } else if (msg.role === 'ai') {
            if (msg.type === 'image' && (msg.imageUrl || msg.localPath)) {
              chatEngine.addAIImage(msg.localPath || msg.imageUrl, msg.text);
            } else {
              chatEngine.addAIMessage(msg.text);
            }
          }
        }
      }

      // 更新侧边栏高亮
      renderSessionList();
    } catch (e) {
      console.error('切换会话失败:', e.message);
    }
  }

  /**
   * 删除会话
   */
  async function deleteSession(sessionId) {
    if (!confirm('确定删除这个对话？')) return;

    try {
      await sessionSvc.delete(sessionId);

      // 如果删除的是当前会话，清空聊天区
      if (!sessionSvc.currentSessionId) {
        chatEngine.clear();
        chatHeaderTitle.textContent = '新对话';
        lastGenResult = null;
        lastParseResult = null;
      }

      renderSessionList();
    } catch (e) {
      console.error('删除会话失败:', e.message);
    }
  }

  /**
   * 新建对话
   */
  async function newChat() {
    chatEngine.clear();
    lastGenResult = null;
    lastParseResult = null;
    accumulatedText = '';
    finalProcessed = false;
    currentLoadingRow = null;
    sessionSvc.currentSessionId = null;
    chatHeaderTitle.textContent = '新对话';
    textInput.value = '';

    // 更新侧边栏（去掉高亮）
    const activeItem = sessionList.querySelector('.session-item--active');
    if (activeItem) activeItem.classList.remove('session-item--active');

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

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ===========================
  // 事件绑定
  // ===========================

  // 麦克风按钮
  micBtn.addEventListener('click', function () {
    if (isListening) stopListening();
    else startListening();
  });

  // 自动/手动发送切换
  const autoSendToggle = document.getElementById('autoSendToggle');
  const autoSendLabel = autoSendToggle.querySelector('.auto-send-label');
  autoSendToggle.addEventListener('click', function () {
    autoSendVoice = !autoSendVoice;
    autoSendLabel.textContent = autoSendVoice ? '自动' : '手动';
    autoSendToggle.classList.toggle('auto-send--manual', !autoSendVoice);
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
    console.log('语音绘图工具 — 启动（微信聊天模式 + 多会话）');

    // 先检查登录
    initAuth();

    if (!initChat()) {
      chatEngine.addAIMessage('初始化失败，请刷新页面重试');
      return;
    }

    checkAudioSupport();

    // 加载会话列表
    renderSessionList();

    console.log('💡 点击麦克风语音输入，或在输入框打字后按回车');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
