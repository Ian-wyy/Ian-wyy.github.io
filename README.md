# Ian-wyy.github.io

Personal academic website of Yiyu Wang — <https://Ian-wyy.github.io>.

Static HTML, based on [Jon Barron's website template](https://github.com/jonbarron/jonbarron_website).
No build step: `.nojekyll` tells GitHub Pages to publish the files as-is.

## Layout

```
index.html        the whole site
stylesheet.css    Lato webfont + the template's styles + a small responsive block
images/           profile photo, paper thumbnails, favicons
```

## Editing

Open `index.html` and edit the section you want; the comments mark them off
(Header / News + Research / Publications / Miscellanea / Footer).

- **News.** Each item is a `<p class="news-item" data-month="YYYY-MM">`. A short
  inline script moves anything older than 11 months into a collapsed
  "Earlier news" block, so old items can just stay in the file.
- **Publications.** One `<tr>` per paper: thumbnail on the left
  (`class="papershot"`), title / authors / venue / links / summary on the right.
- **CV.** The CV is deliberately *not* checked in — `.gitignore` blocks `*.pdf` so a
  browser of this repo cannot download it. It lives in the `Ian-wyy/phd-cv` LaTeX repo.
  If a public link is ever wanted, host the PDF elsewhere and link out.

## Previewing locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```
