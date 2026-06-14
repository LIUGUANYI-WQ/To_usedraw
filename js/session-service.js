/**
 * SessionService — 聊天会话管理服务
 * 封装后端 /api/sessions CRUD 接口
 */

class SessionService {
  constructor() {
    /** 当前活跃会话 ID */
    this.currentSessionId = null;
    /** 会话列表缓存 */
    this.sessions = [];
  }

  /**
   * 获取当前用户的会话列表
   * @returns {Promise<Array>}
   */
  async list() {
    const resp = await fetch('/api/sessions', { credentials: 'same-origin' });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error('获取会话列表失败: ' + err);
    }
    this.sessions = await resp.json();
    return this.sessions;
  }

  /**
   * 创建新会话
   * @param {string} [title='新对话']
   * @returns {Promise<object>} { id, title, createdAt }
   */
  async create(title = '新对话') {
    const resp = await fetch('/api/sessions', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[SessionService] 创建会话失败:', resp.status, errText);
      throw new Error('创建会话失败(' + resp.status + '): ' + errText);
    }
    const session = await resp.json();
    this.currentSessionId = session.id;
    this.sessions.unshift({
      id: session.id,
      title: session.title,
      preview: '',
      createdAt: session.createdAt,
      updatedAt: session.createdAt,
      messageCount: 0,
    });
    return session;
  }

  /**
   * 获取会话详情（含消息列表）
   * @param {string} sessionId
   * @returns {Promise<object>}
   */
  async get(sessionId) {
    const resp = await fetch('/api/sessions/' + sessionId, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error('获取会话详情失败');
    const session = await resp.json();
    this.currentSessionId = sessionId;
    return session;
  }

  /**
   * 向会话添加消息
   * @param {string} sessionId
   * @param {object} message { role, type, text, imageUrl?, localPath? }
   * @returns {Promise<object>}
   */
  async addMessage(sessionId, message) {
    if (!sessionId) return;
    try {
      const resp = await fetch('/api/sessions/' + sessionId + '/messages', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });
      if (!resp.ok) return;
      const result = await resp.json();

      // 更新本地缓存
      const cached = this.sessions.find(s => s.id === sessionId);
      if (cached) {
        cached.messageCount = (cached.messageCount || 0) + 1;
        cached.preview = message.text ? message.text.substr(0, 30) : '';
        if (message.type === 'image') cached.preview = '🖼 ' + cached.preview;
        cached.updatedAt = result.timestamp || new Date().toISOString();
        if (cached.messageCount === 1 && message.role === 'user') {
          cached.title = message.text.substr(0, 20);
        }
      }
      return result;
    } catch (e) {
      console.warn('[SessionService] 保存消息失败:', e.message);
    }
  }

  /**
   * 删除会话
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async delete(sessionId) {
    const resp = await fetch('/api/sessions/' + sessionId, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (!resp.ok) throw new Error('删除会话失败');
    this.sessions = this.sessions.filter(s => s.id !== sessionId);
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }
    return true;
  }

  /**
   * 确保有活跃会话（没有则自动创建）
   * @returns {Promise<string>} sessionId
   */
  async ensureSession() {
    if (this.currentSessionId) return this.currentSessionId;
    const session = await this.create();
    return session.id;
  }
}

if (typeof window !== 'undefined') {
  window.SessionService = SessionService;
}
