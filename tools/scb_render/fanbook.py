"""Fan-work (二次創作) books: long text (+ illustrations) -> pages -> volumes.  Pure Python (no browser), so the publisher (how many books / slots?)
and the renderer (what is on each page?) always agree.

VERTICAL writing (縦書き, right-bound book).  Page geometry (928 x 1528 px page): 27 px type, columns 42 px apart,
40 characters per column, 18 columns per page.  A column is a "line" in the code below.
A book has 12 pages: p.1 = title page (title / author / summary / volume), p.2..p.12 = 11 content pages (text pages and illustration pages).
A work longer than one book is split evenly into volumes (第一巻, 第二巻 ...); each volume is one book slot  story-NNN.
Columns are laid out here (kinsoku: no closing punctuation at the top of a column, no opening bracket at the bottom) and drawn one <div> per column,
so what is measured is exactly what is drawn.  Illustrations: [{'image': 'assets/...', 'caption': '', 'after': N}] = full-page picture placed after
the N-th text page (0 = before the first text page).
"""
import re

LINE_UNITS = 40           # characters per column
PAGE_LINES = 18           # columns per text page
ITEMS_PER_BOOK = 15       # content pages (p.2 .. p.16; a book has 8 spreads = 16 pages)
PAGES_PER_BOOK = 12
MAX_VOLUMES = 8

NO_START = set('、。，．,.）」』】〕］｝〉》！？!?…‥ー～々ゝゞヽヾぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ・：；')
HANG = set('、。，．,.')                 # may hang below the column when it is full
NO_END = set('（「『【〔［｛〈《')
HEADING = re.compile(r'^(第[一二三四五六七八九十百〇0-9０-９]+[章話節部巻]|プロローグ|エピローグ|序章|終章|幕間|あとがき)')
FULLWIDTH = str.maketrans({**{chr(0x30 + i): chr(0xFF10 + i) for i in range(10)}, '!': '！', '?': '？', '(': '（', ')': '）'})


def width(ch):
    o = ord(ch)
    if ch == '　':
        return 1.0
    if o < 0x80 or 0xFF61 <= o <= 0xFF9F:      # remaining ASCII (letters) / half-width kana: rotated, narrower
        return 0.5
    return 1.0


def normalize(text):
    t = text.replace('\r\n', '\n').replace('\r', '\n').replace(' ', ' ').replace('\t', ' ')
    t = re.sub(r'[ ]+\n', '\n', t)
    t = re.sub(r'(?<=[^\x00-\x7f]) +(?=[^\x00-\x7f])', '', t)      # stray spaces between Japanese characters
    t = t.translate(FULLWIDTH)                                      # digits and ! ? ( ) stand upright in vertical text
    return t.strip('\n')


def layout_paragraph(text, indent):
    """One paragraph -> list of column strings."""
    lines, cur, w = [], '', 0.0
    chars = list(('　' if indent else '') + text)
    i = 0
    while i < len(chars):
        ch = chars[i]
        cw = width(ch)
        if w + cw > LINE_UNITS + 1e-6:
            if ch in HANG and w <= LINE_UNITS + 1e-6:                       # hang 、。 below the column
                cur += ch; i += 1
                lines.append(cur); cur, w = '', 0.0
                continue
            if ch in NO_START and cur:                                      # pull one character down with the closing mark
                last = cur[-1]; cur = cur[:-1]
                lines.append(cur); cur, w = last, width(last)
                continue
            if cur and cur[-1] in NO_END:                                   # never end a column with an opening bracket
                last = cur[-1]; cur = cur[:-1]
                lines.append(cur); cur, w = last, width(last)
                continue
            lines.append(cur); cur, w = '', 0.0
            continue
        cur += ch; w += cw; i += 1
    if cur or not lines:
        lines.append(cur)
    return lines


def to_lines(body, colon_heading=False):
    """Whole text -> list of (kind, text): kind 'h' heading column (double width), 't' text column, 'b' blank column."""
    out = []
    for raw in normalize(body).split('\n'):
        para = raw.strip(' ')
        if para == '':
            if out and out[-1][0] != 'b':
                out.append(('b', ''))
            continue
        by_colon = colon_heading and para[-1] in '：:' and para.strip('：: ') != ''      # (own settings) a short line that ends with a colon is a heading
        if (HEADING.match(para) or by_colon) and len(para) <= 36:
            if out and out[-1][0] != 'b':
                out.append(('b', ''))
            out.append(('h', para.rstrip('：: ') if by_colon else para))
            continue
        indent = para[0] not in '「『（(【〔―—'
        for ln in layout_paragraph(para, indent):
            out.append(('t', ln))
    return out


def paginate(body, colon_heading=False):
    """Columns -> list of text pages (each a list of (kind, text)); a heading never ends a page, no blank column starts or ends one."""
    lines = to_lines(body, colon_heading)
    pages, cur = [], []

    def used(page):
        return sum(2 if k == 'h' else 1 for k, _ in page)

    for kind, text in lines:
        cost = 2 if kind == 'h' else 1
        if cur and used(cur) + cost > PAGE_LINES:
            while cur and cur[-1][0] == 'b':
                cur.pop()
            tail = [cur.pop()] if cur and cur[-1][0] == 'h' else []       # keep a heading with the text that follows
            while cur and cur[-1][0] == 'b':
                cur.pop()
            pages.append(cur)
            cur = tail
        if not cur and kind == 'b':
            continue
        cur.append((kind, text))
    while cur and cur[-1][0] == 'b':
        cur.pop()
    if cur:
        pages.append(cur)
    return pages or [[('t', '')]]


def volume_label(i, n):
    if n == 1:
        return ''
    if n == 2:
        return ('上', '下')[i]
    if n == 3:
        return ('上', '中', '下')[i]
    return '第' + '一二三四五六七八'[i] + '巻'


def build_items(work):
    """Text pages and illustration pages in reading order: [{'kind': 'text', 'lines': [...]} | {'kind': 'image', 'image', 'caption'}]."""
    pages = paginate(work.get('body', ''))
    ill = []
    for k, x in enumerate(work.get('illustrations') or []):
        ill.append((max(0, min(int(x.get('after', 0)), len(pages))), k, x))
    ill.sort(key=lambda t: (t[0], t[1]))
    items, j = [], 0
    for n in range(len(pages) + 1):
        while j < len(ill) and ill[j][0] == n:
            items.append({'kind': 'image', 'image': ill[j][2]['image'], 'caption': ill[j][2].get('caption', '')})
            j += 1
        if n < len(pages):
            items.append({'kind': 'text', 'lines': pages[n]})
    return items


def split_volumes(work):
    """work = {'title','author','summary','category','body','illustrations'} -> list of volumes: {'label','items','index','of'}."""
    items = build_items(work)
    n = min(MAX_VOLUMES, max(1, -(-len(items) // ITEMS_PER_BOOK)))
    size = -(-len(items) // n)                                      # spread the pages evenly over the volumes
    chunks = [items[i:i + size] for i in range(0, len(items), size)][:MAX_VOLUMES] or [[]]
    n = len(chunks)
    return [{'label': volume_label(i, n), 'items': c, 'index': i + 1, 'of': n} for i, c in enumerate(chunks)]


def estimate_volumes(work):
    return len(split_volumes(work))


CSS = """
.story-t .pno{color:#a59388}
.story-title .st-cat{position:absolute;left:70px;top:130px;width:788px;font-size:calc(26px*var(--fs));letter-spacing:.2em;color:var(--muted);text-align:center}
.story-title .st-name{position:absolute;left:70px;top:230px;width:788px;text-align:center;font-weight:700;color:var(--text);line-height:1.35;overflow:hidden}
.story-title .st-vol{position:absolute;left:70px;top:520px;width:788px;text-align:center;font-size:calc(40px*var(--fs));color:var(--accent);letter-spacing:.3em}
.story-title .st-rule{position:absolute;left:304px;top:600px;width:320px;height:4px;background:var(--accent);border-radius:2px}
.story-title .st-author{position:absolute;left:70px;top:640px;width:788px;text-align:center;font-size:calc(38px*var(--fs));color:var(--text)}
.story-title .st-cover{position:absolute;left:214px;top:740px;width:500px;height:400px;object-fit:cover;border:4px solid var(--accent);border-radius:12px;background:#f0e6df}
.story-title .st-sum{position:absolute;left:90px;top:1170px;width:748px;height:240px;overflow:hidden;font-size:calc(26px*var(--fs));line-height:1.7;color:var(--muted);text-align:left}
.story-title.nocover .st-sum{top:760px;height:640px;font-size:calc(30px*var(--fs))}
.story-text .st-head{position:absolute;left:70px;top:72px;width:788px;font-size:calc(20px*var(--fs));letter-spacing:.2em;color:var(--muted);white-space:nowrap;overflow:hidden}
.story-text .st-body{position:absolute;left:68px;top:200px;width:792px;height:1170px;writing-mode:vertical-rl;text-orientation:mixed;font-feature-settings:"vert" 1,"palt" 0;font-size:29px;color:var(--text)}
.story-text .ln{white-space:pre;width:44px;height:1170px;line-height:44px;overflow:visible}
.story-text .ln.h{width:88px;font-size:36px;font-weight:700;line-height:88px;color:var(--accent);filter:brightness(.7)}
.story-text .ln.b{width:44px}
.story-text .rot{display:inline-block;width:1em;height:1em;line-height:1;text-align:center;transform:rotate(90deg)}
.story-text .st-colophon{position:absolute;left:70px;top:1384px;width:788px;text-align:center;font-size:calc(19px*var(--fs));line-height:1.45;color:var(--muted);letter-spacing:.08em}
"""
