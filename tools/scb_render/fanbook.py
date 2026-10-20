"""Fan-work (二次創作) books: long text -> pages -> volumes.  Pure Python (no browser), so the publisher (how many books / slots?)
and the renderer (what is on each page?) always agree.

Page geometry (928 x 1528 px page, text area 788 px wide): 28 px type -> 28 full-width characters per line, 26 lines per page.
A book has 12 pages: p.1 = title page (title / author / summary / volume), p.2..p.12 = text.  A work longer than one book is split into
volumes (上 / 中 / 下 ... or 1, 2, 3 ...), each volume is one book slot  story-NNN.
Lines are laid out here (kinsoku: no closing punctuation at the start of a line, no opening bracket at the end) and drawn one <div> per line,
so what is measured is exactly what is drawn.
"""
import re

LINE_UNITS = 28           # full-width characters per line
PAGE_LINES = 26           # lines per text page
TEXT_PAGES = 11           # p.2 .. p.12
PAGES_PER_BOOK = 12
MAX_VOLUMES = 8

NO_START = set('、。，．,.）」』】〕］｝〉》！？!?…‥ー～々ゝゞヽヾぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ・：；')
HANG = set('、。，．,.')                 # may hang over the right edge when the line is full
NO_END = set('（「『【〔［｛〈《')
HEADING = re.compile(r'^(第[一二三四五六七八九十百〇0-9０-９]+[章話節部巻]|プロローグ|エピローグ|序章|終章|幕間|あとがき)')


def width(ch):
    o = ord(ch)
    if ch == '　':
        return 1.0
    if o < 0x80 or 0xFF61 <= o <= 0xFF9F:      # ASCII / half-width kana
        return 0.5
    return 1.0


def normalize(text):
    t = text.replace('\r\n', '\n').replace('\r', '\n').replace(' ', ' ').replace('\t', ' ')
    t = re.sub(r'[ ]+\n', '\n', t)
    t = re.sub(r'(?<=[^\x00-\x7f]) +(?=[^\x00-\x7f])', '', t)      # stray spaces between Japanese characters
    return t.strip('\n')


def layout_paragraph(text, indent):
    """One paragraph -> list of line strings."""
    lines, cur, w = [], '', 0.0
    chars = list(('　' if indent else '') + text)
    i = 0
    while i < len(chars):
        ch = chars[i]
        cw = width(ch)
        if w + cw > LINE_UNITS + 1e-6:
            if ch in HANG and w <= LINE_UNITS + 1e-6:                       # hang 、。 over the edge
                cur += ch; i += 1
                lines.append(cur); cur, w = '', 0.0
                continue
            if ch in NO_START and cur:                                      # pull one character down with the closing mark
                last = cur[-1]; cur = cur[:-1]
                lines.append(cur); cur, w = last, width(last)
                continue
            if cur and cur[-1] in NO_END:                                   # never end a line with an opening bracket
                last = cur[-1]; cur = cur[:-1]
                lines.append(cur); cur, w = last, width(last)
                continue
            lines.append(cur); cur, w = '', 0.0
            continue
        cur += ch; w += cw; i += 1
    if cur or not lines:
        lines.append(cur)
    return lines


def to_lines(body):
    """Whole text -> list of (kind, text): kind 'h' heading line, 't' text line, 'b' blank."""
    out = []
    for raw in normalize(body).split('\n'):
        para = raw.strip(' ')
        if para == '':
            if out and out[-1][0] != 'b':
                out.append(('b', ''))
            continue
        if HEADING.match(para) and len(para) <= 40:
            if out and out[-1][0] != 'b':
                out.append(('b', ''))
            out.append(('h', para))
            continue
        indent = para[0] not in '「『（(【〔―—'
        for ln in layout_paragraph(para, indent):
            out.append(('t', ln))
    return out


def paginate(body):
    """Lines -> list of pages (each a list of (kind, text)); a heading never ends a page, no blank line starts or ends one."""
    lines = to_lines(body)
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
    return '第' + '一二三四五六七八' [i] + '巻'


def split_volumes(work):
    """work = {'title','author','summary','category','body'} -> list of volumes: {'label','pages':[text pages], 'index','of'}."""
    pages = paginate(work.get('body', ''))
    n = min(MAX_VOLUMES, max(1, -(-len(pages) // TEXT_PAGES)))
    size = -(-len(pages) // n)                                      # spread the pages evenly over the volumes
    chunks = [pages[i:i + size] for i in range(0, len(pages), size)][:MAX_VOLUMES] or [[]]
    n = len(chunks)
    return [{'label': volume_label(i, n), 'pages': c, 'index': i + 1, 'of': n} for i, c in enumerate(chunks)]


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
.story-text .st-body{position:absolute;left:70px;top:130px;width:788px;font-size:28px;line-height:47.6px;color:var(--text)}
.story-text .ln{white-space:pre;height:47.6px;overflow:visible}
.story-text .ln.h{font-size:36px;font-weight:700;height:95px;line-height:95px;color:var(--accent);filter:brightness(.7)}
.story-text .ln.b{height:47.6px}
"""
