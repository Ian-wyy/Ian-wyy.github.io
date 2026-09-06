# Ian-wyy.github.io

Personal academic website of Yiyu Wang — <https://Ian-wyy.github.io>.

Static HTML, based on [Jon Barron's website template](https://github.com/jonbarron/jonbarron_website).
No build step: `.nojekyll` tells GitHub Pages to publish the files as-is.

## Layout

```
index.html        the whole site
stylesheet.css    Lato webfont + the template's styles + a small responsive block
images/           profile photo, paper thumbnails, favicons
demo/pyrch/       interactive PyRCH routing demo (page + precomputed instances)
tools/            offline scripts that produce what the demo replays
```

## Editing

Open `index.html` and edit the section you want; the comments mark them off
(Header / News + Research / Publications / Miscellanea / Footer).

- **News.** Each item is a `<p class="news-item" data-month="YYYY-MM">`. A short
  inline script moves anything older than 11 months into a collapsed
  "Earlier news" block, so old items can just stay in the file.
- **Publications.** One `<tr>` per paper: thumbnail on the left
  (`class="papershot"`), title / authors / venue / links / summary on the right.


## The PyRCH demo

`demo/pyrch/` shows a drone, a wheeled robot and a legged robot splitting one
field between them. GitHub Pages is static, so the C++ solver cannot run in the
browser: `tools/gen_pyrch_demo.py` builds random instances, solves each with the
real solver, and writes `demo/pyrch/data/NNNN.json`; the page only replays them.

The field is 600 m across and the robots move at 8, 11 and 6 m/s, so route
costs are travel times in seconds and the replay runs at 20x real time. The
seed box takes any number and hashes it onto one of the 50 shipped instances;
which file that is stays an implementation detail.

Regenerate the instances (needs a C++17 compiler and CMake to build PyRCH):

```bash
uv venv && . .venv/bin/activate
uv pip install PyRCH
python tools/gen_pyrch_demo.py --count 65 --time-limit 4
```

That keeps roughly 60; trim to 50 and rewrite `data/manifest.json` to match.

After editing `demo.css` or `demo.js`, run `python tools/stamp_assets.py`: it
hashes each file into its `?v=` query string, so a deploy cannot leave a
browser running the previous version out of cache.
Instances are skipped when a robot ends up idle, the fleet is badly unbalanced,
or the solver's own cost disagrees with the route geometry, so whatever a
visitor types always shows the point. Useful query parameters: `?seed=1234`
picks an instance, `&at=0.6` freezes the replay partway through, and
`&focus=wheeled` isolates one robot.

## Previewing locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```
