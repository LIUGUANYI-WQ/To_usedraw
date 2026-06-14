/**
 * ChatEngine — 微信风格聊天消息渲染引擎
 * 管理消息列表、气泡渲染、流式文字、图片展示
 */

class ChatEngine {
  constructor(containerEl) {
    /** @type {HTMLElement} */
    this.container = containerEl;
    /** 消息列表 */
    this.messages = [];
    /** 当前流式消息的 DOM 引用 */
    this._streamingBubble = null;
  }

  /**
   * 添加用户消息气泡
   * @param {string} text - 用户输入文本
   * @param {object} [opts]
   * @param {string} [opts.avatar] - 头像文字
   */
  addUserMessage(text, opts = {}) {
    this._removeWelcome();
    const msg = { role: 'user', text, time: new Date() };
    this.messages.push(msg);
    const el = this._createMsgRow('user', text, opts.avatar);
    this.container.appendChild(el);
    this._scrollToBottom();
    return el;
  }

  /**
   * 添加 AI 文字消息气泡
   * @param {string} text - AI 回复文本
   */
  addAIMessage(text) {
    this._removeWelcome();
    const msg = { role: 'ai', text, time: new Date() };
    this.messages.push(msg);
    const el = this._createMsgRow('ai', text);
    this.container.appendChild(el);
    this._scrollToBottom();
    return el;
  }

  /**
   * 添加 AI 图片消息气泡
   * @param {string} imageUrl - 图片 URL
   * @param {string} [caption] - 图片说明
   */
  addAIImage(imageUrl, caption = '') {
    this._removeWelcome();
    const msg = { role: 'ai', type: 'image', imageUrl, caption, time: new Date() };
    this.messages.push(msg);

    const row = document.createElement('div');
    row.className = 'msg-row msg-row--ai';

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = 'AI';

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    const img = document.createElement('img');
    img.className = 'msg-image';
    img.src = imageUrl;
    img.alt = caption || 'AI 生成图片';
    img.loading = 'lazy';
    bubble.appendChild(img);

    if (caption) {
      const captionEl = document.createElement('div');
      captionEl.className = 'msg-meta';
      captionEl.textContent = caption;
      bubble.appendChild(captionEl);
    }

    row.appendChild(avatar);
    row.appendChild(bubble);
    this.container.appendChild(row);
    this._scrollToBottom();
    return row;
  }

  /**
   * 开始流式 AI 消息（先显示空气泡 + 光标）
   * @returns {HTMLElement} 气泡元素，后续可调用 appendStreamText
   */
  startStreamMessage() {
    this._removeWelcome();
    const row = document.createElement('div');
    row.className = 'msg-row msg-row--ai';

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = 'AI';

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble streaming-cursor';

    row.appendChild(avatar);
    row.appendChild(bubble);
    this.container.appendChild(row);
    this._scrollToBottom();

    this._streamingBubble = bubble;
    return bubble;
  }

  /**
   * 追加流式文字到当前流式气泡
   * @param {string} delta - 增量文字
   */
  appendStreamText(delta) {
    if (!this._streamingBubble) return;
    this._streamingBubble.textContent += delta;
    this._scrollToBottom();
  }

  /**
   * 结束流式消息（移除光标）
   */
  endStreamMessage() {
    if (!this._streamingBubble) return;
    this._streamingBubble.classList.remove('streaming-cursor');
    this.messages.push({
      role: 'ai',
      text: this._streamingBubble.textContent,
      time: new Date(),
    });
    this._streamingBubble = null;
  }

  /**
   * 添加加载中提示（三点动画）
   * @returns {HTMLElement} 加载行元素
   */
  addLoading() {
    this._removeWelcome();
    const row = document.createElement('div');
    row.className = 'msg-row msg-row--ai';

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = 'AI';

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.innerHTML =
      '<div class="msg-loading">' +
        '<div class="dot-anim"><span></span><span></span><span></span></div>' +
        '<span>生成中</span>' +
      '</div>';

    row.appendChild(avatar);
    row.appendChild(bubble);
    this.container.appendChild(row);
    this._scrollToBottom();
    return row;
  }

  /**
   * 替换加载中提示为图片
   * @param {HTMLElement} loadingRow - addLoading 返回的元素
   * @param {string} imageUrl - 图片 URL
   * @param {string} [caption] - 说明
   */
  replaceLoadingWithImage(loadingRow, imageUrl, caption = '') {
    const bubble = loadingRow.querySelector('.msg-bubble');
    if (!bubble) return;
    bubble.innerHTML = '';

    const img = document.createElement('img');
    img.className = 'msg-image';
    img.src = imageUrl;
    img.alt = caption || 'AI 生成图片';
    img.loading = 'lazy';
    bubble.appendChild(img);

    if (caption) {
      const captionEl = document.createElement('div');
      captionEl.className = 'msg-meta';
      captionEl.textContent = caption;
      bubble.appendChild(captionEl);
    }

    this.messages.push({
      role: 'ai',
      type: 'image',
      imageUrl,
      caption,
      time: new Date(),
    });

    this._scrollToBottom();
  }

  /**
   * 替换加载中提示为文字
   */
  replaceLoadingWithText(loadingRow, text) {
    const bubble = loadingRow.querySelector('.msg-bubble');
    if (!bubble) return;
    bubble.textContent = text;

    this.messages.push({ role: 'ai', text, time: new Date() });
    this._scrollToBottom();
  }

  /**
   * 清空所有消息
   */
  clear() {
    this.messages = [];
    this._streamingBubble = null;
    this.container.innerHTML =
      '<div class="chat-welcome" id="chatWelcome">' +
        '<div class="welcome-icon">🎨</div>' +
        '<h3>说出你想要的画面</h3>' +
        '<p>点击下方麦克风按钮，用语音描述你想生成的图片</p>' +
      '</div>';
  }

  /**
   * 获取最后一条 AI 消息
   */
  getLastAIMessage() {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'ai') return this.messages[i];
    }
    return null;
  }

  // ===========================
  // 内部方法
  // ===========================

  _removeWelcome() {
    const welcome = this.container.querySelector('.chat-welcome');
    if (welcome) welcome.remove();
  }

  _createMsgRow(role, text, avatarText) {
    const row = document.createElement('div');
    row.className = 'msg-row msg-row--' + role;

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    if (role === 'user') {
      avatar.textContent = avatarText || '我';
    } else {
      avatar.textContent = 'AI';
    }

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = text;

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = this._formatTime(new Date());

    row.appendChild(avatar);
    row.appendChild(bubble);
    row.appendChild(meta);

    return row;
  }

  _scrollToBottom() {
    requestAnimationFrame(() => {
      this.container.scrollTop = this.container.scrollHeight;
    });
  }

  _formatTime(date) {
    const h = date.getHours().toString().padStart(2, '0');
    const m = date.getMinutes().toString().padStart(2, '0');
    return h + ':' + m;
  }
}

if (typeof window !== 'undefined') {
  window.ChatEngine = ChatEngine;
}
