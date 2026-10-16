#!/usr/bin/env python3
"""SCB page renderer: person data -> per-book spread atlases (2048x2048 JPEG) for the VRChat library world.

Reads the same public data the website uses (data/public-people-all.json, produced by publish_from_db.py)
and the same slot list (tools/scb_publish/slots.json), draws the pages with a TEMPLATE, and writes
    <out>/books/<slot>/spread-<n>.jpg

Pages are drawn with a headless Chromium (Playwright) so Japanese text, shrink-to-fit and (later) vertical
writing come from the browser engine. The page art is a swappable template folder (templates/<id>/): the
placeholder template is plain on purpose; the designer's art replaces it without touching this script.

Atlas geometry (spec 9.8, right-bound mirrored book): left page = p.even in the LEFT half, right page = p.odd
in the RIGHT half, the spine / fore-edge / bottom colour bands are copied from the base atlas and never painted.

Default is a DRY RUN (lists what would be rendered; writes nothing). --apply writes into --out.
It never runs git and never publishes anything. Images are only re-rendered when their input changed
(content hash), unless --force.

Run:  python render_books.py                 (dry run)
      python render_books.py --apply         (render to tools/scb_render/out/)
      python render_books.py --apply --out ../../scb-library-repo   (render straight into the Pages repo folder)
"""
import argparse, datetime, hashlib, io, json, re, sys, tempfile
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]                                    # .../SCB
DEFAULT_FE = ROOT / 'WEBPage' / 'SCB_Library_Home_Prototype'
DEFAULT_OUT = HERE / 'out'
DEFAULT_BASE = ROOT / 'uv test atlas' / 'UV Test Atlas.jpg'
FONT_DIR = ROOT / 'fonts-download' / 'NotoSansJP'
SLOTS = ROOT / 'tools' / 'scb_publish' / 'slots.json'
TEMPLATES = HERE / 'templates'

ATLAS = 2048
PAGE_W, PAGE_H = 928, 1528                                # render size of one page
# atlas rectangles (spec 9.8, x right / y down). Both are fully painted with paper first, so no base art leaks.
LEFT_RECT = (29, 32, 957, 1561)                           # p.even
RIGHT_RECT = (950, 26, 1884, 1559)                        # p.odd
LEFT_POS = (29, 32)                                       # where a 928x1528 page is pasted
RIGHT_POS = (953, 28)
MAX_BYTES = 1_000_000                                     # warn above this (target ~740 KB)
JPEG_QUALITY = 88
SLOT_RE = re.compile(r'^person-\d{3}$')
SAFE_IMG = re.compile(r'^assets/[A-Za-z0-9_./-]+$')


class Report:
    def __init__(self): self.errors, self.warnings = [], []
    def error(self, m): self.errors.append(m)
    def warn(self, m): self.warnings.append(m)


# ---------------------------------------------------------------- content: which page shows what
def role_line(p):
    if p['kind'] == 'teacher':
        return p['group'] or '教員'
    g = (p['grade'] or '').replace('年', '年生')
    c = '・'.join(x for x in re.split(r'[/・]', p['club'] or '') if x)
    return f'{g}　{c}' if c else g


def build_pages(p, spreads, fe: Path, rep: Report, tpl: dict, extra=None, bonds=None):
    """Return a list of page dicts (content pages p.1..p.2N, already padded to an even count).
    p.1 title, p.2 profile, p.3 introduction (if any text), p.4 relations (if any), then the free pages:
    the member's book pages (image + caption); without them the outfit images, then the old flat gallery."""
    extra = extra or {}
    color = p['color'] or '#d9c3cf'
    pages = []
    portrait = p.get('portrait') or p.get('image')
    if portrait and not (fe / portrait).exists():
        rep.warn(f'{p["id"]}: portrait file missing: {portrait}'); portrait = None
    pages.append({'role': 'title', 'name': p['name'], 'kana': p['nameKana'], 'roleLine': role_line(p),
                  'portrait': portrait, 'color': color})
    pages.append({'role': 'profile', 'name': p['name'], 'rows': profile_rows(p, extra), 'color': color})
    secs = [(k, extra[key]) for k, key in (('好きなもの', 'likes'), ('苦手なもの', 'dislikes'), ('人物紹介', 'about')) if extra.get(key)]
    if secs:
        pages.append({'role': 'about', 'sections': secs, 'color': color})
    if bonds:
        pages.append({'role': 'bonds', 'bonds': bonds[:8], 'color': color})
    photos = []                                            # (image, caption)
    for bp in extra.get('bookPages') or []:
        photos.append((bp.get('image'), bp.get('caption', '')))
    if not photos:
        for o in extra.get('outfits') or []:
            photos += [(x, o.get('label', '')) for x in o.get('images', [])]
    if not photos:
        photos = [(g, '') for g in (p.get('gallery') or [])]
    for img, cap in photos:                                # one picture per page, in order
        if img and SAFE_IMG.match(img) and (fe / img).exists():
            pages.append({'role': 'photo', 'image': img, 'caption': cap, 'color': color})
        else:
            rep.warn(f'{p["id"]}: book image missing, page skipped: {img}')
    total = spreads * 2
    if len(pages) > total:
        rep.warn(f'{p["id"]}: {len(pages)} pages but only {total} fit in {spreads} spreads; extra pages dropped')
        pages = pages[:total]
    while len(pages) < total:
        pages.append({'role': 'blank'})
    return pages


def bonds_of(pid, relations, people, fe: Path):
    """Relation entries for the book page: other person, label, portrait (only if the file exists)."""
    out = []
    for r in relations:
        if pid not in (r['a'], r['b']):
            continue
        other = people.get(r['b'] if pid == r['a'] else r['a'])
        if not other:
            continue
        label = r.get('label') or ('妹' if (r['kind'] == 'sister' and pid == r['a']) else 'お姉様' if r['kind'] == 'sister'
                                   else {'blood': '血縁', 'friend': '友人', 'acquaintance': '知人', 'other': '関係者'}[r['kind']])
        port = other.get('portrait') or other.get('image')
        out.append({'name': other['name'], 'label': label, 'portrait': port if port and (fe / port).exists() else None,
                    'kind': r['kind']})
    order = {'sister': 0, 'blood': 1, 'friend': 2, 'acquaintance': 3, 'other': 4}
    return sorted(out, key=lambda b: (order[b['kind']], b['name']))


def profile_rows(p, extra=None):
    rows = [('名前', p['name']), ('よみがな', p['nameKana']), ('ローマ字', p['romaji']),
            ('区分', '教員' if p['kind'] == 'teacher' else '生徒'),
            ('学年', p['grade']), ('所属', p['club']),
            ('在籍状況', '卒業' if p['status'] == 'graduated' else '在籍中')]
    if p.get('group'):
        rows.append(('副題', p['group']))
    for label, key in (('種族', 'species'), ('身長', 'height'), ('一人称', 'firstPerson'), ('二人称', 'secondPerson')):
        if (extra or {}).get(key):
            rows.append((label, extra[key]))
    return [(k, v) for k, v in rows if v]


# ---------------------------------------------------------------- page HTML (template-driven)
def esc(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;'))


def page_html(pg, tpl, fe: Path, number: int):
    css = (TEMPLATES / tpl['id'] / 'page.css').read_text(encoding='utf-8')
    font_css = ''.join(
        f"@font-face{{font-family:'NotoJP';font-weight:{w};src:url('{(FONT_DIR / f).as_uri()}')}}"
        for w, f in ((400, 'NotoSansJP-Regular.ttf'), (700, 'NotoSansJP-Bold.ttf')))
    color = pg.get('color', '#d9c3cf')
    role = pg['role']
    body = ''
    if role == 'title':
        img = f'<img class="portrait" src="{(fe / pg["portrait"]).as_uri()}">' if pg.get('portrait') else \
              '<div class="portrait empty">PORTRAIT</div>'
        body = (f'<div class="kana" data-fit="1" data-min="22">{esc(pg["kana"])}</div>'
                f'<div class="name" data-fit="1" data-min="44">{esc(pg["name"])}</div>'
                f'<div class="roleline" data-fit="1" data-min="26">{esc(pg["roleLine"])}</div>'
                f'<div class="portrait-box">{img}</div>')
    elif role == 'profile':
        rows = ''.join(f'<div class="row"><span class="k">{esc(k)}</span><span class="v" data-fit="1" data-min="22">{esc(v)}</span></div>'
                       for k, v in pg['rows'])
        dense = ' dense' if len(pg['rows']) > 9 else ''
        body = f'<h2>PROFILE</h2><div class="rows{dense}">{rows}</div><div class="swatch"></div>'
    elif role == 'about':
        secs = ''.join(f'<div class="sec"><h3>{esc(k)}</h3><p>{esc(v).replace(chr(10), "<br>")}</p></div>' for k, v in pg['sections'])
        body = f'<h2>ABOUT</h2><div class="secs">{secs}</div>'
    elif role == 'bonds':
        items = ''
        for b in pg['bonds']:
            im = f'<img src="{(fe / b["portrait"]).as_uri()}">' if b.get('portrait') else '<span class="noimg"></span>'
            items += f'<div class="bond">{im}<div class="bt"><div class="bn">{esc(b["name"])}</div><div class="bl">{esc(b["label"])}</div></div></div>'
        body = f'<h2>BONDS</h2><div class="bonds">{items}</div>'
    elif role == 'photo':
        cap = f'<div class="caption">{esc(pg["caption"])}</div>' if pg.get('caption') else ''
        body = f'<div class="photo-box{" with-cap" if cap else ""}"><img src="{(fe / pg["image"]).as_uri()}"></div>{cap}'
    else:
        body = '<div class="blank-note">&nbsp;</div>'
    num = '' if role == 'blank' else f'<div class="pno">{number}</div>'
    return (f'<!doctype html><meta charset="utf-8"><style>{font_css}{css}</style>'
            f'<body class="role-{role}" style="--accent:{esc(color)}"><div class="page">{body}{num}</div></body>')


FIT_JS = """() => {
  const out = [];
  document.querySelectorAll('[data-fit]').forEach(el => {
    let size = parseFloat(getComputedStyle(el).fontSize); const min = parseFloat(el.dataset.min || '20');
    const over = () => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
    while (over() && size > min) { size -= 2; el.style.fontSize = size + 'px'; }
    if (over()) out.push((el.className || el.tagName) + ': ' + el.textContent.slice(0, 20));
  });
  return out;
}"""


def render_page(browser_page, html, rep: Report, label):
    # file:// page so local fonts and portraits are allowed to load (set_content pages are blocked from file URLs)
    with tempfile.NamedTemporaryFile('w', suffix='.html', encoding='utf-8', delete=False) as f:
        f.write(html)
    try:
        browser_page.goto(Path(f.name).as_uri(), wait_until='load')
    finally:
        Path(f.name).unlink(missing_ok=True)
    browser_page.evaluate("document.fonts.ready")
    overflow = browser_page.evaluate(FIT_JS)
    for o in overflow:
        rep.warn(f'{label}: text still overflows at minimum size ({o})')
    png = browser_page.screenshot(clip={'x': 0, 'y': 0, 'width': PAGE_W, 'height': PAGE_H})
    return Image.open(io.BytesIO(png)).convert('RGB')


# ---------------------------------------------------------------- atlas composition
def paper_of(tpl):
    h = tpl.get('paper', '#fbf6f1').lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def compose(base: Image.Image, left: Image.Image, right: Image.Image, paper):
    atlas = base.copy()
    for r in (LEFT_RECT, RIGHT_RECT):
        atlas.paste(paper, (r[0], r[1], r[2], r[3]))
    atlas.paste(left, LEFT_POS)
    atlas.paste(right, RIGHT_POS)
    return atlas


def input_hash(pages, tpl, base_hash, extra_files):
    h = hashlib.sha256()
    h.update(json.dumps([pages, tpl], sort_keys=True, ensure_ascii=False).encode('utf-8'))
    h.update(base_hash.encode())
    for f in extra_files:
        h.update(Path(f).read_bytes())
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--apply', action='store_true', help='render and write (default: dry run)')
    ap.add_argument('--out', type=Path, default=DEFAULT_OUT, help='output root (books/<slot>/ is created below it)')
    ap.add_argument('--fe', type=Path, default=DEFAULT_FE, help='frontend project folder (data + assets)')
    ap.add_argument('--slots', type=Path, default=SLOTS)
    ap.add_argument('--template', default='placeholder')
    ap.add_argument('--base', type=Path, default=DEFAULT_BASE, help='base atlas that supplies the spine/edge bands')
    ap.add_argument('--only', help='render only this slot (e.g. person-001)')
    ap.add_argument('--fonts', type=Path, default=None, help='folder with NotoSansJP-Regular.ttf / -Bold.ttf (default: fonts-download/NotoSansJP)')
    ap.add_argument('--force', action='store_true', help='re-render even if the inputs did not change')
    ap.add_argument('--png', action='store_true', help='also save lossless PNG next to each JPEG (debug)')
    a = ap.parse_args()

    a.fe, a.out, a.slots, a.base = a.fe.resolve(), a.out.resolve(), a.slots.resolve(), a.base.resolve()   # file:// URLs need absolute paths
    if a.fonts:
        global FONT_DIR
        FONT_DIR = a.fonts.resolve()
    rep = Report()
    tpl = json.loads((TEMPLATES / a.template / 'template.json').read_text(encoding='utf-8'))
    people = {p['id']: p for p in json.loads((a.fe / 'data' / 'public-people-all.json').read_text(encoding='utf-8'))['people']}
    slots = json.loads(a.slots.read_text(encoding='utf-8'))
    cc_file = a.fe / 'data' / 'character-content.json'
    content = json.loads(cc_file.read_text(encoding='utf-8')).get('characters', {}) if cc_file.exists() else {}
    rel_file = a.fe / 'data' / 'relations.json'
    relations = json.loads(rel_file.read_text(encoding='utf-8')).get('relations', []) if rel_file.exists() else []
    base_bytes = a.base.read_bytes()
    base_hash = hashlib.sha256(base_bytes).hexdigest()
    base = Image.open(io.BytesIO(base_bytes)).convert('RGB')
    if base.size != (ATLAS, ATLAS):
        sys.exit(f'base atlas must be {ATLAS}x{ATLAS}, got {base.size}')
    state_file = a.out / 'books' / '.render-state.json'
    state = json.loads(state_file.read_text(encoding='utf-8')) if state_file.exists() else {}

    jobs = []
    for s in slots:
        slot = s.get('slot', '')
        if not SLOT_RE.match(slot):
            rep.warn(f'{slot!r}: not a person slot; skipped (story books come later)'); continue
        if a.only and slot != a.only:
            continue
        p = people.get(s.get('person'))
        if p is None:
            rep.error(f'{slot}: person {s.get("person")!r} is not in public-people-all.json'); continue
        spreads = int(s.get('spreads', 6))
        if not 1 <= spreads <= 6:
            rep.error(f'{slot}: person books support 1..6 spreads'); continue
        pages = build_pages(p, spreads, a.fe, rep, tpl, content.get(p['id']), bonds_of(p['id'], relations, people, a.fe))
        imgs = [a.fe / x for pg in pages for x in (pg.get('portrait'), pg.get('image'), *[b.get('portrait') for b in pg.get('bonds', [])]) if x]
        h = input_hash(pages, tpl, base_hash, imgs)
        jobs.append((slot, spreads, pages, h))

    todo = [j for j in jobs if a.force or state.get(j[0]) != j[3]
            or not all((a.out / 'books' / j[0] / f'spread-{n + 1}.jpg').exists() for n in range(j[1]))]
    print(f'[template] {tpl["id"]} v{tpl["version"]}   [output] {a.out}')
    print(f'books: {len(jobs)} total, {len(todo)} need rendering, {len(jobs) - len(todo)} up to date')
    for j in todo:
        print(f'  render {j[0]}  ({j[1]} spreads)')

    if rep.errors:
        for e in rep.errors: print('ERROR:', e)
        print('\nResult: FAILED. Nothing written.'); sys.exit(2)
    if not todo:
        for w in rep.warnings: print('WARNING:', w)
        print('\nResult: already up to date.'); return
    if not a.apply:
        for w in rep.warnings: print('WARNING:', w)
        print('\nResult: DRY RUN. Re-run with --apply to render. (Nothing was written or pushed.)'); return

    from playwright.sync_api import sync_playwright
    paper = paper_of(tpl)
    written = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        bp = browser.new_page(viewport={'width': PAGE_W, 'height': PAGE_H})
        for slot, spreads, pages, h in todo:
            outdir = a.out / 'books' / slot
            outdir.mkdir(parents=True, exist_ok=True)
            rendered = []
            for i, pg in enumerate(pages, start=1):
                rendered.append(render_page(bp, page_html(pg, tpl, a.fe, i), rep, f'{slot} p.{i}'))
            for j in range(spreads):
                right, left = rendered[2 * j], rendered[2 * j + 1]       # right-bound: p.(2j+1) right, p.(2j+2) left
                atlas = compose(base, left, right, paper)
                path = outdir / f'spread-{j + 1}.jpg'
                tmp = path.with_suffix('.tmp')
                atlas.save(tmp, format='JPEG', quality=JPEG_QUALITY, optimize=True, subsampling=0)
                tmp.replace(path)
                if a.png: atlas.save(path.with_suffix('.png'))
                size = path.stat().st_size
                if size > MAX_BYTES:
                    rep.warn(f'{slot} spread-{j + 1}.jpg is {size // 1024} KB (target ~740 KB)')
                written.append(path)
            state[slot] = h
        browser.close()
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(json.dumps(state, indent=1, sort_keys=True), encoding='utf-8')
    for w in rep.warnings: print('WARNING:', w)
    print(f'\nResult: RENDERED {len(written)} image(s) into {a.out / "books"}. Review them, then commit/push the Pages repo yourself.')


if __name__ == '__main__':
    main()
