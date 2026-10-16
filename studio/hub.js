// Admin hub: one page with every tool, the open work, and the state of the automatic publisher.
// Everything here is a convenience; each action is checked again by the database.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

const $ = id => document.getElementById(id);
const cfg = window.SCB_SUPABASE_CONFIG || {};
const ready = /^https:\/\/[\w-]+\.supabase\.co$/.test(cfg.url) && !!cfg.anonKey;
const REPO = 'himurosuiu/scb-library';
let api = null;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const fmt = iso => iso ? new Date(iso).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '';
const count = async (fn, args) => { const { data, error } = await api.rpc(fn, args); if (error) throw error; return Array.isArray(data) ? data.length : 0; };

async function loadRuns() {
  const list = $('runs'), badge = $('pubBadge');
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/publish.yml/runs?per_page=5`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const runs = (await r.json()).workflow_runs || [];
    list.replaceChildren();
    for (const run of runs) {
      const li = el('li');
      const state = run.status !== 'completed' ? '実行中' : run.conclusion === 'success' ? '成功' : '失敗';
      const b = el('span', 'badge ' + (run.status !== 'completed' ? '' : run.conclusion === 'success' ? 'ok' : 'bad'), state);
      const a = el('a', '', fmt(run.created_at) + (run.event === 'schedule' ? '（自動）' : '（手動）')); a.href = run.html_url; a.target = '_blank'; a.rel = 'noopener';
      li.append(b, document.createTextNode(' '), a); list.append(li);
    }
    const last = runs[0];
    if (!last) { badge.textContent = '履歴なし'; return; }
    badge.textContent = last.status !== 'completed' ? '実行中' : last.conclusion === 'success' ? '直近：成功' : '直近：失敗（要確認）';
    badge.className = 'badge ' + (last.status !== 'completed' ? '' : last.conclusion === 'success' ? 'ok' : 'bad');
  } catch (e) { badge.textContent = '取得できません'; list.replaceChildren(el('li', 'muted', 'GitHub の状況を読み込めませんでした（' + e.message + '）。Actions 画面を直接開いてください。')); }
}

async function loadAdmin() {
  $('adminPanel').hidden = false;
  const note = $('adminNote');
  try { const n = await count('scb_list_drafts'); $('nDrafts').textContent = n; if (n) $('nDrafts').parentElement.classList.add('hot'); } catch (e) { $('nDrafts').textContent = '?'; }
  try { $('nRels').textContent = await count('scb_admin_relation_queue'); } catch (e) { $('nRels').textContent = '?'; note.textContent = '関係の審査数は SQL 07 の実行後に表示されます。'; }
  try { $('nEditors').textContent = await count('scb_list_editors', { cid: null }); } catch (e) { $('nEditors').textContent = '?'; }
  loadRuns();
}

async function loadMember(admin) {
  const box = $('myChars'); box.replaceChildren();
  const { data: items, error } = await api.from('character_records').select('id,data').order('id');
  if (error) { $('myNote').textContent = '人物を読み込めませんでした: ' + error.message; $('memberPanel').hidden = false; return; }
  let mine = 0;
  for (const p of items) {
    let ok = admin;
    if (!admin) { const { data: yes } = await api.rpc('can_edit_scb_character', { cid: p.id }); ok = yes === true; }
    if (!ok) continue;
    mine++;
    if (admin && mine > 12) continue;                // administrators can edit everyone: show a few, the editor lists the rest
    const a = el('a', 'card'); a.href = './';
    a.append(el('strong', '', p.data.name || p.id), el('span', '', p.id));
    box.append(a);
  }
  $('memberPanel').hidden = false;
  $('myNote').textContent = admin ? `管理者はすべての人物（${items.length} 名）を編集できます。「人物の編集」から選んでください。`
    : (mine ? '' : 'まだ担当の人物がありません。管理者に「ログインしました。Discord の表示名は ○○ です」と連絡して、割り当てを依頼してください。');
}

async function start() {
  try {
    const { data: { user }, error } = await api.auth.getUser();
    if (error && error.name !== 'AuthSessionMissingError') throw error;
    $('login').hidden = !!user; $('logout').hidden = !user;
    $('who').textContent = user ? 'ログイン中：' + (user.email || user.id) : '未ログイン';
    if (!user) return;
    const { data: role, error: er } = await api.rpc('is_scb_super_admin');
    if (er) throw er;
    const admin = role === true;
    $('priv').textContent = admin ? '権限：super_admin（すべての管理機能）' : '権限：編集者（担当人物のみ）';
    $('dir').hidden = false;
    if (!admin) { for (const c of $('adminCards').querySelectorAll('a')) c.classList.add('soon'); for (const c of document.querySelectorAll('#dir .cards')) { /* external admin links stay visible but need an account anyway */ } }
    const m = /^https:\/\/([\w-]+)\.supabase\.co$/.exec(cfg.url); if (m && admin) $('sbLink').href = 'https://supabase.com/dashboard/project/' + m[1];
    if (admin) loadAdmin();
    await loadMember(admin);
  } catch (e) { $('who').textContent = '初期化に失敗しました: ' + e.message; $('who').className = 'err'; }
}

$('login').disabled = !ready;
if (!ready) { $('who').textContent = 'Supabase の接続先が未設定です。studio/config.js を設定してください。'; }
else {
  api = createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  $('login').onclick = async () => { const { error } = await api.auth.signInWithOAuth({ provider: 'discord', options: { redirectTo: location.origin + location.pathname, scopes: 'identify' } }); if (error) $('who').textContent = error.message; };
  $('logout').onclick = async () => { await api.auth.signOut(); location.reload(); };
  start();
}
