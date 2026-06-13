/**
 * LLMService — 前端 LLM 调用封装
 * PR 3.2: 调用后端 /api/parse，后端代理 DeepSeek
 */

class LLMService {
  constructor(serverUrl = '') {
    this.serverUrl = serverUrl || '';  // 空 = 同源
  }

  /**
   * 调用后端 LLM 解析接口
   * @param {string} text - 语音识别文本
   * @returns {Promise<{correctedText: string, englishPrompt: string, style: string, analysis: string}>}
   */
  async parse(text) {
    const resp = await fetch(this.serverUrl + '/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || 'LLM 服务请求失败 (HTTP ' + resp.status + ')');
    }

    return await resp.json();
  }

  /**
   * 快速测试：验证 DeepSeek 连通性
   * 在控制台执行: llm.test()
   */
  async test() {
    console.log('🔗 测试 LLM 连通性...');
    try {
      const result = await this.parse('画一个红色的圆');
      console.log('✅ LLM 连通成功:', result);
      return result;
    } catch (e) {
      console.error('❌ LLM 连通失败:', e.message);
      return null;
    }
  }
}

// 挂到全局
if (typeof window !== 'undefined') {
  window.LLMService = LLMService;
  window.llm = new LLMService();
}
