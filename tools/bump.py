#!/usr/bin/env python3
"""Stamp a new version before each deploy so phones never mix cached old files with new ones.

Every script / Ruby / data URL carries ?v=<version>; BUILD in js/main.js (shown in the diagnostic) and
VER in js/worker.js get the same value. Run from the repo root:  python3 tools/bump.py
"""
import datetime, pathlib, re

root = pathlib.Path(__file__).resolve().parent.parent
v = datetime.datetime.now().strftime('%Y%m%d-%H%M')
for name in ['index.html', 'js/main.js', 'js/worker.js']:
    f = root / name
    s = f.read_text()
    s = re.sub(r"\?v=[\w-]+(['\"])", rf"?v={v}\1", s)
    s = re.sub(r"const (BUILD|VER) = '[^']*'", rf"const \1 = '{v}'", s)
    s = re.sub(r'id="ver">[^<]*<', f'id="ver">{v}<', s)
    f.write_text(s)
print(v)
