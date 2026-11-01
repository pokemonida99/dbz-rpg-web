#!/usr/bin/env python3
"""Re-draw pictures that have Simplified Chinese baked in, as Traditional, into overrides/.

Usage: build_tc_images.py <font.ttf>   (a TrueType Noto Sans TC; Pillow can't read the woff2 build)
Each spec lists text rows: the row area is cleared and the converted text drawn in its place.
"""
import json, os, sys
from PIL import Image, ImageDraw, ImageFont

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
table = json.load(open(os.path.join(root, 'js', 's2t.json'), encoding='utf-8'))
max_phrase = max(map(len, table['phrases']))


def s2t(s):
    out, i = [], 0
    while i < len(s):
        for n in range(min(max_phrase, len(s) - i), 1, -1):
            hit = table['phrases'].get(s[i:i + n])
            if hit:
                out.append(hit)
                i += n
                break
        else:
            out.append(table['chars'].get(s[i], s[i]))
            i += 1
    return ''.join(table['tw'].get(c, c) for c in ''.join(out))


# picture -> (row height, clear width, [(row index, simplified text), ...])
SPECS = {
    'Graphics/Pictures/名前.PNG': (16, 170, list(enumerate([
        '悟空', '比克', '悟饭', '克林', '亚木茶', '天津饭', '饺子', '琪琪', '亚奇洛贝', '贝吉塔', None,
        '悟空', '青年', '巴达克', '特兰克斯', '悟空', '贝吉塔', '特兰克斯', '18号', '17号', '16号',
        '龟仙人', '悟饭', '悟饭', '托马', '赛里帕', '铁布', '潘博金', None, '巴达克',
    ]))),
}

font_path = sys.argv[1]
os.makedirs(os.path.join(root, 'overrides'), exist_ok=True)
json.dump(sorted(SPECS), open(os.path.join(root, 'overrides', 'list.json'), 'w', encoding='utf-8'), ensure_ascii=False)
for rel, (row_h, clear_w, rows) in SPECS.items():
    src = os.path.join(root, 'game', rel)
    im = Image.open(src).convert('RGBA')
    draw = ImageDraw.Draw(im)
    font = ImageFont.truetype(font_path, row_h)
    font.set_variation_by_axes([700])
    for idx, text in rows:
        if text is None:
            continue
        y = idx * row_h
        draw.rectangle([0, y, clear_w - 1, y + row_h - 1], fill=(0, 0, 0, 0))
        tc = s2t(text)
        # one 16px cell per full-width character (8px for ASCII), matching the original sheet's grid
        x = 0
        for ch in tc:
            cell = row_h // 2 if ord(ch) < 0x80 else row_h
            w = draw.textlength(ch, font=font)
            draw.text((x + (cell - w) / 2, y + row_h / 2), ch, font=font, fill=(0, 0, 0, 255), anchor='lm')
            x += cell
    dst = os.path.join(root, 'overrides', rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    im.save(dst)
    print(rel, '->', ' '.join(s2t(t) for _, t in rows if t))
