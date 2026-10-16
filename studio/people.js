// Create / delete people (administrator only). The server checks every call again.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

const $ = id => document.getElementById(id);
const cfg = window.SCB_SUPABASE_CONFIG || {};
const ready = /^https:\/\/[\w-]+\.supabase\.co$/.test(cfg.url) && !!cfg.anonKey;
let api = null, people = [], slotOf = new Map();

const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); e.append(...kids); return e; };
const say = (t, cls = '') => { const m = $('msg'); m.textContent = t; m.className = cls; };
async function rpc(fn, args) { const { data, error } = await api.rpc(fn, args); if (error) throw new Error(error.message); return data; }

async function load() {
  const pr = await api.from('character_records').select('id,data').order('id');
  if (pr.error) throw pr.error;
  people = pr.data;
  const sr = await api.from('book_slots_public').select('slot,person_id');
  slotOf = new Map((sr.error ? [] : sr.data).map(s => [s.person_id, s.slot]));
  render();
}

function render() {
  const body = $('rows'); body.replaceChildren();
  for (const p of people) {
    const d = p.data;
    const del = el('button', { type: 'button' }, '削除');
    del.onclick = () => remove(p);
    body.append(el('tr', {}, el('td', {}, d.name || '（名前なし）'), el('td', { className: 'id' }, p.id),
      el('td', {}, (d.kind === 'teacher' ? '教員' : '生徒') + (d.grade ? '・' + d.grade : '')), el('td', {}, slotOf.get(p.id) || '–'), el('td', {}, del)));
  }
}

async function remove(p) {
  const typed = prompt(`${p.data.name}（${p.id}）を削除します。確認のため ID を入力してください。`, '');
  if (typed === null) return;
  if (typed.trim() !== p.id) { say('ID が一致しないため、削除しませんでした。', 'err'); return; }
  try {
    let r = await rpc('scb_admin_delete_person', { p_id: p.id, p_force: false });
    if (r && r.ok === false && r.error === 'has_slot') { say(`${p.data.name} は ${r.slot} の本になっています。先に書位を削除してください。`, 'err'); return; }
    if (r && r.ok === false && r.error === 'has_relations') {
      if (!confirm(`${p.data.name} には関係が ${r.count} 件あります。関係も一緒に削除しますか？`)) { say('削除をやめました。'); return; }
      r = await rpc('scb_admin_delete_person', { p_id: p.id, p_force: true });
    }
    if (r && r.ok) { say(`${p.data.name} を削除しました。`, 'ok'); await load(); }
    else say('削除できませんでした。', 'err');
  } catch (e) { say('削除できませんでした: ' + e.message, 'err'); }
}

$('create').onclick = async () => {
  const id = $('nId').value.trim(), name = $('nName').value.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) { say('ID は英小文字・数字・ハイフンだけで入力してください。', 'err'); return; }
  if (!name) { say('名前を入力してください。', 'err'); return; }
  const color = $('nColor').value.trim();
  if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) { say('カラーは #RRGGBB 形式で入力してください。', 'err'); return; }
  const data = { name, nameKana: $('nKana').value.trim(), romaji: $('nRomaji').value.trim(), kind: $('nKind').value, grade: $('nGrade').value.trim(), club: $('nClub').value.trim(), color: color || null };
  try {
    const r = await rpc('scb_admin_create_person', { p_id: id, p_data: data });
    if (r && r.ok === false && r.error === 'exists') { say(`ID「${id}」はすでに使われています。`, 'err'); return; }
    say(`${name} を作成しました。次は編集者の割り当てと書位の設定です。`, 'ok');
    for (const x of ['nId', 'nName', 'nKana', 'nRomaji', 'nGrade', 'nClub', 'nColor']) $(x).value = '';
    await load();
  } catch (e) { say('作成できませんでした: ' + e.message, 'err'); }
};

async function start() {
  try {
    const { data: { user }, error } = await api.auth.getUser();
    if (error && error.name !== 'AuthSessionMissingError') throw error;
    $('login').hidden = !!user; $('logout').hidden = !user;
    $('who').textContent = user ? 'ログイン中：' + (user.email || user.id) : '未ログイン';
    if (!user) return;
    const admin = (await rpc('is_scb_super_admin')) === true;
    $('priv').textContent = admin ? '権限：super_admin' : '権限：super_admin ではありません。この画面は使えません。';
    if (!admin) return;
    $('panel').hidden = false;
    await load();
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
