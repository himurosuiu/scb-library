// Fan works (二次創作の小説): members write / paste a novel, the administrator approves it, the publisher turns it into book volumes.
// The page layout below is a port of tools/scb_render/fanbook.py (VERTICAL writing: 40 characters per column, 18 columns per page, 11 content pages per book).
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

const $ = id => document.getElementById(id);
const cfg = window.SCB_SUPABASE_CONFIG || {};
const ready = /^https:\/\/[\w-]+\.supabase\.co$/.test(cfg.url) && !!cfg.anonKey;
const BUCKET = 'scb-uploads', MAX_BYTES = 5 * 1024 * 1024, MAX_BODY = 60000;
const STATUS = { draft: '下書き', pending: '審査待ち', approved: '公開中', rejected: '差し戻し' };
let api = null, user = null, admin = false, current = null, pageIdx = 0, pages = [], items = [];

// ---------------------------------------------------------------- layout (port of fanbook.py)
const LINE_UNITS = 40, PAGE_LINES = 18, ITEMS_PER_BOOK = 11, MAX_VOLUMES = 8, MAX_ILL = 12;
const NO_START = new Set('、。，．,.）」』】〕］｝〉》！？!?…‥ー～々ゝゞヽヾぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ・：；');
const HANG = new Set('、。，．,.');
const NO_END = new Set('（「『【〔［｛〈《');
const HEADING = /^(第[一二三四五六七八九十百〇0-9０-９]+[章話節部巻]|プロローグ|エピローグ|序章|終章|幕間|あとがき)/;
const width = ch => { const o = ch.codePointAt(0); if (ch === '　') return 1; if (o < 0x80 || (o >= 0xFF61 && o <= 0xFF9F)) return 0.5; return 1; };
function normalize(t) {
  t = t.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/\t/g, ' ').replace(/ +\n/g, '\n');
  t = t.replace(/(?<=[^\x00-\x7f]) +(?=[^\x00-\x7f])/g, '');
  t = t.replace(/[0-9]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xFEE0)).replace(/!/g, '！').replace(/\?/g, '？').replace(/\(/g, '（').replace(/\)/g, '）');
  return t.replace(/^\n+|\n+$/g, '');
}
function layoutParagraph(text, indent) {
  const lines = []; let cur = '', w = 0; const chars = Array.from((indent ? '　' : '') + text); let i = 0;
  while (i < chars.length) {
    const ch = chars[i], cw = width(ch);
    if (w + cw > LINE_UNITS + 1e-6) {
      if (HANG.has(ch) && w <= LINE_UNITS + 1e-6) { cur += ch; i++; lines.push(cur); cur = ''; w = 0; continue; }
      if (NO_START.has(ch) && cur) { const last = Array.from(cur).pop(); cur = Array.from(cur).slice(0, -1).join(''); lines.push(cur); cur = last; w = width(last); continue; }
      if (cur && NO_END.has(Array.from(cur).pop())) { const last = Array.from(cur).pop(); cur = Array.from(cur).slice(0, -1).join(''); lines.push(cur); cur = last; w = width(last); continue; }
      lines.push(cur); cur = ''; w = 0; continue;
    }
    cur += ch; w += cw; i++;
  }
  if (cur || !lines.length) lines.push(cur);
  return lines;
}
function toLines(body) {
  const out = [];
  for (const raw of normalize(body).split('\n')) {
    const para = raw.replace(/^ +| +$/g, '');
    if (para === '') { if (out.length && out[out.length - 1][0] !== 'b') out.push(['b', '']); continue; }
    if (HEADING.test(para) && Array.from(para).length <= 36) { if (out.length && out[out.length - 1][0] !== 'b') out.push(['b', '']); out.push(['h', para]); continue; }
    const indent = !'「『（(【〔―—'.includes(para[0]);
    for (const ln of layoutParagraph(para, indent)) out.push(['t', ln]);
  }
  return out;
}
function paginate(body) {
  const lines = toLines(body); const res = []; let cur = [];
  const used = p => p.reduce((n, [k]) => n + (k === 'h' ? 2 : 1), 0);
  for (const [kind, text] of lines) {
    const cost = kind === 'h' ? 2 : 1;
    if (cur.length && used(cur) + cost > PAGE_LINES) {
      while (cur.length && cur[cur.length - 1][0] === 'b') cur.pop();
      const tail = cur.length && cur[cur.length - 1][0] === 'h' ? [cur.pop()] : [];
      while (cur.length && cur[cur.length - 1][0] === 'b') cur.pop();
      res.push(cur); cur = tail;
    }
    if (!cur.length && kind === 'b') continue;
    cur.push([kind, text]);
  }
  while (cur.length && cur[cur.length - 1][0] === 'b') cur.pop();
  if (cur.length) res.push(cur);
  return res.length ? res : [[['t', '']]];
}
function buildItems(textPages, ills) {
  const ill = (ills || []).map((x, k) => [Math.max(0, Math.min(x.after | 0, textPages.length)), k, x]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const items = []; let j = 0;
  for (let n = 0; n <= textPages.length; n++) {
    while (j < ill.length && ill[j][0] === n) { items.push({ kind: 'image', image: ill[j][2].image, caption: ill[j][2].caption || '' }); j++; }
    if (n < textPages.length) items.push({ kind: 'text', lines: textPages[n] });
  }
  return items;
}
const volumesOf = items => Math.min(MAX_VOLUMES, Math.max(1, Math.ceil(items.length / ITEMS_PER_BOOK)));

// ---------------------------------------------------------------- helpers
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); e.append(...kids); return e; };
const say = (t, cls = '') => { const m = $('msg'); m.textContent = t; m.className = cls; };
async function rpc(fn, args) { const { data, error } = await api.rpc(fn, args); if (error) throw new Error(error.message); return data; }
const imgUrl = p => { const m = /^assets\/uploads\/(.+)$/.exec(p || ''); return m ? `${cfg.url}/storage/v1/object/public/${BUCKET}/${m[1]}` : ''; };
// pasted text: plain characters only (same idea as the profile editor)
function cleanText(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u2028\u2029\u000b\u000c\u0085]/g, '\n').replace(/\t/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g, '').replace(/[<>]/g, '');
}

// ---------------------------------------------------------------- list
async function loadMine() {
  const rows = (await rpc('scb_fan_mine', {})) || [];
  const box = $('works'); box.replaceChildren();
  if (!rows.length) box.append(el('p', { className: 'muted' }, 'まだ作品がありません。「新しい作品」から始めましょう。'));
  for (const w of rows) {
    const b = el('button', { type: 'button' }, '開く'); b.onclick = () => openEditor(w);
    const card = el('div', { className: 'work' }, el('span', { className: 'st ' + w.status }, STATUS[w.status] || w.status), el('h3', {}, w.title || '（無題）'), el('div', { className: 'muted' }, `${(w.body || '').length.toLocaleString()} 字`));
    if (w.status === 'rejected' && w.admin_note) card.append(el('div', { className: 'err' }, '差し戻し：' + w.admin_note));
    card.append(b); box.append(card);
  }
}

// ---------------------------------------------------------------- editor
function openEditor(w) {
  current = w ? { ...w, illustrations: (w.illustrations || []).map(x => ({ ...x })), art: { ...(w.art || {}) } } : { id: null, title: '', author: '', category: '小説・SS', summary: '', cover: null, body: '', status: 'draft', illustrations: [], art: {} };
  $('editor').hidden = false; $('edTitle').textContent = current.id ? '作品の編集' : '新しい作品';
  $('title').value = current.title; $('author').value = current.author; $('category').value = current.category; $('summary').value = current.summary; $('body').value = current.body;
  $('coverTitle').value = current.art.coverTitle || ''; $('del').hidden = !current.id; showCover(); showArt(); renderIlls(); refresh(); $('editor').scrollIntoView({ behavior: 'smooth' });
}
function showCover() { const b = $('coverBox'); b.replaceChildren(); const u = imgUrl(current.cover); if (u) { const im = el('img', { src: u, alt: '' }); const x = el('button', { type: 'button' }, '表紙を外す'); x.onclick = () => { current.cover = null; showCover(); }; b.append(im, x); } }
function refresh() {
  const body = cleanText($('body').value); pages = paginate(body); const n = Array.from(body).length;
  items = buildItems(pages, current ? current.illustrations : []);
  const vols = volumesOf(items); $('counter').textContent = `${n.toLocaleString()} / ${MAX_BODY.toLocaleString()} 字`; $('counter').className = n > MAX_BODY ? 'err' : '';
  const nill = current ? current.illustrations.length : 0;
  $('volInfo').textContent = n ? `本文 ${pages.length} ページ` + (nill ? ` ＋ 挿絵 ${nill} ページ` : '') + ` → 本 ${vols} 冊（1 冊に最大 ${ITEMS_PER_BOOK} ページ）` + (items.length > ITEMS_PER_BOOK * MAX_VOLUMES ? '。長すぎるため後半は本になりません' : '') : '';
  if (pageIdx >= items.length) pageIdx = items.length - 1; if (pageIdx < 0) pageIdx = 0; drawPage();
}
const ROT = '\u2026\u2025\u2015\u2014\u2500';
function fillCol(div, t) { for (const ch of Array.from(t === '' ? ' ' : t)) { if (ROT.includes(ch)) div.append(el('span', { className: 'rot' }, ch)); else div.append(document.createTextNode(ch)); } }
function drawPage() {
  const pg = $('pg'); pg.replaceChildren(); const it = items[pageIdx];
  if (it && it.kind === 'image') {
    const box = el('div', { className: 'ill' }); const u = imgUrl(it.image); if (u) box.append(el('img', { src: u, alt: '' })); box.append(el('div', {}, it.caption || '（挿絵）')); pg.append(box);
  } else if (it) { for (const [k, t] of it.lines) { const d = el('div', { className: 'ln ' + (k === 'h' ? 'h' : '') }); fillCol(d, t); pg.append(d); } }
  $('pgNo').textContent = `${pageIdx + 1} / ${items.length}`;
}
// ---------------------------------------------------------------- illustrations
function renderIlls() {
  const box = $('ills'); box.replaceChildren(); if (!current) return;
  current.illustrations.forEach((x, i) => {
    const maxAfter = pages.length;
    const pos = el('div', { className: 'pos' }, x.after <= 0 ? '本文の前（扉絵）' : `本文 ${Math.min(x.after, maxAfter)} ページ目のあと`);
    const up = el('button', { type: 'button' }, '↑ 前へ'), dn = el('button', { type: 'button' }, '↓ 後ろへ'), del = el('button', { type: 'button' }, '外す');
    up.disabled = x.after <= 0; dn.disabled = x.after >= maxAfter;
    up.onclick = () => { x.after = Math.max(0, Math.min(x.after, maxAfter) - 1); renderIlls(); refresh(); jumpToIll(i); };
    dn.onclick = () => { x.after = Math.min(maxAfter, x.after + 1); renderIlls(); refresh(); jumpToIll(i); };
    del.onclick = () => { current.illustrations.splice(i, 1); renderIlls(); refresh(); };
    const cap = el('input', { type: 'text', placeholder: 'キャプション（任意・60字まで）', maxLength: 60, value: x.caption || '' }); cap.oninput = () => { x.caption = cleanText(cap.value); };
    box.append(el('div', { className: 'ill-card' }, el('img', { src: imgUrl(x.image), alt: '' }), pos, cap, up, dn, del));
  });
}
function jumpToIll(i) { const k = items.findIndex(it => it.kind === 'image' && it.image === current.illustrations[i].image); if (k >= 0) { pageIdx = k; drawPage(); } }
$('illFile').onchange = async () => {
  const files = Array.from($('illFile').files || []); if (!files.length) return;
  try {
    for (const f of files) {
      if (current.illustrations.length >= MAX_ILL) throw new Error(`挿絵は ${MAX_ILL} 枚までです`);
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[f.type]; if (!ext) throw new Error('PNG / JPG / WebP の画像を選んでください');
      if (f.size > MAX_BYTES) throw new Error('5MB 以下の画像を選んでください');
      const name = `fan-${user.id.replace(/-/g, '')}/${crypto.randomUUID()}.${ext}`;
      const { error } = await api.storage.from(BUCKET).upload(name, f, { contentType: f.type, upsert: false }); if (error) throw new Error('アップロード失敗: ' + error.message);
      current.illustrations.push({ image: 'assets/uploads/' + name, caption: '', after: pages.length });
    }
    say('挿絵をアップロードしました。保存で確定します。');
  } catch (e) { say(e.message, 'err'); }
  $('illFile').value = ''; renderIlls(); refresh();
};
$('prev').onclick = () => { if (pageIdx > 0) { pageIdx--; drawPage(); } };
$('next').onclick = () => { if (pageIdx < items.length - 1) { pageIdx++; drawPage(); } };
$('body').addEventListener('input', () => { pageIdx = 0; refresh(); renderIlls(); });
$('body').addEventListener('paste', () => setTimeout(() => { const c = cleanText($('body').value); if (c !== $('body').value) { $('body').value = c; } pageIdx = 0; refresh(); }, 0));
$('newWork').onclick = () => openEditor(null);
$('txtFile').onchange = async () => { const f = $('txtFile').files[0]; if (!f) return; $('body').value = cleanText(await f.text()); pageIdx = 0; refresh(); };
$('coverFile').onchange = async () => {
  const f = $('coverFile').files[0]; if (!f) return;
  try {
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[f.type]; if (!ext) throw new Error('PNG / JPG / WebP の画像を選んでください');
    if (f.size > MAX_BYTES) throw new Error('5MB 以下の画像を選んでください');
    const name = `fan-${user.id.replace(/-/g, '')}/${crypto.randomUUID()}.${ext}`;
    const { error } = await api.storage.from(BUCKET).upload(name, f, { contentType: f.type, upsert: false }); if (error) throw new Error('アップロード失敗: ' + error.message);
    current.cover = 'assets/uploads/' + name; showCover(); say('表紙をアップロードしました。保存で確定します。');
  } catch (e) { say(e.message, 'err'); }
};
// own front cover / back cover / spine pictures (they replace the automatic cover design)
const ART = [['front', 'artFront', 'artFrontBox', '表紙'], ['back', 'artBack', 'artBackBox', '裏表紙'], ['spine', 'artSpine', 'artSpineBox', '背表紙']];
function showArt() {
  for (const [key, , boxId, label] of ART) {
    const b = $(boxId); b.replaceChildren(); const u = imgUrl(current.art[key]);
    if (u) { const x = el('button', { type: 'button' }, label + 'を外す'); x.onclick = () => { delete current.art[key]; showArt(); }; b.append(el('img', { src: u, alt: '' }), x); }
  }
}
for (const [key, inputId, , label] of ART) {
  $(inputId).onchange = async () => {
    const f = $(inputId).files[0]; if (!f) return;
    try {
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[f.type]; if (!ext) throw new Error('PNG / JPG / WebP の画像を選んでください');
      if (f.size > MAX_BYTES) throw new Error('5MB 以下の画像を選んでください');
      const name = `fan-${user.id.replace(/-/g, '')}/${crypto.randomUUID()}.${ext}`;
      const { error } = await api.storage.from(BUCKET).upload(name, f, { contentType: f.type, upsert: false }); if (error) throw new Error('アップロード失敗: ' + error.message);
      current.art[key] = 'assets/uploads/' + name; showArt(); say(label + 'をアップロードしました。保存で確定します。');
    } catch (e) { say(e.message, 'err'); }
    $(inputId).value = '';
  };
}
function artPayload() {
  const a = {}; for (const [key] of ART) if (current.art[key]) a[key] = current.art[key];
  const t = cleanText($('coverTitle').value).replace(/^\n+|\n+$/g, '').slice(0, 60); if (t) a.coverTitle = t;
  return a;
}
async function save(submit) {
  const body = cleanText($('body').value), title = cleanText($('title').value).trim();
  if (!title) return say('タイトルを入力してください', 'err');
  if (Array.from(body).length > MAX_BODY) return say(`本文は ${MAX_BODY.toLocaleString()} 字までです`, 'err');
  if (submit && Array.from(body).length < 200) return say('本文が短すぎます（200 字以上で審査に出せます）', 'err');
  try {
    const r = await rpc('scb_fan_save', { p_id: current.id, p_title: title, p_author: cleanText($('author').value).trim(), p_category: $('category').value, p_summary: cleanText($('summary').value), p_cover: current.cover, p_body: body, p_submit: submit, p_illust: current.illustrations.map(x => ({ image: x.image, caption: cleanText(x.caption || ''), after: Math.min(x.after, pages.length) })), p_art: artPayload() });
    current.id = r.id; current.status = r.status; say(submit ? '審査に出しました。承認されると本になります。' : '下書きを保存しました。', 'ok');
    await loadMine(); $('del').hidden = false;
  } catch (e) { say('保存できませんでした: ' + e.message, 'err'); }
}
$('saveDraft').onclick = () => save(false);
$('submit').onclick = () => save(true);
$('del').onclick = async () => {
  if (!current.id || !confirm('この作品を削除します。元に戻せません。よろしいですか？')) return;
  try { await rpc('scb_fan_delete', { p_id: current.id }); $('editor').hidden = true; current = null; say(''); await loadMine(); if (admin) await loadPending(); } catch (e) { say('削除できませんでした: ' + e.message, 'err'); }
};

// ---------------------------------------------------------------- administrator review
async function loadPending() {
  const rows = (await rpc('scb_fan_pending', {})) || []; const box = $('pending'); box.replaceChildren();
  if (!rows.length) box.append(el('p', { className: 'muted' }, '審査待ちの作品はありません。'));
  for (const w of rows) {
    const note = el('input', { type: 'text', placeholder: '差し戻しの理由（任意・300字まで）', maxLength: 300 });
    const ok = el('button', { type: 'button' }, '承認する'), ng = el('button', { type: 'button' }, '差し戻す');
    const decide = async yes => { try { await rpc('scb_fan_decide', { p_id: w.id, p_ok: yes, p_note: yes ? '' : cleanText(note.value) }); await loadPending(); await loadMine(); } catch (e) { alert('処理できませんでした: ' + e.message); } };
    ok.onclick = () => decide(true); ng.onclick = () => decide(false);
    const its = buildItems(paginate(w.body || ''), w.illustrations || []); const n = its.length;
    box.append(el('div', { className: 'pend' }, el('strong', {}, w.title), el('span', { className: 'muted' }, `　${w.author || '（作者名なし）'} ・ ${w.category} ・ ${(w.body || '').length.toLocaleString()} 字（${n} ページ → ${volumesOf(its)} 冊、挿絵 ${(w.illustrations || []).length} 枚${Object.keys(w.art || {}).length ? '、本の外側：' + Object.keys(w.art).join('/') : ''}）`),
      el('p', {}, w.summary || ''), el('details', {}, el('summary', {}, '本文を読む'), el('pre', {}, w.body || '')), note, ok, ng));
  }
}

// ---------------------------------------------------------------- start
async function start() {
  try {
    const { data: { user: u }, error } = await api.auth.getUser(); if (error && error.name !== 'AuthSessionMissingError') throw error; user = u;
    $('login').hidden = !!user; $('logout').hidden = !user; $('who').textContent = user ? 'ログイン中：' + (user.email || user.id) : '未ログイン';
    if (!user) return;
    admin = (await rpc('is_scb_super_admin')) === true; $('priv').textContent = admin ? '権限：super_admin（審査もできます）' : '権限：メンバー';
    try { await loadMine(); } catch (e) { if (/scb_fan_mine|PGRST202|404/.test(e.message)) throw new Error('この機能はまだ使えません（SQL 21 を実行してください）'); throw e; }
    $('panel').hidden = false;
    if (admin) { $('adminBox').hidden = false; await loadPending(); }
  } catch (e) { $('who').textContent = '初期化に失敗しました: ' + e.message; $('who').className = 'err'; }
}
$('login').disabled = !ready;
if (!ready) $('who').textContent = 'Supabase の接続先が未設定です。studio/config.js を設定してください。';
else {
  api = createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  $('login').onclick = async () => { const { error } = await api.auth.signInWithOAuth({ provider: 'discord', options: { redirectTo: location.origin + location.pathname, scopes: 'identify' } }); if (error) say(error.message, 'err'); };
  $('logout').onclick = async () => { await api.auth.signOut(); location.reload(); };
  start();
}
