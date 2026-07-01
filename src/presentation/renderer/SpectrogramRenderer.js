/**
 * @presentation renderer/spectrogram
 *
 * Renders a publication-quality spectrogram onto an HTML <canvas> element.
 * * Pipeline:
 * AudioBuffer → windowed STFT → dB magnitude → [ WebGL GPU Interpolation ] → Canvas 2D
 *
 * Key design choices:
 * • ULTIMATE PERFORMANCE & QUALITY: Uses WebGL for hardware-accelerated 
 * bilinear interpolation of dB values and colormap lookup.
 * • Seamless API: Internally manages the WebGL context, outputting to a standard 2D Canvas.
 */

import { fft, hannWindow } from './fft.js';

// ─── STFT parameters ──────────────────────────────────────────────────────────
const FFT_SIZE  = 1024;
const HOP_SIZE  = 128;
const FREQ_MAX  = 16000;
const FREQ_MIN  = 300;

// ─── Rendering parameters ────────────────────────────────────────────────────
const DYNAMIC_RANGE = 50;

// ─── Jet colormap ────────────────────────────────────────────────────────────
const JET_CTRL = [
  [0,   0,   143], // dark blue
  [0,   0,   255], // blue
  [0,   127, 255], // light blue
  [0,   255, 255], // cyan
  [0,   255, 0  ], // green
  [255, 255, 0  ], // yellow
  [255, 127, 0  ], // orange
  [255, 0,   0  ], // red
  [143, 0,   0  ], // dark red
];

function jetRGB(t) {
  t = Math.max(0, Math.min(1, t));
  const s  = t * (JET_CTRL.length - 1);
  const lo = Math.floor(s);
  const hi = Math.min(lo + 1, JET_CTRL.length - 1);
  const f  = s - lo;
  const c0 = JET_CTRL[lo];
  const c1 = JET_CTRL[hi];
  return [
    Math.round(c0[0] + f * (c1[0] - c0[0])),
    Math.round(c0[1] + f * (c1[1] - c0[1])),
    Math.round(c0[2] + f * (c1[2] - c0[2])),
  ];
}

// 建立 256 階一維 RGB 陣列給 WebGL Texture 使用
const LUT_RGB = new Uint8Array(256 * 3);
for (let i = 0; i < 256; i++) {
  const [r, g, b] = jetRGB(i / 255);
  LUT_RGB[i * 3]     = r;
  LUT_RGB[i * 3 + 1] = g;
  LUT_RGB[i * 3 + 2] = b;
}

// ─── SpectrogramRenderer ─────────────────────────────────────────────────────

export class SpectrogramRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    // 主畫布仍然是 2D，用來畫座標軸和接收 WebGL 的渲染結果
    this.ctx = canvas.getContext('2d', { willReadFrequently: false });
    
    // 初始化隱藏的 WebGL 渲染器
    this._initWebGL();
  }

  async render(audioBuffer, segmentBoundaries = [], { drawAxes = true } = {}) {
    const dpr         = window.devicePixelRatio || 1;
    const cssW        = this.canvas.clientWidth;
    const cssH        = this.canvas.clientHeight;

    this.canvas.width  = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    const physW = this.canvas.width;
    const physH = this.canvas.height;

    // ── 1. 擷取音訊與計算 STFT ──────────────────────────────────────────────
    const samples    = this._toMono(audioBuffer);
    const sampleRate = audioBuffer.sampleRate;
    const { frames, numFrames } = this._stft(samples);

    const freqPerBin = sampleRate / FFT_SIZE;
    const binMin     = Math.max(0,       Math.floor(FREQ_MIN / freqPerBin));
    const binMax     = Math.min(FFT_SIZE / 2 - 1, Math.ceil(FREQ_MAX / freqPerBin));
    const usedBins   = binMax - binMin + 1;

    // ── 2. 邊算 dB 邊抓出全域最大值 (極速 O(N)，解決卡頓問題) ────────────────
    let globalMaxDb = -Infinity;
    const dbFrames = frames.map(mag => {
      const db = new Float32Array(usedBins);
      for (let b = 0; b < usedBins; b++) {
        const val = 20 * Math.log10(Math.max(mag[binMin + b], 1e-10));
        db[b] = val;
        if (val > globalMaxDb) globalMaxDb = val;
      }
      return db;
    });

    // ── 3. 捨棄緩慢的百分位數，改用絕對範圍 (解決背景顆粒與噪點) ──────────────
    // 以整首歌的最大音量為基準，往下減 80dB。這能保證背景完美深藍，特徵清晰。
    const REF_MAX = globalMaxDb;
    const MIN_DB  = REF_MAX - DYNAMIC_RANGE;
    const rangeInv = 1 / DYNAMIC_RANGE;

    // ── 4. 打包資料為單色 8-bit Texture 陣列 ─────────────────────────────────
    const textureData = new Uint8Array(numFrames * usedBins);
    
    for (let x = 0; x < numFrames; x++) {
      const db = dbFrames[x];
      for (let y = 0; y < usedBins; y++) {
        const val = db[y]; 
        let norm = (val - MIN_DB) * rangeInv;
        
        // 確保數值在 0 ~ 1 之間
        if (norm < 0) norm = 0;
        if (norm > 1) norm = 1;
        
        textureData[y * numFrames + x] = Math.round(norm * 255);
      }
    }

    // ── 5. WebGL GPU 瞬間渲染 ────────────────────────────────────────────────
    this.glCanvas.width = physW;
    this.glCanvas.height = physH;
    this.gl.viewport(0, 0, physW, physH);

    this._renderWebGL(textureData, numFrames, usedBins);

    // ── 6. 將 GPU 算好的結果貼回 2D 畫布 ─────────────────────────────────────
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(this.glCanvas, 0, 0, physW, physH);

    // ── 7. 疊加 2D 向量 UI (框線與座標軸) ────────────────────────────────────
    this.ctx.scale(dpr, dpr);
    const totalDuration = audioBuffer.duration;
    this._drawBoundaries(segmentBoundaries, totalDuration, cssW, cssH);
    this._drawTopDurationLabels(totalDuration, cssW, cssH);

    if (drawAxes) {
      this._drawFreqAxis(cssW, cssH, sampleRate, binMin, binMax, freqPerBin, usedBins);
      this._drawTimeAxis(cssW, cssH, totalDuration);
    }
  }

  // ─── WebGL GPU Pipeline (核心魔法) ─────────────────────────────────────────

  _initWebGL() {
    this.glCanvas = document.createElement('canvas');
    const gl = this.glCanvas.getContext('webgl');
    if (!gl) {
      console.error('WebGL is not supported in this browser.');
      return;
    }
    this.gl = gl;

    // 頂點著色器：負責畫一個填滿整個畫布的方形
    const vsSource = `
      attribute vec2 a_position;
      varying vec2 v_uv;
      void main() {
        v_uv = a_position * 0.5 + 0.5; // 將 -1~1 轉為 0~1 的紋理座標
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;

    // 片段著色器：硬體級別的插值與查表上色
    const fsSource = `
      precision highp float;
      varying vec2 v_uv;
      uniform sampler2D u_data;      // 音訊資料 (單通道灰階)
      uniform sampler2D u_colormap;  // 色碼表 (RGB)

      void main() {
        // GPU 會自動在這裡做雙線性平滑插值 (Bilinear Interpolation)
        float normalizedDb = texture2D(u_data, v_uv).r; 
        
        // 拿插值出來的數值，去色碼表中尋找顏色
        vec4 color = texture2D(u_colormap, vec2(normalizedDb, 0.5));
        
        gl_FragColor = vec4(color.rgb, 1.0);
      }
    `;

    // 編譯著色器
    const compileShader = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };

    const vertexShader = compileShader(gl.VERTEX_SHADER, vsSource);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fsSource);

    // 連結程式
    this.program = gl.createProgram();
    gl.attachShader(this.program, vertexShader);
    gl.attachShader(this.program, fragmentShader);
    gl.linkProgram(this.program);
    gl.useProgram(this.program);

    // 設定畫布的四個頂點座標 (兩個三角形拼成方形)
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1,  1,
      -1,  1,  1, -1,   1,  1
    ]), gl.STATIC_DRAW);

    const positionLocation = gl.getAttribLocation(this.program, "a_position");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    // 初始化並上傳色碼表紋理 (只需要做一次)
    this.colormapTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.colormapTex);
    // 使用 gl.LINEAR 讓色彩過渡呈現奶油般平滑
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 256, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, LUT_RGB);

    // 建立音訊資料紋理
    this.dataTex = gl.createTexture();
  }

  _renderWebGL(textureData, width, height) {
    const gl = this.gl;
    
    // 確保當前使用的是我們的著色器程式
    gl.useProgram(this.program);
    
    // 【關鍵修復】：解除 WebGL 預設的 4-byte 記憶體對齊限制！
    // 這樣 GPU 才能正確讀取任意寬度 (numFrames) 的陣列，否則讀取失敗會回傳全 0 (導致畫面全藍)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    
    // 上傳目前的音訊資料到 GPU
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, width, height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, textureData);
    
    // 設定 LINEAR 啟動 GPU 硬體級別的雙線性內插平滑
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // 告訴 Shader 去哪裡找 Texture
    gl.uniform1i(gl.getUniformLocation(this.program, "u_data"), 0);
    
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.colormapTex);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_colormap"), 1);

    // 執行 GPU 繪製 (瞬間完成)
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // ─── Private: STFT & Math (保留你的原始實作) ──────────────────────────────

  _toMono(audioBuffer) {
    if (audioBuffer.numberOfChannels === 1) return audioBuffer.getChannelData(0);
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.getChannelData(1);
    const out  = new Float32Array(ch0.length);
    for (let i = 0; i < ch0.length; i++) out[i] = (ch0[i] + ch1[i]) * 0.5;
    return out;
  }

  _stft(samples) {
    const n       = samples.length;
    const window  = hannWindow(FFT_SIZE);
    const halfFFT = FFT_SIZE >> 1;
    const numFrames = Math.max(1, Math.floor((n - FFT_SIZE) / HOP_SIZE) + 1);
    const frames    = [];
    const real = new Float32Array(FFT_SIZE);
    const imag = new Float32Array(FFT_SIZE);

    for (let f = 0; f < numFrames; f++) {
      const start = f * HOP_SIZE;
      real.fill(0);
      imag.fill(0);
      for (let i = 0; i < FFT_SIZE; i++) {
        real[i] = (start + i < n ? samples[start + i] : 0) * window[i];
      }
      fft(real, imag);
      const mag = new Float32Array(halfFFT);
      for (let i = 0; i < halfFFT; i++) {
        mag[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
      }
      frames.push(mag);
    }
    return { frames, numFrames };
  }

  // ─── Private: Overlays ─────────────────────────────────────────────────────

  _drawBoundaries(boundaries, totalDuration, w, h) {
    const lines = [];
    for (let t = 3; t < totalDuration; t += 3) lines.push(t);
    if (!lines.length) return;

    this.ctx.save();
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    this.ctx.lineWidth   = 1.5;
    this.ctx.setLineDash([7, 5]);
    this.ctx.lineDashOffset = 0;
    for (const t of lines) {
      const x = (t / totalDuration) * w;
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, h);
      this.ctx.stroke();
    }
    this.ctx.restore();
  }

  _drawTopDurationLabels(totalDuration, w, h) {
    const segmentLen = 3;
    const numSegments = Math.ceil(totalDuration / segmentLen);

    this.ctx.save();
    this.ctx.font = 'bold 13px sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';

    for (let i = 0; i < numSegments; i++) {
      const tStart = i * segmentLen;
      const tEnd = Math.min(totalDuration, (i + 1) * segmentLen);
      
      const xStart = (tStart / totalDuration) * w;
      const xEnd = (tEnd / totalDuration) * w;
      const xMid = (xStart + xEnd) / 2;
      
      const startStr = Number.isInteger(tStart) ? `${tStart}` : tStart.toFixed(1);
      const endStr = Number.isInteger(tEnd) ? `${tEnd}` : tEnd.toFixed(1);
      const label = `${startStr}s ~ ${endStr}s`;
      
      const textWidth = this.ctx.measureText(label).width;
      const pillW = textWidth + 10;
      const pillH = 18;
      const pillX = xMid - pillW / 2;
      const pillY = 6;
      
      this.ctx.fillStyle = 'rgba(18, 18, 30, 0.75)';
      this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      this.ctx.lineWidth = 1;
      
      this._roundRect(this.ctx, pillX, pillY, pillW, pillH, 4);
      this.ctx.fill();
      this.ctx.stroke();
      
      this.ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      this.ctx.fillText(label, xMid, pillY + pillH / 2 + 0.5);
    }
    
    this.ctx.restore();
  }

  _roundRect(ctx, x, y, width, height, radius) {
    if (width < 2 * radius) radius = width / 2;
    if (height < 2 * radius) radius = height / 2;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
  }

  _drawFreqAxis(w, h, sampleRate, binMin, binMax, freqPerBin, usedBins) {
    const freqMin = binMin * freqPerBin;
    const freqMax = binMax * freqPerBin;
    const ticks   = this._niceTicks(freqMin, freqMax, 7);

    this.ctx.save();
    this.ctx.font        = '13px monospace';
    this.ctx.textAlign   = 'left';

    for (const hz of ticks) {
      const norm = (hz - freqMin) / (freqMax - freqMin);
      const y    = h * (1 - norm);
      const text = `${(hz / 1000).toFixed(hz < 1000 ? 2 : 1)}k`;
      const metrics = this.ctx.measureText(text);
      const bgW = metrics.width + 6;
      this.ctx.fillStyle = 'rgba(18, 18, 30, 0.6)';
      this.ctx.fillRect(2, y - 11, bgW, 14);
      this.ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      this.ctx.fillText(text, 5, y);
    }
    this.ctx.restore();
  }

  _drawTimeAxis(w, h, duration) {
    const ticks = this._niceTicks(0, duration, 8);
    this.ctx.save();
    this.ctx.fillStyle = 'rgba(255,255,255,0.75)';
    this.ctx.font      = '11px monospace';
    this.ctx.textAlign = 'center';
    for (const t of ticks) {
      const x = (t / duration) * w;
      this.ctx.fillText(`${t.toFixed(1)}s`, x, h - 4);
    }
    this.ctx.restore();
  }

  _niceTicks(lo, hi, count) {
    const range    = hi - lo;
    const rawStep  = range / count;
    const mag      = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const step     = Math.ceil(rawStep / mag) * mag;
    const start    = Math.ceil(lo / step) * step;
    const ticks    = [];
    for (let v = start; v <= hi + 1e-9; v += step) ticks.push(parseFloat(v.toFixed(10)));
    return ticks;
  }
}