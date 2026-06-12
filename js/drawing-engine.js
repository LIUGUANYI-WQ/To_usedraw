/**
 * DrawingEngine — 语音绘图工具 核心绘图引擎
 * PR 2.1: 纯 Canvas 状态管理 + 6 种形状绘制 + 全量重绘
 *
 * 设计原则：
 *   - 完全独立，不依赖语音/指令模块
 *   - 对象列表存储所有图形，每次全量重绘（保证简单可靠）
 *   - 固定尺寸 Canvas（800×500），所有坐标基于此计算
 *   - 策略模式预留接口，未来可插拔 LLM 生成的复杂指令
 */

class DrawingEngine {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [options]
   */
  constructor(canvas, options = {}) {
    /** @type {HTMLCanvasElement} */
    this.canvas = canvas;

    /** @type {CanvasRenderingContext2D} */
    this.ctx = canvas.getContext('2d');

    // ========================
    // 默认样式（后续 PR 会由 CommandParser / UI 动态修改）
    // ========================
    this.defaultStyle = {
      fillColor: '#e74c3c',       // 红色（默认填色，区别于白背景）
      strokeColor: '#2c3e50',     // 深灰蓝描边
      lineWidth: 3,
      fillEnabled: true,
      strokeEnabled: true,
    };

    // ========================
    // 画布逻辑尺寸
    // ========================
    this.width = canvas.width;    // 800
    this.height = canvas.height;  // 500

    // ========================
    // 图形对象列表（"文档模型"）
    // ========================
    this.objects = [];

    // 初始化：铺白底
    this._render();
  }

  // ================================================================
  // 公开 API — 绘制方法
  // 每个方法返回该图形的 id，方便未来做选中/删除/变色
  // ================================================================

  /**
   * 画圆
   * @param {object} opts
   * @param {number} opts.cx        - 圆心 X（默认画布中心）
   * @param {number} opts.cy        - 圆心 Y
   * @param {number} opts.radius    - 半径（默认 80）
   * @param {string} [opts.fillColor]
   * @param {string} [opts.strokeColor]
   * @param {number} [opts.lineWidth]
   * @returns {string} shape id
   */
  drawCircle(opts = {}) {
    const cx = opts.cx ?? this.width / 2;
    const cy = opts.cy ?? this.height / 2;
    const radius = opts.radius ?? 80;

    const obj = this._makeShape('circle', opts, {
      cx: this._clampX(cx),
      cy: this._clampY(cy),
      radius: this._clampSize(radius),
    });

    this.objects.push(obj);
    this._render();
    return obj.id;
  }

  /**
   * 画矩形
   * @param {object} opts
   * @param {number} opts.x         - 左上角 X（默认居中偏移）
   * @param {number} opts.y         - 左上角 Y
   * @param {number} opts.width     - 宽度（默认 160）
   * @param {number} opts.height    - 高度（默认 120）
   */
  drawRectangle(opts = {}) {
    const w = opts.width ?? 160;
    const h = opts.height ?? 120;
    const x = opts.x ?? (this.width - w) / 2;
    const y = opts.y ?? (this.height - h) / 2;

    const obj = this._makeShape('rectangle', opts, {
      x: this._clampX(x),
      y: this._clampY(y),
      width: this._clampSize(w),
      height: this._clampSize(h),
    });

    this.objects.push(obj);
    this._render();
    return obj.id;
  }

  /**
   * 画正方形（width = height）
   */
  drawSquare(opts = {}) {
    const size = opts.size ?? 140;
    const x = opts.x ?? (this.width - size) / 2;
    const y = opts.y ?? (this.height - size) / 2;

    const obj = this._makeShape('square', opts, {
      x: this._clampX(x),
      y: this._clampY(y),
      size: this._clampSize(size),
    });

    this.objects.push(obj);
    this._render();
    return obj.id;
  }

  /**
   * 画正三角形
   * @param {object} opts
   * @param {number} opts.cx        - 中心 X
   * @param {number} opts.cy        - 中心 Y
   * @param {number} opts.size      - 边长（默认 140）
   */
  drawTriangle(opts = {}) {
    const cx = opts.cx ?? this.width / 2;
    const cy = opts.cy ?? this.height / 2;
    const size = opts.size ?? 140;
    const h = size * Math.sqrt(3) / 2;   // 等边三角形高

    const obj = this._makeShape('triangle', opts, {
      cx: this._clampX(cx),
      cy: this._clampY(cy),
      size: this._clampSize(size),
      // 顶点坐标由渲染时计算
    });

    this.objects.push(obj);
    this._render();
    return obj.id;
  }

  /**
   * 画线段
   * @param {object} opts
   * @param {number} opts.x1
   * @param {number} opts.y1
   * @param {number} opts.x2
   * @param {number} opts.y2
   */
  drawLine(opts = {}) {
    const x1 = opts.x1 ?? this.width / 2 - 100;
    const y1 = opts.y1 ?? this.height / 2;
    const x2 = opts.x2 ?? this.width / 2 + 100;
    const y2 = opts.y2 ?? this.height / 2;

    const obj = this._makeShape('line', opts, {
      x1: this._clampX(x1),
      y1: this._clampY(y1),
      x2: this._clampX(x2),
      y2: this._clampY(y2),
    });

    this.objects.push(obj);
    this._render();
    return obj.id;
  }

  /**
   * 画弧线（默认半圆）
   * @param {object} opts
   * @param {number} opts.cx
   * @param {number} opts.cy
   * @param {number} opts.radius    - 默认 100
   * @param {number} opts.startAngle - 弧度，默认 0
   * @param {number} opts.endAngle   - 弧度，默认 PI（半圆）
   */
  drawArc(opts = {}) {
    const cx = opts.cx ?? this.width / 2;
    const cy = opts.cy ?? this.height / 2;
    const radius = opts.radius ?? 100;
    const startAngle = opts.startAngle ?? 0;
    const endAngle = opts.endAngle ?? Math.PI;

    const obj = this._makeShape('arc', opts, {
      cx: this._clampX(cx),
      cy: this._clampY(cy),
      radius: this._clampSize(radius),
      startAngle,
      endAngle,
    });

    this.objects.push(obj);
    this._render();
    return obj.id;
  }

  // ================================================================
  // 公开 API — 便捷方法（供 future CommandParser / LLM 使用）
  // ================================================================

  /**
   * 通用绘制入口
   * @param {'circle'|'rectangle'|'square'|'triangle'|'line'|'arc'} type
   * @param {object} opts
   */
  drawShape(type, opts = {}) {
    switch (type) {
      case 'circle':    return this.drawCircle(opts);
      case 'rectangle': return this.drawRectangle(opts);
      case 'square':    return this.drawSquare(opts);
      case 'triangle':  return this.drawTriangle(opts);
      case 'line':      return this.drawLine(opts);
      case 'arc':       return this.drawArc(opts);
      default:
        console.warn(`DrawingEngine: 未知形状类型 "${type}"`);
        return null;
    }
  }

  /**
   * 清空画布
   */
  clear() {
    if (this.objects.length === 0) return;  // 已经是空的
    this.objects = [];
    this._render();
  }

  /**
   * 修改默认样式（后续 CommandParser 会频繁调用）
   */
  setFillColor(color)   { this.defaultStyle.fillColor = color;   }
  setStrokeColor(color) { this.defaultStyle.strokeColor = color; }
  setLineWidth(w)       { this.defaultStyle.lineWidth = w;       }
  setFillEnabled(v)     { this.defaultStyle.fillEnabled = v;     }
  setStrokeEnabled(v)   { this.defaultStyle.strokeEnabled = v;   }

  /**
   * 获取当前状态快照
   */
  getState() {
    return {
      width: this.width,
      height: this.height,
      objectCount: this.objects.length,
      defaultStyle: { ...this.defaultStyle },
    };
  }

  // ================================================================
  // 内部方法
  // ================================================================

  /**
   * 构建图形对象（合并样式 + 生成 ID）
   */
  _makeShape(type, opts, params) {
    return {
      id: this._uid(),
      type,
      params,
      style: {
        fillColor:    opts.fillColor    ?? this.defaultStyle.fillColor,
        strokeColor:  opts.strokeColor  ?? this.defaultStyle.strokeColor,
        lineWidth:    opts.lineWidth    ?? this.defaultStyle.lineWidth,
        fillEnabled:  opts.fillEnabled  ?? this.defaultStyle.fillEnabled,
        strokeEnabled: opts.strokeEnabled ?? this.defaultStyle.strokeEnabled,
      },
      createdAt: Date.now(),
    };
  }

  /**
   * 全量重绘
   * - 先铺白底
   * - 再逐个绘制 objects[] 中的图形
   */
  _render() {
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;

    // 1. 白底
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // 2. 逐个绘制
    for (const obj of this.objects) {
      this._drawOne(ctx, obj);
    }
  }

  /**
   * 绘制单个图形
   */
  _drawOne(ctx, obj) {
    const s = obj.style;

    ctx.save();
    ctx.fillStyle = s.fillColor;
    ctx.strokeStyle = s.strokeColor;
    ctx.lineWidth = s.lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    switch (obj.type) {
      case 'circle':
        ctx.beginPath();
        ctx.arc(obj.params.cx, obj.params.cy, obj.params.radius, 0, Math.PI * 2);
        if (s.fillEnabled) ctx.fill();
        if (s.strokeEnabled) ctx.stroke();
        break;

      case 'rectangle':
        if (s.fillEnabled) ctx.fillRect(obj.params.x, obj.params.y, obj.params.width, obj.params.height);
        if (s.strokeEnabled) ctx.strokeRect(obj.params.x, obj.params.y, obj.params.width, obj.params.height);
        break;

      case 'square':
        if (s.fillEnabled) ctx.fillRect(obj.params.x, obj.params.y, obj.params.size, obj.params.size);
        if (s.strokeEnabled) ctx.strokeRect(obj.params.x, obj.params.y, obj.params.size, obj.params.size);
        break;

      case 'triangle': {
        const { cx, cy, size } = obj.params;
        const h = size * Math.sqrt(3) / 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy - h / 2);             // 顶点
        ctx.lineTo(cx - size / 2, cy + h / 2);  // 左下
        ctx.lineTo(cx + size / 2, cy + h / 2);  // 右下
        ctx.closePath();
        if (s.fillEnabled) ctx.fill();
        if (s.strokeEnabled) ctx.stroke();
        break;
      }

      case 'line':
        ctx.beginPath();
        ctx.moveTo(obj.params.x1, obj.params.y1);
        ctx.lineTo(obj.params.x2, obj.params.y2);
        // 线段不填色，只描边
        ctx.stroke();
        break;

      case 'arc':
        ctx.beginPath();
        ctx.arc(obj.params.cx, obj.params.cy, obj.params.radius, obj.params.startAngle, obj.params.endAngle);
        if (s.fillEnabled) ctx.fill();
        if (s.strokeEnabled) ctx.stroke();
        break;
    }

    ctx.restore();
  }

  // ================================================================
  // 工具方法
  // ================================================================

  _clampX(x) { return Math.max(0, Math.min(this.width, x)); }
  _clampY(y) { return Math.max(0, Math.min(this.height, y)); }
  _clampSize(s) { return Math.max(5, Math.min(Math.min(this.width, this.height), s)); }

  _uid() {
    return 's_' + Math.random().toString(36).slice(2, 9) + '_' + Date.now().toString(36);
  }
}

// ================================================================
// 挂到全局，方便在浏览器控制台测试
// ================================================================
if (typeof window !== 'undefined') {
  window.DrawingEngine = DrawingEngine;
}
