// Runs ruby.wasm + the game in a worker so Graphics.update can block synchronously.
import { RubyVM } from '../vendor/wasm-wasi-2.10.1/package/dist/esm/vm.js';
import { WASI, File, Directory, OpenFile, PreopenDirectory, ConsoleStdout } from '../vendor/browser_wasi_shim-0.4.2/package/dist/index.js';
import { Runtime, CTRL } from './rgss.js?v=20261101-1552';

const VER = '20261101-1552'; // stamped by tools/bump.py so a new version never mixes with cached old files

const GAME = '../game/';
const RUBY_WASM = '../vendor/3.4-wasm-wasi-2.10.1/package/dist/ruby+stdlib.wasm';
const PERSIST = /^(Save.*\.rvdata|Save_Auto\.rvdata|QuickSave\d+\.rvdata|Game\.ini)$/i;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const status = (s) => post({ t: 'status', s });
const gameUrl = (p) => GAME + p.split('/').map(encodeURIComponent).join('/');

// Windows file names are case-insensitive; the game mixes "Game.ini" / "game.ini".
class CIMap extends Map {
  constructor() { super(); this.keyOf = new Map(); }
  canon(k) { return this.keyOf.get(String(k).normalize('NFC').toLowerCase()) ?? k; }
  get(k) { return super.get(this.canon(k)); }
  has(k) { return super.has(this.canon(k)); }
  set(k, v) {
    const low = String(k).normalize('NFC').toLowerCase();
    const c = this.keyOf.get(low);
    if (c === undefined) this.keyOf.set(low, k);
    return super.set(c ?? k, v);
  }
  delete(k) {
    const c = this.canon(k);
    this.keyOf.delete(String(k).normalize('NFC').toLowerCase());
    return super.delete(c);
  }
}

function sum(u8) {
  let h = u8.length;
  for (let i = 0; i < u8.length; i += 7) h = (h * 31 + u8[i]) | 0;
  return h;
}

async function buildFs(manifest, saves) {
  const root = new CIMap();
  const dirOf = (parts) => {
    let m = root;
    for (const p of parts) {
      let d = m.get(p);
      if (!d) { d = new Directory(new CIMap()); m.set(p, d); }
      m = d.contents;
    }
    return m;
  };
  // every asset exists as an empty placeholder so FileTest.exist? works
  for (const [p] of manifest) {
    const parts = p.split('/');
    const name = parts.pop();
    dirOf(parts).set(name, new File(new Uint8Array(0)));
  }
  const need = manifest.map(([p]) => p).filter((p) => (p.startsWith('Data/') && p.endsWith('.rvdata')) || p === 'Game.ini');
  let done = 0;
  await Promise.all(need.map(async (p) => {
    let buf = new Uint8Array(await (await fetch(gameUrl(p))).arrayBuffer());
    // the shipped ini has a GBK title; the game's Ruby ini parser expects UTF-8
    if (p === 'Game.ini') buf = new TextEncoder().encode(new TextDecoder('gbk').decode(buf));
    const parts = p.split('/');
    const name = parts.pop();
    dirOf(parts).set(name, new File(buf));
    status(`載入資料 ${++done}/${need.length}`);
  }));
  for (const [k, v] of saves) root.set(k, new File(v));
  return root;
}

// Saves are persisted by the page (IndexedDB); the worker never yields, so check on frame ticks.
function saveWatcher(root) {
  const seen = new Map();
  for (const [k, f] of root) if (PERSIST.test(k) && f.data) seen.set(k, sum(f.data));
  return (frame) => {
    if (frame % 120) return;
    for (const [k, f] of root) {
      if (!PERSIST.test(k) || !f.data) continue;
      const s = sum(f.data);
      if (seen.get(k) !== s) {
        seen.set(k, s);
        post({ t: 'save', name: k, data: f.data.slice() });
      }
    }
  };
}

async function loadFonts() {
  const faces = [
    ['UmePlus Gothic', 'Fonts/umeplus-gothic.ttf'],
    ['GameTC', '../fonts/GameTC.woff2'],
  ];
  await Promise.all(faces.map(async ([fam, p]) => {
    try {
      const url = p.startsWith('../') ? p : gameUrl(p);
      const f = new FontFace(fam, await (await fetch(url)).arrayBuffer());
      await f.load();
      self.fonts.add(f);
    } catch (e) { console.warn('font', fam, e); post({ t: 'note', s: `字型載入失敗 ${fam}: ${e}` }); }
  }));
}

async function start(init) {
  const RG = new Runtime({ post, ctrl: new Int32Array(init.ctrl), pix: init.pix, cmdBuf: init.cmdBuf, fb: init.fb });
  self.RG = RG;
  RG.turbo = init.turbo || 1;

  status('載入清單…');
  const [manifest, overrides, s2t] = await Promise.all(
    ['../manifest.json', '../overrides/list.json', 's2t.json'].map(async (p) => (await fetch(`${p}?v=${VER}`)).json()));
  RG.setManifest(manifest);
  RG.setOverrides(overrides);
  RG.setS2T(s2t);
  const [rgssRb, rpgRb, patchRb, loaderRb, mapNamesRb] = await Promise.all(
    ['rgss.rb', 'rpg.rb', 'patches.rb', 'loader.rb', 'map_names.rb'].map(async (p) => (await fetch(`../rb/${p}?v=${VER}`)).text()));

  RG.alert = (s) => post({ t: 'toast', s: String(s) });
  RG.fatal = (s) => post({ t: 'fatal', s: String(s) });
  RG.halt = (bt) => { console.log('exit', bt); status('遊戲結束'); };
  RG.warn = (s) => console.warn(String(s));
  RG.expRate = () => Atomics.load(RG.ctrl, CTRL.EXP_RATE) || 1; // page's 經驗 button
  RG.patchesFor = () => patchRb;

  status('載入字型…');
  const fontP = loadFonts();
  status('建立檔案系統…');
  const root = await buildFs(manifest, init.saves);
  await fontP;
  RG.frameHooks.push(saveWatcher(root));
  RG.persist = (name) => {
    const f = root.get(name);
    if (f && f.data) post({ t: 'save', name, data: f.data.slice() });
  };

  status('啟動 Ruby…');
  const mod = await WebAssembly.compileStreaming(fetch(RUBY_WASM));
  const wasi = new WASI([], [], [
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered((m) => console.log(m)),
    ConsoleStdout.lineBuffered((m) => console.warn(m)),
    new PreopenDirectory('/', new Map()),
    new PreopenDirectory('/game', root),
  ], { debug: false });
  const { vm, instance } = await RubyVM.instantiateModule({ module: mod, wasip1: wasi });

  vm.eval(rgssRb);
  vm.eval(rpgRb);
  vm.eval(mapNamesRb);
  RG.mem = () => instance.exports.memory.buffer.byteLength;
  RG.dbg = (s) => post({ t: 'dbglog', s: String(s) });
  if (init.nogc) vm.eval('GC.disable');
  if (init.manualgc) vm.eval(`GC.disable; $RGSS_MANUAL_GC = ${Number(init.manualgc) || 120}`);
  if (init.debug) {
    vm.eval('$RGSS_DEBUG = true');
    if (init.prof) vm.eval('$RGSS_PROF = true');
    RG.frameHooks.push((f) => {
      if (f % 300 === 0) {
        let px = 0, dpx = 0, big = [];
        for (const [id, c] of RG.bitmaps) { px += c.width * c.height; if (c.width * c.height > 1e6) big.push(`${id}:${c.width}x${c.height}`); }
        for (const c of RG.decoded.values()) if (c) dpx += c.width * c.height;
        post({ t: 'debug', mb: (instance.exports.memory.buffer.byteLength / 1048576) | 0, frame: f, bitmaps: RG.bitmaps.size,
          bitmapMPx: (px / 1e6) | 0, decodedMPx: (dpx / 1e6) | 0, decoded: RG.decoded.size, big: big.slice(0, 8) });
      }
    });
  }
  status('');
  if (init.bench) return runBench(vm, instance, RG, init.bench);
  post({ t: 'started' });
  vm.eval(loaderRb); // runs the whole game synchronously
  status('遊戲結束');
}

function runBench(vm, instance, RG, only) {
  const mb = () => (instance.exports.memory.buffer.byteLength / 1048576) | 0;
  vm.eval(`Dir.chdir('/game'); $b = Bitmap.new(64, 64); $f = Font.new; $r = Rect.new(0, 0, 8, 8)`);
  const tests = {
    nums: `20000.times { RG.call(:clearRect, $b.id, 0, 0, 1, 1) }`,
    strAscii: `20000.times { RG.call(:warnless, "abcdefghij" * 3) }`,
    strCJK: `20000.times { RG.call(:warnless, "移动菜单地图") }`,
    drawText: `20000.times { $b.draw_text(0, 0, 64, 64, "移动") }`,
    blt: `20000.times { $b.blt(0, 0, $b, $r) }`,
    getPixel: `20000.times { $b.get_pixel(1, 1) }`,
    frame: `3000.times { Graphics.update }`,
    cache: `20000.times { Cache.picture("アイコン") rescue nil }`,
    gcShallow: `200.times { GC.start }`,
    gcDeep50: `def rec(n) = n == 0 ? GC.start : [1].each { rec(n - 1) }; 200.times { rec(50) }`,
    gcDeep150: `200.times { rec(150) }`,
    gcMinorDeep: `def rec2(n) = n == 0 ? GC.start(full_mark: false) : [1].each { rec2(n - 1) }; 200.times { rec2(150) }`,
    evalSmall: `20000.times { eval("1 + 2") }`,
    evalBind: `def evb; eval("x = 1\nif x == 1\n  y = [1,2,3].map { |v| v * 2 }\nend"); end; 20000.times { evb }`,
    evalLong: `$src = (1..80).map { |i| "a#{i} = #{i} if $game_switches_dummy" }.join("\n"); 5000.times { eval($src) }`,
  };
  RG.warnless = () => 0;
  const out = [];
  for (const [k, code] of Object.entries(tests)) {
    if (only !== '1' && !k.startsWith(only)) continue;
    const m0 = mb(), t0 = performance.now();
    try {
      vm.eval(code + '; GC.start; nil');
      out.push(`${k} MB ${m0} -> ${mb()} ms ${(performance.now() - t0) | 0}`);
    } catch (e) {
      out.push(`${k} FAILED ${String(e).slice(0, 300)}`);
    }
  }
  post({ t: 'bench', out });
}

self.addEventListener('error', (e) => post({ t: 'fatal', s: `worker error: ${e.message}` }));
self.addEventListener('unhandledrejection', (e) => post({ t: 'fatal', s: `worker rejection: ${(e.reason && e.reason.stack) || e.reason}` }));

self.onmessage = (e) => {
  if (e.data.t === 'init') {
    start(e.data).catch((err) => post({ t: 'fatal', s: String((err && err.stack) || err) }));
  }
};
