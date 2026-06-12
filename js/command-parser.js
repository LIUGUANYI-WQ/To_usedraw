/**
 * CommandParser — 语音指令解析引擎
 * PR 2.2: 中文自然语言 → 结构化 Command 对象
 *
 * 设计原则：
 *   - 策略模式：parse() 按优先级尝试多个解析策略，第一个成功即返回
 *   - 正则优先：本地零延迟处理常见简单指令
 *   - 接口统一：所有策略遵循 `parse(text) → Command | null`
 *   - 未来可插拔 LLM 策略（如 "画一棵樱花树" → 拆解为子命令序列）
 */

class CommandParser {
  constructor() {
    /**
     * 解析策略列表（按优先级从高到低）
     * 每个策略须实现 parse(text: string) → Command | null
     */
    this.strategies = [
      new CanvasOpStrategy(),      // 优先级最高：清空画布
      new SimpleDrawStrategy(),    // "画一个红色的圆"
    ];

    // 未来只需要 push 一行：
    // this.strategies.push(new LLMStrategy({ apiKey: '...' }));
  }

  /**
   * 解析语音文本，返回结构化 Command 或 null
   * @param {string} text - 语音识别最终文本
   * @param {object} [state] - 当前绘图状态（暂未使用，预留给 LLM 策略）
   * @returns {Command|null}
   */
  parse(text, state = {}) {
    if (!text || typeof text !== 'string') return null;

    const cleaned = text.trim();

    for (const strategy of this.strategies) {
      const result = strategy.parse(cleaned);
      if (result) {
        result.raw = cleaned;
        result.matchedStrategy = strategy.name;
        return result;
      }
    }

    return null;
  }

  /**
   * 列出所有策略支持的命令（用于帮助提示）
   */
  getSupportedCommands() {
    return this.strategies.flatMap(s => s.getPatterns?.() ?? []);
  }
}

// ================================================================
// Command 结构（所有策略遵循此格式）
// ================================================================
/**
 * @typedef {object} Command
 * @property {string} action      - 操作类型
 * @property {object} params      - 参数
 * @property {string} raw         - 原始语音文本
 * @property {string} matchedStrategy - 命中策略名
 */

// ================================================================
// 基础策略类
// ================================================================
class BaseStrategy {
  constructor(name) {
    this.name = name;
  }

  /**
   * 尝试解析文本，成功返回 Command，失败返回 null
   */
  parse(text) {
    return null;  // 子类覆盖
  }
}

// ================================================================
// 策略 1：画布操作（清空画布）
// ================================================================
class CanvasOpStrategy extends BaseStrategy {
  constructor() {
    super('CanvasOpStrategy');
  }

  parse(text) {
    const patterns = [
      /^(清空|清除|清理)(画布|屏幕|所有|一切)?$/,
      /^(擦掉|擦除|抹掉|抹除)(画布|屏幕|所有)?$/,
      /^(全部|所有)(清除|清空|删除|删掉)$/,
    ];

    for (const re of patterns) {
      if (re.test(text)) {
        return {
          action: 'clear_canvas',
          params: {},
          matchedPattern: re.toString().slice(1, -1),
        };
      }
    }

    return null;
  }

  getPatterns() {
    return [
      { category: '画布操作', examples: ['清空画布', '清除所有', '擦掉'] },
    ];
  }
}

// ================================================================
// 策略 2：简单绘图（形状 + 可选颜色）
// ================================================================
class SimpleDrawStrategy extends BaseStrategy {
  constructor() {
    super('SimpleDrawStrategy');
  }

  /**
   * 颜色关键词映射表
   */
  static COLORS = {
    '红':   '#e74c3c',
    '红色': '#e74c3c',
    '蓝':   '#3498db',
    '蓝色': '#3498db',
    '绿':   '#2ecc71',
    '绿色': '#2ecc71',
    '黄':   '#f1c40f',
    '黄色': '#f1c40f',
    '橙':   '#e67e22',
    '橙色': '#e67e22',
    '紫':   '#9b59b6',
    '紫色': '#9b59b6',
    '黑':   '#2c3e50',
    '黑色': '#2c3e50',
    '白':   '#ecf0f1',
    '白色': '#ecf0f1',
    '灰':   '#95a5a6',
    '灰色': '#95a5a6',
    '粉':   '#ff69b4',
    '粉色': '#ff69b4',
  };

  /**
   * 形状关键词映射表
   */
  static SHAPES = {
    '圆':     'circle',
    '圆形':   'circle',
    '圆圈':   'circle',
    '正方形': 'square',
    '方块':   'square',
    '矩形':   'rectangle',
    '长方形': 'rectangle',
    '三角形': 'triangle',
    '三角':   'triangle',
    '线':     'line',
    '线段':   'line',
    '直线':   'line',
  };

  parse(text) {
    // 找出句中出现的颜色词
    const foundColor = this._findColor(text);

    // 找出句中出现的形状词
    const foundShape = this._findShape(text);

    if (!foundShape) return null;

    const result = {
      action: 'draw_shape',
      params: {
        shape: foundShape,
        fillColor: foundColor ?? '#e74c3c',   // 默认红色
        strokeColor: '#2c3e50',               // 默认深色描边
      },
    };

    // 如果是线段，fillColor 改为 strokeColor 的语义
    if (foundShape === 'line') {
      result.params.strokeColor = result.params.fillColor;
      result.params.fillColor = null;
    }

    return result;
  }

  _findColor(text) {
    // 按最长匹配优先排序（避免"红色"中的"红"先匹配到）
    const sorted = Object.entries(SimpleDrawStrategy.COLORS)
      .sort((a, b) => b[0].length - a[0].length);

    for (const [keyword, hex] of sorted) {
      if (text.includes(keyword)) return hex;
    }
    return null;
  }

  _findShape(text) {
    const sorted = Object.entries(SimpleDrawStrategy.SHAPES)
      .sort((a, b) => b[0].length - a[0].length);

    for (const [keyword, type] of sorted) {
      if (text.includes(keyword)) return type;
    }
    return null;
  }

  getPatterns() {
    return [
      {
        category: '画形状',
        examples: [
          '画一个圆',
          '画一个红色的正方形',
          '画一个蓝色三角形',
          '画一条黄色的线',
        ],
      },
    ];
  }
}

// ================================================================
// 挂到全局
// ================================================================
if (typeof window !== 'undefined') {
  window.CommandParser = CommandParser;
}
