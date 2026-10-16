// Draft review (super admin only). The server re-checks every call; this page is only a convenience.
// Library version is pinned on purpose (no floating @2).
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

const $ = id => document.getElementById(id);
const cfg = window.SCB_SUPABASE_CONFIG || {};
const ready = /^https:\/\/[\w-]+\.supabase\.co$/.test(cfg.url) && !!cfg.anonKey;
const LABELS = { name: '名前', nameKana: 'よみがな', romaji: 'ローマ字', kind: '区分', grade: '学年', club: '所属', status: '在籍状況', group: '副題', color: '代表色', portrait: '肖像画像', fullBody: '全身画像', gallery: 'ギャラリー', species: '種族', height: '身長', likes: '好きなもの', dislikes: '苦手なもの', firstPerson: '一人称', secondPerson: '二人称', about: '人物紹介', outfits: 'ギャラリー（衣装別）' };
const ORDER = Object.keys(LABELS);
const VALUE_WORDS = { student: '生徒', teacher: '教員', active: '在籍中', graduated: '卒業' };
const SAFE_IMG = /^assets\/[A-Za-z0-9_./-]+$/;
let api = null;

const say = (text, cls = '') => { const m = $('msg'); m.textContent = text; m.className = cls; };
const fmt = iso => iso ? new Date(iso).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '';
const need = res => { if (res.error) throw new Error(res.error.message); return res.data; };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

// Pending uploads live in Storage until the administrator publishes them into assets/.
function thumbFor(path) {
  if (typeof path !== 'string' || !SAFE_IMG.test(path) || path.includes('..')) return null;
  const m = /^assets\/uploads\/(.+)$/.exec(path);
  const img = el('img', 'thumb'); img.alt = ''; img.loading = 'lazy';
  img.src = m ? `${cfg.url}/storage/v1/object/public/scb-uploads/${m[1]}` : '../' + path;
  img.onerror = () => img.remove();
  return img;
}

function valueCell(key, v, cls) {
  const td = el('td', cls);
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) { td.textContent = '（なし）'; td.classList.add('muted'); return td; }
  if (key === 'color' && typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) { const sw = el('span', 'sw'); sw.style.background = v; td.append(sw, document.createTextNode(v)); return td; }
  if (key === 'outfits' && Array.isArray(v)) {
    for (const o of v) {
      td.append(el('div', '', '■ ' + (o && o.label ? o.label : '（衣装名なし）')));
      const row = el('div'); row.style.display = 'flex'; row.style.flexWrap = 'wrap'; row.style.gap = '.3rem';
      for (const path of (o && Array.isArray(o.images) ? o.images : [])) { const t = thumbFor(path); if (t) row.append(t); }
      td.append(row);
    }
    return td;
  }
  if (Array.isArray(v)) { td.textContent = v.join('\n'); td.style.whiteSpace = 'pre-line'; return td; }
  td.textContent = VALUE_WORDS[v] ? `${VALUE_WORDS[v]}（${v}）` : String(v);
  if (key === 'about') td.style.whiteSpace = 'pre-wrap';
  if ((key === 'portrait' || key === 'fullBody') && typeof v === 'string') { const t = thumbFor(v); if (t) td.append(t); }
  return td;
}

function card(d) {
  const root = el('div', 'cloud-box draft');
  const head = el('h3', '', `${d.character_name || d.character_id}`);
  const sub = el('div', 'sub', `${d.character_id} ／ 編集者：${(d.display_name && d.display_name.trim()) || '（名前なし）'}${d.discord_id ? '（' + d.discord_id + '）' : ''} ／ 保存：${fmt(d.updated_at)}`);
  const badges = el('div');
  const hasConflict = Object.keys(d.conflicts || {}).length > 0;
  if (hasConflict) badges.append(el('span', 'badge bad', '衝突あり：承認できません'));
  if (d.unchanged) badges.append(el('span', 'badge mute', '公開中の値と同じ（承認しても変更なし）'));
  if (Number(d.current_revision) !== Number(d.base_revision)) badges.append(el('span', 'badge mute', `公開データは更新済み（草稿の基準 rev ${d.base_revision} → 現在 rev ${d.current_revision}）`));
  root.append(head, sub, badges);

  const table = el('table', 'diff'); const thead = el('thead'); const hr = el('tr');
  for (const t of ['項目', '草稿の基準だった値', '公開中の値（現在）', '草稿の値']) hr.append(el('th', '', t));
  thead.append(hr); table.append(thead); const tb = el('tbody');
  const keys = Object.keys(d.changes || {}).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  for (const k of keys) {
    const tr = document.createElement('tr'); if (d.conflicts && d.conflicts[k]) tr.className = 'conflict';
    tr.append(el('td', '', LABELS[k] || k), valueCell(k, d.base_values ? d.base_values[k] : null, 'before'), valueCell(k, d.current_values ? d.current_values[k] : null, 'before'), valueCell(k, d.changes[k], 'after'));
    tb.append(tr);
  }
  table.append(tb); root.append(table);

  const approve = el('button', '', '承認（データベースへ反映）'); approve.type = 'button'; approve.disabled = hasConflict;
  const reject = el('button', 'danger', '却下'); reject.type = 'button';
  approve.onclick = () => commit(d, approve, reject);
  reject.onclick = () => rejectDraft(d, approve, reject);
  root.append(approve, reject);
  return root;
}

async function load() {
  const list = need(await api.rpc('scb_list_drafts'));
  const box = $('drafts'); box.replaceChildren();
  for (const d of list) box.append(card(d));
  $('none').hidden = list.length > 0;
  $('count').textContent = list.length ? `${list.length} 件の草稿` : '';
}

async function commit(d, approve, reject) {
  const who = (d.display_name && d.display_name.trim()) || '編集者';
  if (!confirm(`${d.character_name || d.character_id} への ${who} の草稿を承認し、データベースに反映しますか？\n（公開サイトと World は、公開コマンドを実行するまで変わりません）`)) return;
  approve.disabled = reject.disabled = true;
  try {
    const r = need(await api.rpc('commit_scb_draft', { cid: d.character_id, draft_owner: d.user_id }));
    if (r.ok && r.nochange) say('公開中の値と同じだったため、変更なしで草稿を片付けました。', 'ok');
    else if (r.ok) say(`承認しました（revision ${r.revision}）。サイトと World に反映するには publish_from_db.py を実行してください。`, 'ok');
    else if (r.conflicts) say('衝突があるため承認できませんでした。却下するか、編集者に再編集を依頼してください。', 'err');
    else if (r.invalid) say('草稿の値が規則に合わないため承認できませんでした: ' + r.invalid, 'err');
    else say('承認できませんでした。', 'err');
    const msg = $('msg').textContent, cls = $('msg').className;
    await load(); say(msg, cls);
  } catch (e) { say('承認に失敗しました: ' + e.message, 'err'); approve.disabled = reject.disabled = false; }
}

async function rejectDraft(d, approve, reject) {
  const reason = prompt('却下の理由（任意・200字まで。空欄でも可）', '');
  if (reason === null) return;                      // cancelled
  approve.disabled = reject.disabled = true;
  try {
    const r = need(await api.rpc('scb_reject_draft', { cid: d.character_id, draft_owner: d.user_id, reason: reason.trim() || null }));
    const text = r.wasPresent ? '草稿を却下しました。' : 'すでに片付けられていました。';
    await load(); say(text, 'ok');
  } catch (e) { say('却下に失敗しました: ' + e.message, 'err'); approve.disabled = reject.disabled = false; }
}

async function start() {
  try {
    const { data: { user }, error } = await api.auth.getUser();
    if (error && error.name !== 'AuthSessionMissingError') throw error;
    $('login').hidden = !!user; $('logout').hidden = !user;
    $('who').textContent = user ? 'ログイン中：' + (user.email || user.id) : '未ログイン';
    if (!user) return;
    const admin = need(await api.rpc('is_scb_super_admin')) === true;
    $('priv').textContent = admin ? '権限：super_admin' : '権限：super_admin ではありません。この画面は使えません。';
    $('priv').className = admin ? 'ok' : 'err';
    if (!admin) return;
    $('panel').hidden = false;
    await load();
  } catch (e) { $('who').textContent = '初期化に失敗しました: ' + e.message; $('who').className = 'err'; }
}

$('login').disabled = !ready;
if (!ready) { $('who').textContent = 'Supabase の接続先が未設定です。studio/config.js を設定してください。'; }
else {
  api = createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  $('login').onclick = async () => {
    const { error } = await api.auth.signInWithOAuth({ provider: 'discord', options: { redirectTo: location.origin + location.pathname, scopes: 'identify' } });
    if (error) say(error.message, 'err');
  };
  $('logout').onclick = async () => { await api.auth.signOut(); location.reload(); };
  $('reload').onclick = async () => { try { await load(); say(''); } catch (e) { say('更新に失敗しました: ' + e.message, 'err'); } };
  start();
}
