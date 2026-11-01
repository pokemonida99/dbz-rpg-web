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


# picture -> (row height, clear width, font px, [(row index, simplified text), ...])
SPECS = {
    # skill names used by the enemy record's S-combo list; rows follow output_technique_detail (Share.rb),
    # names are the skills' descriptions in Skills.rvdata
    'Graphics/Pictures/文字_必殺技.png': (24, 200, 16, [
        (0, '冲击波'),
        (1, '能量波'),
        (2, '龟派气功'),
        (3, '太阳拳'),
        (4, '魔光炮'),
        (5, '眼部怪光线'),
        (6, '魔口炮'),
        (7, '爆裂魔光炮'),
        (8, '魔贯光杀炮'),
        (9, '魔闪光'),
        (10, '扩散能量波'),
        (11, '气圆斩'),
        (12, '狼牙风风拳'),
        (13, '操气弹'),
        (14, '气功炮'),
        (15, '四身拳'),
        (16, '四身拳气功炮'),
        (17, '洞洞波'),
        (18, '超能力'),
        (19, '界王拳'),
        (20, '界王拳龟派气功'),
        (21, '元气弹'),
        (22, '超级元气弹'),
        (23, '爆发波'),
        (24, '伽力克炮'),
        (25, '超级赛亚人变身'),  # not referenced by the code, but drawn on the original sheet
        (26, '超级龟派气功'),
        (27, '大能量波'),
        (28, '复仇标枪'),
        (29, '灵魂加农'),
        (30, '？？？？？？？？？？？'),
        (31, '双重冲击波'),
        (32, '舍身攻击'),
        (33, '龟派乱舞'),
        (34, '操气气圆斩'),
        (35, '聚合元气弹'),
        (36, '双重洞洞波'),
        (37, '超能力气功炮'),
        (38, '师徒攻击'),
        (39, '赛亚人无双(悟空＆悟饭）'),
        (40, '赛亚人无双(悟空＆巴达克）'),
        (41, '狼鹤相打阵'),
        (42, '地球人强袭'),
        (43, '伽力克龟派气功'),
        (44, '精神攻击'),
        (45, '大猿变身'),
        (46, '爆裂冲击'),
        (47, '爆裂波'),
        (48, '魔空包围弹'),
        (49, '全功率魔贯光杀炮'),
        (50, '剑击'),
        (51, '烈焰攻击'),
        (52, '闪耀剑击'),
    ]),
    'Graphics/Pictures/名前.PNG': (16, 170, 16, list(enumerate([
        '悟空', '比克', '悟饭', '克林', '亚木茶', '天津饭', '饺子', '琪琪', '亚奇洛贝', '贝吉塔', None,
        '悟空', '青年', '巴达克', '特兰克斯', '悟空', '贝吉塔', '特兰克斯', '18号', '17号', '16号',
        '龟仙人', '悟饭', '悟饭', '托马', '赛里帕', '铁布', '潘博金', None, '巴达克',
    ]))),
}

font_path = sys.argv[1]
os.makedirs(os.path.join(root, 'overrides'), exist_ok=True)
json.dump(sorted(SPECS), open(os.path.join(root, 'overrides', 'list.json'), 'w', encoding='utf-8'), ensure_ascii=False)
for rel, (row_h, clear_w, font_px, rows) in SPECS.items():
    src = os.path.join(root, 'game', rel)
    im = Image.open(src).convert('RGBA')
    draw = ImageDraw.Draw(im)
    font = ImageFont.truetype(font_path, font_px)
    font.set_variation_by_axes([700])
    for idx, text in rows:
        if text is None:
            continue
        y = idx * row_h
        draw.rectangle([0, y, clear_w - 1, y + row_h - 1], fill=(0, 0, 0, 0))
        tc = s2t(text)
        # one cell per full-width character (half for ASCII), matching the original sheet's grid
        x = 3 if row_h > font_px else 0
        for ch in tc:
            cell = font_px // 2 if ord(ch) < 0x80 else font_px
            w = draw.textlength(ch, font=font)
            draw.text((x + (cell - w) / 2, y + row_h - font_px / 2 - 2 if row_h > font_px else y + row_h / 2), ch, font=font, fill=(0, 0, 0, 255), anchor='lm')
            x += cell
    dst = os.path.join(root, 'overrides', rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    im.save(dst)
    print(rel, '->', ' '.join(s2t(t) for _, t in rows if t)[:120])
