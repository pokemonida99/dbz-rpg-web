// JS half of the RGSS2 runtime, running in a Web Worker next to ruby.wasm:
// canvases, scene rendering, frame pacing. Ruby calls into the global `RG` object (see rb/rgss.rb).
// Ruby blocks synchronously (Atomics.wait) instead of awaiting; display, audio, input and image
// decoding are done by the page (js/main.js) and exchanged through messages + SharedArrayBuffers.

const FLOOR_TABLE = [
  [[2,4],[1,4],[2,3],[1,3]],[[2,0],[1,4],[2,3],[1,3]],[[2,4],[3,0],[2,3],[1,3]],[[2,0],[3,0],[2,3],[1,3]],
  [[2,4],[1,4],[2,3],[3,1]],[[2,0],[1,4],[2,3],[3,1]],[[2,4],[3,0],[2,3],[3,1]],[[2,0],[3,0],[2,3],[3,1]],
  [[2,4],[1,4],[2,1],[1,3]],[[2,0],[1,4],[2,1],[1,3]],[[2,4],[3,0],[2,1],[1,3]],[[2,0],[3,0],[2,1],[1,3]],
  [[2,4],[1,4],[2,1],[3,1]],[[2,0],[1,4],[2,1],[3,1]],[[2,4],[3,0],[2,1],[3,1]],[[2,0],[3,0],[2,1],[3,1]],
  [[0,4],[1,4],[0,3],[1,3]],[[0,4],[3,0],[0,3],[1,3]],[[0,4],[1,4],[0,3],[3,1]],[[0,4],[3,0],[0,3],[3,1]],
  [[2,2],[1,2],[2,3],[1,3]],[[2,2],[1,2],[2,3],[3,1]],[[2,2],[1,2],[2,1],[1,3]],[[2,2],[1,2],[2,1],[3,1]],
  [[2,4],[3,4],[2,3],[3,3]],[[2,4],[3,4],[2,1],[3,3]],[[2,0],[3,4],[2,3],[3,3]],[[2,0],[3,4],[2,1],[3,3]],
  [[2,4],[1,4],[2,5],[1,5]],[[2,0],[1,4],[2,5],[1,5]],[[2,4],[3,0],[2,5],[1,5]],[[2,0],[3,0],[2,5],[1,5]],
  [[0,4],[3,4],[0,3],[3,3]],[[2,2],[1,2],[2,5],[1,5]],[[0,2],[1,2],[0,3],[1,3]],[[0,2],[1,2],[0,3],[3,1]],
  [[2,2],[3,2],[2,3],[3,3]],[[2,2],[3,2],[2,1],[3,3]],[[2,4],[3,4],[2,5],[3,5]],[[2,0],[3,4],[2,5],[3,5]],
  [[0,4],[1,4],[0,5],[1,5]],[[0,4],[3,0],[0,5],[1,5]],[[0,2],[3,2],[0,3],[3,3]],[[0,2],[1,2],[0,5],[1,5]],
  [[0,4],[3,4],[0,5],[3,5]],[[2,2],[3,2],[2,5],[3,5]],[[0,2],[3,2],[0,5],[3,5]],[[0,0],[1,0],[0,1],[1,1]],
];
const WALL_TABLE = [
  [[2,2],[1,2],[2,1],[1,1]],[[0,2],[1,2],[0,1],[1,1]],[[2,0],[1,0],[2,1],[1,1]],[[0,0],[1,0],[0,1],[1,1]],
  [[2,2],[3,2],[2,1],[3,1]],[[0,2],[3,2],[0,1],[3,1]],[[2,0],[3,0],[2,1],[3,1]],[[0,0],[3,0],[0,1],[3,1]],
  [[2,2],[1,2],[2,3],[1,3]],[[0,2],[1,2],[0,3],[1,3]],[[2,0],[1,0],[2,3],[1,3]],[[0,0],[1,0],[0,3],[1,3]],
  [[2,2],[3,2],[2,3],[3,3]],[[0,2],[3,2],[0,3],[3,3]],[[2,0],[3,0],[2,3],[3,3]],[[0,0],[3,0],[0,3],[3,3]],
];
const WATERFALL_TABLE = [
  [[2,0],[1,0],[2,1],[1,1]],[[0,0],[1,0],[0,1],[1,1]],[[2,0],[3,0],[2,1],[3,1]],[[0,0],[3,0],[0,1],[3,1]],
];

const FONT_MAP = {
  'umeplus gothic': 'UmePlus Gothic',
  '思源黑体': 'GameTC',
  'source han sans sc': 'GameTC',
};

// Simplified -> Traditional (Taiwan) converter using OpenCC tables (js/s2t.json, built by tools/build_s2t.py).
// Applied when text is drawn: the game's data keeps its simplified strings because picture file names
// are built from them.
class S2T {
  constructor(table) {
    this.chars = table.chars;
    this.phrases = table.phrases;
    this.tw = table.tw;
    this.maxLen = Math.max(1, ...Object.keys(this.phrases).map((k) => k.length));
    this.cache = new Map();
  }

  convert(s) {
    if (!/[\u3400-\u9fff]/.test(s)) return s;
    let r = this.cache.get(s);
    if (r !== undefined) return r;
    let out = '';
    for (let i = 0; i < s.length;) {
      let hit = null;
      for (let n = Math.min(this.maxLen, s.length - i); n > 1 && !hit; n--) {
        const p = this.phrases[s.substr(i, n)];
        if (p) { hit = p; i += n; }
      }
      if (!hit) { const c = s[i++]; hit = this.chars[c] || c; }
      out += hit;
    }
    r = '';
    for (const c of out) r += this.tw[c] || c;
    if (this.cache.size > 20000) this.cache.clear();
    this.cache.set(s, r);
    return r;
  }
}

// Shared control block layout (Int32Array over a SharedArrayBuffer), see js/main.js.
export const CTRL = {
  IMG_STATE: 0, IMG_W: 1, IMG_H: 2, IMG_NEED: 3,
  KEYS: 8, LATCH: 32, FAST_BATTLE: 52, PAUSE: 53, REQ_SLOT: 54, REQ: 55,
  FB_W: 56, FB_H: 57, FRAME_PENDING: 58, CMD: 59, RESET: 60, EXP_RATE: 61, SKIP: 62, SLEEP: 63, SIZE: 64,
};
export const NKEYS = 20;
const DECODED_BUDGET = 3e6; // pixels of decoded images kept for reuse (~12MB)

// All canvases are CPU-backed (willReadFrequently): a GPU context loss in the worker would wipe every
// bitmap the game holds, and the game reads pixels back often anyway.
function mkCanvas(w, h) {
  const c = new OffscreenCanvas(Math.max(1, w | 0), Math.max(1, h | 0));
  c.getContext('2d', { willReadFrequently: true });
  return c;
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

export class Runtime {
  constructor(host) {
    this.host = host; // { post(msg, transfer), ctrl: Int32Array, pix: SharedArrayBuffer }
    this.ctrl = host.ctrl;
    this.screen = mkCanvas(544, 416);
    this.sctx = this.screen.getContext('2d');
    this.w = 544;
    this.h = 416;
    this.bitmaps = new Map();
    this.nextId = 1;
    this.imgCache = new Map();
    this.files = new Map(); // lower-case path without ext -> real path
    this.tilemaps = new Map();
    this.scene = mkCanvas(this.w, this.h);
    this.frozen = null;
    this.trans = null;
    this.tmpA = mkCanvas(64, 64);
    this.tmpB = mkCanvas(64, 64);
    this.lastFrame = 0;
    this.nextTime = 0;
    this.lastRender = 0;
    this.stats = { frames: 0, renders: 0, t0: performance.now() };
    this.decoded = new Map(); // real path -> decoded source canvas
    this.conv = null;
    this.layers = [];
    this.frameHooks = [];
  }

  // ---------- assets ----------
  setManifest(list) {
    for (const [p] of list) {
      const noext = p.replace(/\.[^./]+$/, '').toLowerCase();
      if (!this.files.has(noext) || /\.(png|ogg)$/i.test(p)) this.files.set(noext, p);
      this.files.set(p.toLowerCase(), p);
    }
  }

  setS2T(table) { this.conv = new S2T(table); }
  s2t(str) { return this.conv ? this.conv.convert(String(str)) : String(str); }

  // Pictures re-drawn in Traditional Chinese (overrides/, see tools/build_tc_images.py) win over the game's.
  setOverrides(list) {
    for (const p of list) {
      const real = '~/' + p;
      this.files.set(p.toLowerCase(), real);
      this.files.set(p.replace(/\.[^./]+$/, '').toLowerCase(), real);
    }
  }

  resolve(path, exts) {
    const p = path.replace(/\\/g, '/').replace(/^\.\//, '');
    const low = p.toLowerCase();
    for (const e of exts) {
      const hit = this.files.get(low + e);
      if (hit) return hit;
    }
    const hit = this.files.get(low) || this.files.get(low.replace(/\.[^./]+$/, ''));
    return hit || null;
  }

  // Asks the page to decode an image into the shared pixel buffer and blocks until done.
  decodeSync(real) {
    const c = this.ctrl;
    for (;;) {
      Atomics.store(c, CTRL.IMG_STATE, 0);
      this.host.post({ t: 'img', path: real, pix: this.host.pix });
      Atomics.wait(c, CTRL.IMG_STATE, 0);
      const w = c[CTRL.IMG_W], h = c[CTRL.IMG_H];
      if (w === -2) { this.host.pix = new SharedArrayBuffer(c[CTRL.IMG_NEED]); continue; }
      if (w <= 0 || h <= 0) return null;
      const data = new Uint8ClampedArray(w * h * 4);
      data.set(new Uint8Array(this.host.pix, 0, w * h * 4));
      const cv = mkCanvas(w, h);
      cv.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
      return cv;
    }
  }

  // Decoded images are kept in a small most-recently-used cache: the game's own Cache module already keeps
  // the bitmaps it reuses, and keeping every image ever loaded doubled the image memory (phones with 4GB
  // such as the iPhone 13 mini crashed).
  loadImage(real) {
    let cv = this.decoded.get(real);
    if (cv !== undefined) {
      this.decoded.delete(real); // move to the most-recent end
    } else {
      cv = this.decodeSync(real);
      if (cv && cv.width * cv.height > 2e6) this.host.post({ t: 'dbglog', s: `big image ${real} ${cv.width}x${cv.height}` });
    }
    this.decoded.set(real, cv);
    let px = 0;
    for (const c of this.decoded.values()) if (c) px += c.width * c.height;
    for (const [k, c] of this.decoded) {
      if (px <= DECODED_BUDGET || k === real) break;
      if (c) px -= c.width * c.height;
      this.decoded.delete(k);
    }
    return cv;
  }

  // ---------- bitmap API ----------
  addBitmap(c) {
    const id = this.nextId++;
    this.bitmaps.set(id, c);
    return id;
  }
  ctx(id) {
    const c = this.bitmaps.get(id);
    return c ? c.getContext('2d') : null;
  }

  bmpLoad(path) {
    const real = this.resolve(path, ['.png', '.jpg', '.bmp', '.jpeg']);
    if (!real) {
      console.warn('missing image', path);
      return -1;
    }
    const img = this.loadImage(real);
    if (!img) return -1;
    const c = mkCanvas(img.width, img.height);
    c.getContext('2d').drawImage(img, 0, 0);
    return this.addBitmap(c);
  }
  bmpNew(w, h) { return this.addBitmap(mkCanvas(w, h)); }
  bmpSize(id) { const c = this.bitmaps.get(id); return c ? `${c.width},${c.height}` : '0,0'; }
  bmpClone(id) {
    const s = this.bitmaps.get(id);
    const c = mkCanvas(s.width, s.height);
    c.getContext('2d').drawImage(s, 0, 0);
    return this.addBitmap(c);
  }
  bmpFree(id) { this.bitmaps.delete(id); }

  blt(d, x, y, s, sx, sy, sw, sh, op) {
    const dc = this.ctx(d), sc = this.bitmaps.get(s);
    if (!dc || !sc || sw <= 0 || sh <= 0) return;
    const r = this.clipSrc(sc, sx, sy, sw, sh);
    if (!r) return;
    dc.globalAlpha = op / 255;
    dc.drawImage(sc, r[0], r[1], r[2], r[3], x + (r[0] - sx), y + (r[1] - sy), r[2], r[3]);
    dc.globalAlpha = 1;
  }
  clipSrc(c, sx, sy, sw, sh) {
    const x0 = Math.max(0, sx), y0 = Math.max(0, sy);
    const x1 = Math.min(c.width, sx + sw), y1 = Math.min(c.height, sy + sh);
    if (x1 <= x0 || y1 <= y0) return null;
    return [x0, y0, x1 - x0, y1 - y0];
  }
  sblt(d, dx, dy, dw, dh, s, sx, sy, sw, sh, op) {
    const dc = this.ctx(d), sc = this.bitmaps.get(s);
    if (!dc || !sc || sw <= 0 || sh <= 0) return;
    dc.globalAlpha = op / 255;
    dc.drawImage(sc, sx, sy, sw, sh, dx, dy, dw, dh);
    dc.globalAlpha = 1;
  }
  blendBlt(d, x, y, s, sx, sy, sw, sh, type, op) {
    const dc = this.ctx(d);
    if (!dc) return;
    dc.globalCompositeOperation = ['source-over', 'lighter', 'difference', 'multiply', 'screen', 'overlay'][type] || 'source-over';
    this.blt(d, x, y, s, sx, sy, sw, sh, op);
    dc.globalCompositeOperation = 'source-over';
  }
  fill(id, x, y, w, h, r, g, b, a, replace) {
    const c = this.ctx(id);
    if (!c) return;
    c.clearRect(x, y, w, h);
    c.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${a / 255})`;
    c.fillRect(x, y, w, h);
  }
  gfill(id, x, y, w, h, r1, g1, b1, a1, r2, g2, b2, a2, vert) {
    const c = this.ctx(id);
    if (!c) return;
    const gr = vert ? c.createLinearGradient(x, y, x, y + h) : c.createLinearGradient(x, y, x + w, y);
    gr.addColorStop(0, `rgba(${r1 | 0},${g1 | 0},${b1 | 0},${a1 / 255})`);
    gr.addColorStop(1, `rgba(${r2 | 0},${g2 | 0},${b2 | 0},${a2 / 255})`);
    c.clearRect(x, y, w, h);
    c.fillStyle = gr;
    c.fillRect(x, y, w, h);
  }
  clearRect(id, x, y, w, h) { const c = this.ctx(id); if (c) c.clearRect(x, y, w, h); }
  getPixel(id, x, y) {
    const cv = this.bitmaps.get(id);
    if (!cv || x < 0 || y < 0 || x >= cv.width || y >= cv.height) return '0,0,0,0';
    const d = cv.getContext('2d').getImageData(x, y, 1, 1).data;
    return `${d[0]},${d[1]},${d[2]},${d[3]}`;
  }
  pixels(id, fn) {
    const cv = this.bitmaps.get(id);
    if (!cv) return;
    const c = cv.getContext('2d');
    const im = c.getImageData(0, 0, cv.width, cv.height);
    fn(im.data, cv.width, cv.height);
    c.putImageData(im, 0, 0);
  }
  hue(id, h) {
    const cv = this.bitmaps.get(id);
    if (!cv) return;
    const c = mkCanvas(cv.width, cv.height), x = c.getContext('2d');
    x.filter = `hue-rotate(${h}deg)`;
    x.drawImage(cv, 0, 0);
    const d = cv.getContext('2d');
    d.clearRect(0, 0, cv.width, cv.height);
    d.drawImage(c, 0, 0);
  }
  blur(id, r) {
    const cv = this.bitmaps.get(id);
    if (!cv) return;
    const c = mkCanvas(cv.width, cv.height), x = c.getContext('2d');
    x.filter = `blur(${r}px)`;
    x.drawImage(cv, 0, 0);
    const d = cv.getContext('2d');
    d.clearRect(0, 0, cv.width, cv.height);
    d.drawImage(c, 0, 0);
  }
  tone(id, r, g, b) {
    this.pixels(id, (d) => {
      for (let i = 0; i < d.length; i += 4) {
        if (!d[i + 3]) continue;
        d[i] = clamp255(d[i] + r); d[i + 1] = clamp255(d[i + 1] + g); d[i + 2] = clamp255(d[i + 2] + b);
      }
    });
  }
  invert(id) {
    this.pixels(id, (d) => { for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } });
  }
  mosaic(id, rx, ry, rw, rh, mw, mh) {
    this.pixels(id, (d, w, h) => {
      for (let by = ry; by < ry + rh; by += mh) for (let bx = rx; bx < rx + rw; bx += mw) {
        const cx = Math.min(w - 1, bx), cy = Math.min(h - 1, by), o = (cy * w + cx) * 4;
        for (let y = by; y < Math.min(by + mh, ry + rh, h); y++) for (let x = bx; x < Math.min(bx + mw, rx + rw, w); x++) {
          const p = (y * w + x) * 4;
          d[p] = d[o]; d[p + 1] = d[o + 1]; d[p + 2] = d[o + 2]; d[p + 3] = d[o + 3];
        }
      }
    });
  }
  clipMask(id, mid, ox, oy, outer) {
    const m = this.bitmaps.get(mid);
    if (!m) return;
    const md = m.getContext('2d').getImageData(0, 0, m.width, m.height).data;
    this.pixels(id, (d, w, h) => {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const mx = x - ox, my = y - oy;
        let a = (mx >= 0 && my >= 0 && mx < m.width && my < m.height) ? md[(my * m.width + mx) * 4 + 3] : 0;
        if (outer) a = 255 - a;
        const p = (y * w + x) * 4 + 3;
        d[p] = (d[p] * a / 255) | 0;
      }
    });
  }
  getData(id) {
    const cv = this.bitmaps.get(id);
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const out = new Uint8Array(d.length);
    for (let i = 0; i < d.length; i += 4) { out[i] = d[i + 2]; out[i + 1] = d[i + 1]; out[i + 2] = d[i]; out[i + 3] = d[i + 3]; }
    let s = '';
    for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
    return btoa(s);
  }
  setData(id, b64) {
    const bin = atob(b64);
    this.pixels(id, (d) => {
      const n = Math.min(d.length, bin.length);
      for (let i = 0; i < n; i += 4) {
        d[i] = bin.charCodeAt(i + 2); d[i + 1] = bin.charCodeAt(i + 1); d[i + 2] = bin.charCodeAt(i); d[i + 3] = bin.charCodeAt(i + 3);
      }
    });
  }

  fontCss(name, size, bold, italic) {
    const fams = String(name).split(',').map((n) => {
      const k = n.trim();
      return `"${FONT_MAP[k.toLowerCase()] || k}"`;
    });
    fams.push('"GameTC"', '"UmePlus Gothic"', 'sans-serif');
    return `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${fams.join(',')}`;
  }
  textWidth(str, name, size, bold, italic) {
    str = this.s2t(str);
    const c = this.tmpA.getContext('2d');
    c.font = this.fontCss(name, size, bold, italic);
    return Math.ceil(c.measureText(str).width);
  }
  text(id, x, y, w, h, str, align, name, size, bold, italic, shadow, outline, r, g, b, a, or, og, ob, oa) {
    const c = this.ctx(id);
    if (!c) return;
    str = this.s2t(str);
    c.save();
    c.font = this.fontCss(name, size, bold, italic);
    c.textBaseline = 'middle';
    const tw = c.measureText(str).width;
    let sx = 1;
    if (tw > w && w > 0) sx = w / tw;
    let tx = x;
    if (sx === 1) { if (align === 1) tx = x + (w - tw) / 2; else if (align === 2) tx = x + w - tw; }
    const ty = y + h / 2 + 1;
    c.beginPath();
    c.rect(x - 2, y - 2, w + 4, h + 4);
    c.clip();
    c.translate(tx, ty);
    // RGSS squeezes over-long text horizontally only; dense Traditional glyphs turn to mush that way,
    // so shrink proportionally instead (centered on the line).
    c.scale(sx, sx);
    if (outline) {
      c.lineWidth = 2;
      c.strokeStyle = `rgba(${or | 0},${og | 0},${ob | 0},${oa / 255})`;
      c.strokeText(str, 0, 0);
    }
    if (shadow) {
      c.fillStyle = `rgba(0,0,0,${(a / 255) * 0.6})`;
      c.fillText(str, 1, 1);
    }
    c.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${a / 255})`;
    c.fillText(str, 0, 0);
    c.restore();
  }

  // ---------- tilemap ----------
  tm(tid) {
    let t = this.tilemaps.get(tid);
    if (!t) { t = { data: null, xs: 0, ys: 0, zs: 0, pass: null, bm: [] }; this.tilemaps.set(tid, t); }
    return t;
  }
  decode16(b64) {
    const bin = atob(b64);
    const out = new Int16Array(bin.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = (bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8)) << 16 >> 16;
    return out;
  }
  tmMap(tid, xs, ys, zs, b64) { const t = this.tm(tid); t.xs = xs; t.ys = ys; t.zs = zs; t.data = this.decode16(b64); }
  tmPass(tid, b64) { this.tm(tid).pass = this.decode16(b64); }
  tmBitmaps(tid, ids) { this.tm(tid).bm = String(ids).split(',').map(Number); }
  tmFree(tid) { this.tilemaps.delete(tid); }

  drawTilemap(c, tid, upper, ox, oy, fc) {
    const t = this.tilemaps.get(tid);
    if (!t || !t.data) return;
    const bm = t.bm.map((id) => this.bitmaps.get(id));
    const vw = c.__vw || this.w, vh = c.__vh || this.h;
    const tx0 = Math.floor(ox / 32), ty0 = Math.floor(oy / 32);
    const tx1 = Math.floor((ox + vw) / 32), ty1 = Math.floor((oy + vh) / 32);
    const anim = Math.floor(fc / 30);
    for (let ty = ty0; ty <= ty1; ty++) {
      if (ty < 0 || ty >= t.ys) continue;
      for (let tx = tx0; tx <= tx1; tx++) {
        if (tx < 0 || tx >= t.xs) continue;
        const dx = tx * 32 - ox, dy = ty * 32 - oy;
        for (let z = 0; z < t.zs; z++) {
          const id = t.data[tx + (ty + z * t.ys) * t.xs];
          if (id <= 0) continue;
          const over = t.pass && (t.pass[id] & 0x10);
          if (!!over !== !!upper) continue;
          this.drawTile(c, bm, id, dx, dy, anim);
        }
      }
    }
  }

  drawTile(c, bm, id, dx, dy, anim) {
    if (id < 1024) {
      const src = bm[5 + (id >> 8)];
      if (!src) return;
      const t = id & 255;
      c.drawImage(src, ((t % 8) + (t >> 7) * 8) * 32, ((t >> 3) % 16) * 32, 32, 32, dx, dy, 32, 32);
    } else if (id >= 1536 && id < 2048) {
      const src = bm[4];
      if (!src) return;
      const t = id - 1536;
      c.drawImage(src, (t % 8) * 32, (t >> 3) * 32, 32, 32, dx, dy, 32, 32);
    } else if (id >= 2048) {
      this.drawAutotile(c, bm, id, dx, dy, anim);
    }
  }

  drawAutotile(c, bm, id, dx, dy, anim) {
    let table = FLOOR_TABLE;
    const kind = ((id - 2048) / 48) | 0, shape = (id - 2048) % 48;
    const tx = kind % 8, ty = (kind / 8) | 0;
    let bx = 0, by = 0, set = 0;
    if (id < 2816) {
      const wi = [0, 1, 2, 1][anim % 4];
      if (kind === 0) { bx = wi * 2; by = 0; }
      else if (kind === 1) { bx = wi * 2; by = 3; }
      else if (kind === 2) { bx = 6; by = 0; }
      else if (kind === 3) { bx = 6; by = 3; }
      else {
        bx = ((tx / 4) | 0) * 8;
        by = ty * 6 + (((tx / 2) | 0) % 2) * 3;
        if (kind % 2 === 0) bx += wi * 2;
        else { bx += 6; table = WATERFALL_TABLE; by += anim % 3; }
      }
    } else if (id < 4352) { set = 1; bx = tx * 2; by = (ty - 2) * 3; }
    else if (id < 5888) { set = 2; bx = tx * 2; by = (ty - 6) * 2; table = WALL_TABLE; }
    else { set = 3; bx = tx * 2; by = Math.floor((ty - 10) * 2.5 + (ty % 2 === 1 ? 0.5 : 0)); if (ty % 2 === 1) table = WALL_TABLE; }
    const q = table[shape], src = bm[set];
    if (!q || !src) return;
    for (let i = 0; i < 4; i++) {
      c.drawImage(src, (bx * 2 + q[i][0]) * 16, (by * 2 + q[i][1]) * 16, 16, 16, dx + (i % 2) * 16, dy + (i >> 1) * 16, 16, 16);
    }
  }

  // ---------- rendering ----------
  resize(w, h) {
    this.w = w; this.h = h;
    this.screen = mkCanvas(w, h);
    this.sctx = this.screen.getContext('2d');
    this.scene = mkCanvas(w, h);
    this.host.post({ t: 'resize', w, h });
  }

  // Applies tone/color/flash to a canvas region in place via a temp canvas.
  effectCanvas(src, sx, sy, sw, sh, tone, color, flash) {
    const t = this.tmpB.width < sw || this.tmpB.height < sh ? (this.tmpB = mkCanvas(Math.max(sw, this.tmpB.width), Math.max(sh, this.tmpB.height))) : this.tmpB;
    const c = t.getContext('2d');
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, sw, sh);
    c.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
    if (tone && (tone[0] || tone[1] || tone[2] || tone[3])) {
      const im = c.getImageData(0, 0, sw, sh), d = im.data;
      const gr = tone[3] / 255;
      for (let i = 0; i < d.length; i += 4) {
        if (!d[i + 3]) continue;
        let r = d[i], g = d[i + 1], b = d[i + 2];
        if (gr) { const l = r * 0.299 + g * 0.587 + b * 0.114; r += (l - r) * gr; g += (l - g) * gr; b += (l - b) * gr; }
        d[i] = clamp255(r + tone[0]); d[i + 1] = clamp255(g + tone[1]); d[i + 2] = clamp255(b + tone[2]);
      }
      c.putImageData(im, 0, 0);
    }
    for (const col of [color, flash]) {
      if (col && col[3] > 0) {
        c.globalCompositeOperation = 'source-atop';
        c.fillStyle = `rgba(${col[0] | 0},${col[1] | 0},${col[2] | 0},${col[3] / 255})`;
        c.fillRect(0, 0, sw, sh);
      }
    }
    c.globalCompositeOperation = 'source-over';
    return t;
  }

  renderList(target, list) {
    const c = target.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = '#000';
    c.fillRect(0, 0, target.width, target.height);
    const a = list.length ? list.split(',').map(Number) : [];
    // stack of viewport states
    const stack = [];
    let ctx = c, vx = 0, vy = 0, vw = this.w, vh = this.h, vox = 0, voy = 0;
    let i = 0;
    while (i < a.length) {
      const type = a[i++];
      if (type === 1) {
        const n = a.slice(i, i + 31); i += 31;
        this.drawSprite(ctx, n, vx - vox, vy - voy);
      } else if (type === 2) {
        const n = a.slice(i, i + 15); i += 15;
        this.drawPlane(ctx, n, vw, vh, vx, vy);
      } else if (type === 3) {
        const n = a.slice(i, i + 19); i += 19;
        this.drawWindow(ctx, n, vx - vox, vy - voy);
      } else if (type === 4) {
        const tid = a[i], up = a[i + 1], ox = a[i + 2], oy = a[i + 3], fc = a[i + 4]; i += 5;
        ctx.save();
        ctx.translate(vx - vox, vy - voy);
        ctx.__vw = vw; ctx.__vh = vh;
        this.drawTilemap(ctx, tid, up, ox, oy, fc);
        ctx.__vw = 0;
        ctx.restore();
      } else if (type === 5) {
        const n = a.slice(i, i + 18); i += 18;
        stack.push({ ctx, vx, vy, vw, vh, vox, voy, n });
        const off = n.slice(6, 18).some((v) => v !== 0);
        if (off) {
          // viewports with color/tone/flash render into a pooled offscreen layer first
          const depth = stack.length - 1;
          let layer = this.layers[depth];
          if (!layer || layer.width !== this.w || layer.height !== this.h) layer = this.layers[depth] = mkCanvas(this.w, this.h);
          ctx = layer.getContext('2d');
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, this.w, this.h);
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(n[0], n[1], n[2], n[3]);
        ctx.clip();
        vx = n[0]; vy = n[1]; vw = n[2]; vh = n[3]; vox = n[4]; voy = n[5];
        stack[stack.length - 1].layer = off ? ctx.canvas : null;
      } else if (type === 6) {
        ctx.restore();
        const s = stack.pop();
        if (s.layer) {
          const n = s.n;
          const fx = this.effectCanvas(s.layer, n[0], n[1], n[2], n[3], n.slice(10, 14), n.slice(6, 10), n.slice(14, 18));
          s.ctx.drawImage(fx, 0, 0, n[2], n[3], n[0], n[1], n[2], n[3]);
        }
        ({ ctx, vx, vy, vw, vh, vox, voy } = s);
      }
    }
  }

  drawSprite(c, n, offx, offy) {
    const [bid, x, y, ox, oy, sx, sy, sw, sh, zx, zy, angle, mirror, op, blend, bush,
      cr, cg, cb, ca, tr, tg, tb, tgr, fr, fg, fb, fa, wamp, wlen, wph] = n;
    let src = this.bitmaps.get(bid);
    if (!src || sw <= 0 || sh <= 0 || zx === 0 || zy === 0) return;
    const r = this.clipSrc(src, sx, sy, sw, sh);
    if (!r) return;
    let [rx, ry, rw, rh] = r;
    const dox = rx - sx, doy = ry - sy;
    if (tr || tg || tb || tgr || ca > 0 || fa > 0) {
      src = this.effectCanvas(src, rx, ry, rw, rh, [tr, tg, tb, tgr], [cr, cg, cb, ca], [fr, fg, fb, fa]);
      rx = 0; ry = 0;
    }
    c.save();
    c.globalAlpha = op / 255;
    c.globalCompositeOperation = blend === 1 ? 'lighter' : blend === 2 ? 'difference' : 'source-over';
    c.translate(x + offx, y + offy);
    if (angle) c.rotate(-angle * Math.PI / 180);
    c.scale(mirror ? -zx : zx, zy);
    const dx = dox - ox, dy = doy - oy;
    if (wamp) {
      for (let row = 0; row < rh; row += 2) {
        const off = wamp * Math.sin(((wph + row * 360 / wlen) * Math.PI) / 180);
        c.drawImage(src, rx, ry + row, rw, Math.min(2, rh - row), dx + off, dy + row, rw, Math.min(2, rh - row));
      }
    } else if (bush > 0 && bush < rh) {
      const top = rh - bush;
      c.drawImage(src, rx, ry, rw, top, dx, dy, rw, top);
      c.globalAlpha = (op / 255) * 0.5;
      c.drawImage(src, rx, ry + top, rw, bush, dx, dy + top, rw, bush);
    } else {
      c.drawImage(src, rx, ry, rw, rh, dx, dy, rw, rh);
    }
    c.restore();
  }

  drawPlane(c, n, vw, vh, vx, vy) {
    const [bid, ox, oy, zx, zy, op, blend, cr, cg, cb, ca, tr, tg, tb, tgr] = n;
    let src = this.bitmaps.get(bid);
    if (!src) return;
    if (tr || tg || tb || tgr || ca > 0) src = this.effectCanvas(src, 0, 0, src.width, src.height, [tr, tg, tb, tgr], [cr, cg, cb, ca], null);
    const bw = src.width * zx, bh = src.height * zy;
    if (bw <= 0 || bh <= 0) return;
    c.save();
    c.globalAlpha = op / 255;
    c.globalCompositeOperation = blend === 1 ? 'lighter' : blend === 2 ? 'difference' : 'source-over';
    const sx = -(((ox * zx) % bw) + bw) % bw, sy = -(((oy * zy) % bh) + bh) % bh;
    for (let y = sy; y < vh; y += bh) for (let x = sx; x < vw; x += bw) {
      c.drawImage(src, 0, 0, src.width, src.height, vx + x, vy + y, bw, bh);
    }
    c.restore();
  }

  drawWindow(c, n, offx, offy) {
    const [sk, ct, wx, wy, w, h, ox, oy, op, bop, cop, openness, crx, cry, crw, crh, active, pause, anim] = n;
    if (w <= 0 || h <= 0) return;
    const skin = this.bitmaps.get(sk);
    const x = wx + offx, y = wy + offy;
    const oh = Math.floor(h * openness / 255);
    const yy = y + Math.floor((h - oh) / 2);
    c.save();
    if (skin && oh > 0) {
      c.globalAlpha = (op / 255) * (bop / 255);
      c.drawImage(skin, 0, 0, 64, 64, x + 2, yy + 2, w - 4, oh - 4);
      c.save();
      c.beginPath(); c.rect(x + 2, yy + 2, w - 4, oh - 4); c.clip();
      for (let ty = yy + 2; ty < yy + oh - 2; ty += 64) for (let tx = x + 2; tx < x + w - 2; tx += 64) c.drawImage(skin, 0, 64, 64, 64, tx, ty, 64, 64);
      c.restore();
      c.globalAlpha = op / 255;
      const b = 16;
      // corners
      c.drawImage(skin, 64, 0, b, b, x, yy, b, b);
      c.drawImage(skin, 128 - b, 0, b, b, x + w - b, yy, b, b);
      c.drawImage(skin, 64, 64 - b, b, b, x, yy + oh - b, b, b);
      c.drawImage(skin, 128 - b, 64 - b, b, b, x + w - b, yy + oh - b, b, b);
      // edges
      if (w > 2 * b) {
        c.drawImage(skin, 64 + b, 0, 64 - 2 * b, b, x + b, yy, w - 2 * b, b);
        c.drawImage(skin, 64 + b, 64 - b, 64 - 2 * b, b, x + b, yy + oh - b, w - 2 * b, b);
      }
      if (oh > 2 * b) {
        c.drawImage(skin, 64, b, b, 64 - 2 * b, x, yy + b, b, oh - 2 * b);
        c.drawImage(skin, 128 - b, b, b, 64 - 2 * b, x + w - b, yy + b, b, oh - 2 * b);
      }
    }
    if (openness >= 255) {
      c.beginPath(); c.rect(x + 16, y + 16, w - 32, h - 32); c.clip();
      if (skin && crw > 0 && crh > 0) {
        const blink = active ? 0.5 + 0.5 * Math.abs(Math.sin((anim % 40) / 40 * Math.PI)) : 0.5;
        c.globalAlpha = (op / 255) * blink + 0.25;
        this.nine(c, skin, 64, 64, 32, 32, 8, x + 16 + crx - ox, y + 16 + cry - oy, crw, crh);
      }
      const cs = this.bitmaps.get(ct);
      if (cs) {
        c.globalAlpha = cop / 255;
        c.drawImage(cs, x + 16 - ox, y + 16 - oy);
      }
    }
    c.restore();
    if (skin && pause && openness >= 255) {
      c.save();
      c.globalAlpha = op / 255;
      const f = (anim >> 3) % 4;
      c.drawImage(skin, 96 + (f % 2) * 16, 64 + (f >> 1) * 16, 16, 16, x + w / 2 - 8, y + h - 16, 16, 16);
      c.restore();
    }
  }

  nine(c, s, sx, sy, sw, sh, b, dx, dy, dw, dh) {
    if (dw < 2 * b || dh < 2 * b) { c.drawImage(s, sx, sy, sw, sh, dx, dy, dw, dh); return; }
    const cols = [[0, b, 0, b], [b, sw - 2 * b, b, dw - 2 * b], [sw - b, b, dw - b, b]];
    const rows = [[0, b, 0, b], [b, sh - 2 * b, b, dh - 2 * b], [sh - b, b, dh - b, b]];
    for (const [rsy, rsh, rdy, rdh] of rows) for (const [csx, csw, cdx, cdw] of cols) {
      c.drawImage(s, sx + csx, sy + rsy, csw, rsh, dx + cdx, dy + rdy, cdw, rdh);
    }
  }

  render(list) {
    this.stats.renders++;
    this.renderList(this.scene, list);
    this.present();
  }

  // Copies the finished frame into the shared framebuffer; the page paints it on its next animation frame.
  show() {
    const now = performance.now();
    if (now - (this.lastShow || 0) < 15) return; // the page refreshes at most ~60 times a second
    if (Atomics.load(this.ctrl, CTRL.FRAME_PENDING)) return; // previous frame not painted yet
    this.lastShow = now;
    const px = this.sctx.getImageData(0, 0, this.w, this.h).data;
    const fb = this.host.fb;
    if (fb.byteLength < px.length) return;
    new Uint8Array(fb, 0, px.length).set(px);
    Atomics.store(this.ctrl, CTRL.FB_W, this.w);
    Atomics.store(this.ctrl, CTRL.FB_H, this.h);
    Atomics.store(this.ctrl, CTRL.FRAME_PENDING, 1);
  }

  present() {
    const c = this.sctx;
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    if (this.frozen && !this.trans) {
      c.drawImage(this.frozen, 0, 0);
    } else if (this.trans) {
      const t = this.trans;
      c.drawImage(this.scene, 0, 0);
      if (t.mask) {
        // mask transition: pixels whose mask value is below the threshold show the new scene
        const im = t.frozenData;
        const out = c.getImageData(0, 0, this.w, this.h);
        const thr = t.p * (255 + t.vague);
        for (let i = 0, j = 0; i < out.data.length; i += 4, j++) {
          let a = (t.maskVals[j] - thr + t.vague) / Math.max(1, t.vague);
          a = a < 0 ? 0 : a > 1 ? 1 : a;
          if (a > 0) {
            out.data[i] = out.data[i] * (1 - a) + im.data[i] * a;
            out.data[i + 1] = out.data[i + 1] * (1 - a) + im.data[i + 1] * a;
            out.data[i + 2] = out.data[i + 2] * (1 - a) + im.data[i + 2] * a;
          }
        }
        c.putImageData(out, 0, 0);
      } else {
        c.globalAlpha = 1 - t.p;
        c.drawImage(this.frozen, 0, 0);
        c.globalAlpha = 1;
      }
    } else {
      c.drawImage(this.scene, 0, 0);
    }
    if (this.brightness < 255) {
      c.fillStyle = `rgba(0,0,0,${1 - this.brightness / 255})`;
      c.fillRect(0, 0, this.w, this.h);
    }
    this.show();
  }

  freeze() {
    this.frozen = mkCanvas(this.w, this.h);
    this.frozen.getContext('2d').drawImage(this.scene, 0, 0);
  }
  transStart(d, maskId, vague) {
    if (!this.frozen) this.freeze();
    const t = { p: 0, mask: null, vague };
    const m = this.bitmaps.get(maskId);
    if (m) {
      const mc = mkCanvas(this.w, this.h), mx = mc.getContext('2d');
      mx.drawImage(m, 0, 0, this.w, this.h);
      const md = mx.getImageData(0, 0, this.w, this.h).data;
      t.maskVals = new Float32Array(this.w * this.h);
      for (let i = 0; i < t.maskVals.length; i++) t.maskVals[i] = md[i * 4];
      t.mask = true;
      t.frozenData = this.frozen.getContext('2d').getImageData(0, 0, this.w, this.h);
    }
    this.trans = t;
  }
  transStep(p) { if (this.trans) this.trans.p = p; }
  transEnd() { this.trans = null; this.frozen = null; this.present(); }

  snap(list, id) {
    const c = mkCanvas(this.w, this.h);
    this.renderList(c, list);
    const d = this.ctx(id);
    if (d) d.drawImage(c, 0, 0);
  }

  // Frame pacing: blocks until the next game frame is due (and while the page has the game paused).
  // Returns 2 = reset (F12); otherwise bit 1 = render this frame, bit 4 = a quick save/load is waiting.
  frame(fps, brightness, battle) {
    const c = this.ctrl;
    this.brightness = brightness;
    this.stats.frames++;
    for (const f of this.frameHooks) f(this.stats.frames);
    while (Atomics.load(c, CTRL.PAUSE)) Atomics.wait(c, CTRL.PAUSE, 1, 250);
    // 略過對話 also runs cutscenes 6× faster (outside battle)
    const skip = !battle && Atomics.load(c, CTRL.SKIP);
    const speed = (this.turbo || 1) * (battle && Atomics.load(c, CTRL.FAST_BATTLE) ? 2 : 1) * (skip ? 6 : 1);
    const step = 1000 / (fps * speed);
    let now = performance.now();
    if (!this.nextTime || now - this.nextTime > 250) this.nextTime = now;
    this.nextTime += step;
    const wait = this.nextTime - now;
    if (wait > 0.5) Atomics.wait(c, CTRL.SLEEP, 0, wait);
    if (Atomics.exchange(c, CTRL.RESET, 0)) return 2;
    // drawing more often than the display refreshes is wasted work (matters at 2x / turbo speed)
    now = performance.now();
    let r = 0;
    if (now - this.lastRender >= 12) { this.lastRender = now; r |= 1; }
    if (Atomics.load(c, CTRL.REQ)) r |= 4;
    return r;
  }

  takeReq() {
    const op = Atomics.exchange(this.ctrl, CTRL.REQ, 0);
    if (!op) return '';
    return `${op === 1 ? 'save' : 'load'}:${this.ctrl[CTRL.REQ_SLOT]}`;
  }

  quickResult(op, slot, ok, msg) { this.host.post({ t: 'quick', op, slot, ok: !!ok, msg }); }

  // ---------- dev REPL: the page writes Ruby code into host.cmdBuf and sets CTRL.CMD ----------
  pollCmd() {
    const n = Atomics.exchange(this.ctrl, CTRL.CMD, 0);
    if (!n) return '';
    return new TextDecoder().decode(new Uint8Array(this.host.cmdBuf, 0, n).slice());
  }

  // ---------- input ----------
  inputState() {
    const c = this.ctrl;
    let s = '';
    for (let i = 0; i < NKEYS; i++) {
      const latched = Atomics.exchange(c, CTRL.LATCH + i, 0);
      s += (Atomics.load(c, CTRL.KEYS + i) || latched) ? '1' : '0';
    }
    return s;
  }

  // ---------- audio (played by the page) ----------
  audioCall(ch, op, path, a, b) {
    let real = '';
    if (op === 'play') {
      real = this.resolve(path, ['.ogg', '.wav', '.mp3', '.m4a']);
      if (!real) { console.warn('missing audio', path); return; }
    }
    this.host.post({ t: 'audio', ch, op, path: real, a, b });
  }
}
