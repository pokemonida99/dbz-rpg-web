#!/usr/bin/env python3
"""Build js/s2t.json: OpenCC simplified -> Traditional (Taiwan) tables for the in-game text converter.

Phrases are trimmed to the ones that actually occur in the game's text (corpus file), characters are kept
in full. Usage: build_s2t.py <corpus.txt> <out.json>
"""
import json, os, sys

here = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'opencc')


def load(name):
    table = {}
    with open(os.path.join(here, name + '.txt'), encoding='utf-8') as f:
        for line in f:
            if not line.strip() or line.startswith('#'):
                continue
            src, dst = line.rstrip('\n').split('\t')[:2]
            table[src] = dst.split(' ')[0]
    return table


import re
corpus = open(sys.argv[1], encoding='utf-8').read()
runs = re.findall(r'[\u3400-\u9fff\uf900-\ufaff]{2,}', corpus)
grams = {r[i:i + n] for r in runs for n in range(2, 9) for i in range(len(r) - n + 1)}
chars = load('STCharacters')
phrases = {k: v for k, v in load('STPhrases').items() if k in grams}
tw = load('TWVariants')  # Taiwan-standard character forms, applied after the s2t pass

# Game-specific fixes. The game is full of transliterated names (卡里克, 赛里帕, 托马, 奥托星),
# so 里/托/台 default to themselves and only the common words get the other form.
chars.update({'里': '里', '托': '托', '台': '台'})
extra = {
    '头发': '頭髮', '金发': '金髮', '黑发': '黑髮', '白发': '白髮', '发型': '髮型',
    '这里': '這裡', '那里': '那裡', '哪里': '哪裡', '里面': '裡面', '心里': '心裡', '家里': '家裡',
    '手里': '手裡', '眼里': '眼裡', '嘴里': '嘴裡', '城里': '城裡', '屋里': '屋裡', '夜里': '夜裡',
    '梦里': '夢裡', '体里': '體裡', '脑里': '腦裡', '店里': '店裡', '洞里': '洞裡', '村里': '村裡',
    '拜托': '拜託', '委托': '委託', '托付': '託付', '寄托': '寄託',
    '征服': '征服', '征讨': '征討', '特征': '特徵', '象征': '象徵',
    '筋斗': '筋斗', '泰斗': '泰斗', '北斗': '北斗', '这台': '這台', '那台': '那台',
}
phrases.update(extra)

json.dump({'chars': chars, 'phrases': phrases, 'tw': tw}, open(sys.argv[2], 'w', encoding='utf-8'),
          ensure_ascii=False, separators=(',', ':'))
print(len(chars), 'chars,', len(phrases), 'phrases,', len(tw), 'tw variants')
