/**
 * LLMService — 前端 API 调用封装
 * /api/parse (非流式) + /api/parse-stream (流式 SSE) + /api/generate (通义万相)
 */

class LLMService {
  constructor(serverUrl = '') {
    this.serverUrl = serverUrl || '';
  }

  /**
   * 语音文字 → 星火 Lite → 优化 Prompt（非流式）
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
   * 语音文字 → 星火 Lite → 优化 Prompt（流式 SSE）
   *
   * @param text          语音转写文本
   * @param onDelta       每收到增量文本的回调 (deltaText)
   * @return {object}     最终解析结果 { englishPrompt, negativePrompt, ... }
   */
  async parseStream(text, onDelta) {
    const resp = await fetch(this.serverUrl + '/api/parse-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || '/api/parse-stream failed (HTTP ' + resp.status + ')');
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // 按 \n\n 分割 SSE 事件
      const parts = buffer.split('\n\n');
      buffer = parts.pop(); // 最后一段可能不完整，留到下次

      for (const part of parts) {
        const lines = part.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const jsonStr = line.substring(5).trim();
          if (!jsonStr) continue;

          let data;
          try { data = JSON.parse(jsonStr); } catch { continue; }

          if (data.type === 'delta' && onDelta) {
            onDelta(data.text);
          } else if (data.type === 'done') {
            finalResult = data;
          } else if (data.type === 'error') {
            throw new Error(data.error || 'Spark API failed');
          }
        }
      }
    }

    return finalResult;
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
