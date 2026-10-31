// World board images (administrator only): the left and the right half of the 5:2 board.
// The images are uploaded as they are; the automatic publisher fits them onto two 2048 x 1638 tiles.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

const $ = id => document.getElementById(id);
const cfg = window.SCB_SUPABASE_CONFIG || {};
const ready = /^https:\/\/[\w-]+\.supabase\.co$/.test(cfg.url) && !!cfg.anonKey;
const BUCKET = 'scb-uploads', MAX_BYTES = 5 * 1024 * 1024, MIN_WIDTH = 1000;
const SIDES = [['left', '左（tile-1）', '../board/tile-1.jpg'], ['right', '右（tile-2）', '../board/tile-2.jpg']];
let api = null, board = {}, saved = null;       // saved = the stored setting (null = never saved)

const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); e.append(...kids); return e; };
const say = (t, cls = '') => { const m = $('msg'); m.textContent = t; m.className = cls; };
async function rpc(fn, args) { const { data, error } = await api.rpc(fn, args); if (error) throw new Error(error.message); return data; }
const imgUrl = p => { const m = /^assets\/uploads\/(.+)$/.exec(p || ''); return m ? `${cfg.url}/storage/v1/object/public/${BUCKET}/${m[1]}` : ''; };

async function upload(file) {
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[file.type];
  if (!ext) throw new Error('PNG / JPG / WebP の画像を選んでください');
  if (file.size > MAX_BYTES) throw new Error('5MB 以下の画像を選んでください');
  const bmp = await createImageBitmap(file);
  if (bmp.width < MIN_WIDTH) throw new Error(`画像は横 ${MIN_WIDTH}px 以上にしてください（選んだ画像：${bmp.width}×${bmp.height}）`);
  const name = `site/${crypto.randomUUID()}.${ext}`;
  const { error } = await api.storage.from(BUCKET).upload(name, file, { contentType: file.type, upsert: false });
  if (error) throw new Error('アップロード失敗: ' + error.message);
  return 'assets/uploads/' + name;
}

function render() {
  const both = !!(board.left && board.right);
  $('mode').textContent = both ? '固定画像を使用中（保存済み）' : '関係データから自動で描画';
  const box = $('preview'); box.replaceChildren();
  for (const [key, label, current] of SIDES) {
    const chosen = imgUrl(board[key]);
    const img = el('img', { alt: label });
    img.src = chosen || `${current}?t=${Date.now()}`;           // nothing chosen: show what the board shows now
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    file.onchange = async () => {
      if (!file.files[0]) return; say('アップロード中…');
      try { board[key] = await upload(file.files[0]); say('アップロードしました。「保存」で確定します。'); } catch (e) { say(e.message, 'err'); }
      render();
    };
    box.append(el('div', { className: 'side' }, el('strong', {}, label, el('span', { className: 'badge' }, chosen ? '新しい画像' : '現在の看板')), el('div', { className: 'frame' }, img), file));
  }
}

$('save').onclick = async () => {
  if (!board.left || !board.right) { say('左右どちらの画像も選んでください。', 'err'); return; }
  try { await rpc('scb_admin_save_setting', { p_key: 'board.images', p_value: { left: board.left, right: board.right } }); saved = { left: board.left, right: board.right }; say('保存しました。最大 15 分で World の看板が入れ替わります。', 'ok'); render(); }
  catch (e) { say('保存できませんでした: ' + e.message, 'err'); }
};

$('auto').onclick = async () => {
  if (!confirm('固定画像をやめて、承認済みの関係から看板を自動で描く状態に戻しますか？')) return;
  try { await rpc('scb_admin_save_setting', { p_key: 'board.images', p_value: {} }); board = {}; saved = {}; say('戻しました。次の自動公開（最大 15 分）から、関係データで看板が描かれます。', 'ok'); render(); }
  catch (e) { say('保存できませんでした: ' + e.message, 'err'); }
};

async function load() {
  const sr = await api.from('site_settings_public').select('key,value').eq('key', 'board.images');
  if (sr.error && sr.error.code === 'PGRST205') throw new Error('設定テーブルがまだありません（SQL 13 以降を実行してください）');
  if (sr.error) throw sr.error;
  saved = sr.data[0] ? sr.data[0].value : null;
  board = { ...(saved || {}) };
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
