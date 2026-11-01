// Page side: shows frames from the game worker, plays audio, feeds input, decodes images, keeps saves.
import { CTRL, NKEYS } from './rgss.js?v=20261101-1546';

const GAME = 'game/';
// '~/…' paths are our Traditional-Chinese replacements in overrides/, everything else is the original game
const gameUrl = (p) => (p.startsWith('~/') ? 'overrides/' + p.slice(2) : GAME + p).split('/').map(encodeURIComponent).join('/');

const $screen = document.getElementById('screen');
const $status = document.getElementById('status');
const $err = document.getElementById('error');
const BUILD = '20261101-1546'; // shown in the diagnostic so a cached old copy is easy to spot
const status = (s) => { $status.textContent = s; $status.hidden = !s; };
const toast = (s) => {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = s;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 6000);
};

if (!self.crossOriginIsolated) {
  status('正在啟用執行環境，頁面會自動重新整理…');
  // if the service worker reload didn't help, say why instead of waiting forever
  setTimeout(async () => {
    const sw = navigator.serviceWorker;
    const regs = sw ? (await sw.getRegistrations().catch(() => [])).length : 0;
    status('');
    $err.hidden = false;
    $err.textContent = '這個瀏覽器沒有啟用跨來源隔離，遊戲無法執行。\n請按下方按鈕重新整理；若仍不行，請改用 Safari 或 Chrome 最新版。\n\n'
      + `secure=${self.isSecureContext} sw=${!!sw} registered=${regs} controlled=${!!(sw && sw.controller)}\n${navigator.userAgent}`;
    const b = document.createElement('button');
    b.textContent = '重新整理';
    b.style.cssText = 'display:block;margin-top:12px;font-size:16px;padding:8px 16px';
    b.onclick = () => location.reload();
    $err.appendChild(b);
  }, 6000);
  throw new Error('not crossOriginIsolated');
}

// ---------- shared memory with the worker ----------
const ctrlBuf = new SharedArrayBuffer(CTRL.SIZE * 4);
const ctrl = new Int32Array(ctrlBuf);

// dev REPL (?debug): rubyEval('code') runs Ruby inside the game on the next frame; output lands in pageStats.log
const cmdBuf = new SharedArrayBuffer(1 << 16);
window.rubyEval = (code) => {
  const b = new TextEncoder().encode(code);
  new Uint8Array(cmdBuf).set(b);
  Atomics.store(ctrl, CTRL.CMD, b.length);
};

// ---------- saves (IndexedDB) ----------
const idb = new Promise((res, rej) => {
  const r = indexedDB.open('dbz-rpg-web', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('files');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function idbAll() {
  const db = await idb;
  return new Promise((res) => {
    const out = [];
    const req = db.transaction('files').objectStore('files').openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return res(out);
      out.push([c.key, c.value]);
      c.continue();
    };
    req.onerror = () => res(out);
  });
}
async function idbPut(k, v) {
  const db = await idb;
  db.transaction('files', 'readwrite').objectStore('files').put(v, k);
}

// ---------- input ----------
const KEYMAP = {
  // indexes match Input::KEYS in rb/rgss.rb
  ArrowDown: 0, ArrowLeft: 1, ArrowRight: 2, ArrowUp: 3,
  ShiftLeft: 4, ShiftRight: 4,
  KeyX: 5, Escape: 5, Backspace: 5, Numpad0: 5,
  KeyZ: 6, Enter: 6, Space: 6, NumpadEnter: 6,
  KeyA: 7, KeyS: 8, KeyD: 9, KeyQ: 10, PageUp: 10, KeyW: 11, PageDown: 11,
  ControlLeft: 13, ControlRight: 13, AltLeft: 14, AltRight: 14,
  F5: 15, F6: 16, F7: 17, F8: 18, F9: 19,
};
function setKey(k, v) {
  Atomics.store(ctrl, CTRL.KEYS + k, v);
  if (v) Atomics.store(ctrl, CTRL.LATCH + k, 1); // taps shorter than a frame still register once
}
window.setVirtualKey = setKey;
function onKey(e, v) {
  if (e.code === 'F12' && v) { Atomics.store(ctrl, CTRL.RESET, 1); e.preventDefault(); return; }
  if (panel.open) { if (v) panel.key(e); e.preventDefault(); return; }
  if (v && e.code === 'F2') { panel.show('save'); e.preventDefault(); return; }
  if (v && e.code === 'F4') { panel.show('load'); e.preventDefault(); return; }
  if (v && e.code === 'F8') { setFastBattle(!fastBattle); e.preventDefault(); return; }
  const k = KEYMAP[e.code];
  if (k === undefined) return;
  audio.unlock();
  setKey(k, v);
  if (e.code.startsWith('Shift')) setKey(12, v); // physical shift is also Input::SHIFT
  e.preventDefault();
}
window.addEventListener('keydown', (e) => onKey(e, 1));
window.addEventListener('keyup', (e) => onKey(e, 0));
window.addEventListener('blur', () => { for (let i = 0; i < NKEYS; i++) Atomics.store(ctrl, CTRL.KEYS + i, 0); });
window.addEventListener('pointerdown', () => audio.unlock());

// ---------- touch devices: on-screen pad (landscape layout lives in index.html) ----------
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window || location.search.includes('touch');
if (isTouch) {
  document.documentElement.classList.add('touch');
  // each pointer holds at most one game key; releasing (or sliding off) lets it go
  const held = new Map(); // pointerId -> { key, el }
  const press = (id, key, el) => {
    const cur = held.get(id);
    if (cur && cur.key === key) return;
    if (cur) { setKey(cur.key, 0); cur.el.classList.remove('down'); }
    if (key === null) { held.delete(id); return; }
    held.set(id, { key, el });
    setKey(key, 1);
    if (key === 4) setKey(12, 1);
    el.classList.add('down');
  };
  const release = (id) => {
    const cur = held.get(id);
    if (!cur) return;
    setKey(cur.key, 0);
    if (cur.key === 4) setKey(12, 0);
    cur.el.classList.remove('down');
    held.delete(id);
  };
  // d-pad: the direction is picked from the angle to the pad's centre, so sliding the thumb changes it
  const dpad = document.getElementById('dpad');
  const arrows = [...dpad.querySelectorAll('i')];
  const dirAt = (e) => {
    const r = dpad.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    if (Math.hypot(dx, dy) < 14) return null;
    if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 1 : 2;
    return dy < 0 ? 3 : 0;
  };
  const dpadMove = (e) => {
    const d = dirAt(e);
    if (d === null) { release(e.pointerId); return; }
    press(e.pointerId, d, arrows.find((a) => Number(a.dataset.d) === d));
  };
  dpad.addEventListener('pointerdown', (e) => { dpad.setPointerCapture(e.pointerId); dpadMove(e); e.preventDefault(); });
  dpad.addEventListener('pointermove', (e) => { if (held.has(e.pointerId)) dpadMove(e); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) dpad.addEventListener(ev, (e) => release(e.pointerId));
  for (const b of document.querySelectorAll('#pad b[data-k]')) {
    b.addEventListener('pointerdown', (e) => { b.setPointerCapture(e.pointerId); press(e.pointerId, Number(b.dataset.k), b); e.preventDefault(); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, (e) => release(e.pointerId));
  }
  // iOS only lets audio start from a user gesture
  for (const ev of ['touchend', 'click']) window.addEventListener(ev, () => audio.unlock(), { passive: true });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault());
}

// ---------- quick save / load panel, battle speed ----------
const META_KEY = 'dbz-quick-meta';
const SLOTS = 8;
const readMeta = () => { try { return JSON.parse(localStorage.getItem(META_KEY)) || {}; } catch (e) { return {}; } };
const writeMeta = (m) => { try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch (e) { /* private mode */ } };

const panel = {
  open: false,
  mode: 'save',
  sel: 1,
  el: document.getElementById('panel'),
  show(mode) {
    this.mode = mode;
    this.open = true;
    for (let i = 0; i < NKEYS; i++) Atomics.store(ctrl, CTRL.KEYS + i, 0);
    Atomics.store(ctrl, CTRL.PAUSE, 1);
    this.render();
    this.el.hidden = false;
  },
  close() {
    this.open = false;
    this.el.hidden = true;
    Atomics.store(ctrl, CTRL.PAUSE, 0);
    Atomics.notify(ctrl, CTRL.PAUSE);
  },
  pick(slot) {
    const meta = readMeta();
    if (this.mode === 'load' && !meta[slot]) { toast('這個欄位沒有存檔'); return; }
    ctrl[CTRL.REQ_SLOT] = slot;
    Atomics.store(ctrl, CTRL.REQ, this.mode === 'save' ? 1 : 2);
    this.close();
  },
  key(e) {
    if (e.code === 'Escape' || e.code === 'KeyX') this.close();
    else if (e.code === 'ArrowDown') { this.sel = this.sel % SLOTS + 1; this.render(); }
    else if (e.code === 'ArrowUp') { this.sel = (this.sel + SLOTS - 2) % SLOTS + 1; this.render(); }
    else if (e.code === 'Enter' || e.code === 'KeyZ' || e.code === 'Space') this.pick(this.sel);
    else if (/^Digit[1-8]$/.test(e.code)) this.pick(Number(e.code.slice(5)));
  },
  render() {
    const meta = readMeta();
    const title = this.mode === 'save' ? '存檔' : '讀檔';
    const rows = [];
    for (let i = 1; i <= SLOTS; i++) {
      const m = meta[i];
      const when = m ? new Date(m.time).toLocaleString('zh-TW', { hour12: false }) : '（空）';
      rows.push(`<button class="slot${i === this.sel ? ' sel' : ''}" data-slot="${i}"><b>${i}</b><span>${when}</span><small>${m ? escapeHtml(m.info) : ''}</small></button>`);
    }
    this.el.innerHTML = `<div class="box"><h2>${title}</h2>${rows.join('')}<p class="hint">↑↓ 選擇　Enter 確定　Esc 取消</p><button class="close" data-close>取消</button></div>`;
  },
};
const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
panel.el.addEventListener('click', (e) => {
  const b = e.target.closest('[data-slot]');
  if (b) panel.pick(Number(b.dataset.slot));
  else if (e.target === panel.el || e.target.closest('[data-close]')) panel.close();
});
document.getElementById('btn-save').onclick = () => panel.show('save');
document.getElementById('btn-load').onclick = () => panel.show('load');

let fastBattle = (() => { try { return localStorage.getItem('dbz-fast-battle') !== '0'; } catch (e) { return true; } })();
function setFastBattle(on) {
  fastBattle = on;
  Atomics.store(ctrl, CTRL.FAST_BATTLE, on ? 1 : 0);
  document.getElementById('btn-speed').classList.toggle('on', on);
  document.getElementById('btn-speed').textContent = on ? '戰鬥 2×' : '戰鬥 1×';
  try { localStorage.setItem('dbz-fast-battle', on ? '1' : '0'); } catch (e) { /* private mode */ }
}
document.getElementById('btn-speed').onclick = () => setFastBattle(!fastBattle);
setFastBattle(fastBattle);

// battle EXP multiplier: 10× by default for faster levelling; tap to cycle 10× → 5× → 1×
const EXP_RATES = [10, 5, 1];
let expRate = (() => { try { return Number(localStorage.getItem('dbz-exp-rate')) || 10; } catch (e) { return 10; } })();
function setExpRate(r) {
  expRate = EXP_RATES.includes(r) ? r : 10;
  Atomics.store(ctrl, CTRL.EXP_RATE, expRate);
  const b = document.getElementById('btn-exp');
  if (!b) return;
  b.textContent = `經驗 ${expRate}×`;
  b.classList.toggle('on', expRate > 1);
  try { localStorage.setItem('dbz-exp-rate', String(expRate)); } catch (e) { /* private mode */ }
}
const $btnExp = document.getElementById('btn-exp');
if ($btnExp) $btnExp.onclick = () => setExpRate(EXP_RATES[(EXP_RATES.indexOf(expRate) + 1) % EXP_RATES.length]);
setExpRate(expRate);

function onQuick(m) {
  if (!m.ok) { toast(m.msg); return; }
  if (m.op === 'save') {
    const meta = readMeta();
    meta[m.slot] = { time: Date.now(), info: m.msg };
    writeMeta(meta);
    toast(`已存到欄位 ${m.slot}`);
  } else {
    toast(`已讀取欄位 ${m.slot}`);
  }
}

// ---------- audio ----------
class AudioSys {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.ch = { bgm: null, bgs: null, me: null };
    this.ses = new Set();
  }
  unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  buffer(real) {
    let p = this.buffers.get(real);
    if (!p) {
      p = fetch(gameUrl(real)).then((r) => r.arrayBuffer()).then((b) => this.ctx.decodeAudioData(b))
        .catch((e) => { console.warn('audio', real, e); return null; });
      this.buffers.set(real, p);
    }
    return p;
  }
  stopNode(n, fadeMs = 0) {
    if (!n || !n.src) return;
    try {
      if (fadeMs > 0) {
        n.gain.gain.setTargetAtTime(0, this.ctx.currentTime, fadeMs / 3000);
        n.src.stop(this.ctx.currentTime + fadeMs / 1000);
      } else n.src.stop();
    } catch (e) { /* already stopped */ }
  }
  async start(real, vol, pitch, loop) {
    const buf = await this.buffer(real);
    if (!buf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    src.playbackRate.value = pitch / 100;
    const gain = this.ctx.createGain();
    gain.gain.value = Math.pow(vol / 100, 2);
    src.connect(gain).connect(this.master);
    src.start();
    return { src, gain, real, vol, pitch };
  }
  play(ch, real, vol, pitch) {
    if (!this.ctx) this.unlock();
    if (/\.midi?$/i.test(real)) return; // MIDI is not supported yet
    if (ch === 'se') {
      this.start(real, vol, pitch, false).then((n) => {
        if (!n) return;
        this.ses.add(n);
        n.src.onended = () => this.ses.delete(n);
      });
      return;
    }
    const cur = this.ch[ch];
    if (cur && cur.real === real && ch !== 'me') {
      if (!cur.gain) return; // same track still loading
      cur.gain.gain.value = Math.pow(vol / 100, 2);
      cur.src.playbackRate.value = pitch / 100;
      return;
    }
    this.stopNode(cur);
    const token = {};
    this.ch[ch] = { pending: token, real };
    this.start(real, vol, pitch, ch !== 'me').then((n) => {
      if (!n) return;
      if (!(this.ch[ch] && this.ch[ch].pending === token)) { n.src.stop(); return; }
      this.ch[ch] = n;
      if (ch !== 'me') return;
      const b = this.ch.bgm;
      if (b && b.gain) b.gain.gain.value = 0;
      n.src.onended = () => {
        if (this.ch.me !== n) return;
        this.ch.me = null;
        const bg = this.ch.bgm;
        if (bg && bg.gain) bg.gain.gain.setTargetAtTime(Math.pow(bg.vol / 100, 2), this.ctx.currentTime, 0.3);
      };
    });
  }
  call({ ch, op, path, a, b }) {
    if (op === 'play') return this.play(ch, path, a, b);
    if (!this.ctx) return;
    if (ch === 'se') { for (const n of this.ses) this.stopNode(n); this.ses.clear(); return; }
    const cur = this.ch[ch];
    this.ch[ch] = null;
    this.stopNode(cur, op === 'fade' ? a : 0);
  }
}
const audio = new AudioSys();

// ---------- image decoding for the worker ----------
async function decode({ path, pix }) {
  stats.decodes = (stats.decodes || 0) + 1;
  stats.lastDecode = performance.now();
  stats.lastPath = path;
  if (started && !stats.frames) status(`載入圖片中…（${stats.decodes}）`);
  let w = -1, h = -1;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30000);
    const blob = await (await fetch(gameUrl(path), { signal: ac.signal })).blob();
    clearTimeout(timer);
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    w = bmp.width; h = bmp.height;
    const need = w * h * 4;
    if (need > pix.byteLength) {
      ctrl[CTRL.IMG_NEED] = need;
      w = -2;
    } else {
      const c = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
      c.drawImage(bmp, 0, 0);
      new Uint8Array(pix, 0, need).set(c.getImageData(0, 0, w, h).data);
    }
    bmp.close();
  } catch (e) {
    console.warn('decode', path, e);
    note(`圖片解碼失敗 ${path}: ${e}`);
    w = -1;
  }
  ctrl[CTRL.IMG_W] = w;
  ctrl[CTRL.IMG_H] = h;
  Atomics.store(ctrl, CTRL.IMG_STATE, 1);
  Atomics.notify(ctrl, CTRL.IMG_STATE);
}

// ---------- boot ----------
// The worker writes finished frames into this shared framebuffer; paint it on each animation frame.
const fb = new SharedArrayBuffer(1024 * 768 * 4);
const view = $screen.getContext('2d');
let frameImage = null;
function paint() {
  if (Atomics.load(ctrl, CTRL.FRAME_PENDING)) {
    const w = ctrl[CTRL.FB_W], h = ctrl[CTRL.FB_H];
    if (!frameImage || frameImage.width !== w || frameImage.height !== h) frameImage = new ImageData(w, h);
    frameImage.data.set(new Uint8Array(fb, 0, w * h * 4));
    Atomics.store(ctrl, CTRL.FRAME_PENDING, 0);
    view.putImageData(frameImage, 0, 0);
    stats.frames++;
  }
  requestAnimationFrame(paint);
}
const qs = new URLSearchParams(location.search);
const worker = new Worker('js/worker.js?v=20261101-1546', { type: 'module' });
window.gameWorker = worker;
const stats = { frames: 0 };
// Boot/runtime notes, shown on screen if the game never draws (phones have no dev console).
const diag = [];
const note = (s) => {
  const line = `${((performance.now() / 1000) | 0)}s ${s}`;
  // progress messages ("載入資料 3/141") replace the previous one instead of piling up
  if (diag.length && /^載入資料/.test(s) && /載入資料/.test(diag[diag.length - 1])) diag[diag.length - 1] = line;
  else diag.push(line);
  if (diag.length > 40) diag.shift();
};
window.diag = diag;
function showDiag(reason) {
  $err.hidden = false;
  $err.textContent = `${reason}\n請先點這個畫面重新整理一次；還是不行再截圖回報。\n\n版本=${BUILD} 畫面幀=${stats.frames} 隔離=${self.crossOriginIsolated}\n${navigator.userAgent}\n\n${diag.join('\n')}`;
}
$err.addEventListener('click', () => location.reload());
let started = false;
setTimeout(() => { if (!started) showDiag('遊戲 60 秒內沒有啟動完成。'); }, 60000);
window.pageStats = stats;

worker.onmessage = (e) => {
  const m = e.data;
  switch (m.t) {
    case 'img': decode(m); break;
    case 'audio': audio.call(m); break;
    case 'resize': $screen.width = m.w; $screen.height = m.h; break;
    case 'save': idbPut(m.name, m.data); break;
    case 'status': status(m.s); if (m.s) note(m.s); break;
    case 'started':
      started = true;
      note('Ruby 啟動完成');
      stats.lastDecode = performance.now();
      // on a slow connection the first frame waits for many image downloads; only call it stuck when
      // nothing has arrived for a while
      const check = setInterval(() => {
        if (stats.frames > 0) { clearInterval(check); status(''); return; }
        if (performance.now() - stats.lastDecode > 12000) {
          clearInterval(check);
          showDiag(`遊戲已啟動但畫面沒有更新（已載入 ${stats.decodes || 0} 張圖，最後一張：${stats.lastPath || '無'}）。`);
        }
      }, 1000);
      break;
    case 'note': note(m.s); break;
    case 'debug': stats.debug = m; break;
    case 'quick': onQuick(m); break;
    case 'dbglog': (stats.log ||= []).push(m.s); break;
    case 'bench': window.benchOut = m.out; console.log(m.out.join('\n')); break;
    case 'toast': console.log('[print]', m.s); toast(m.s); break;
    case 'fatal': console.error(m.s); note(m.s); showDiag('發生錯誤：'); break;
    default: break;
  }
};
requestAnimationFrame(paint);
worker.onerror = (e) => { note(`worker 錯誤：${e.message || e} ${e.filename || ''}:${e.lineno || ''}`); showDiag('背景執行緒載入失敗。'); };

(async () => {
  const saves = await idbAll().catch(() => []);
  worker.postMessage({
    t: 'init',
    ctrl: ctrlBuf,
    pix: new SharedArrayBuffer(1 << 20), // grows when an image needs more (CTRL.IMG_NEED); small start helps phones with less memory
    cmdBuf,
    fb,
    saves,
    turbo: Number(qs.get('turbo')) || 1,
    debug: qs.has('debug'),
    bench: qs.get('bench'),
    nogc: qs.has('nogc'),
    manualgc: qs.get('manualgc'),
    prof: qs.has('prof'),
  });
  // test helper: ?autoc taps the confirm key
  if (qs.has('autoc')) window.autoC = setInterval(() => { setKey(6, 1); setTimeout(() => setKey(6, 0), 30); }, 300);
})();
