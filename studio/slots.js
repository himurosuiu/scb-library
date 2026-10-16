// Book slots editor (administrator only). The server checks every call again.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

const $ = id => document.getElementById(id);
const cfg = window.SCB_SUPABASE_CONFIG || {};
const ready = /^https:\/\/[\w-]+\.supabase\.co$/.test(cfg.url) && !!cfg.anonKey;
const WORLD_BOOKS = 48;           // person-001 ... person-048 exist in the World. Raise this when more books are added in Unity.
let api = null, people = [], slots = [];

const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); e.append(...kids); return e; };
const say = (t, cls = '') => { const m = $('msg'); m.textContent = t; m.className = cls; };
const nameOf = id => (people.find(p => p.id === id) || { data: { name: id } }).data.name || id;
const num = slot => parseInt(slot.slice(-3), 10);

async function rpc(fn, args) {
  const { data, error } = await api.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

async function load() {
  const [pr, sr] = await Promise.all([
    api.from('character_records').select('id,data').order('id'),
    api.from('book_slots_public').select('slot,person_id,spreads,cover_name,spine_text').order('slot')]);
  if (pr.error) throw pr.error;
  if (sr.error) throw new Error(sr.error.code === 'PGRST205' ? '書位テーブルがまだありません（SQL 11 を実行してください）' : sr.error.message);
  people = pr.data; slots = sr.data;
  render();
}

function personSelect(value, slot) {
  const used = new Map(slots.map(s => [s.person_id, s.slot]));
  const sel = el('select');
  for (const p of people) {
    const other = used.get(p.id);
    sel.add(new Option(`${p.data.name}（${p.id}）${other && other !== slot ? ' ※' + other + ' に割り当て済み' : (!other ? ' ※未割り当て' : '')}`, p.id));
  }
  sel.value = value;
  return sel;
}

function render() {
  $('worldMax').textContent = String(WORLD_BOOKS).padStart(3, '0');
  const body = $('rows'); body.replaceChildren();
  for (const s of slots) {
    const tr = el('tr', { className: num(s.slot) > WORLD_BOOKS ? 'warn' : '' });
    const sel = personSelect(s.person_id, s.slot);
    const sp = el('input', { type: 'number', min: 1, max: 12, value: s.spreads });
    const cv = el('input', { value: s.cover_name || '', maxLength: 60, placeholder: nameOf(s.person_id) });
    const spn = el('input', { value: s.spine_text || '', maxLength: 40, placeholder: '自動' });
    const save = el('button', { type: 'button' }, '保存'), del = el('button', { type: 'button' }, '削除');
    const mark = () => tr.classList.add('dirty');
    for (const x of [sel, sp, cv, spn]) { x.oninput = mark; x.onchange = mark; }
    save.onclick = async () => {
      try {
        const r = await rpc('scb_admin_save_slot', { p_slot: s.slot, p_person: sel.value, p_spreads: Number(sp.value), p_cover: cv.value.trim(), p_spine: spn.value.trim() });
        if (r && r.ok === false && r.error === 'person_in_other_slot') { say(`${nameOf(sel.value)} はすでに ${r.slot} に入っています。入れ替えを使ってください。`, 'err'); return; }
        say(`${s.slot} を保存しました。`, 'ok'); await load();
      } catch (e) { say('保存できませんでした: ' + e.message, 'err'); }
    };
    del.onclick = async () => {
      if (!confirm(`${s.slot}（${nameOf(s.person_id)}）を削除しますか？ World ではその本が表示されなくなります。`)) return;
      try { await rpc('scb_admin_delete_slot', { p_slot: s.slot }); say(`${s.slot} を削除しました。`, 'ok'); await load(); }
      catch (e) { say('削除できませんでした: ' + e.message, 'err'); }
    };
    const idCell = el('td', { className: 'slotid' }, s.slot);
    if (num(s.slot) > WORLD_BOOKS) idCell.append(el('div', { className: 'sub err' }, 'World に本なし'));
    tr.append(idCell, el('td', {}, sel), el('td', {}, sp), el('td', {}, cv), el('td', {}, spn), el('td', {}, save, del));
    body.append(tr);
  }
  for (const id of ['swapA', 'swapB']) {
    const sel = $(id); const keep = sel.value; sel.replaceChildren();
    for (const s of slots) sel.add(new Option(`${s.slot}　${nameOf(s.person_id)}`, s.slot));
    if (keep) sel.value = keep;
  }
  if (!$('swapB').value && slots[1]) $('swapB').value = slots[1].slot;
}

$('add').onclick = async () => {
  const next = Math.max(0, ...slots.map(s => num(s.slot))) + 1;
  if (next > 100) { say('スロットは person-100 までです。', 'err'); return; }
  const used = new Set(slots.map(s => s.person_id));
  const free = people.find(p => !used.has(p.id));
  if (!free) { say('未割り当ての人物がいません。先に「人物の追加」で人物を作ってください。', 'err'); return; }
  const id = 'person-' + String(next).padStart(3, '0');
  try {
    await rpc('scb_admin_save_slot', { p_slot: id, p_person: free.id, p_spreads: 6, p_cover: '', p_spine: '' });
    say(`${id} に ${free.data.name} を追加しました。` + (next > WORLD_BOOKS ? '（World に本のオブジェクトを追加するまで World には出ません）' : ''), 'ok'); await load();
  } catch (e) { say('追加できませんでした: ' + e.message, 'err'); }
};
$('reload').onclick = () => load().then(() => say('')).catch(e => say(e.message, 'err'));
$('swap').onclick = async () => {
  const a = $('swapA').value, b = $('swapB').value;
  if (!a || !b || a === b) { say('別々のスロットを選んでください。', 'err'); return; }
  try { await rpc('scb_admin_swap_slots', { a, b }); say(`${a} と ${b} の人物を入れ替えました。`, 'ok'); await load(); }
  catch (e) { say('入れ替えできませんでした: ' + e.message, 'err'); }
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
