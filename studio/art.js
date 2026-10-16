// Page base art per tier (administrator only). The image is stored as it is (no resizing): it is an atlas with a fixed layout.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

const $ = id => document.getElementById(id);
const cfg = window.SCB_SUPABASE_CONFIG || {};
const ready = /^https:\/\/[\w-]+\.supabase\.co$/.test(cfg.url) && !!cfg.anonKey;
const BUCKET = 'scb-uploads', MAX_BYTES = 5 * 1024 * 1024;
const TIERS = [['y1', '一年生'], ['y2', '二年生'], ['y3', '三年生'], ['teacher', '教職員']];
let api = null, art = {};

const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); e.append(...kids); return e; };
const say = (t, cls = '') => { const m = $('msg'); m.textContent = t; m.className = cls; };
async function rpc(fn, args) { const { data, error } = await api.rpc(fn, args); if (error) throw new Error(error.message); return data; }
const imgUrl = p => { const m = /^assets\/uploads\/(.+)$/.exec(p || ''); return m ? `${cfg.url}/storage/v1/object/public/${BUCKET}/${m[1]}` : ''; };

async function upload(file) {
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[file.type];
  if (!ext) throw new Error('PNG / JPG / WebP の画像を選んでください');
  if (file.size > MAX_BYTES) throw new Error('5MB 以下の画像を選んでください');
  const bmp = await createImageBitmap(file);
  if (bmp.width !== bmp.height || ![1024, 2048].includes(bmp.width)) throw new Error(`画像は 1024×1024 または 2048×2048 の正方形にしてください（選んだ画像：${bmp.width}×${bmp.height}）`);
  const name = `site/${crypto.randomUUID()}.${ext}`;
  const { error } = await api.storage.from(BUCKET).upload(name, file, { contentType: file.type, upsert: false });
  if (error) throw new Error('アップロード失敗: ' + error.message);
  return 'assets/uploads/' + name;
}

function render() {
  const box = $('tiers'); box.replaceChildren();
  for (const [key, label] of TIERS) {
    const img = el('img', { alt: '' }); const u = imgUrl(art[key]); if (u) img.src = u;
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    file.onchange = async () => { if (!file.files[0]) return; say('アップロード中…'); try { art[key] = await upload(file.files[0]); say('アップロードしました。「保存」で確定します。'); } catch (e) { say(e.message, 'err'); } render(); };
    const reset = el('button', { type: 'button' }, '既定に戻す'); reset.onclick = () => { delete art[key]; render(); say('「保存」で確定します。'); };
    box.append(el('div', { className: 'tier' }, el('strong', {}, label), u ? img : el('p', { className: 'hint' }, '既定の画像を使用中'), file, el('div', {}, reset)));
  }
}

$('save').onclick = async () => {
  const value = {}; for (const [k] of TIERS) if (art[k]) value[k] = art[k];
  try { await rpc('scb_admin_save_setting', { p_key: 'tier.pages', p_value: value }); say('保存しました。最大 15 分で書籍画像が描き直されます。', 'ok'); }
  catch (e) { say('保存できませんでした: ' + e.message, 'err'); }
};

async function load() {
  const sr = await api.from('site_settings_public').select('key,value').eq('key', 'tier.pages');
  if (sr.error && sr.error.code === 'PGRST205') throw new Error('設定テーブルがまだありません（SQL 13 と 14 を実行してください）');
  if (sr.error) throw sr.error;
  art = { ...((sr.data[0] || {}).value || {}) };
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
