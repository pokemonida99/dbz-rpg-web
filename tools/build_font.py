#!/usr/bin/env python3
"""Build fonts/GameTC.woff2: Noto Sans TC Bold trimmed to the characters the game can show.

Usage: build_font.py <NotoSansTC[wght].ttf> <corpus.txt> <s2t.json> <out.woff2>
The character set is the game text before and after simplified->traditional conversion, every
character the converter can produce, plus kana, ASCII and full-width punctuation.
"""
import json, re, sys
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

src, corpus_path, table_path, out = sys.argv[1:5]
corpus = open(corpus_path, encoding='utf-8').read()
table = json.load(open(table_path, encoding='utf-8'))

text = set(re.findall(r'[　-ヿ㐀-鿿豈-﫿＀-￯]', corpus))
text |= set(''.join(table['chars'].values())) | set(''.join(table['phrases'].values())) | set(table['tw'].values())
text |= {chr(c) for c in range(0x20, 0x7f)}
text |= {chr(c) for c in range(0x3000, 0x3100)} | {chr(c) for c in range(0xff00, 0xffef)}
text |= set('…—–‘’“”・※○●◎◇◆□■△▲▽▼☆★♪→←↑↓')

font = TTFont(src)
font = instancer.instantiateVariableFont(font, {'wght': 700})
opts = subset.Options()
opts.flavor = 'woff2'
opts.layout_features = ['*']
opts.name_IDs = ['*']
sub = subset.Subsetter(opts)
sub.populate(text=''.join(sorted(text)))
sub.subset(font)
font.flavor = 'woff2'
font.save(out)
print(len(text), 'characters ->', out)
