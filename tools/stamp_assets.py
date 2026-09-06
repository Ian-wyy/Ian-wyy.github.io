#!/usr/bin/env python3
"""Stamp demo/pyrch/index.html's CSS and JS links with a content hash.

GitHub Pages serves everything with ``cache-control: max-age=600``, so for ten
minutes after a deploy a browser will happily keep running the previous
demo.js without asking. Hashing the query string means a changed file is a
changed URL, which no cache can confuse with the old one.

Run before committing whenever demo.css or demo.js changed:

    python tools/stamp_assets.py
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

DEMO = Path(__file__).resolve().parent.parent / "demo" / "pyrch"


def main() -> None:
    page = DEMO / "index.html"
    html = page.read_text(encoding="utf-8")
    for asset in ("demo.css", "demo.js"):
        digest = hashlib.sha256((DEMO / asset).read_bytes()).hexdigest()[:8]
        html, n = re.subn(
            rf'({re.escape(asset)})(\?v=[0-9a-f]+)?"',
            rf'\g<1>?v={digest}"',
            html,
        )
        print(f"{asset}: v={digest} ({n} reference{'' if n == 1 else 's'})")
        if n == 0:
            raise SystemExit(f"{asset} is not referenced by {page}")
    page.write_text(html, encoding="utf-8")


if __name__ == "__main__":
    main()
