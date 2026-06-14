/**
 * AuthService — 前端认证服务
 * 登录/注册/登出/获取当前用户
 */

class AuthService {
  constructor(serverUrl = '') {
    this.serverUrl = serverUrl || '';
    this._user = null;  // 缓存当前用户
  }

  /** 获取当前登录用户信息 */
  async me() {
    try {
      const resp = await fetch(this.serverUrl + '/api/me');
      if (!resp.ok) {
        this._user = null;
        return null;
      }
      this._user = await resp.json();
      return this._user;
    } catch {
      this._user = null;
      return null;
    }
  }

  /** 登录 */
  async login(username, password) {
    const resp = await fetch(this.serverUrl + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '登录失败');
    this._user = data;
    return data;
  }

  /** 注册 */
  async register(username, password, nickname = '') {
    const resp = await fetch(this.serverUrl + '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, nickname }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '注册失败');
    return data;
  }

  /** 退出登录 */
  async logout() {
    await fetch(this.serverUrl + '/api/logout', { method: 'POST' });
    this._user = null;
  }

  /** 检查是否已登录，未登录则跳转登录页 */
  async requireAuth() {
    const user = await this.me();
    if (!user) {
      window.location.href = '/login.html';
      return null;
    }
    return user;
  }

  /** 获取缓存的用户信息 */
  get user() {
    return this._user;
  }
}

if (typeof window !== 'undefined') {
  window.AuthService = AuthService;
  window.auth = new AuthService();
}
