// Website art slots (administrator only): replace an image and/or move its focus point. Only changed slots are saved (setting 'site.art').
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

const $ = id => document.getElementById(id);
const cfg = window.SCB_SUPABASE_CONFIG || {};
const ready = /^https:\/\/[\w-]+\.supabase\.co$/.test(cfg.url) && !!cfg.anonKey;
const BUCKET = 'scb-uploads', MAX_BYTES = 5 * 1024 * 1024;
let api = null, base = {}, over = {};

const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); e.append(...kids); return e; };
const say = (t, cls = '') => { const m = $('msg'); m.textContent = t; m.className = cls; };
async function rpc(fn, args) { const { data, error } = await api.rpc(fn, args); if (error) throw new Error(error.message); return data; }
const imgUrl = p => { const m = /^assets\/uploads\/(.+)$/.exec(p || ''); return m ? `${cfg.url}/storage/v1/object/public/${BUCKET}/${m[1]}` : (p ? '../' + p : ''); };
const parsePos = s => { const m = /^(\d{1,3})% (\d{1,3})%$/.exec(s || ''); return m ? [Math.min(100, +m[1]), Math.min(100, +m[2])] : [50, 50]; };
const clean = o => { for (const k of Object.keys(o)) if (o[k] == null) delete o[k]; return o; };

async function upload(file) {
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[file.type];
  if (!ext) throw new Error('PNG / JPG / WebP の画像を選んでください');
  if (file.size > MAX_BYTES) throw new Error('5MB 以下の画像を選んでください');
  const name = `site/${crypto.randomUUID()}.${ext}`;
  const { error } = await api.storage.from(BUCKET).upload(name, file, { contentType: file.type, upsert: false });
  if (error) throw new Error('アップロード失敗: ' + error.message);
  return 'assets/uploads/' + name;
}

function setOver(id, field, value) {
  const o = { ...(over[id] || {}) }; const b = base[id] || {};
  if (value == null || value === b[field]) delete o[field]; else o[field] = value;
  if (Object.keys(o).length) over[id] = o; else delete over[id];
}

function render() {
  const box = $('slots'); box.replaceChildren();
  for (const [id, s] of Object.entries(base)) {
    const o = over[id] || {}, path = o.path || s.path;
    const [dx, dy] = parsePos(o.positionDesktop || s.positionDesktop), [mx, my] = parsePos(o.positionMobile || s.positionMobile);
    const isDeco = /^(globalBackdrop|chapterFlourish|archiveCorner|cardSeal|marginLeft|marginRight|chapterEmblem|footerEmblem)$/.test(id);
    const pv = el('img', { className: 'pv' + (isDeco ? ' contain' : ''), alt: '', src: imgUrl(path) }); pv.style.objectPosition = `${dx}% ${dy}%`;
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    file.onchange = async () => { if (!file.files[0]) return; say('アップロード中…'); try { setOver(id, 'path', await upload(file.files[0])); say('アップロードしました。「保存」で確定します。'); } catch (e) { say(e.message, 'err'); } render(); };
    const slider = (label, field, cur, axis) => {
      const r = el('input', { type: 'range', min: 0, max: 100, step: 1, value: cur });
      r.oninput = () => {
        const p = parsePos(over[id]?.[field] || s[field]); if (axis === 0) p[0] = +r.value; else p[1] = +r.value;
        setOver(id, field, `${p[0]}% ${p[1]}%`);
        if (field === 'positionDesktop') pv.style.objectPosition = `${p[0]}% ${p[1]}%`;
        lab.firstChild.nodeValue = label + ' ' + r.value + '%'; card.classList.toggle('changed', !!over[id]);
      };
      const lab = el('label', {}, label + ' ' + cur + '%', r); return lab;
    };
    const reset = el('button', { type: 'button' }, '元に戻す'); reset.onclick = () => { delete over[id]; render(); say('「保存」で確定します。'); };
    const card = el('div', { className: 'slot' + (over[id] ? ' changed' : '') }, el('h3', {}, s.label || id), el('small', {}, id + (o.path ? '（差し替え済み）' : '')), pv, file,
      el('div', { className: 'pos' }, slider('PC 横', 'positionDesktop', dx, 0), slider('PC 縦', 'positionDesktop', dy, 1), slider('スマホ 横', 'positionMobile', mx, 0), slider('スマホ 縦', 'positionMobile', my, 1)), el('div', {}, reset));
    box.append(card);
  }
}

$('resetAll').onclick = () => { over = {}; render(); say('すべて元に戻しました。「保存」で確定します。'); };
$('save').onclick = async () => {
  const value = {}; for (const [id, o] of Object.entries(over)) { const c = clean({ ...o }); if (Object.keys(c).length) value[id] = c; }
  try { await rpc('scb_admin_save_setting', { p_key: 'site.art', p_value: value }); say('保存しました。最大 15 分でサイトに反映されます。', 'ok'); }
  catch (e) { say('保存できませんでした: ' + e.message, 'err'); }
};

async function load() {
  const sr = await api.from('site_settings_public').select('key,value').eq('key', 'site.art');
  if (sr.error && sr.error.code === 'PGRST205') throw new Error('設定テーブルがまだありません（SQL 13〜16 を実行してください）');
  if (sr.error) throw sr.error;
  over = structuredClone((sr.data[0] || {}).value || {});
  const j = async p => { try { const r = await fetch(p, { cache: 'no-cache' }); return r.ok ? r.json() : null; } catch (e) { return null; } };
  const doc = (await j('../data/site-art-base.json')) || (await j('../data/site-art.json')) || {};
  base = doc.slots || {};
  render();
}

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
