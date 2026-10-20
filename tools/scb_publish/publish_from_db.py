#!/usr/bin/env python3
"""SCB publish pipeline: Supabase `character_records` -> public JSON for the website and the VRChat world.

Reads ONLY public data through the public (publishable) key, validates it, and produces:
  1. data/public-people-all.json         (website: people list/detail/graph)
  2. data/public-demo.json  (characters)  (website: home page featured cards; works are kept as is)
  3. books/index.json                    (VRChat world: cover texts per book slot)

Default mode is a DRY RUN: it prints a diff and writes nothing.
  --apply        write the files (existing files are backed up first)
It never runs git and never publishes anything by itself.

Standard library only. Run:  python publish_from_db.py            (dry run)
                              python publish_from_db.py --apply
"""
import argparse, datetime, json, re, shutil, sys, urllib.request, urllib.error
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'scb_render'))
import fanbook                                          # long text -> pages -> volumes (shared with the renderer)
ROOT = HERE.parents[1]                                   # .../SCB
DEFAULT_FE = ROOT / 'WEBPage' / 'SCB_Library_Home_Prototype'
DEFAULT_REPO = ROOT / 'scb-library-repo'
UNITY_EXTRA = Path(r'D:\VRCHAT相關保存\project file\SCB Library\SCB Library\Assets\Enchanted_tim\memoria book\animation\scb\Fonts\extra-chars.txt')

PERSON_KEYS = ['id', 'name', 'nameKana', 'romaji', 'kind', 'grade', 'club', 'color', 'status', 'group',
               'image', 'portrait', 'fullBody', 'gallery']
# profile fields editable by members; they go to data/character-content.json (the character page), not to public-people-all.json
TEXT_LIMITS = {'species': 60, 'height': 50, 'likes': 250, 'dislikes': 250, 'firstPerson': 80, 'secondPerson': 80, 'about': 2000}
EXTRA_KEYS = list(TEXT_LIMITS) + ['outfits', 'bookPages']
IMG_EXT_RE = re.compile(r'\.(jpe?g|png|webp)$', re.I)
UPLOAD_RE = re.compile(r'^assets/uploads/([a-z0-9][a-z0-9-]{0,79})/([0-9a-f-]{36}\.(?:jpg|png|webp))$')
ID_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,79}$')
COLOR_RE = re.compile(r'^#[0-9a-fA-F]{6}$')
PATH_RE = re.compile(r'^assets/[A-Za-z0-9_./-]+$')
SLOT_RE = re.compile(r'^(person|story)-\d{3}$')
TIER = {'3年': 'y3', '2年': 'y2', '1年': 'y1'}
DEFAULT_COLOR = '#d9c3cf'


class Report:
    def __init__(self):
        self.errors, self.warnings = [], []

    def error(self, msg): self.errors.append(msg)
    def warn(self, msg): self.warnings.append(msg)


def load_config(fe: Path):
    """The Supabase URL and PUBLISHABLE key live in studio/config.js (public identifiers)."""
    text = (fe / 'studio' / 'config.js').read_text(encoding='utf-8')
    url = re.search(r"url:\s*'([^']+)'", text)
    key = re.search(r"anonKey:\s*'([^']+)'", text)
    if not url or not key:
        sys.exit('studio/config.js has no Supabase url/anonKey')
    key = key.group(1)
    if key.startswith('sb_secret_') or key.count('.') == 2 and 'service_role' in _jwt_role(key):
        sys.exit('REFUSING: config.js contains a secret/service_role key. Use the publishable key only.')
    return url.group(1).rstrip('/'), key


def _jwt_role(token):
    import base64
    try:
        payload = token.split('.')[1]
        payload += '=' * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload)).get('role', '')
    except Exception:
        return ''


def fetch_records(url, key):
    req = urllib.request.Request(f'{url}/rest/v1/character_records?select=id,data,revision&order=id&limit=1000',
                                 headers={'apikey': key, 'Authorization': f'Bearer {key}'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        sys.exit(f'Supabase request failed: HTTP {e.code} {e.read()[:200]!r}')
    except urllib.error.URLError as e:
        sys.exit(f'Cannot reach Supabase: {e.reason}')


def valid_path(v):
    return v is None or (isinstance(v, str) and bool(PATH_RE.match(v)) and '..' not in v)


def clean_person(rec, rep: Report):
    """Whitelist + validate one DB record. Returns a clean dict or None (and logs errors)."""
    pid, d = rec['id'], rec.get('data')
    if not ID_RE.match(pid):
        rep.error(f'{pid}: invalid id'); return None
    if not isinstance(d, dict):
        rep.error(f'{pid}: data is not an object'); return None
    if d.get('id') != pid:
        rep.error(f'{pid}: data.id ({d.get("id")!r}) does not match the record id'); return None
    extra = sorted(set(d) - set(PERSON_KEYS) - set(EXTRA_KEYS))
    if extra:
        rep.warn(f'{pid}: dropped unknown fields {extra}')
    out = {k: d.get(k) for k in PERSON_KEYS}
    limits = {'name': 100, 'nameKana': 130, 'romaji': 130, 'grade': 30, 'club': 130, 'group': 150}
    ok = True
    for k, n in limits.items():
        v = out[k] if out[k] is not None else ''
        if not isinstance(v, str) or len(v) > n:
            rep.error(f'{pid}: {k} must be a string up to {n} chars'); ok = False
        out[k] = v
    if not out['name'].strip():
        rep.error(f'{pid}: name is empty'); ok = False
    if out['kind'] not in ('student', 'teacher'):
        rep.error(f'{pid}: kind must be student/teacher, got {out["kind"]!r}'); ok = False
    if out['status'] not in ('active', 'graduated'):
        rep.error(f'{pid}: status must be active/graduated, got {out["status"]!r}'); ok = False
    if out['color'] is not None and not (isinstance(out['color'], str) and COLOR_RE.match(out['color'])):
        rep.error(f'{pid}: color must be #RRGGBB or null, got {out["color"]!r}'); ok = False
    for k in ('image', 'portrait', 'fullBody'):
        if not valid_path(out[k]):
            rep.error(f'{pid}: {k} path is not allowed: {out[k]!r}'); ok = False
    g = out['gallery'] if out['gallery'] is not None else []
    if not isinstance(g, list) or len(g) > 10 or not all(isinstance(x, str) and valid_path(x) for x in g):
        rep.error(f'{pid}: gallery must be up to 10 valid asset paths'); ok = False
    out['gallery'] = g
    # keep image and portrait consistent (the site reads portrait || image)
    if out['portrait'] and not out['image']:
        out['image'] = out['portrait']
    return out if ok else None


def clean_content(rec, rep: Report):
    """Member-editable profile fields -> the entry for data/character-content.json (only non-empty values). None on error."""
    pid, d = rec['id'], rec['data']
    out, ok = {}, True
    for k, n in TEXT_LIMITS.items():
        v = d.get(k, '')
        if v is None:
            v = ''
        if not isinstance(v, str) or len(v) > n or re.search(r'[<>\x00-\x08\x0b-\x1f\x7f]', v):
            rep.error(f'{pid}: {k} must be plain text up to {n} chars'); ok = False; continue
        if v.strip():
            out[k] = v.strip()
    outfits = d.get('outfits') or []
    if not isinstance(outfits, list) or len(outfits) > 8:
        rep.error(f'{pid}: outfits must be a list of at most 8'); return None
    clean = []
    for i, o in enumerate(outfits, 1):
        imgs = o.get('images') if isinstance(o, dict) else None
        label = o.get('label') if isinstance(o, dict) else None
        if not (isinstance(label, str) and 1 <= len(label.strip()) <= 40 and not re.search(r'[<>\x00-\x1f\x7f]', label)
                and isinstance(imgs, list) and len(imgs) <= 10
                and all(isinstance(x, str) and PATH_RE.match(x) and '..' not in x and '//' not in x and IMG_EXT_RE.search(x) for x in imgs)):
            rep.error(f'{pid}: outfit #{i} is invalid (label 1..40 chars, up to 10 assets/ image paths)'); ok = False; continue
        clean.append({'id': f'outfit-{i}', 'label': label.strip(), 'images': imgs})
    if clean:
        out['outfits'] = clean
    pages = d.get('bookPages') or []
    if not isinstance(pages, list) or len(pages) > 8:
        rep.error(f'{pid}: bookPages must be a list of at most 8'); return None
    book = []
    for i, bp in enumerate(pages, 1):
        img = bp.get('image') if isinstance(bp, dict) else None
        cap = bp.get('caption', '') if isinstance(bp, dict) else None
        if not (isinstance(img, str) and PATH_RE.match(img) and '..' not in img and '//' not in img and IMG_EXT_RE.search(img)
                and isinstance(cap, str) and len(cap) <= 60 and not re.search(r'[<>\x00-\x1f\x7f]', cap)):
            rep.error(f'{pid}: book page #{i} is invalid (assets/ image path, caption up to 60 chars)'); ok = False; continue
        book.append({'image': img, 'caption': cap.strip()})
    if book:
        out['bookPages'] = book
    return out if ok else None


# kind -> (label on A's page next to B, label on B's page next to A). sister / blood: A = the elder.
# Directed kinds (second block): A = the one who feels / acts, B = the one it is aimed at.
REL_LABELS = {
    'sister': ('妹', 'お姉様'), 'blood': ('血縁', '血縁'), 'friend': ('友人', '友人'), 'acquaintance': ('知人', '知人'),
    'clan': ('同族', '同族'), 'rival': ('ライバル', 'ライバル'), 'kusareen': ('腐れ縁', '腐れ縁'), 'gizagiza': ('ギザギザ', 'ギザギザ'),
    'other': ('関係者', '関係者'),
    'one_sided': ('片想いの相手', '片想いしている人'), 'tsuntsun': ('ツンツンする相手', 'ツンツンしてくる人'),
    'honmei': ('本命の相手', '本命にしている人'), 'oshi': ('推し', '推してくれている人'),
    'amayakashi': ('甘やかす相手', '甘やかしてくれる人'), 'amae': ('甘える相手', '甘えてくる人'),
    'izon': ('依存先', '依存してくる人'), 'kininaru': ('気になる相手', '気にしてくれている人'),
}
REL_KINDS = tuple(REL_LABELS)
REL_DIRECTED = ('one_sided', 'tsuntsun', 'honmei', 'oshi', 'amayakashi', 'amae', 'izon', 'kininaru')


def fetch_relations(url, key):
    req = urllib.request.Request(f'{url}/rest/v1/character_relations_public?select=a_id,b_id,kind,label,note&limit=2000',
                                 headers={'apikey': key, 'Authorization': f'Bearer {key}'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        body = e.read()[:300]
        if e.code == 404 and b'PGRST205' in body:
            print('NOTE: the relations view does not exist yet (07_relations.sql not applied); relations are left as they are.')
            return None
        sys.exit(f'Supabase relations request failed: HTTP {e.code} {body!r}')
    except urllib.error.URLError as e:
        sys.exit(f'Cannot reach Supabase: {e.reason}')


def fetch_settings(url, key):
    """Home page settings (featured people, works, texts) from the public view. {} = none stored / not installed yet."""
    req = urllib.request.Request(f'{url}/rest/v1/site_settings_public?select=key,value&limit=20',
                                 headers={'apikey': key, 'Authorization': f'Bearer {key}'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return {x['key']: x['value'] for x in json.loads(r.read().decode('utf-8'))}
    except urllib.error.HTTPError as e:
        body = e.read()[:300]
        if e.code == 404 and b'PGRST205' in body:
            print('NOTE: the site_settings view does not exist yet (13_site_settings.sql not applied); the home page data is left as it is.')
            return {}
        sys.exit(f'Supabase settings request failed: HTTP {e.code} {body!r}')
    except urllib.error.URLError as e:
        sys.exit(f'Cannot reach Supabase: {e.reason}')


def fetch_person_themes(url, key):
    """Per-person book looks {person_id: theme} from the public view. None = not installed yet (17_person_theme.sql)."""
    req = urllib.request.Request(f'{url}/rest/v1/person_themes_public?select=person_id,value&limit=1000',
                                 headers={'apikey': key, 'Authorization': f'Bearer {key}'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return {x['person_id']: x['value'] for x in json.loads(r.read().decode('utf-8'))}
    except urllib.error.HTTPError as e:
        body = e.read()[:300]
        if e.code == 404 and b'PGRST205' in body:
            print('NOTE: the person_themes view does not exist yet (17_person_theme.sql not applied); person-themes.json is left as it is.')
            return None
        sys.exit(f'Supabase person themes request failed: HTTP {e.code} {body!r}')
    except urllib.error.URLError as e:
        sys.exit(f'Cannot reach Supabase: {e.reason}')


STORY_CAPACITY = 26          # story-001 .. story-026 are the books on the shelf prepared in the world
STORY_TIER = 'y2'            # cover / back / page-edge art of the fan books (one of y1 y2 y3 teacher)


def fetch_fan_works(url, key):
    """Approved fan works [{id, data:{title,author,category,summary,cover,body}, approved_at}] from the public view. None = not installed yet (21_fan_works.sql)."""
    req = urllib.request.Request(f'{url}/rest/v1/fan_works_public?select=id,data,approved_at&order=approved_at,id&limit=200',
                                 headers={'apikey': key, 'Authorization': f'Bearer {key}'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        body = e.read()[:300]
        if e.code == 404 and b'PGRST205' in body:
            print('NOTE: the fan_works view does not exist yet (21_fan_works.sql not applied); fanworks.json is left as it is.')
            return None
        sys.exit(f'Supabase fan works request failed: HTTP {e.code} {body!r}')
    except urllib.error.URLError as e:
        sys.exit(f'Cannot reach Supabase: {e.reason}')


def assign_story_slots(works, old_works, rep):
    """Stable slot numbers: a work keeps its slots while its volume count is unchanged; new works take the lowest free numbers."""
    old = {w['id']: list(w.get('slots', [])) for w in old_works}
    used, result = set(), {}
    for w in works:                                      # first pass: keep what still fits
        keep = old.get(w['id'], [])[:w['volumes']]
        result[w['id']] = keep
        used.update(keep)
    free = [f'story-{n:03d}' for n in range(1, STORY_CAPACITY + 1) if f'story-{n:03d}' not in used]
    for w in works:
        mine = result[w['id']]
        while len(mine) < w['volumes']:
            if not free:
                rep.warn(f'fan work {w["title"]!r}: no free story slot left (capacity {STORY_CAPACITY}); the remaining volumes are not published')
                break
            mine.append(free.pop(0))
    return result


def fetch_slots(url, key):
    """Book slots from the database (public view). None = the view does not exist yet (11_book_slots.sql not applied)."""
    req = urllib.request.Request(f'{url}/rest/v1/book_slots_public?select=slot,person_id,spreads,cover_name,spine_text&order=slot&limit=1000',
                                 headers={'apikey': key, 'Authorization': f'Bearer {key}'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            rows = json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        body = e.read()[:300]
        if e.code == 404 and b'PGRST205' in body:
            print('NOTE: the book_slots view does not exist yet (11_book_slots.sql not applied); slots.json is used.')
            return None
        sys.exit(f'Supabase slots request failed: HTTP {e.code} {body!r}')
    except urllib.error.URLError as e:
        sys.exit(f'Cannot reach Supabase: {e.reason}')
    out = []
    for r in rows:
        s_ = {'slot': r['slot'], 'person': r['person_id'], 'spreads': r['spreads']}
        if r.get('cover_name'):
            s_['coverName'] = r['cover_name']
        if r.get('spine_text'):
            s_['spineText'] = r['spine_text']
        out.append(s_)
    return out


def clean_relations(rows, ids, rep: Report):
    """Approved relations from the public view -> sorted clean list. sister/blood: a = the elder."""
    out, seen = [], set()
    for r in rows:
        a, b, k = r.get('a_id'), r.get('b_id'), r.get('kind')
        label, note = (r.get('label') or '').strip(), (r.get('note') or '').strip()
        if a not in ids or b not in ids or a == b or k not in REL_KINDS or len(label) > 40 or len(note) > 200                 or re.search(r'[<>\x00-\x08\x0b-\x1f\x7f]', label + note):
            rep.error(f'relation {a!r} - {b!r} ({k}) is invalid or points to an unknown person'); continue
        key = (a, b, k) if k in REL_DIRECTED else (min(a, b), max(a, b), k)
        if key in seen:
            rep.warn(f'relation {a} - {b} ({k}) appears twice; second one ignored'); continue
        seen.add(key)
        out.append({'a': a, 'b': b, 'kind': k, 'label': label, 'note': note,
                    'forA': label or REL_LABELS[k][0], 'forB': label or REL_LABELS[k][1]})
    return sorted(out, key=lambda x: (x['kind'], x['a'], x['b']))


def bonds_for(pid, relations):
    """character page entries ('絆') for one person."""
    res = []
    for r in relations:
        if pid not in (r['a'], r['b']):
            continue
        other = r['b'] if pid == r['a'] else r['a']
        label = r['forA'] if pid == r['a'] else r['forB']
        res.append({'characterId': other, 'kind': r['kind'], 'label': label, 'approved': True})
    return sorted(res, key=lambda x: (x['kind'], x['characterId']))


def image_paths(person, content):
    paths = [person['portrait'], person['fullBody'], *person['gallery']]
    for o in (content or {}).get('outfits', []):
        paths += o['images']
    paths += [b['image'] for b in (content or {}).get('bookPages', [])]
    return [p for p in paths if p]


def fetch_upload(url, rel, dest: Path):
    """Copy an approved member upload from the public Storage bucket into the site's assets/ folder."""
    req = urllib.request.Request(f'{url}/storage/v1/object/public/scb-uploads/{rel}')
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    if len(data) > 5 * 1024 * 1024 or not (data[:3] == b'\xff\xd8\xff' or data[:8] == b'\x89PNG\r\n\x1a\n' or (data[:4] == b'RIFF' and data[8:12] == b'WEBP')):
        raise ValueError('not a jpeg/png/webp image or larger than 5 MB')
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)


def diff_content(old, new):
    lines = []
    short = lambda v: (repr(v) if not isinstance(v, str) or len(v) < 40 else repr(v[:37] + '...')) if not isinstance(v, list) else f'{len(v)} item(s)'
    for pid in sorted(set(old) | set(new)):
        for k in EXTRA_KEYS + ['relationships']:
            ov, nv = (old.get(pid) or {}).get(k), (new.get(pid) or {}).get(k)
            if ov != nv:
                lines.append(f'  ~ {pid}.{k}: {short(ov)} -> {short(nv)}')
    return lines


def order_people(people, existing_ids):
    pos = {pid: i for i, pid in enumerate(existing_ids)}
    return sorted(people, key=lambda p: (pos.get(p['id'], 10 ** 6), p['id']))


def club_text(club):
    parts = [c for c in re.split(r'[/・]', club) if c]
    return '・'.join(parts)


KANJI_DIGITS = str.maketrans('0123456789', '〇一二三四五六七八九')


def kanji_digits(text):
    """Cover / spine use kanji numerals (二年生), never arabic ones."""
    return text.translate(KANJI_DIGITS)


TEACHER_TITLES = ('学園長', '神父', 'シスター')


def spine_text(p, cover_name, grade_text):
    """Title printed on the spine: students 'N年生　name', teachers 'シスター　name' / '神父　name' / '学園長　name'."""
    if p['kind'] == 'teacher':
        for src in (p['name'], cover_name):
            for title in TEACHER_TITLES:
                if title in src:
                    base = src.replace(title, '').replace('・', '').strip()
                    return f'{title}　{base}' if base else title
        return cover_name
    return f'{grade_text}　{p["name"]}' if grade_text else p['name']


def build_manifest(people_by_id, slots, rep: Report, failed=()):
    books = []
    seen = set()
    for s in slots:
        slot = s.get('slot', '')
        if not SLOT_RE.match(slot):
            rep.error(f'slots.json: invalid slot {slot!r}'); continue
        if slot in seen:
            rep.error(f'slots.json: duplicate slot {slot}'); continue
        seen.add(slot)
        p = people_by_id.get(s.get('person'))
        if p is None:
            if s.get('person') not in failed:
                rep.error(f'{slot}: person {s.get("person")!r} is not in the database')
            continue
        if s.get('type', 'person') != 'person':
            rep.warn(f'{slot}: only person books are generated for now; skipped'); continue
        if p['kind'] == 'teacher':
            tier = 'teacher'
            top = ''
            name = s.get('coverName') or p['name']
            if not s.get('coverName') and not (name.endswith('神父') or name.startswith('シスター') or 'シスター' in name):
                rep.warn(f'{slot}: teacher cover name {name!r} has no 神父/シスター; set "coverName" in slots.json')
        else:
            tier = TIER.get(p['grade'])
            if tier is None:
                rep.warn(f'{slot}: unknown grade {p["grade"]!r}; using y1'); tier = 'y1'
            grade = kanji_digits(p['grade'].replace('年', '年生')) if p['grade'] else ''
            c = club_text(p['club'])
            top = (f'{grade}　{c}' if c else grade)
            name = s.get('coverName') or p['name']
        color = p['color'] or DEFAULT_COLOR
        spreads = int(s.get('spreads', 6))
        if not 1 <= spreads <= 12:
            rep.error(f'{slot}: spreads must be 1..12'); continue
        grade_txt = kanji_digits(p['grade'].replace('年', '年生')) if p.get('grade') else ''
        books.append({'slot': slot, 'type': 'person', 'tier': tier, 'color': color,
                      'coverTop': top, 'coverName': name, 'spineText': s.get('spineText') or spine_text(p, name, grade_txt), 'spreads': spreads})
    return books


def font_gaps(strings, rep: Report):
    """Warn about characters the Unity static cover font might not contain (read-only check)."""
    have = set()
    extra_file = UNITY_EXTRA if UNITY_EXTRA.exists() else HERE / 'extra-chars.txt'   # CI uses the committed copy
    if extra_file.exists():
        for line in extra_file.read_text(encoding='utf-8').splitlines():
            if not line.startswith('#'):
                have.update(line)
    else:
        rep.warn('Unity extra-chars.txt not found; skipped the cover-font check')
        return
    fixed = set(chr(c) for c in range(0x20, 0x7F)) | set(chr(c) for c in range(0x3041, 0x3097)) \
        | set(chr(c) for c in range(0x30A1, 0x30FB)) | set('ー・、。「」『』（）！？～…　所属年生シスター神父読み込み中')
    missing = sorted({c for s in strings for c in s if not c.isspace() or c == '　'} - have - fixed)
    if missing:
        rep.warn('cover characters NOT in the Unity static font atlas (run SCB/Rebuild Cover Font Atlas after adding to '
                 'extra-chars.txt): ' + ''.join(missing))


def diff_people(old, new, skip=()):
    o = {p['id']: p for p in old}
    n = {p['id']: p for p in new}
    lines = []
    for pid in n:
        if pid not in o:
            lines.append(f'  + new person {pid}')
        else:
            for k in PERSON_KEYS:
                if o[pid].get(k) != n[pid].get(k):
                    lines.append(f'  ~ {pid}.{k}: {o[pid].get(k)!r} -> {n[pid].get(k)!r}')
    for pid in o:
        if pid not in n and pid not in skip:
            lines.append(f'  - removed {pid} (kept out of the new file)')
    if [p['id'] for p in old if p['id'] in n] != [p['id'] for p in new if p['id'] in o]:
        lines.append('  ~ order changed')
    return lines


def diff_books(old, new):
    o = {b['slot']: b for b in old}
    n = {b['slot']: b for b in new}
    lines = []
    for s in n:
        if s not in o:
            lines.append(f'  + new slot {s}: {n[s]["coverName"]}')
        else:
            for k in n[s]:
                if o[s].get(k) != n[s].get(k):
                    lines.append(f'  ~ {s}.{k}: {o[s].get(k)!r} -> {n[s].get(k)!r}')
    for s in o:
        if s not in n:
            lines.append(f'  - slot {s} removed -> the world will HIDE that book')
    return lines


def write_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--apply', action='store_true', help='write files (default: dry run)')
    ap.add_argument('--no-backup', action='store_true', help='do not copy the old files to backups/ (used by the automatic publisher; git keeps the history)')
    ap.add_argument('--fe', type=Path, default=DEFAULT_FE, help='frontend project folder')
    ap.add_argument('--repo', type=Path, default=DEFAULT_REPO, help='GitHub Pages repo folder (books/index.json)')
    ap.add_argument('--slots', type=Path, default=HERE / 'slots.json')
    ap.add_argument('--source-json', type=Path, help='use a local JSON file of records instead of Supabase (testing)')
    ap.add_argument('--settings-json', type=Path, help='testing: a local JSON object {key: value} of home page settings')
    ap.add_argument('--fanworks-json', type=Path, help='testing: a local JSON list [{id, data, approved_at}] of approved fan works')
    ap.add_argument('--relations-json', type=Path, help='with --source-json: a local JSON list of approved relations (a_id,b_id,kind,label,note)')
    a = ap.parse_args()

    rep = Report()
    url = key = None
    if a.source_json:
        records = json.loads(a.source_json.read_text(encoding='utf-8'))
        print(f'[source] local file {a.source_json} ({len(records)} records)')
    else:
        url, key = load_config(a.fe)
        records = fetch_records(url, key)
        print(f'[source] Supabase {url} ({len(records)} records)')

    people_file = a.fe / 'data' / 'public-people-all.json'
    old_people_doc = json.loads(people_file.read_text(encoding='utf-8')) if people_file.exists() else {'people': []}
    old_people = old_people_doc.get('people', [])

    cleaned = [c for c in (clean_person(r, rep) for r in records) if c]
    failed_ids = {r['id'] for r in records} - {c['id'] for c in cleaned}
    if len(cleaned) != len(records):
        rep.error(f'{len(records) - len(cleaned)} record(s) failed validation (see errors); nothing will be written')
    new_people = order_people(cleaned, [p['id'] for p in old_people])
    by_id = {p['id']: p for p in new_people}

    # member-editable profile fields -> data/character-content.json (merged with what is already there)
    content_file = a.fe / 'data' / 'character-content.json'
    old_content_doc = json.loads(content_file.read_text(encoding='utf-8')) if content_file.exists() else {'schemaVersion': 1, 'demo': False, 'characters': {}}
    old_chars = old_content_doc.get('characters') or {}
    new_chars = {pid: dict(v) for pid, v in old_chars.items()}
    contents = {}
    for r in records:
        if r['id'] not in by_id:
            continue
        c = clean_content(r, rep)
        if c is None:
            failed_ids.add(r['id']); continue
        contents[r['id']] = c
        entry = {k: v for k, v in new_chars.get(r['id'], {}).items() if k not in EXTRA_KEYS}
        entry.update(c)
        if entry:
            new_chars[r['id']] = entry
        else:
            new_chars.pop(r['id'], None)
    # approved relations -> data/relations.json (graph, board, book) and the "bonds" of each character page
    rel_file = a.fe / 'data' / 'relations.json'
    old_rel_doc = json.loads(rel_file.read_text(encoding='utf-8')) if rel_file.exists() else {'schemaVersion': 1, 'relations': []}
    rel_rows = None
    if a.source_json:
        if a.relations_json:
            rel_rows = json.loads(a.relations_json.read_text(encoding='utf-8'))
    else:
        rel_rows = fetch_relations(url, key)
    relations = clean_relations(rel_rows, set(by_id), rep) if rel_rows is not None else old_rel_doc.get('relations', [])
    if rel_rows is not None:
        for pid in by_id:
            bonds = bonds_for(pid, relations)
            entry = dict(new_chars.get(pid, {}))
            if bonds:
                entry['relationships'] = bonds
            else:
                entry.pop('relationships', None)
            if entry:
                new_chars[pid] = entry
            else:
                new_chars.pop(pid, None)
    rel_doc = {'schemaVersion': 1, 'comment': 'Approved relations (public). kind sister/blood: a = the elder. Generated by publish_from_db.py.', 'relations': relations}
    rd = []
    if rel_doc['relations'] != old_rel_doc.get('relations', []):
        oldk = {(r['a'], r['b'], r['kind']): r for r in old_rel_doc.get('relations', [])}
        newk = {(r['a'], r['b'], r['kind']): r for r in relations}
        rd += [f"  + {k[2]}: {k[0]} - {k[1]}" for k in newk if k not in oldk]
        rd += [f"  - {k[2]}: {k[0]} - {k[1]}" for k in oldk if k not in newk]
        rd += [f"  ~ {k[2]}: {k[0]} - {k[1]} (label/note)" for k in newk if k in oldk and newk[k] != oldk[k]]
    content_doc = dict(old_content_doc)
    content_doc['characters'] = new_chars
    cd = diff_content(old_chars, new_chars)

    # image files referenced must exist in the frontend project; approved member uploads are fetched from Storage
    to_fetch = []
    for p in new_people:
        for path in image_paths(p, contents.get(p['id'])):
            if (a.fe / path).exists():
                continue
            m = UPLOAD_RE.match(path)
            if m and m.group(1) == p['id'] and url:
                to_fetch.append((path, f'{m.group(1)}/{m.group(2)}'))
            else:
                rep.warn(f'{p["id"]}: referenced image is missing in the frontend: {path}')

    people_doc = dict(old_people_doc)
    people_doc.update({'schemaVersion': 2, 'demo': False, 'people': new_people,
                       'comment': 'Generated by tools/scb_publish/publish_from_db.py from Supabase character_records (public fields only).'})

    # home page featured cards, works and texts
    site_fetch = []
    settings = json.loads(a.settings_json.read_text(encoding='utf-8')) if a.settings_json else (fetch_settings(url, key) if (url and key) else {})
    if 'person.themes' not in settings and url and key and not a.settings_json:
        _pt = fetch_person_themes(url, key)
        if _pt is not None:
            settings['person.themes'] = _pt
    demo_file = a.fe / 'data' / 'public-demo.json'
    demo_doc = json.loads(demo_file.read_text(encoding='utf-8')) if demo_file.exists() else None
    new_demo = None
    if demo_doc:
        new_demo = json.loads(json.dumps(demo_doc))
        for c in new_demo.get('characters', []):
            p = by_id.get(c.get('id'))
            if p is None:
                if c.get('id') not in failed_ids:
                    rep.warn(f'public-demo.json: character {c.get("id")!r} is not in the database')
                continue
            for k in ('name', 'nameKana', 'romaji', 'kind', 'grade', 'club', 'color', 'status', 'group'):
                c[k] = p[k]
            c['image'] = p['portrait'] or p['image']
            c['featured'] = c.get('featured', True) and p['status'] == 'active'

        # settings edited in the admin hub win over the old demo list
        if 'home.featured' in settings:
            old = {c['id']: c for c in new_demo.get('characters', [])}
            chars = []
            for pid in settings['home.featured']:
                p = by_id.get(pid)
                if p is None:
                    rep.warn(f'home.featured: {pid!r} is not in the database; skipped'); continue
                c = dict(old.get(pid, {'id': pid}))
                for k in ('name', 'nameKana', 'romaji', 'kind', 'grade', 'club', 'color', 'status', 'group'):
                    c[k] = p[k]
                c['image'] = p['portrait'] or p['image']
                c['featured'] = p['status'] == 'active'
                chars.append(c)
            new_demo['characters'] = chars
        if 'home.works' in settings:
            works = []
            for w in settings['home.works']:
                work = {'id': w['id'], 'category': w.get('category', ''), 'title': w['title'], 'description': w.get('description', ''), 'demo': False}
                if w.get('image'):
                    work['image'] = w['image']
                    if not (a.fe / w['image']).exists():
                        m = UPLOAD_RE.match(w['image'])
                        if m and m.group(1) == 'site' and url:
                            site_fetch.append((w['image'], f'site/{m.group(2)}'))
                        else:
                            rep.warn(f'home.works {w["id"]}: image is missing in the frontend: {w["image"]}')
                if w.get('link'):
                    work['link'] = w['link']
                works.append(work)
            new_demo['works'] = works
        if settings.get('home.texts'):
            new_demo['texts'] = settings['home.texts']
        elif 'texts' in new_demo and 'home.texts' in settings:
            new_demo.pop('texts')

    # page base art per tier (uploaded in the admin hub): data/tier-art.json, images are copied like the other uploads
    tier_file = a.fe / 'data' / 'tier-art.json'
    tier_old = json.loads(tier_file.read_text(encoding='utf-8')) if tier_file.exists() else {}
    tier_new = {k: v for k, v in (settings.get('tier.pages') or {}).items() if v} if 'tier.pages' in settings else tier_old
    for k, v in tier_new.items():
        if not (a.fe / v).exists():
            m = UPLOAD_RE.match(v)
            if m and m.group(1) == 'site' and url:
                site_fetch.append((v, f'site/{m.group(2)}'))
            else:
                rep.warn(f'tier art {k}: image is missing in the frontend: {v}')
    td = [] if tier_new == tier_old else ['  ~ tier-art.json: ' + ', '.join(sorted(set(tier_old) | set(tier_new)))]
    # website art slots (home hero, cards, decorations): data/site-art-base.json (original) + settings 'site.art' overrides -> data/site-art.json
    art_file = a.fe / 'data' / 'site-art.json'
    art_base_file = a.fe / 'data' / 'site-art-base.json'
    art_cur = json.loads(art_file.read_text(encoding='utf-8')) if art_file.exists() else {'schemaVersion': 1, 'revision': 0, 'slots': {}}
    art_base = json.loads(art_base_file.read_text(encoding='utf-8')) if art_base_file.exists() else art_cur
    art_over = settings['site.art'] if 'site.art' in settings else None
    art_new = art_cur
    if art_over is not None:
        art_new = json.loads(json.dumps(art_base))
        for sid, o in art_over.items():
            if sid not in art_new.get('slots', {}):
                rep.warn(f'site art: unknown slot {sid} ignored')
                continue
            for fld in ('path', 'positionDesktop', 'positionMobile'):
                if o.get(fld):
                    art_new['slots'][sid][fld] = o[fld]
            v = o.get('path')
            if v and not (a.fe / v).exists():
                m = UPLOAD_RE.match(v)
                if m and m.group(1) == 'site' and url:
                    site_fetch.append((v, f'site/{m.group(2)}'))
                else:
                    rep.warn(f'site art {sid}: image is missing in the frontend: {v}')
    ad = [] if art_new == art_cur and art_base_file.exists() else ['  ~ site-art.json: ' + (', '.join(sorted(k for k, v in art_new.get('slots', {}).items() if v != art_cur.get('slots', {}).get(k))) or 'base copy')]
    # per-person look of the personal book (members' own choices over the global theme): data/person-themes.json
    pt_file = a.fe / 'data' / 'person-themes.json'
    pt_old = json.loads(pt_file.read_text(encoding='utf-8')) if pt_file.exists() else {}
    pt_new = pt_old
    if 'person.themes' in settings:
        known = {q['id'] for q in new_people}
        pt_new = {pid: v for pid, v in sorted(settings['person.themes'].items()) if pid in known and v}
    for pid, tv in pt_new.items():
        for role, per_tier in (tv.get('backgrounds') or {}).items():
            for tier_key, v in (per_tier or {}).items():
                if v and not (a.fe / v).exists():
                    m = UPLOAD_RE.match(v)
                    if m and m.group(1) == 'site' and url:
                        site_fetch.append((v, f'site/{m.group(2)}'))
                    else:
                        rep.warn(f'person theme {pid} background {role}/{tier_key}: image is missing in the frontend: {v}')
    pd_ = [] if pt_new == pt_old else ['  ~ person-themes.json: ' + ', '.join(sorted(k for k in set(pt_old) | set(pt_new) if pt_old.get(k) != pt_new.get(k)))]
    # book page theme (colours, frame, page order, background images): data/book-theme.json
    theme_file = a.fe / 'data' / 'book-theme.json'
    theme_old = json.loads(theme_file.read_text(encoding='utf-8')) if theme_file.exists() else {}
    theme_new = settings['book.theme'] if 'book.theme' in settings else theme_old
    for role, per_tier in (theme_new.get('backgrounds') or {}).items():
        for tier_key, v in (per_tier or {}).items():
            if v and not (a.fe / v).exists():
                m = UPLOAD_RE.match(v)
                if m and m.group(1) == 'site' and url:
                    site_fetch.append((v, f'site/{m.group(2)}'))
                else:
                    rep.warn(f'book theme background {role}/{tier_key}: image is missing in the frontend: {v}')
    th = [] if theme_new == theme_old else ['  ~ book-theme.json: ' + ', '.join(sorted(k for k in set(theme_old) | set(theme_new) if theme_old.get(k) != theme_new.get(k)))]
    # fan works (二次創作): approved snapshots -> data/fanworks.json (text, volumes, stable story slots); covers are fetched like the other uploads
    fan_file = a.fe / 'data' / 'fanworks.json'
    fan_old = json.loads(fan_file.read_text(encoding='utf-8')) if fan_file.exists() else {'works': []}
    fan_rows = (json.loads(a.fanworks_json.read_text(encoding='utf-8')) if a.fanworks_json else (fetch_fan_works(url, key) if (url and key) else None))
    fan_new = fan_old
    if fan_rows is not None:
        works = []
        for row in fan_rows:
            d = row['data']
            works.append({'id': row['id'], 'title': d['title'], 'author': d.get('author', ''), 'category': d.get('category', '小説・SS'), 'summary': d.get('summary', ''),
                          'cover': d.get('cover'), 'body': d.get('body', ''), 'illustrations': d.get('illustrations') or [], 'art': d.get('art') or {}, 'volumes': fanbook.estimate_volumes(d)})
        slot_map = assign_story_slots(works, fan_old.get('works', []), rep)
        for w in works:
            w['slots'] = slot_map[w['id']]
            for c in [w['cover']] + [x['image'] for x in w['illustrations']] + [v for k, v in w['art'].items() if k in ('front', 'back', 'spine')]:
                if c and not (a.fe / c).exists():
                    m = UPLOAD_RE.match(c)
                    if m and url:
                        site_fetch.append((c, f'{m.group(1)}/{m.group(2)}'))
                    else:
                        rep.warn(f'fan work {w["title"]!r}: image is missing in the frontend: {c}')
        fan_new = {'version': 1, 'works': works}
    fd = [] if fan_new == fan_old else ['  ~ fanworks.json: ' + ', '.join(sorted(w['title'] for w in fan_new['works'] if w not in fan_old.get('works', []))) + (f' ({sum(len(w["slots"]) for w in fan_new["works"])} story books)')]
    to_fetch = to_fetch + [x for x in site_fetch if x not in to_fetch]   # images of the home works and the tier art (folder "site")

    # world manifest
    slots_file = a.fe / 'data' / 'slots.json'
    db_slots = None if a.source_json else fetch_slots(url, key)
    if db_slots:
        slots = db_slots
        print(f'[slots] {len(slots)} from the database')
    else:
        slots = json.loads(a.slots.read_text(encoding='utf-8')) if a.slots.exists() else []
        print(f'[slots] {len(slots)} from {a.slots.name} (fallback)')
    old_slots = json.loads(slots_file.read_text(encoding='utf-8')) if slots_file.exists() else None
    sd = [] if (old_slots == slots) else ['  ~ slots.json: ' + str(len(slots)) + ' slots']
    books = build_manifest(by_id, slots, rep, failed_ids)
    for w in fan_new.get('works', []):                   # one book per volume of every approved fan work
        for vi, slot in enumerate(w.get('slots', [])):
            label = fanbook.volume_label(vi, w['volumes'])
            art = w.get('art') or {}
            title_text = (art.get('coverTitle') or w['title']).replace('\r', '')
            entry = {'slot': slot, 'type': 'story', 'tier': STORY_TIER, 'color': DEFAULT_COLOR, 'coverTop': ''}
            if art.get('front'):                          # the member's own cover picture replaces the text
                entry['coverName'] = ''
                entry['customCover'] = True
            else:                                         # title (line breaks kept, normal size) and, at the bottom, the volume
                entry['coverName'] = (title_text + (f'\n<size=65%>{label}</size>' if label else ''))[:100]
            if art.get('back'):
                entry['customBack'] = True
            if art.get('spine'):
                entry['spineText'] = ''
                entry['customSpine'] = True
            else:
                entry['spineText'] = (f'{w["title"]}{label}' if label else w['title'])[:40]
            entry['spreads'] = 6
            books.append(entry)
    idx_file = a.repo / 'books' / 'index.json'
    old_idx = json.loads(idx_file.read_text(encoding='utf-8')) if idx_file.exists() else {'books': [], 'updated': ''}
    new_idx = {'version': 1, 'updated': old_idx.get('updated') or datetime.date.today().isoformat(), 'books': books}
    changed_books = diff_books(old_idx.get('books', []), books) if not failed_ids else []
    if changed_books:
        new_idx['updated'] = datetime.date.today().isoformat()
    font_gaps([s for b in books for s in (b['coverTop'], b['coverName'], b['spineText'])], rep)

    # ---------- report ----------
    pd = diff_people(old_people, new_people, failed_ids)
    print('\n== website: public-people-all.json ==')
    print('\n'.join(pd) if pd else '  (no changes)')
    dd = []
    if new_demo:
        oc_ids, nc_ids = [c['id'] for c in demo_doc.get('characters', [])], [c['id'] for c in new_demo.get('characters', [])]
        if oc_ids != nc_ids:
            dd.append(f'  ~ home featured people: {oc_ids} -> {nc_ids}')
        old_by = {c['id']: c for c in demo_doc.get('characters', [])}
        for nc in new_demo.get('characters', []):
            oc = old_by.get(nc['id'], {})
            for k in nc:
                if oc.get(k) != nc.get(k):
                    dd.append(f'  ~ home {nc["id"]}.{k}: {oc.get(k)!r} -> {nc.get(k)!r}')
        if demo_doc.get('works') != new_demo.get('works'):
            dd.append(f'  ~ home works: {len(demo_doc.get("works", []))} -> {len(new_demo.get("works", []))} item(s)')
        if demo_doc.get('texts') != new_demo.get('texts'):
            dd.append('  ~ home texts: ' + ', '.join(sorted(set((demo_doc.get('texts') or {}).keys()) | set((new_demo.get('texts') or {}).keys()))))
    print('\n== website: public-demo.json (home featured) ==')
    print('\n'.join(dd) if dd else '  (no changes)')
    print('\n== website: character-content.json (profile text, outfits) ==')
    print('\n'.join(cd) if cd else '  (no changes)')
    print('\n== relations.json (approved relations: graph, board, book) ==')
    print('\n'.join(rd) if rd else '  (no changes)')
    print('\n== data/tier-art.json (page base art per tier) ==')
    print('\n'.join(td) if td else '  (no changes)')
    print('\n== data/book-theme.json (look of the book pages) ==')
    print('\n'.join(th) if th else '  (no changes)')
    print('\n== data/person-themes.json (look of each personal book) ==')
    print('\n'.join(pd_) if pd_ else '  (no changes)')
    print('\n== data/fanworks.json (fan works / story books) ==')
    print('\n'.join(fd) if fd else '  (no changes)')
    print('\n== data/site-art.json (home page art slots) ==')
    print('\n'.join(ad) if ad else '  (no changes)')
    print('\n== data/slots.json (book slots used by the page renderer) ==')
    print('\n'.join(sd) if sd else '  (no changes)')
    print('\n== member uploads to copy from Storage into assets/ ==')
    print('\n'.join(f'  + {p}' for p, _ in to_fetch) if to_fetch else '  (none)')
    print('\n== world: books/index.json ==')
    print('\n'.join(changed_books) if changed_books else '  (no changes)')
    for w in rep.warnings:
        print('WARNING:', w)
    for e in rep.errors:
        print('ERROR:', e)

    if rep.errors:
        print('\nResult: FAILED. Nothing written.'); sys.exit(2)
    if not (pd or dd or changed_books or cd or to_fetch or rd or sd or td or th or ad or pd_ or fd):
        print('\nResult: already up to date.'); return
    if not a.apply:
        print('\nResult: DRY RUN. Re-run with --apply to write these files. (Nothing was pushed.)'); return

    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    bdir = HERE / 'backups' / stamp
    targets = [(people_file, people_doc, bool(pd))]
    if new_demo:
        targets.append((demo_file, new_demo, bool(dd)))
    targets.append((idx_file, new_idx, bool(changed_books)))
    targets.append((content_file, content_doc, bool(cd)))
    targets.append((rel_file, rel_doc, bool(rd)))
    targets.append((slots_file, slots, bool(sd)))
    targets.append((tier_file, tier_new, bool(td)))
    targets.append((theme_file, theme_new, bool(th)))
    targets.append((fan_file, fan_new, bool(fd)))
    targets.append((pt_file, pt_new, bool(pd_)))
    targets.append((art_base_file, art_base, not art_base_file.exists()))
    targets.append((art_file, art_new, art_new != art_cur))
    for path, rel in to_fetch:                       # approved member uploads: Storage -> site assets (and the Pages repo copy)
        try:
            fetch_upload(url, rel, a.fe / path)
            fetch_upload(url, rel, a.repo / path)
            print('downloaded:', path)
        except Exception as e:
            print(f'ERROR: could not fetch {path}: {e}'); sys.exit(2)
    for path, obj, changed in targets:
        if not changed:
            continue
        if path.exists() and not a.no_backup:
            bdir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, bdir / path.name)
        write_json(path, obj)
        print('written:', path)
    print(f'\nResult: APPLIED. Backups in {bdir}. Review, then commit/push the GitHub Pages repo yourself.')


if __name__ == '__main__':
    main()
