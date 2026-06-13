/**
 * LLMService — 前端 API 调用封装
 * PR 3.3: /api/parse (DeepSeek) + /api/generate (通义万相)
 */

class LLMService {
  constructor(serverUrl = '') {
    this.serverUrl = serverUrl || '';
  }

  /**
   * 语音文字 → DeepSeek 理解 → 优化 Prompt
   */
  async parse(text) {
    const resp = await fetch(this.serverUrl + '/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || '/api/parse failed (HTTP ' + resp.status + ')');
    }
    return await resp.json();
  }

  /**
   * 英文 Prompt → 阿里通义万相 → 图片
   */
  async generate(prompt, negativePrompt = '') {
    const body = { prompt };
    if (negativePrompt) body.negativePrompt = negativePrompt;
    const resp = await fetch(this.serverUrl + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || '/api/generate failed (HTTP ' + resp.status + ')');
    }
    return await resp.json();
  }

  async test() {
    console.log('测试后端...');
    try {
      const r = await this.parse('画一棵樱花树');
      console.log('parse 成功:', r);
      return r;
    } catch (e) {
      console.error('测试失败:', e.message);
      return null;
    }
  }
}

if (typeof window !== 'undefined') {
  window.LLMService = LLMService;
  window.llm = new LLMService();
}
