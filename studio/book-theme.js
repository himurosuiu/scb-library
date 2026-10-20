// Book page look editor with a live preview.
// Global mode (administrator): the look of every book (setting 'book.theme').
// Person mode (?person=<id> or ?mine=1; the administrator or an assigned editor): the look of one person's book, laid over the global one (table person_themes).
// The preview builds the same HTML as tools/scb_render/render_books.py (port of page_html / graph_body) and the same CSS (book-page.css).
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

const $ = id => document.getElementById(id);
const cfg = window.SCB_SUPABASE_CONFIG || {};
const ready = /^https:\/\/[\w-]+\.supabase\.co$/.test(cfg.url) && !!cfg.anonKey;
const BUCKET = 'scb-uploads', MAX_BYTES = 5 * 1024 * 1024;
const COLORS = [['paper', '紙の色', '#fbf6f1'], ['text', '文字の色', '#3a2f33'], ['muted', '補助の文字色', '#8a7468'], ['rule', '罫線の色', '#e6d6cc']];
const TIERS = [['y1', '一年'], ['y2', '二年'], ['y3', '三年'], ['teacher', '教職員']];
const TIER_ACCENT = { y1: '#f2a7a0', y2: '#c04a58', y3: '#8a6a3d', teacher: '#4a4a50' };
const ROLES = [['title', '表紙頁'], ['profile', 'プロフィール'], ['about', '人物紹介'], ['graph', '関係図'], ['photos', '写真頁']];
const PAGE_BLOCKS = [['about', '人物紹介'], ['graph', '関係図'], ['photos', '写真（個人ブックのページ）']];
const KIND_JP = { sister: '姉妹', blood: '血縁', friend: '友人', acquaintance: '知人', clan: '同族', rival: 'ライバル', kusareen: '腐れ縁', gizagiza: 'ギザギザ', other: 'その他', one_sided: '片想い', tsuntsun: 'ツンツン', honmei: '本命', oshi: '推し', amayakashi: '甘やかし', amae: '甘え', izon: '依存', kininaru: '気になる' };
const KIND_STYLE = { sister: ['#c04a58', ''], blood: ['#c04a58', '14 10'], clan: ['#a8566a', ''], one_sided: ['#d86a9a', ''], honmei: ['#d86a9a', ''], oshi: ['#e0508a', ''], kininaru: ['#e58aa8', '4 8'], amae: ['#d9879a', ''], amayakashi: ['#d9879a', ''], izon: ['#a04a7a', ''], friend: ['#5f9a70', ''], kusareen: ['#6a8a5a', '14 10'], tsuntsun: ['#7aa05a', ''], acquaintance: ['#9a8478', '14 10'], rival: ['#4a6a9a', ''], gizagiza: ['#6a5a9a', '14 10'], other: ['#9a8478', ''] };
const DIRECTED = ['one_sided', 'tsuntsun', 'honmei', 'oshi', 'amayakashi', 'amae', 'izon', 'kininaru'];
const MAX_SINGLE = 6, MAX_GRAPH = 14, PAGE_H = 1528;

let api = null, theme = {}, globalTheme = {}, mode = 'global', isAdmin = false, editable = [], people = [], content = {}, relations = [];

const T = () => ({ ...globalTheme, ...theme });
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); e.append(...kids); return e; };
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const say = (t, cls = '') => { const m = $('msg'); m.textContent = t; m.className = cls; };
async function rpc(fn, args) { const { data, error } = await api.rpc(fn, args); if (error) throw new Error(error.message); return data; }
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const tierOf = p => p.kind === 'teacher' ? 'teacher' : ({ '1年': 'y1', '2年': 'y2', '3年': 'y3' }[p.grade] || 'y1');
const imgSrc = path => { const m = /^assets\/uploads\/(.+)$/.exec(path || ''); return m ? `${cfg.url}/storage/v1/object/public/${BUCKET}/${m[1]}` : (path ? '../' + path : ''); };

// ---------------------------------------------------------------- page content (port of render_books.py)
function roleLine(p) {
  if (p.kind === 'teacher') return p.group || '教員';
  const g = (p.grade || '').replace('年', '年生'); const c = (p.club || '').split(/[/・]/).filter(Boolean).join('・');
  return c ? `${g}　${c}` : g;
}
function profileRows(p, x) {
  const rows = [['名前', p.name], ['よみがな', p.nameKana], ['ローマ字', p.romaji], ['区分', p.kind === 'teacher' ? '教員' : '生徒'], ['学年', p.grade], ['所属', p.club], ['在籍状況', p.status === 'graduated' ? '卒業' : '在籍中']];
  if (p.group) rows.push(['副題', p.group]);
  for (const [l, k] of [['種族', 'species'], ['身長', 'height'], ['一人称', 'firstPerson'], ['二人称', 'secondPerson']]) if (x[k]) rows.push([l, x[k]]);
  return rows.filter(r => r[1]);
}
function bondsOf(pid) {
  const out = [];
  for (const r of relations) {
    if (r.a !== pid && r.b !== pid) continue;
    const other = people.find(q => q.id === (r.b === pid ? r.a : r.b)); if (!other) continue;
    out.push({ name: other.name, label: (r.a === pid ? r.forA : r.forB) || r.label || '関係者', portrait: other.portrait || other.image || null, kind: r.kind, dir: DIRECTED.includes(r.kind) ? (r.a === pid ? 'out' : 'in') : 'none' });
  }
  const order = { sister: 0, blood: 1, clan: 2 };
  return out.sort((x, y) => (order[x.kind] ?? 3) - (order[y.kind] ?? 3) || x.name.localeCompare(y.name, 'ja'));
}
function buildPages(p) {
  const x = content[p.id] || {}, tier = tierOf(p), color = p.color || '#d9c3cf', portrait = p.portrait || p.image || null;
  const pages = [{ role: 'title', name: p.name, kana: p.nameKana || '', roleLine: roleLine(p), portrait, color }, { role: 'profile', rows: profileRows(p, x), notes: [['好きなもの', x.likes], ['苦手なもの', x.dislikes]].filter(n => n[1]), color }];
  let bonds = bondsOf(p.id), graph = null;
  if (bonds.length) {
    bonds = bonds.slice(0, MAX_GRAPH); const center = { name: p.name, portrait };
    graph = bonds.length > MAX_SINGLE ? [{ role: 'graph', span: 2, half: 'R', bonds, center, color }, { role: 'graph', span: 2, half: 'L', bonds, center, color }] : [{ role: 'graph', span: 1, half: 'S', bonds, center, color }];
  }
  const secs = [['人物紹介', x.about]].filter(s => s[1]);   // likes / dislikes live on the PROFILE page
  const aboutPage = secs.length ? { role: 'about', sections: secs, color } : null;
  let photos = (x.bookPages || []).map(b => [b.image, b.caption || '']);
  if (!photos.length) for (const o of x.outfits || []) for (const i of o.images || []) photos.push([i, o.label || '']);
  if (!photos.length) photos = (p.gallery || []).map(g => [g, '']);
  const photoPages = photos.filter(ph => ph[0]).map(([image, caption]) => ({ role: 'photo', image, caption, color }));
  const order = T().pages;
  if (!order) {
    if (graph && graph.length === 2) pages.push(...graph);
    if (aboutPage) pages.push(aboutPage);
    if (graph && graph.length === 1) pages.push(...graph);
    pages.push(...photoPages);
  } else {
    for (const name of order) {
      if (name === 'about' && aboutPage) pages.push(aboutPage);
      else if (name === 'graph' && graph) { if (graph.length === 2 && pages.length % 2 === 1) pages.push({ role: 'blank' }); pages.push(...graph); }
      else if (name === 'photos') pages.push(...photoPages);
    }
  }
  while (pages.length < 12) pages.push({ role: 'blank' });
  return pages.slice(0, 12).map(pg => ({ ...pg, tier }));
}

function graphBody(pg) {
  const span = pg.span, W = 928 * span, bonds = pg.bonds, n = bonds.length;
  let cx = W / 2, cy = 800, rx = 720, ry = 490, RC = 120, RN = 72;
  if (span === 1) { cx = 464; cy = 790; rx = 345; ry = 520; RC = 105; RN = 66; }
  const pos = [];
  for (let i = 0; i < n; i++) { const ang = -Math.PI / 2 + 2 * Math.PI * i / Math.max(n, 1) + (span === 2 && n % 2 === 0 ? Math.PI / Math.max(n, 1) : 0); pos.push([cx + rx * Math.cos(ang), cy + ry * Math.sin(ang)]); }
  let svg = '', pills = '', nodes = '';
  pos.forEach(([x, y], i) => {
    const b = bonds[i], [color, dash] = KIND_STYLE[b.kind] || ['#9a8478', ''];
    const dx = x - cx, dy = y - cy, dist = Math.hypot(dx, dy) || 1, ux = dx / dist, uy = dy / dist;
    const x1 = cx + ux * (RC + 4), y1 = cy + uy * (RC + 4), x2 = x - ux * (RN + 8), y2 = y - uy * (RN + 8);
    svg += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="7" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
    if (DIRECTED.includes(b.kind) && (b.dir === 'out' || b.dir === 'in')) {
      const [tx, ty, vx, vy] = b.dir === 'out' ? [x2, y2, ux, uy] : [x1, y1, -ux, -uy]; const ax = tx - vx * 26, ay = ty - vy * 26, px = -vy, py = vx;
      svg += `<polygon points="${tx.toFixed(1)},${ty.toFixed(1)} ${(ax + px * 15).toFixed(1)},${(ay + py * 15).toFixed(1)} ${(ax - px * 15).toFixed(1)},${(ay - py * 15).toFixed(1)}" fill="${color}"/>`;
    }
    pills += `<div class="pill" style="left:${(cx + dx * .5).toFixed(1)}px;top:${(cy + dy * .5).toFixed(1)}px;border-color:${color};color:${color}">${esc(b.label)}</div>`;
    const sz = `width:${2 * RN}px;height:${2 * RN}px`;
    const im = b.portrait ? `<img style="${sz}" src="${esc(imgSrc(b.portrait))}">` : `<span class="noimg" style="${sz}"></span>`;
    nodes += `<div class="gnode" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px">${im}<div class="gname">${esc(b.name)}</div></div>`;
  });
  const csz = `width:${2 * RC}px;height:${2 * RC}px`;
  const cim = pg.center.portrait ? `<img style="${csz}" src="${esc(imgSrc(pg.center.portrait))}">` : `<span class="noimg" style="${csz}"></span>`;
  const kinds = [...new Set(bonds.map(b => b.kind))];
  const legend = kinds.map(k => `<span class="lg"><i style="background:${(KIND_STYLE[k] || ['#9a8478'])[0]}"></i>${esc(KIND_JP[k] || k)}</span>`).join('') + (bonds.some(b => DIRECTED.includes(b.kind)) ? '<span class="lg">矢印＝向き</span>' : '');
  return `<h2>BONDS</h2><svg class="gsvg" width="${W}" height="${PAGE_H}" viewBox="0 0 ${W} ${PAGE_H}">${svg}</svg>${pills}${nodes}<div class="gcenter" style="left:${cx}px;top:${cy}px">${cim}<div class="gcname">${esc(pg.center.name)}</div></div><div class="legend" style="width:${W - 140}px">${legend}</div>`;
}

function pageBodyHtml(pg, number) {
  const role = pg.role; const t = T();
  const accent = (t.accentSource === 'tier' && TIER_ACCENT[pg.tier]) ? ((t.tierAccent || {})[pg.tier] || TIER_ACCENT[pg.tier]) : (pg.color || '#d9c3cf');
  const vars = ['paper', 'text', 'muted', 'rule'].filter(k => COLOR_RE.test(t[k] || '')).map(k => `--${k}:${t[k]};`).join('') + (typeof t.fontScale === 'number' ? `--fs:${t.fontScale};` : '');
  const bgRole = role === 'photo' ? 'photos' : role, bgs = (t.backgrounds || {})[bgRole] || {}, bgPath = bgs[pg.tier] || bgs.all;
  const bg = bgPath ? `<div class="bg" style="background-image:url('${esc(imgSrc(bgPath))}')"></div>` : '';
  let body = '';
  if (role === 'title') body = `<div class="kana">${esc(pg.kana)}</div><div class="name">${esc(pg.name)}</div><div class="roleline">${esc(pg.roleLine)}</div><div class="portrait-box">${pg.portrait ? `<img class="portrait" src="${esc(imgSrc(pg.portrait))}">` : '<div class="portrait empty">PORTRAIT</div>'}</div>`;
  else if (role === 'profile') { const notes = (pg.notes || []).map(([k, v]) => `<div class="note"><h3>${esc(k)}</h3><p>${esc(v).replace(/\n/g, '<br>')}</p></div>`).join(''); body = `<h2>PROFILE</h2><div class="pbody"><div class="rows${(pg.rows.length > 9 || pg.notes?.length) ? ' dense' : ''}">${pg.rows.map(([k, v]) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('')}</div>${notes ? `<div class="notes">${notes}</div>` : ''}</div><div class="swatch"></div>`; }
  else if (role === 'about') body = `<h2>ABOUT</h2><div class="secs">${pg.sections.map(([k, v]) => `<div class="sec"><h3>${esc(k)}</h3><p>${esc(v).replace(/\n/g, '<br>')}</p></div>`).join('')}</div>`;
  else if (role === 'graph') body = graphBody(pg);
  else if (role === 'photo') { const cap = pg.caption ? `<div class="caption">${esc(pg.caption)}</div>` : ''; body = `<div class="photo-box${cap ? ' with-cap' : ''}"><img src="${esc(imgSrc(pg.image))}"></div>${cap}`; }
  const num = (role === 'blank' || role === 'graph' || t.pageNumber === false) ? '' : `<div class="pno">${number}</div>`;
  const cls = `role-${role} frame-${t.frame || 'thin'} shape-${t.portraitShape || 'arch'} pf-${t.photoFrame || 'border'}${t.topBar === false ? ' no-bar' : ''}`;
  const wide = role === 'graph' ? `html,body,.page{width:${928 * pg.span}px}` : '';
  return `<!doctype html><meta charset="utf-8"><style>@font-face{font-family:'NotoJP';font-weight:400;src:url('../tools/fonts/NotoSansJP/NotoSansJP-Regular.ttf')}@font-face{font-family:'NotoJP';font-weight:700;src:url('../tools/fonts/NotoSansJP/NotoSansJP-Bold.ttf')}</style><link rel="stylesheet" href="book-page.css"><style>${wide}</style><body class="${cls}" style="--accent:${esc(accent)};${vars}"><div class="page">${bg}${body}${num}</div></body>`;
}

function renderPreview() {
  const p = people.find(q => q.id === $('person').value); if (!p) return;
  const box = $('preview'); box.replaceChildren();
  const scale = 0.25;
  buildPages(p).forEach((pg, i) => {
    const wide = pg.role === 'graph' && pg.span === 2;
    const frame = el('iframe', { sandbox: 'allow-same-origin', srcdoc: pageBodyHtml(pg, i + 1) });
    frame.style.width = (wide ? 1856 : 928) + 'px'; frame.style.height = PAGE_H + 'px'; frame.style.transform = `scale(${scale})`;
    if (wide && pg.half === 'R') frame.style.marginLeft = (-928 * scale) / scale + 'px';
    const th = el('div', { className: 'thumb' }, frame, el('span', { className: 'no' }, 'p.' + (i + 1)));
    th.style.width = 928 * scale + 'px'; th.style.height = PAGE_H * scale + 'px';
    th.onclick = () => { const z = $('zoomFrame'); z.srcdoc = pageBodyHtml(pg, i + 1); z.style.width = '928px'; z.style.height = PAGE_H + 'px'; z.style.transform = 'scale(.6)'; z.style.transformOrigin = '0 0'; const d = $('zoom'); d.style.width = 928 * .6 + 'px'; d.style.height = PAGE_H * .6 + 'px'; d.style.overflow = 'hidden'; if (wide) z.style.marginLeft = pg.half === 'R' ? '-928px' : '0'; d.showModal(); };
    box.append(th);
  });
}
$('zoom').addEventListener('click', e => { if (e.target === $('zoom')) $('zoom').close(); });

// ---------------------------------------------------------------- controls
function buildControls() {
  const cb = $('colors'); cb.replaceChildren();
  for (const [k, label, def] of COLORS) {
    const inp = el('input', { type: 'color', value: T()[k] || def }); const rst = el('button', { type: 'button' }, '標準');
    inp.oninput = () => { theme[k] = inp.value; renderPreview(); }; rst.onclick = () => { delete theme[k]; inp.value = def; renderPreview(); };
    cb.append(el('div', { className: 'col' }, inp, el('span', {}, label), rst));
  }
  const fs = $('fontScale'); fs.value = T().fontScale || 1; $('fsVal').textContent = Number(fs.value).toFixed(2);
  fs.oninput = () => { theme.fontScale = Number(fs.value); $('fsVal').textContent = Number(fs.value).toFixed(2); renderPreview(); };
  const bind = (id, key, def, isBool) => { const e = $(id); if (isBool) { e.checked = T()[key] ?? def; e.onchange = () => { theme[key] = e.checked; renderPreview(); }; } else { e.value = T()[key] || def; e.onchange = () => { theme[key] = e.value; if (id === 'accentSource') buildTierAccent(); renderPreview(); }; } };
  bind('frame', 'frame', 'thin'); bind('topBar', 'topBar', true, true); bind('pageNumber', 'pageNumber', true, true); bind('accentSource', 'accentSource', 'person'); bind('portraitShape', 'portraitShape', 'arch'); bind('photoFrame', 'photoFrame', 'border'); bind('galleryLayout', 'galleryLayout', 'outfit');
  buildTierAccent(); buildPagesList(); buildBgs();
}
function buildTierAccent() {
  const box = $('tierAccent'); box.replaceChildren(); if (T().accentSource !== 'tier') return;
  for (const [k, label] of TIERS) {
    const inp = el('input', { type: 'color', value: (T().tierAccent || {})[k] || TIER_ACCENT[k] });
    inp.oninput = () => { theme.tierAccent = { ...(T().tierAccent || {}), [k]: inp.value }; renderPreview(); };
    box.append(el('div', { className: 'col' }, inp, el('span', {}, label + 'の色')));
  }
}
function buildPagesList() {
  const box = $('pages'); box.replaceChildren();
  const order = T().pages || ['about', 'graph', 'photos']; const rest = PAGE_BLOCKS.map(b => b[0]).filter(k => !order.includes(k));
  const rows = [...order.map(k => [k, true]), ...rest.map(k => [k, false])];
  const label = k => PAGE_BLOCKS.find(b => b[0] === k)[1];
  const commit = () => { theme.pages = rows.filter(r => r[1]).map(r => r[0]); buildPagesList(); renderPreview(); };
  rows.forEach(([k, on], i) => {
    const c = el('input', { type: 'checkbox', checked: on }); c.onchange = () => { rows[i][1] = c.checked; commit(); };
    const up = el('button', { type: 'button' }, '↑'), dn = el('button', { type: 'button' }, '↓'); up.disabled = i === 0; dn.disabled = i === rows.length - 1;
    up.onclick = () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; commit(); }; dn.onclick = () => { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; commit(); };
    box.append(el('div', { className: 'item' }, c, el('span', {}, label(k)), up, dn));
  });
}
async function upload(file) {
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[file.type];
  if (!ext) throw new Error('PNG / JPG / WebP の画像を選んでください');
  if (file.size > MAX_BYTES) throw new Error('5MB 以下の画像を選んでください');
  const name = `site/${crypto.randomUUID()}.${ext}`;
  const { error } = await api.storage.from(BUCKET).upload(name, file, { contentType: file.type, upsert: false });
  if (error) throw new Error('アップロード失敗: ' + error.message);
  return 'assets/uploads/' + name;
}
function buildBgs() {
  const box = $('bgs'); box.replaceChildren();
  const tiers = [['all', '共通'], ...TIERS];
  for (const [role, label] of ROLES) {
    const row = el('div', { className: 'bgrow' }, el('b', {}, label));
    for (const [tk, tl] of tiers) {
      const cur = ((T().backgrounds || {})[role] || {})[tk];
      const f = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', title: tl });
      f.onchange = async () => { if (!f.files[0]) return; say('アップロード中…'); try { const path = await upload(f.files[0]); theme.backgrounds = { ...(T().backgrounds || {}), [role]: { ...((T().backgrounds || {})[role] || {}), [tk]: path } }; say('アップロードしました。「保存」で確定します。'); } catch (e) { say(e.message, 'err'); } buildBgs(); renderPreview(); };
      const cell = el('div', {}, el('small', {}, tl + (cur ? '（設定済み）' : '')), f);
      if (cur) { const x = el('button', { type: 'button' }, '外す'); x.onclick = () => { const bgs = { ...(T().backgrounds || {}) }; bgs[role] = { ...(bgs[role] || {}) }; delete bgs[role][tk]; if (!Object.keys(bgs[role]).length) delete bgs[role]; theme.backgrounds = bgs; if (!Object.keys(bgs).length) delete theme.backgrounds; buildBgs(); renderPreview(); }; cell.append(x); }
      row.append(cell);
    }
    box.append(row);
  }
}
$('resetAll').onclick = () => { theme = {}; buildControls(); renderPreview(); say('標準に戻しました。「保存」で確定します。'); };
$('save').onclick = async () => {
  try {
    if (mode === 'person') { await rpc('scb_save_person_theme', { pid: $('person').value, p_value: theme }); say('保存しました。最大 15 分で、この人物の書籍画像が描き直されます。', 'ok'); }
    else { await rpc('scb_admin_save_setting', { p_key: 'book.theme', p_value: theme }); say('保存しました。最大 15 分で書籍画像が描き直されます。', 'ok'); }
  } catch (e) { say('保存できませんでした: ' + e.message, 'err'); }
};

async function loadPersonTheme() {
  const r = await api.from('person_themes_public').select('value').eq('person_id', $('person').value);
  if (r.error && r.error.code === 'PGRST205') throw new Error('この機能はまだ使えません（SQL 17 を実行してください）');
  if (r.error) throw r.error;
  theme = structuredClone((r.data[0] || {}).value || {});
}

async function load() {
  const sr = await api.from('site_settings_public').select('key,value').eq('key', 'book.theme');
  if (sr.error && sr.error.code === 'PGRST205') throw new Error('設定テーブルがまだありません（SQL 13・14・15 を実行してください）');
  if (sr.error) throw sr.error;
  const stored = structuredClone((sr.data[0] || {}).value || {});
  if (mode === 'person') { globalTheme = stored; theme = {}; } else { globalTheme = {}; theme = stored; }
  const j = async path => { try { const r = await fetch(path); return r.ok ? r.json() : null; } catch (e) { return null; } };
  people = ((await j('../data/public-people-all.json')) || {}).people || [];
  content = ((await j('../data/character-content.json')) || {}).characters || {};
  relations = ((await j('../data/relations.json')) || {}).relations || [];
  const sel = $('person'); sel.replaceChildren();
  let list = people;
  if (mode === 'person') {
    if (!isAdmin) { list = []; for (const p of people) { const { data: yes, error } = await api.rpc('can_edit_scb_character', { cid: p.id }); if (error) throw new Error(error.message); if (yes) list.push(p); } }
    editable = list;
    const want = new URLSearchParams(location.search).get('person'); if (want) list = [...list].sort((a, b) => (b.id === want) - (a.id === want));
  }
  const prefer = ['tsukisa-yuru']; const sorted = mode === 'person' ? list : [...list].sort((a, b) => (prefer.includes(b.id) - prefer.includes(a.id)));
  for (const p of sorted) sel.add(new Option(`${p.name}（${p.id}）`, p.id));
  if (mode === 'person') {
    if (!sorted.length) throw new Error('編集できる人物がありません（管理者に担当の割り当てを依頼してください）');
    await loadPersonTheme();
    sel.onchange = async () => { try { await loadPersonTheme(); buildControls(); renderPreview(); say(''); } catch (e) { say(e.message, 'err'); } };
  } else sel.onchange = renderPreview;
  buildControls(); renderPreview();
}

async function start() {
  try {
    const { data: { user }, error } = await api.auth.getUser();
    if (error && error.name !== 'AuthSessionMissingError') throw error;
    $('login').hidden = !!user; $('logout').hidden = !user;
    $('who').textContent = user ? 'ログイン中：' + (user.email || user.id) : '未ログイン';
    if (!user) return;
    const admin = (await rpc('is_scb_super_admin')) === true;
    $('priv').textContent = admin ? '権限：super_admin' : '権限：担当している人物の見た目を編集できます';
    isAdmin = admin; const q = new URLSearchParams(location.search);
    mode = (q.has('person') || q.has('mine') || !admin) ? 'person' : 'global';
    if (mode === 'person') {
      document.querySelector('h1').textContent = '自分の本の見た目'; $('lead').textContent = 'あなたが担当している人物の個人ブックの見た目を選びます。ここで変えた項目だけが全体の設定より優先されます。変えていない項目は全体の設定のままです。保存すると最大 15 分で、その人物の書籍画像が描き直されます。';
      $('resetAll').textContent = '全体の設定に戻す'; if (!admin) $('bgField').hidden = true;
    }
    await load(); $('panel').hidden = false;
  } catch (e) { $('who').textContent = '初期化に失敗しました: ' + e.message; $('who').className = 'err'; }
}

$('login').disabled = !ready;
if (!ready) { $('who').textContent = 'Supabase の接続先が未設定です。studio/config.js を設定してください。'; }
else {
  api = createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  $('login').onclick = async () => { const { error } = await api.auth.signInWithOAuth({ provider: 'discord', options: { redirectTo: location.origin + location.pathname, scopes: 'identify' } }); if (error) say(error.message, 'err'); };
  $('logout').onclick = async () => { await api.auth.signOut(); location.reload(); };
  start();
}
