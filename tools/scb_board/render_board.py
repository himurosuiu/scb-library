#!/usr/bin/env python3
"""5:2 relationship board renderer (v2: right-angle lines).

public people (48)  +  relations.json (formal sisters / blood only)  ->  one 4096x1638 image  ->  2 tiles (2048x1638).
Zones left to right: 1年 | 2年 | 3年 | 教職員. People that have a line are placed in the TOP row of their zone, and the
line leaves straight UP from the top of the portrait, runs sideways at its own private height in the channel above the
zones, and comes straight DOWN onto the top of the partner's portrait (right angles only). Every line has its own height
and its own x, so no two lines lie on top of each other; the order of heights is searched to avoid crossings.

    python -X utf8 render_board.py          # render into out/board/

Needs: Python, Pillow, Playwright + Chromium. Nothing is pushed.
Output: out/board/tile-1.jpg, tile-2.jpg (2048x1638), board-preview.jpg, board-full.png, layout.json
"""
import base64, itertools, json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FE = ROOT / 'WEBPage' / 'SCB_Library_Home_Prototype'
FONTS = ROOT / 'fonts-download' / 'NotoSansJP'
OUT = HERE / 'out' / 'board'

W, H = 4096, 1638
PAD, GAP = 40, 24
ZONES = [('1年', '1年生', '#f2a7a0', '#7a3f3a'), ('2年', '2年生', '#c04a58', '#ffffff'),
         ('3年', '3年生', '#8a6a3d', '#ffffff'), ('T', '教職員', '#4a4a50', '#ffffff')]
COLS, ROWS = 5, 3
ZONE_Y, ZONE_H = 410, 1200         # zone panels
FOOT_H = 66                        # zone label strip at the bottom of each panel
PORT_R = 86                        # portrait radius
CHAN_TOP, CHAN_STEP = 184, 24      # routing channel: first line height, spacing between lines


def darken(hexc, f):
    hexc = hexc.lstrip('#')
    r, g, b = (int(hexc[i:i + 2], 16) for i in (0, 2, 4))
    return '#%02x%02x%02x' % (int(r * f), int(g * f), int(b * f))


def zone_of(p):
    return 'T' if p['kind'] == 'teacher' else p['grade']


def b64(path, mime):
    return f'data:{mime};base64,' + base64.b64encode(Path(path).read_bytes()).decode()


def zone_geometry():
    zw = (W - 2 * PAD - 3 * GAP) / 4
    return zw, zw / COLS, (ZONE_H - FOOT_H - 30) / ROWS


def positions(slot):
    zw, cell_w, cell_h = zone_geometry()
    zi = {z[0]: i for i, z in enumerate(ZONES)}
    pos = {}
    for pid, (zid, c, r) in slot.items():
        x0 = PAD + zi[zid] * (zw + GAP)
        pos[pid] = (x0 + (c + 0.5) * cell_w, ZONE_Y + 24 + r * cell_h + PORT_R + 8)
    return pos


def layout(people, edges):
    """Linked people go to the TOP row of their zone so their line can leave straight upwards."""
    links = {p['id']: [] for p in people}
    for e in edges:
        links[e['from']].append(e['to'])
        links[e['to']].append(e['from'])
    slot = {}
    for z in ZONES:
        zid = z[0]
        ms = sorted([p for p in people if zone_of(p) == zid], key=lambda p: p['id'])
        linked = [p['id'] for p in ms if links[p['id']]]
        others = [p['id'] for p in ms if not links[p['id']]]
        if len(linked) > COLS:
            sys.exit(f'zone {zid}: {len(linked)} linked people do not fit in one row of {COLS}')
        for i, pid in enumerate(linked):
            slot[pid] = [zid, i, 0]
        rest = [(c, r) for r in range(ROWS) for c in range(COLS) if not (r == 0 and c < len(linked))]
        for pid, (c, r) in zip(others, rest):
            slot[pid] = [zid, c, r]
    # order the linked people of each zone by the average x of their partners (fewer crossings)
    for _ in range(4):
        pos = positions(slot)
        for z in ZONES:
            zid = z[0]
            ids = [pid for pid, v in slot.items() if v[0] == zid and v[2] == 0 and links[pid]]
            ids.sort(key=lambda i: (sum(pos[q][0] for q in links[i]) / len(links[i]), i))
            for c, pid in enumerate(ids):
                slot[pid][1] = c
    return slot


def _geom(edges, slot):
    """stub x, portrait-top y for every edge end, for the current slots."""
    pos = positions(slot)
    top = {pid: pos[pid][1] - PORT_R - 8 for pid in pos}
    use = {}
    for i, e in enumerate(edges):
        for end in ('from', 'to'):
            use.setdefault(e[end], []).append((i, end))
    stub = {}
    for pid, lst in use.items():
        cx = pos[pid][0]
        lst.sort(key=lambda t: pos[edges[t[0]]['to' if t[1] == 'from' else 'from']][0])
        n = len(lst)
        for k, (i, end) in enumerate(lst):
            stub[(i, end)] = cx + (k - (n - 1) / 2) * 40
    ex = [(stub[(i, 'from')], stub[(i, 'to')]) for i in range(len(edges))]
    ty = [(top[e['from']], top[e['to']]) for e in edges]
    return ex, ty


TRACK_MARGIN = 26     # minimum horizontal gap between two lines that share a height


def _score(edges, slot, track):
    """Lines may SHARE a height when their horizontal runs do not touch. Returns (score, crossings, conflicts)."""
    ex, ty = _geom(edges, slot)
    n = len(edges)
    y = [CHAN_TOP + t * CHAN_STEP for t in track]
    spans = [tuple(sorted(e)) for e in ex]
    conflicts = 0
    for i in range(n):
        for j in range(i + 1, n):
            if track[i] == track[j] and not (spans[i][1] + TRACK_MARGIN < spans[j][0] or spans[j][1] + TRACK_MARGIN < spans[i][0]):
                conflicts += 1
    c = 0
    for i in range(n):
        for j in range(n):
            if i == j:
                continue
            lo, hi = spans[j]
            for xi, tyi in zip(ex[i], ty[i]):
                if lo - 6 < xi < hi + 6 and y[i] <= y[j] <= tyi:
                    c += 1
    used = len(set(track))
    length = sum(abs(ex[i][0] - ex[i][1]) for i in range(n)) * 0.01 + sum((y[i] - CHAN_TOP) for i in range(n)) * 0.5
    return conflicts * 10 ** 7 + c * 10 ** 5 + used * 4000 + length, c, conflicts, used


def optimize(edges, slot):
    """Random-restart hill climbing over (order of the top-row people in each zone, height track of every line)."""
    import random
    rnd = random.Random(11)
    n = len(edges)
    tmax = n
    tops = {z[0]: sorted([pid for pid, v in slot.items() if v[0] == z[0] and v[2] == 0 and any(pid in (e['from'], e['to']) for e in edges)],
                         key=lambda q: slot[q][1]) for z in ZONES}
    best = None
    for restart in range(60):
        for z in tops:
            if restart:
                rnd.shuffle(tops[z])
            for c, pid in enumerate(tops[z]):
                slot[pid][1] = c
        track = [rnd.randrange(0, min(tmax, 5)) for _ in range(n)]
        cur = _score(edges, slot, track)
        for _ in range(2500):
            if rnd.random() < 0.6:
                i = rnd.randrange(n)
                old = track[i]
                track[i] = rnd.randrange(0, min(tmax, 6))
                sc = _score(edges, slot, track)
                if sc[0] <= cur[0]:
                    cur = sc
                else:
                    track[i] = old
            else:
                z = rnd.choice([z for z in tops if len(tops[z]) > 1])
                i, j = rnd.sample(range(len(tops[z])), 2)
                a_, b_ = tops[z][i], tops[z][j]
                slot[a_][1], slot[b_][1] = slot[b_][1], slot[a_][1]
                sc = _score(edges, slot, track)
                if sc[0] <= cur[0]:
                    cur = sc
                    tops[z][i], tops[z][j] = b_, a_
                else:
                    slot[a_][1], slot[b_][1] = slot[b_][1], slot[a_][1]
        if cur[2] == 0 and (best is None or cur[0] < best[0][0]):
            best = (cur, list(track), {pid: slot[pid][1] for z in tops for pid in tops[z]})
    cur, track, cols = best
    for pid, c in cols.items():
        slot[pid][1] = c
    # compact: renumber the used tracks 0..k-1 keeping their order
    used = sorted(set(track))
    track = [used.index(t) for t in track]
    return track, cur[1]


def retrack(edges, slot):
    import random
    rnd = random.Random(5)
    n = len(edges)
    best = None
    for _ in range(200):
        track = [rnd.randrange(0, 6) for _ in range(n)]
        cur = _score(edges, slot, track)
        for _ in range(1500):
            i = rnd.randrange(n)
            old = track[i]
            track[i] = rnd.randrange(0, 6)
            sc = _score(edges, slot, track)
            if sc[0] <= cur[0]:
                cur = sc
            else:
                track[i] = old
        if best is None or cur[0] < best[0][0]:
            best = (cur, list(track))
    used = sorted(set(best[1]))
    return [used.index(t) for t in best[1]]


def route(edges, slot, track):
    """Right-angle routes. Returns (paths, number of line crossings, number of heights used)."""
    ex, ty = _geom(edges, slot)
    sc = _score(edges, slot, track)
    y = [CHAN_TOP + t * CHAN_STEP for t in track]
    paths = []
    for i, e in enumerate(edges):
        xa, xb = ex[i]
        paths.append({'edge': e, 'pts': [(xa, ty[i][0]), (xa, y[i]), (xb, y[i]), (xb, ty[i][1])], 'y': y[i]})
    return paths, sc[1], sc[3]


ORDER = [None]


def build_html(people, edges, slot):
    zw, cell_w, cell_h = zone_geometry()
    pos = positions(slot)
    paths, ncross, nlev = route(edges, slot, ORDER[0])
    zi = {z[0]: i for i, z in enumerate(ZONES)}
    reg = b64(FONTS / 'NotoSansJP-Regular.ttf', 'font/ttf')
    bold = b64(FONTS / 'NotoSansJP-Bold.ttf', 'font/ttf')
    css = """
@font-face{font-family:J;font-weight:400;src:url(%(reg)s)}
@font-face{font-family:J;font-weight:700;src:url(%(bold)s)}
*{margin:0;padding:0;box-sizing:border-box}
body{width:%(W)dpx;height:%(H)dpx;background:#fbf1f0;font-family:J,sans-serif;position:relative;overflow:hidden;color:#3a2a2a}
.title{position:absolute;left:%(PAD)dpx;top:26px;font-size:62px;font-weight:700;letter-spacing:.06em;color:#7a4a4f}
.sub{position:absolute;left:%(PAD4)dpx;top:102px;font-size:30px;color:#9a7a7a;letter-spacing:.12em}
.legend{position:absolute;right:%(PAD)dpx;top:40px;font-size:32px;color:#6a4a4f;display:flex;gap:50px;align-items:center}
.zone{position:absolute;border-radius:22px;background:#fffafa;border:3px solid #ecd2d2;overflow:hidden}
.zf{position:absolute;left:0;right:0;bottom:0;height:%(FOOT)dpx;display:flex;align-items:center;padding:0 28px;font-size:38px;font-weight:700;letter-spacing:.08em}
.zf small{font-size:28px;font-weight:400;margin-left:20px}
.node{position:absolute;width:%(NW)dpx;text-align:center}
.ph{width:%(D)dpx;height:%(D)dpx;border-radius:50%%;margin:0 auto;border:8px solid #ccc;background:#f3e6e6;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:60px;color:#c9a7aa;font-weight:700}
.ph img{width:100%%;height:100%%;object-fit:cover;object-position:50%% 20%%}
.nm{margin-top:12px;font-weight:700;line-height:1.15}
.mt{margin-top:4px;font-size:26px;color:#8a6a6a;line-height:1.2}
svg{position:absolute;left:0;top:0}
""" % dict(reg=reg, bold=bold, W=W, H=H, PAD=PAD, PAD4=PAD + 4, FOOT=FOOT_H, NW=cell_w - 6, D=PORT_R * 2)
    P = ['<!doctype html><meta charset="utf-8"><style>' + css + '</style>']
    P.append('<div class="title">SALON CHERRY BLOSSOM</div><div class="sub">聖桜花女学園　人物相関図　—　姉妹・血縁</div>')
    P.append('<div class="legend"><span><svg width="130" height="34" style="position:static"><line x1="4" y1="17" x2="108" y2="17" stroke="#d4537e" stroke-width="8"/>'
             '<path d="M96,6 L124,17 L96,28 z" fill="#d4537e"/></svg>　姉妹（実線・お姉様のイメージカラー）</span>'
             '<span><svg width="130" height="34" style="position:static"><line x1="4" y1="17" x2="122" y2="17" stroke="#2f7f7a" stroke-width="8" stroke-dasharray="20 10"/></svg>　血縁（破線・年長者のイメージカラー）</span></div>')
    for z in ZONES:
        zid, label, color, fg = z
        n = sum(1 for p in people if zone_of(p) == zid)
        x0 = PAD + zi[zid] * (zw + GAP)
        P.append(f'<div class="zone" style="left:{x0}px;top:{ZONE_Y}px;width:{zw}px;height:{ZONE_H}px">'
                 f'<div class="zf" style="background:{color};color:{fg}">{label}<small>{n}名</small></div></div>')
    sv = [f'<svg width="{W}" height="{H}" viewBox="0 0 {W} {H}">']
    colr = {p['id']: (p.get('color') or '#d9c3cf') for p in people}
    for pth in paths:
        e, pts = pth['edge'], pth['pts']
        col = colr[e['from']]               # the elder person's image colour (older sister / elder relative)
        halo = darken(col, 0.55)
        if e['type'] == 'sister':
            x, y = pts[-1]
            body = pts[:-1] + [(x, y - 26)]
            d = 'M' + ' L'.join(f'{px:.0f},{py:.0f}' for px, py in body)
            sv.append(f'<path d="{d}" fill="none" stroke="{halo}" stroke-width="10" stroke-linejoin="round" stroke-linecap="round"/>')
            sv.append(f'<path d="{d}" fill="none" stroke="{col}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>')
            tri = f'M{x-18:.0f},{y-32:.0f} L{x+18:.0f},{y-32:.0f} L{x:.0f},{y-3:.0f} z'
            sv.append(f'<path d="{tri}" fill="{col}" stroke="{halo}" stroke-width="3" stroke-linejoin="round"/>')
        else:
            d = 'M' + ' L'.join(f'{px:.0f},{py:.0f}' for px, py in pts)
            sv.append(f'<path d="{d}" fill="none" stroke="{halo}" stroke-width="10" stroke-dasharray="24 14" stroke-linejoin="round"/>')
            sv.append(f'<path d="{d}" fill="none" stroke="{col}" stroke-width="6" stroke-dasharray="24 14" stroke-linejoin="round"/>')
    sv.append('</svg>')
    P.append(''.join(sv))
    for p in people:
        x, y = pos[p['id']]
        pf = FE / p['portrait'] if p.get('portrait') else None
        img = f'<img src="{b64(pf, "image/jpeg")}">' if pf and pf.exists() else '桜'
        meta = '教員' if p['kind'] == 'teacher' else (p.get('club') or '')
        col = p.get('color') or '#d9c3cf'
        nm_ = p['name']
        width_em = len(nm_.replace(' ', '')) + 0.35 * nm_.count(' ')
        fit = (cell_w - 14) / width_em
        if fit >= 27:
            size, wrap = min(38, int(fit)), 'white-space:nowrap;'
        else:
            size, wrap = 28, ''                      # long names: two lines
        P.append(f'<div class="node" style="left:{x-(cell_w-6)/2:.0f}px;top:{y-PORT_R:.0f}px"><div class="ph" style="border-color:{col}">{img}</div>'
                 f'<div class="nm" style="font-size:{size}px;{wrap}">{p["name"]}</div><div class="mt">{meta}</div></div>')
    print('line crossings:', ncross, '| heights used:', nlev)
    return ''.join(P)


def main():
    global FE, FONTS, OUT
    import argparse, hashlib
    ap = argparse.ArgumentParser(description='5:2 relationship board')
    ap.add_argument('--fe', type=Path, default=FE, help='site folder with data/ and assets/')
    ap.add_argument('--fonts', type=Path, default=FONTS, help='folder with NotoSansJP-Regular.ttf / -Bold.ttf')
    ap.add_argument('--out-dir', type=Path, default=OUT, help='where the tiles and the preview are written')
    ap.add_argument('--if-changed', type=Path, help='state file: skip rendering when the inputs did not change since the last run')
    ap.add_argument('--force', action='store_true', help='with --if-changed: render anyway')
    a = ap.parse_args()
    FE, FONTS, OUT = a.fe, a.fonts, a.out_dir
    if a.if_changed:
        h = hashlib.sha256()
        for f in (FE / 'data' / 'public-people-all.json', FE / 'data' / 'relations.json', Path(__file__)):
            if f.exists():
                h.update(f.read_bytes())
        for f in (FONTS / 'NotoSansJP-Regular.ttf', FONTS / 'NotoSansJP-Bold.ttf'):
            h.update(str(f.stat().st_size).encode())
        for p_ in (json.loads((FE / 'data' / 'public-people-all.json').read_text(encoding='utf-8')).get('people', [])):
            for k in ('portrait', 'image'):
                f = FE / (p_.get(k) or '')
                if p_.get(k) and f.is_file():
                    h.update(f.read_bytes())
        digest = h.hexdigest()
        if not a.force and a.if_changed.exists() and a.if_changed.read_text(encoding='utf-8').strip() == digest:
            print('board: inputs unchanged, nothing to render')
            return
    people = json.loads((FE / 'data' / 'public-people-all.json').read_text(encoding='utf-8'))
    people = people if isinstance(people, list) else people['people']
    # Approved relations published from the database (data/relations.json) win; relations.json next to this
    # script is only the fallback (drafts from the character sheet). The board draws formal sisters and blood only.
    rel_pub = FE / 'data' / 'relations.json'
    pub_doc = json.loads(rel_pub.read_text(encoding='utf-8')) if rel_pub.exists() else None
    pub = (pub_doc or {}).get('relations', [])
    if pub_doc is not None:                       # once relations are published from the database, that list is the truth (even if empty)
        edges = [{'type': r['kind'], 'from': r['a'], 'to': r['b']} for r in pub if r['kind'] in ('sister', 'blood')]
        print(f'relations: {len(edges)} from data/relations.json (approved, published)')
    else:
        edges = json.loads((HERE / 'relations.json').read_text(encoding='utf-8'))['edges']
        print(f'relations: {len(edges)} from tools/scb_board/relations.json (fallback)')
    ids = {p['id'] for p in people}
    for e in edges:
        if e['from'] not in ids or e['to'] not in ids:
            sys.exit(f'unknown person in edge: {e}')
    slot = layout(people, edges)
    ORDER[0], _ = optimize(edges, slot) if edges else ([], 0)
    global ZONE_Y, ZONE_H
    ZONE_Y = CHAN_TOP + ((max(ORDER[0]) + 1) if ORDER[0] else 1) * CHAN_STEP + 34
    ZONE_H = H - ZONE_Y - 28
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'layout.json').write_text(json.dumps(slot, ensure_ascii=False, indent=1), encoding='utf-8')
    html = build_html(people, edges, slot)
    (OUT / 'board.html').write_text(html, encoding='utf-8')
    from playwright.sync_api import sync_playwright
    from PIL import Image
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = br.new_page(viewport={'width': W, 'height': H}, device_scale_factor=1)
        pg.set_content(html)
        pg.wait_for_timeout(1500)
        pg.screenshot(path=str(OUT / 'board-full.png'), clip={'x': 0, 'y': 0, 'width': W, 'height': H})
        br.close()
    im = Image.open(OUT / 'board-full.png').convert('RGB')
    assert im.size == (W, H), im.size
    for i in range(2):
        im.crop((i * 2048, 0, (i + 1) * 2048, H)).save(OUT / f'tile-{i + 1}.jpg', quality=88, optimize=True)
    im.resize((W // 3, H // 3)).save(OUT / 'board-preview.jpg', quality=85)
    print('rendered', W, 'x', H, '-> tiles KB:', [(OUT / f'tile-{i}.jpg').stat().st_size // 1024 for i in (1, 2)])
    if a.if_changed:
        a.if_changed.parent.mkdir(parents=True, exist_ok=True)
        a.if_changed.write_text(digest + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
