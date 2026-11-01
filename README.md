# 龍珠Z RPG 網頁版（原型）

在瀏覽器裡直接執行原版 RPG Maker VX（RGSS2）的遊戲腳本：ruby.wasm 跑 `Data/Scripts.rvdata` 的 19 萬行 Ruby，
`rb/rgss.rb` + `js/rgss.js` 重新實作 RGSS2 的 Bitmap / Sprite / Window / Tilemap / Graphics / Input / Audio。

## 執行

線上版：https://pokemonida99.github.io/dbz-rpg-web/ （GitHub Pages，`main` 分支根目錄；`coi-serviceworker.min.js` 補上 COOP/COEP）

本機：

```bash
python3 tools/serve.py 8777
```

這個 repo 就是唯一的原始碼。8765 埠被其他服務佔用，不要用。

開 http://localhost:8777/ 。伺服器必須送出 COOP/COEP 標頭（SharedArrayBuffer 需要），所以不能用一般的 `http.server`。

`game/` 是遊戲素材（只含網頁版需要的檔）；改了素材後重跑 `python3 tools/manifest.py game manifest.json`。

## 架構

| 檔案 | 角色 |
|---|---|
| `js/main.js` | 頁面：顯示畫面（共享 framebuffer）、音效、鍵盤、解碼圖片、存檔寫進 IndexedDB |
| `js/worker.js` | Web Worker：啟動 ruby.wasm、建立虛擬檔案系統、執行遊戲 |
| `js/rgss.js` | Worker 內的繪圖引擎：OffscreenCanvas 點陣圖、場景繪製、地圖圖塊、幀率控制 |
| `rb/rgss.rb` | RGSS2 的 Ruby 端類別 |
| `rb/rpg.rb` | `RPG::` 資料結構（讀 .rvdata 用） |
| `rb/patches.rb` / `rb/loader.rb` | DLL 替代、對個別遊戲腳本的原始碼修補、載入流程 |

Ruby 在 worker 裡同步執行，`Graphics.update` 用 `Atomics.wait` 等下一幀；圖片解碼、畫面顯示、輸入都透過 SharedArrayBuffer 交換。

## 已知的 ruby.wasm 限制與對策

- **不能用 await 等幀**：asyncify 緩衝區只有 6KB，堆疊一深就崩潰 → 改成 worker + 同步阻塞。
- **`break` 跳出 C 實作的迭代器會漏記憶體**（每次數 KB～數十 KB，與堆疊深度成正比）→ `Array#each`、`Range#each`、`Hash#each` 等改用純 Ruby 實作（見 `rb/rgss.rb` 開頭）。
- **每次 `eval` 都會留下記憶體** → 事件腳本編譯一次後快取成方法（`RGSSEvalCache`）。
- Worker 內的畫布全部用 CPU 繪製（`willReadFrequently`），避免 GPU 環境遺失時所有點陣圖一起消失。

## 測試用網址參數

| 參數 | 作用 |
|---|---|
| `?turbo=8` | 遊戲加速 8 倍 |
| `?autoc` | 每 0.3 秒自動按確認鍵 |
| `?debug` | 記憶體統計、`rubyEval('…')` 在遊戲內執行 Ruby（結果在 `pageStats.log`） |
| `?prof` | （搭配 debug）各子系統記憶體增長分析 |
| `?bench=1` | Ruby↔JS 介面的效能／洩漏測試 |

## 鍵位

方向鍵移動；Z / Enter / 空白＝確認（C）；X / Esc＝取消（B）；Shift＝A；A / S / D＝X / Y / Z；Q / W＝L / R；F12＝重設。

手機／平板（觸控裝置）：強制橫向，左邊方向鍵、右邊 A（確認）/B（取消）與 X/Y/Z、L/Shift/R；直向時顯示轉向提示。iPhone 建議「加入主畫面」後開啟。`?touch` 可在桌機強制顯示觸控版面。遊戲沒啟動時畫面會顯示診斷資訊。

網頁加的功能：**F2 存檔、F4 讀檔**（8 個欄位，右上角也有按鈕）、**F8 切換戰鬥 2 倍速**（預設開啟，設定記在瀏覽器）。

## 繁體中文

- 遊戲資料保留簡體（圖檔名是用資料裡的名字組出來的，不能改），在**畫到畫面上時**才轉繁體：`js/rgss.js` 的 `S2T`，詞庫 `js/s2t.json`。
- 逐字繪製的地方（對話框、選單文字）先整句轉換再拆字，才能用到詞組：見 `rb/loader.rb` 的原始碼修補。
- 重建詞庫：`python3 tools/build_s2t.py <corpus.txt> js/s2t.json`（OpenCC 字典在 `tools/opencc/`；音譯人名用字如 里、托、台 預設不轉）。
- 字型 `fonts/GameTC.woff2`：Noto Sans TC Bold，只保留遊戲會用到的 6616 字（`tools/build_font.py`）。
- 內嵌簡體字的圖片重畫成繁體放在 `overrides/`（`tools/build_tc_images.py`），目前有角色名稱圖 `名前.PNG` 與技能名稱圖 `文字_必殺技.png`（用 macOS Vision OCR 掃過全部圖片，其餘含簡體字的圖都沒被遊戲使用）。

## 隨時存讀檔

每個欄位存的是「遊戲原本的存檔資料＋所有能序列化的全域變數」，壓縮後放 IndexedDB（`QuickSave1~8.rvdata`），欄位說明放 localStorage。
戰鬥中存檔會存「這一回合開始時」的狀態，讀檔後從那回合繼續打。劇情中途存檔，讀檔後會先照遊戲原本流程顯示「前情提要」，再接回原本的對話並重畫過場背景。

## 尚未完成

- MIDI 背景音樂（42 首 .mid）未播放；使用者覺得目前的音樂已足夠，暫不處理
- 部署（GitHub Pages 需要 coi-serviceworker 補 COOP/COEP；檔名需轉成 NFC）
