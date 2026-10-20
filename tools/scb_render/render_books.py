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
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fanbook

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]                                    # .../SCB
DEFAULT_FE = ROOT / 'WEBPage' / 'SCB_Library_Home_Prototype'
DEFAULT_OUT = HERE / 'out'
DEFAULT_BASE = HERE / 'base' / 'atlas.png'        # the book's own UV texture (Unity: Material/Texture/UV Test Atlas.png) at 2048
FONT_DIR = ROOT / 'fonts-download' / 'NotoSansJP'
SLOTS = ROOT / 'tools' / 'scb_publish' / 'slots.json'
TEMPLATES = HERE / 'templates'

ATLAS = 2048
MAX_SINGLE, MAX_GRAPH = 6, 14                             # nodes on one page / on a whole spread
KIND_JP = {'sister': '姉妹', 'blood': '血縁', 'friend': '友人', 'acquaintance': '知人', 'clan': '同族', 'rival': 'ライバル',
           'kusareen': '腐れ縁', 'gizagiza': 'ギザギザ', 'other': 'その他', 'one_sided': '片想い', 'tsuntsun': 'ツンツン',
           'honmei': '本命', 'oshi': '推し', 'amayakashi': '甘やかし', 'amae': '甘え', 'izon': '依存', 'kininaru': '気になる'}
KIND_STYLE = {                                            # kind -> (colour, dash)
    'sister': ('#c04a58', ''), 'blood': ('#c04a58', '14 10'), 'clan': ('#a8566a', ''),
    'one_sided': ('#d86a9a', ''), 'honmei': ('#d86a9a', ''), 'oshi': ('#e0508a', ''), 'kininaru': ('#e58aa8', '4 8'),
    'amae': ('#d9879a', ''), 'amayakashi': ('#d9879a', ''), 'izon': ('#a04a7a', ''),
    'friend': ('#5f9a70', ''), 'kusareen': ('#6a8a5a', '14 10'), 'tsuntsun': ('#7aa05a', ''),
    'acquaintance': ('#9a8478', '14 10'), 'rival': ('#4a6a9a', ''), 'gizagiza': ('#6a5a9a', '14 10'), 'other': ('#9a8478', ''),
}
DIRECTED = ('one_sided', 'tsuntsun', 'honmei', 'oshi', 'amayakashi', 'amae', 'izon', 'kininaru')
PAGE_W, PAGE_H = 928, 1528                                # render size of one page
# atlas rectangles (spec 9.8, x right / y down). Both are fully painted with paper first, so no base art leaks.
LEFT_RECT = (29, 32, 957, 1561)                           # p.even
RIGHT_RECT = (950, 26, 1884, 1559)                        # p.odd
LEFT_POS = (29, 32)                                       # where a 928x1528 page is pasted
RIGHT_POS = (953, 28)
MAX_BYTES = 1_000_000                                     # warn above this (target ~740 KB)
JPEG_QUALITY = 88
SLOT_RE = re.compile(r'^person-\d{3}$')
STORY_TIER = 'y2'                                          # same value as publish_from_db.STORY_TIER
SAFE_IMG = re.compile(r'^assets/[A-Za-z0-9_./-]+$')


TIER_ACCENT = {'y1': '#f2a7a0', 'y2': '#c04a58', 'y3': '#8a6a3d', 'teacher': '#4a4a50'}
SAFE_COLOR = re.compile(r'^#[0-9A-Fa-f]{6}$')


def accent_for(theme, tier, person_color):
    """Accent colour of a page: the person's colour, or the tier colour (theme.accentSource = 'tier')."""
    if (theme or {}).get('accentSource') == 'tier' and tier in TIER_ACCENT:
        c = ((theme or {}).get('tierAccent') or {}).get(tier) or TIER_ACCENT[tier]
        return c if SAFE_COLOR.match(c) else TIER_ACCENT[tier]
    return person_color or '#d9c3cf'


def background_of(theme, role, tier):
    """Background image path (assets/...) of a page role for a tier: the tier's own, else 'all', else None."""
    b = ((theme or {}).get('backgrounds') or {}).get(role) or {}
    return b.get(tier) or b.get('all') or None


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


def build_pages(p, spreads, fe: Path, rep: Report, tpl: dict, extra=None, bonds=None, theme=None, tier=None):
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
    notes = [(k, extra[key]) for k, key in (('好きなもの', 'likes'), ('苦手なもの', 'dislikes')) if extra.get(key)]
    pages.append({'role': 'profile', 'name': p['name'], 'rows': profile_rows(p, extra), 'notes': notes, 'color': color})
    graph = None
    if bonds:
        if len(bonds) > MAX_GRAPH:
            rep.warn(f'{p["id"]}: {len(bonds)} relations; only the first {MAX_GRAPH} fit in the graph')
            bonds = bonds[:MAX_GRAPH]
        center = {'name': p['name'], 'portrait': portrait}
        if len(bonds) > MAX_SINGLE:               # a whole spread: canvas right half = p.(odd), left half = p.(even)
            graph = [{'role': 'graph', 'span': 2, 'half': 'R', 'bonds': bonds, 'center': center, 'color': color},
                     {'role': 'graph', 'span': 2, 'half': 'L', 'bonds': bonds, 'center': center, 'color': color}]
        else:
            graph = [{'role': 'graph', 'span': 1, 'half': 'S', 'bonds': bonds, 'center': center, 'color': color}]
    secs = [(k, extra[key]) for k, key in (('人物紹介', 'about'),) if extra.get(key)]   # likes / dislikes live on the PROFILE page
    photos = []                                            # (image, caption)
    for bp in extra.get('bookPages') or []:
        photos.append((bp.get('image'), bp.get('caption', '')))
    if not photos:
        for o in extra.get('outfits') or []:
            photos += [(x, o.get('label', '')) for x in o.get('images', [])]
    if not photos:
        photos = [(g, '') for g in (p.get('gallery') or [])]
    photo_pages = []
    for img, cap in photos:                                # one picture per page, in order
        if img and SAFE_IMG.match(img) and (fe / img).exists():
            photo_pages.append({'role': 'photo', 'image': img, 'caption': cap, 'color': color})
        else:
            rep.warn(f'{p["id"]}: book image missing, page skipped: {img}')
    about_page = {'role': 'about', 'sections': secs, 'color': color} if secs else None
    order = (theme or {}).get('pages')
    if order is None:                                      # default order (the layout used so far)
        if graph and len(graph) == 2:                      # right after the profile (p.3 / p.4), so the two halves face each other
            pages += graph
        if about_page:
            pages.append(about_page)
        if graph and len(graph) == 1:
            pages += graph
        pages += photo_pages
    else:                                                  # the theme decides which optional pages appear and in what order
        for name in order:
            if name == 'about' and about_page:
                pages.append(about_page)
            elif name == 'graph' and graph:
                if len(graph) == 2 and len(pages) % 2 == 1:
                    pages.append({'role': 'blank'})        # a whole-spread graph must start on a right-hand (odd) page
                pages += graph
            elif name == 'photos':
                pages += photo_pages
    for pg in pages:
        pg['tier'] = tier
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
        label = r.get('forA' if pid == r['a'] else 'forB') or r.get('label') or '関係者'
        port = other.get('portrait') or other.get('image')
        direction = ('out' if pid == r['a'] else 'in') if r['kind'] in DIRECTED else 'none'
        out.append({'name': other['name'], 'label': label, 'portrait': port if port and (fe / port).exists() else None,
                    'kind': r['kind'], 'dir': direction})
    order = {'sister': 0, 'blood': 1, 'clan': 2}
    return sorted(out, key=lambda b: (order.get(b['kind'], 3), b['name']))


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


def graph_body(pg, fe: Path):
    """Centre person + related people on an ellipse, lines coloured by kind (arrow = direction), label on each line.
    span 1: one page (928 wide). span 2: a whole spread (1856 wide); the page keeps only its half (cropped when screenshotting)."""
    import math
    span = pg['span']
    W = 928 * span
    cx, cy = W / 2, 800
    rx, ry = (310, 500) if span == 1 else (720, 490)
    bonds = pg['bonds']
    n = len(bonds)
    if span == 1:
        cx, cy, rx, ry, R_C, R_N = 464, 790, 345, 520, 105, 66
    else:
        R_C, R_N = 120, 72
    pos = []
    for i in range(n):
        # span 2: keep the nodes off the spine (x = centre) by turning the ring half a step when n is even
        ang = -math.pi / 2 + 2 * math.pi * i / max(n, 1) + (math.pi / max(n, 1) if span == 2 and n % 2 == 0 else 0)
        pos.append((cx + rx * math.cos(ang), cy + ry * math.sin(ang)))
    svg, pills, nodes = '', '', ''
    for (x, y), b in zip(pos, bonds):
        color, dash = KIND_STYLE.get(b['kind'], ('#9a8478', ''))
        dx, dy = x - cx, y - cy
        dist = math.hypot(dx, dy) or 1
        ux, uy = dx / dist, dy / dist
        x1, y1 = cx + ux * (R_C + 4), cy + uy * (R_C + 4)
        x2, y2 = x - ux * (R_N + 8), y - uy * (R_N + 8)
        dd = f' stroke-dasharray="{dash}"' if dash else ''
        svg += f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{color}" stroke-width="7" stroke-linecap="round"{dd}/>'
        if b['kind'] in DIRECTED and b.get('dir') in ('out', 'in'):
            if b['dir'] == 'out':
                tx, ty, vx, vy = x2, y2, ux, uy
            else:
                tx, ty, vx, vy = x1, y1, -ux, -uy
            ax, ay = tx - vx * 26, ty - vy * 26
            px, py = -vy, vx
            svg += (f'<polygon points="{tx:.1f},{ty:.1f} {ax + px * 15:.1f},{ay + py * 15:.1f} {ax - px * 15:.1f},{ay - py * 15:.1f}" fill="{color}"/>')
        mx, my = cx + dx * 0.5, cy + dy * 0.5
        pills += (f'<div class="pill" style="left:{mx:.1f}px;top:{my:.1f}px;border-color:{color};color:{color}">{esc(b["label"])}</div>')
        sz = f'width:{2 * R_N}px;height:{2 * R_N}px'
        im = f'<img style="{sz}" src="{(fe / b["portrait"]).as_uri()}">' if b.get('portrait') else f'<span class="noimg" style="{sz}"></span>'
        nodes += (f'<div class="gnode" style="left:{x:.1f}px;top:{y:.1f}px">{im}<div class="gname">{esc(b["name"])}</div></div>')
    csz = f'width:{2 * R_C}px;height:{2 * R_C}px'
    cim = f'<img style="{csz}" src="{(fe / pg["center"]["portrait"]).as_uri()}">' if pg['center'].get('portrait') else f'<span class="noimg" style="{csz}"></span>'
    centre = f'<div class="gcenter" style="left:{cx:.1f}px;top:{cy:.1f}px">{cim}<div class="gcname">{esc(pg["center"]["name"])}</div></div>'
    kinds = []
    for b in bonds:
        if b['kind'] not in kinds:
            kinds.append(b['kind'])
    legend = ''.join(f'<span class="lg"><i style="background:{KIND_STYLE.get(k, ("#9a8478", ""))[0]}"></i>{esc(KIND_JP.get(k, k))}</span>' for k in kinds)
    arrow_note = '<span class="lg">矢印＝向き</span>' if any(b['kind'] in DIRECTED for b in bonds) else ''
    return (f'<h2>BONDS</h2><svg class="gsvg" width="{W}" height="{PAGE_H}" viewBox="0 0 {W} {PAGE_H}">{svg}</svg>{pills}{nodes}{centre}'
            f'<div class="legend" style="width:{W - 140}px">{legend}{arrow_note}</div>')


def page_html(pg, tpl, fe: Path, number: int, theme=None):
    css = (TEMPLATES / tpl['id'] / 'page.css').read_text(encoding='utf-8')
    font_css = ''.join(
        f"@font-face{{font-family:'NotoJP';font-weight:{w};src:url('{(FONT_DIR / f).as_uri()}')}}"
        for w, f in ((400, 'NotoSansJP-Regular.ttf'), (700, 'NotoSansJP-Bold.ttf')))
    theme = theme or {}
    tier = pg.get('tier')
    color = accent_for(theme, tier, pg.get('color', '#d9c3cf'))
    role = pg['role']
    body = ''
    css_vars = ''.join(f'--{k}:{theme[k]};' for k in ('paper', 'text', 'muted', 'rule') if SAFE_COLOR.match(str(theme.get(k, ''))))
    if isinstance(theme.get('fontScale'), (int, float)) and 0.8 <= theme['fontScale'] <= 1.3:
        css_vars += f'--fs:{theme["fontScale"]};'
    bg_path = background_of(theme, role, tier)
    bg = f'<div class="bg" style="background-image:url(\'{(fe / bg_path).as_uri()}\')"></div>' if bg_path and SAFE_IMG.match(bg_path) and (fe / bg_path).is_file() else ''
    body_cls = (f'role-{role} frame-{theme.get("frame", "thin")} shape-{theme.get("portraitShape", "arch")} pf-{theme.get("photoFrame", "border")}'
                + (' no-bar' if theme.get('topBar') is False else ''))
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
        dense = ' dense' if len(pg['rows']) > 9 or pg.get('notes') else ''   # leave room for the likes / dislikes notes
        notes = ''.join(f'<div class="note"><h3>{esc(k)}</h3><p data-fit="1" data-min="18">{esc(v).replace(chr(10), "<br>")}</p></div>'
                        for k, v in pg.get('notes', []))
        notes = f'<div class="notes">{notes}</div>' if notes else ''
        body = f'<h2>PROFILE</h2><div class="pbody"><div class="rows{dense}">{rows}</div>{notes}</div><div class="swatch"></div>'
    elif role == 'about':
        secs = ''.join(f'<div class="sec"><h3>{esc(k)}</h3><p>{esc(v).replace(chr(10), "<br>")}</p></div>' for k, v in pg['sections'])
        body = f'<h2>ABOUT</h2><div class="secs">{secs}</div>'
    elif role == 'graph':
        body = graph_body(pg, fe)
    elif role == 'photo':
        cap = f'<div class="caption">{esc(pg["caption"])}</div>' if pg.get('caption') else ''
        body = f'<div class="photo-box{" with-cap" if cap else ""}"><img src="{(fe / pg["image"]).as_uri()}"></div>{cap}'
    elif role == 'story_title':
        n = len(pg['title'])
        size = 84 if n <= 8 else 64 if n <= 14 else 50 if n <= 22 else 42
        cover = pg.get('cover') and SAFE_IMG.match(pg['cover']) and (fe / pg['cover']).is_file()
        body = (f'<div class="story-title{"" if cover else " nocover"}"><div class="st-cat">{esc(pg["category"])}</div>'
                f'<div class="st-name" style="font-size:{size}px;height:260px">{esc(pg["title"])}</div>'
                f'<div class="st-vol">{esc(pg["label"])}</div><div class="st-rule"></div><div class="st-author">{esc(pg["author"])}</div>'
                + (f'<img class="st-cover" src="{(fe / pg["cover"]).as_uri()}">' if cover else '')
                + f'<div class="st-sum">{esc(pg["summary"]).replace(chr(10), "<br>")}</div></div>')
    elif role == 'story_text':
        lines = ''.join(f'<div class="ln {k}">{esc(t) if t else "&nbsp;"}</div>' for k, t in pg['lines'])
        body = f'<div class="story-text"><div class="st-head">{esc(pg["head"])}</div><div class="st-body">{lines}</div></div>'
    else:
        body = '<div class="blank-note">&nbsp;</div>'
    num = '' if (role in ('blank', 'graph', 'story_title') or theme.get('pageNumber') is False) else f'<div class="pno">{number}</div>'
    wide = f'html,body,.page{{width:{928 * pg["span"]}px}}' if role == 'graph' else ''
    return (f'<!doctype html><meta charset="utf-8"><style>{font_css}{css}{fanbook.CSS}{wide}</style>'
            f'<body class="{body_cls}" style="--accent:{esc(color)};{css_vars}"><div class="page">{bg}{body}{num}</div></body>')


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


def render_page(browser_page, html, rep: Report, label, width=PAGE_W, crop_x=0):
    # file:// page so local fonts and portraits are allowed to load (set_content pages are blocked from file URLs)
    with tempfile.NamedTemporaryFile('w', suffix='.html', encoding='utf-8', delete=False) as f:
        f.write(html)
    try:
        browser_page.goto(Path(f.name).as_uri(), wait_until='load')
    finally:
        Path(f.name).unlink(missing_ok=True)
    browser_page.evaluate("document.fonts.ready")
    if width != PAGE_W:
        browser_page.set_viewport_size({'width': width, 'height': PAGE_H})
    overflow = browser_page.evaluate(FIT_JS)
    if width != PAGE_W:
        browser_page.wait_for_timeout(100)
    for o in overflow:
        rep.warn(f'{label}: text still overflows at minimum size ({o})')
    png = browser_page.screenshot(clip={'x': crop_x, 'y': 0, 'width': PAGE_W, 'height': PAGE_H})
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
    theme_file = a.fe / 'data' / 'book-theme.json'
    theme = json.loads(theme_file.read_text(encoding='utf-8')) if theme_file.exists() else {}
    theme_global = theme
    pt_file = a.fe / 'data' / 'person-themes.json'
    person_themes = json.loads(pt_file.read_text(encoding='utf-8')) if pt_file.exists() else {}   # each person's own look over the global theme
    rel_file = a.fe / 'data' / 'relations.json'
    relations = json.loads(rel_file.read_text(encoding='utf-8')).get('relations', []) if rel_file.exists() else []
    bases = {}

    def base_for(tier):
        """(image, hash) of the base atlas of a tier: atlas-<tier>.png next to --base (one per 一年/二年/三年/教職員), else --base."""
        if tier not in bases:
            f = a.base.parent / f'atlas-{tier}.png'
            f = f if f.exists() else a.base
            try:                                           # an atlas uploaded in the admin hub (data/tier-art.json) wins
                up = json.loads((a.fe / 'data' / 'tier-art.json').read_text(encoding='utf-8')).get(tier)
                if up and (a.fe / up).is_file():
                    f = a.fe / up
            except (OSError, ValueError):
                pass
            raw = f.read_bytes()
            img = Image.open(io.BytesIO(raw)).convert('RGB')
            if img.size != (ATLAS, ATLAS):
                if img.size[0] == img.size[1] and img.size[0] in (1024, 4096):   # the model texture is 1024 square: enlarge to the atlas size
                    img = img.resize((ATLAS, ATLAS), Image.LANCZOS)
                else:
                    sys.exit(f'base atlas {f.name} must be square (1024 / 2048), got {img.size}')
            bases[tier] = (img, hashlib.sha256(raw).hexdigest())
        return bases[tier]

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
        tier = 'teacher' if p['kind'] == 'teacher' else {'1年': 'y1', '2年': 'y2', '3年': 'y3'}.get(p.get('grade'), 'y1')
        theme = {**theme_global, **(person_themes.get(p['id']) or {})}
        pages = build_pages(p, spreads, a.fe, rep, tpl, content.get(p['id']), bonds_of(p['id'], relations, people, a.fe), theme, tier)
        imgs = [a.fe / x for pg in pages for x in (pg.get('portrait'), pg.get('image'), (pg.get('center') or {}).get('portrait'),
                                                      *[b.get('portrait') for b in pg.get('bonds', [])]) if x]
        bgs = {background_of(theme, pg['role'], tier) for pg in pages if pg['role'] != 'blank'} - {None}
        imgs += [a.fe / x for x in sorted(bgs) if SAFE_IMG.match(x) and (a.fe / x).is_file()]
        h = input_hash(pages, [tpl, theme], base_for(tier)[1], imgs)
        jobs.append((slot, spreads, pages, h, tier, theme))

    # fan works (二次創作): data/fanworks.json -> one 12-page book per volume
    fan_file = a.fe / 'data' / 'fanworks.json'
    for w in (json.loads(fan_file.read_text(encoding='utf-8')).get('works', []) if fan_file.exists() else []):
        vols = fanbook.split_volumes(w)
        for vi, slot in enumerate(w.get('slots', [])):
            if a.only and slot != a.only:
                continue
            if vi >= len(vols):
                break
            v = vols[vi]
            pages = [{'role': 'story_title', 'title': w['title'], 'author': w.get('author', ''), 'label': v['label'], 'summary': w.get('summary', ''),
                      'cover': w.get('cover'), 'category': w.get('category', '小説・SS'), 'color': '#d9c3cf', 'tier': STORY_TIER}]
            head = w['title'] + (('　' + v['label']) if v['label'] else '')
            for tp in v['pages']:
                pages.append({'role': 'story_text', 'head': head, 'lines': tp, 'tier': STORY_TIER})
            if v['index'] == v['of'] and pages[-1]['role'] == 'story_text':
                pages[-1]['lines'] = list(pages[-1]['lines']) + [('b', ''), ('t', '（完）')] if len(pages[-1]['lines']) < fanbook.PAGE_LINES - 1 else pages[-1]['lines']
            while len(pages) < 12:
                pages.append({'role': 'blank', 'tier': STORY_TIER})
            imgs = [a.fe / w['cover']] if w.get('cover') and SAFE_IMG.match(w['cover']) and (a.fe / w['cover']).is_file() else []
            h = input_hash(pages, [tpl, theme_global], base_for(STORY_TIER)[1], imgs)
            jobs.append((slot, 6, pages, h, STORY_TIER, theme_global))

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
        for slot, spreads, pages, h, tier, theme in todo:
            outdir = a.out / 'books' / slot
            outdir.mkdir(parents=True, exist_ok=True)
            rendered = []
            for i, pg in enumerate(pages, start=1):
                if pg['role'] == 'graph' and pg['span'] == 2:           # right half of the wide canvas is the odd (right-hand) page
                    rendered.append(render_page(bp, page_html(pg, tpl, a.fe, i, theme), rep, f'{slot} p.{i}', width=1856, crop_x=928 if pg['half'] == 'R' else 0))
                    bp.set_viewport_size({'width': PAGE_W, 'height': PAGE_H})
                else:
                    rendered.append(render_page(bp, page_html(pg, tpl, a.fe, i, theme), rep, f'{slot} p.{i}'))
            for j in range(spreads):
                right, left = rendered[2 * j], rendered[2 * j + 1]       # right-bound: p.(2j+1) right, p.(2j+2) left
                atlas = compose(base_for(tier)[0], left, right, paper)
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
