// Editor assignment (super admin only). The server re-checks every call; this page is only a convenience.
// Library version is pinned on purpose (no floating @2).
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

const $ = id => document.getElementById(id);
const cfg = window.SCB_SUPABASE_CONFIG || {};
const ready = /^https:\/\/[\w-]+\.supabase\.co$/.test(cfg.url) && !!cfg.anonKey;
let api = null, people = [], users = [], editors = [];

const say = (text, cls = '') => { const m = $('msg'); m.textContent = text; m.className = cls; };
const fmt = iso => iso ? new Date(iso).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '';
const label = (name, id) => (name && name.trim() ? name : '（名前なし）') + (id ? '  ·  ' + id : '');
const cell = (text, cls) => { const td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; return td; };
const need = (res) => { if (res.error) throw new Error(res.error.message); return res.data; };

$('login').disabled = !ready;
if (!ready) {
  $('who').textContent = 'Supabase の接続先が未設定です。studio/config.js を設定してください。';
} else {
  api = createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  start();
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
    people = need(await api.from('character_records').select('id,data').order('id'));
    users = need(await api.rpc('scb_list_users'));
    const sel = $('person'); sel.replaceChildren();
    for (const p of people) sel.add(new Option(`${p.data.name}（${p.id}）`, p.id));
    sel.onchange = loadEditors;
    $('panel').hidden = false;
    await loadEditors();
    await loadAudit();
  } catch (e) { $('who').textContent = '初期化に失敗しました: ' + e.message; $('who').className = 'err'; }
}

async function loadEditors() {
  const cid = $('person').value; if (!cid) return;
  const p = people.find(x => x.id === cid);
  $('personTitle').textContent = p ? p.data.name : cid;
  editors = need(await api.rpc('scb_list_editors', { cid }));
  const body = $('editors'); body.replaceChildren();
  for (const e of editors) {
    const tr = document.createElement('tr');
    tr.append(cell(e.display_name && e.display_name.trim() ? e.display_name : '（名前なし）'), cell(e.discord_id || ''), cell(fmt(e.created_at)));
    const td = document.createElement('td'); const b = document.createElement('button');
    b.type = 'button'; b.className = 'danger'; b.textContent = '解除';
    b.onclick = () => removeEditor(cid, e);
    td.append(b); tr.append(td); body.append(tr);
  }
  $('noEditors').hidden = editors.length > 0;
  const taken = new Set(editors.map(e => e.user_id));
  const cand = $('candidate'); cand.replaceChildren();
  const free = users.filter(u => u.discord_id && !taken.has(u.user_id));
  if (!free.length) cand.add(new Option('追加できるアカウントがありません', ''));
  for (const u of free) cand.add(new Option(label(u.display_name, u.discord_id), u.user_id));
  $('assign').disabled = !free.length;
  say('');
}

$('assign').onclick = async () => {
  const cid = $('person').value, uid = $('candidate').value; if (!cid || !uid) return;
  $('assign').disabled = true;
  try {
    const r = need(await api.rpc('scb_assign_editor', { cid, uid }));
    say(r.alreadyAssigned ? 'すでに割り当て済みです。' : '編集者に追加しました。', 'ok');
    users = need(await api.rpc('scb_list_users'));
    await loadEditors(); await loadAudit();
    say(r.alreadyAssigned ? 'すでに割り当て済みです。' : '編集者に追加しました。', 'ok');
  } catch (e) { say('追加に失敗しました: ' + e.message, 'err'); }
  finally { $('assign').disabled = false; }
};

async function removeEditor(cid, e) {
  const who = (e.display_name && e.display_name.trim()) || e.discord_id || e.user_id;
  if (!confirm(`${who} の編集権限を、この人物から解除しますか？\n（保存済みの草稿は削除されません）`)) return;
  try {
    const r = need(await api.rpc('scb_remove_editor', { cid, uid: e.user_id }));
    await loadEditors(); await loadAudit();
    say(r.wasAssigned ? '解除しました。' : 'すでに解除済みでした。', 'ok');
  } catch (err) { say('解除に失敗しました: ' + err.message, 'err'); }
}

async function loadAudit() {
  try {
    const rows = need(await api.rpc('scb_list_audit', { lim: 30 }));
    const body = $('audit'); body.replaceChildren();
    const names = { assign_editor: '編集者を追加', remove_editor: '編集者を解除', commit_draft: '草稿を承認' };
    for (const a of rows) {
      const tr = document.createElement('tr');
      let detail = names[a.action] || a.action;
      if (a.action === 'commit_draft' && a.details && Array.isArray(a.details.fields)) detail += `（${a.details.fields.join(', ')} / rev ${a.details.revision}）`;
      tr.append(cell(fmt(a.at)), cell(a.actor_name || a.actor || ''), cell(detail), cell([a.character_id, a.target_name].filter(Boolean).join(' / ')));
      body.append(tr);
    }
    $('noAudit').hidden = rows.length > 0;
  } catch (e) { say('監査ログを読み込めません: ' + e.message, 'err'); }
}

$('login').onclick = async () => {
  const redirectTo = location.origin + location.pathname;
  const { error } = await api.auth.signInWithOAuth({ provider: 'discord', options: { redirectTo, scopes: 'identify' } });
  if (error) say(error.message, 'err');
};
$('logout').onclick = async () => { await api.auth.signOut(); location.reload(); };
$('refreshAudit').onclick = loadAudit;
