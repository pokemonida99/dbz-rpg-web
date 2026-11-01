#!/usr/bin/env python3
"""Generate game/manifest list of all asset files (relative paths)."""
import json, os, sys, unicodedata
root = sys.argv[1]
out = []
for d, _, fs in os.walk(root):
    for f in fs:
        if f.startswith('.'):
            continue
        p = os.path.relpath(os.path.join(d, f), root).replace(os.sep, '/')
        out.append([unicodedata.normalize('NFC', p), os.path.getsize(os.path.join(d, f))])
out.sort()
json.dump(out, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(len(out), 'files')
