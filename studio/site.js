// Home page content (administrator only): featured people, work cards, fixed texts.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

const $ = id => document.getElementById(id);
const cfg = window.SCB_SUPABASE_CONFIG || {};
const ready = /^https:\/\/[\w-]+\.supabase\.co$/.test(cfg.url) && !!cfg.anonKey;
const BUCKET = 'scb-uploads';
const MAX_BYTES = 5 * 1024 * 1024;
const TEXT_LABELS = {
  heroEyebrow: 'ヒーロー：小見出し', heroTitle: 'ヒーロー：タイトル', heroSub: 'ヒーロー：サブタイトル', heroDescription: 'ヒーロー：説明文', heroQuote: 'ヒーロー：ひとこと',
  feature1Title: '入口1：見出し', feature1Text: '入口1：説明', feature2Title: '入口2：見出し', feature2Text: '入口2：説明', feature3Title: '入口3：見出し', feature3Text: '入口3：説明',
  charactersLead: '人物セクション：リード文', relationsTitle: '関係図セクション：見出し', relationsText: '関係図セクション：説明', worksLead: '作品セクション：リード文', groupsTitle: '学園案内：見出し', groupsText: '学園案内：説明'};
let api = null, people = [], featured = [], works = [], texts = {}, defaults = {};

const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); e.append(...kids); return e; };
const say = (t, cls = '') => { const m = $('msg'); m.textContent = t; m.className = cls; };
const nameOf = id => (people.find(p => p.id === id) || { data: { name: id } }).data.name || id;
async function rpc(fn, args) { const { data, error } = await api.rpc(fn, args); if (error) throw new Error(error.message); return data; }
const save = async (key, value, label) => { try { await rpc('scb_admin_save_setting', { p_key: key, p_value: value }); say(`${label}を保存しました。最大 15 分でサイトに反映されます。`, 'ok'); } catch (e) { say('保存できませんでした: ' + e.message, 'err'); } };

function imgUrl(path) { const m = /^assets\/uploads\/(.+)$/.exec(path || ''); return m ? `${cfg.url}/storage/v1/object/public/${BUCKET}/${m[1]}` : (path ? '../' + path : ''); }
async function upload(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('JPG / PNG / WebP の画像を選んでください');
  const bmp = await createImageBitmap(file); const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  let blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.9));
  if (!blob || blob.type !== 'image/webp') blob = await new Promise(r => c.toBlob(r, 'image/png'));
  if (blob.size > MAX_BYTES) throw new Error('画像が大きすぎます（5MB 以下）');
  const ext = blob.type === 'image/webp' ? 'webp' : 'png', name = `site/${crypto.randomUUID()}.${ext}`;
  const { error } = await api.storage.from(BUCKET).upload(name, blob, { contentType: blob.type, upsert: false });
  if (error) throw new Error('アップロード失敗: ' + error.message);
  return 'assets/uploads/' + name;
}

// ---- featured people
function renderFeatured() {
  const box = $('featList'); box.replaceChildren();
  featured.forEach((id, i) => {
    const up = el('button', { type: 'button' }, '↑'), dn = el('button', { type: 'button' }, '↓'), rm = el('button', { type: 'button' }, '外す');
    up.disabled = i === 0; dn.disabled = i === featured.length - 1;
    up.onclick = () => { [featured[i - 1], featured[i]] = [featured[i], featured[i - 1]]; renderFeatured(); };
    dn.onclick = () => { [featured[i + 1], featured[i]] = [featured[i], featured[i + 1]]; renderFeatured(); };
    rm.onclick = () => { featured.splice(i, 1); renderFeatured(); };
    box.append(el('div', { className: 'item' }, `${i + 1}. ${nameOf(id)}（${id}） `, up, dn, rm));
  });
  const sel = $('featAdd'); sel.replaceChildren();
  for (const p of people) if (!featured.includes(p.id)) sel.add(new Option(`${p.data.name}（${p.id}）`, p.id));
}
$('featAddBtn').onclick = () => { const v = $('featAdd').value; if (!v) return; if (featured.length >= 12) { say('最大 12 名までです。', 'err'); return; } featured.push(v); renderFeatured(); };
$('featSave').onclick = () => save('home.featured', featured, '人物の並び');

// ---- works
function renderWorks() {
  const box = $('workList'); box.replaceChildren();
  works.forEach((w, i) => {
    const item = el('div', { className: 'item' });
    const mk = (label, key, props = {}) => { const inp = el('input', { value: w[key] ?? '', ...props }); inp.oninput = () => { w[key] = inp.value; }; return el('label', {}, label, inp); };
    const img = el('img', { className: 'thumb', alt: '' }); if (w.image) img.src = imgUrl(w.image);
    const file = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
    file.onchange = async () => { if (!file.files[0]) return; say('アップロード中…'); try { w.image = await upload(file.files[0]); say('アップロードしました。「保存」で確定します。'); } catch (e) { say(e.message, 'err'); } renderWorks(); };
    const up = el('button', { type: 'button' }, '↑'), dn = el('button', { type: 'button' }, '↓'), rm = el('button', { type: 'button' }, 'この作品を削除');
    up.disabled = i === 0; dn.disabled = i === works.length - 1;
    up.onclick = () => { [works[i - 1], works[i]] = [works[i], works[i - 1]]; renderWorks(); };
    dn.onclick = () => { [works[i + 1], works[i]] = [works[i], works[i + 1]]; renderWorks(); };
    rm.onclick = () => { works.splice(i, 1); renderWorks(); };
    item.append(el('div', { className: 'row' }, mk('ID（英小文字・数字・ハイフン）', 'id', { maxLength: 40 }), mk('カテゴリ', 'category', { maxLength: 30 }),
      mk('タイトル', 'title', { maxLength: 60 }), mk('リンク（https:// または fan-library/ など・任意）', 'link', { maxLength: 250 })),
      mk('説明（200 文字まで）', 'description', { maxLength: 200 }), el('div', {}, img, file), el('div', {}, up, dn, rm));
    box.append(item);
  });
}
$('workAdd').onclick = () => { if (works.length >= 12) { say('最大 12 件までです。', 'err'); return; } works.push({ id: 'work-' + (works.length + 1) + '-' + Math.random().toString(36).slice(2, 5), category: '', title: '', description: '', image: null, link: '' }); renderWorks(); };
$('workSave').onclick = () => {
  const out = works.map(w => ({ id: (w.id || '').trim(), category: (w.category || '').trim(), title: (w.title || '').trim(), description: (w.description || '').trim(), image: w.image || null, link: (w.link || '').trim() || null }));
  if (out.some(w => !w.title)) { say('タイトルが空の作品があります。', 'err'); return; }
  save('home.works', out, '作品カード');
};

// ---- texts
function renderTexts() {
  const box = $('textList'); box.replaceChildren();
  for (const [key, label] of Object.entries(TEXT_LABELS)) {
    const ta = el('textarea', { value: texts[key] || '', placeholder: defaults[key] || '', maxLength: 300 }); ta.oninput = () => { texts[key] = ta.value; };
    box.append(el('label', {}, label, ta));
  }
}
$('textSave').onclick = () => {
  const out = {}; for (const k of Object.keys(TEXT_LABELS)) { const v = (texts[k] || '').replace(/\r\n?/g, '\n').trim(); if (v) out[k] = v; }
  save('home.texts', out, '文章');
};

for (const [tab, box] of [['tabF', 'boxF'], ['tabW', 'boxW'], ['tabT', 'boxT']]) {
  $(tab).onclick = () => { for (const [t, b] of [['tabF', 'boxF'], ['tabW', 'boxW'], ['tabT', 'boxT']]) { $(t).setAttribute('aria-selected', String(t === tab)); $(b).hidden = b !== box; } say(''); };
}

async function load() {
  const pr = await api.from('character_records').select('id,data').order('id'); if (pr.error) throw pr.error; people = pr.data;
  const sr = await api.from('site_settings_public').select('key,value');
  if (sr.error && sr.error.code === 'PGRST205') throw new Error('設定テーブルがまだありません（SQL 13 を実行してください）');
  if (sr.error) throw sr.error;
  const st = Object.fromEntries(sr.data.map(x => [x.key, x.value]));
  let demo = {}; try { demo = await (await fetch('../data/public-demo.json')).json(); } catch (e) { /* keep empty */ }
  try { defaults = await (await fetch('../data/site-text-defaults.json')).json(); } catch (e) { defaults = {}; }
  featured = st['home.featured'] ? [...st['home.featured']] : (demo.characters || []).filter(c => c.featured !== false).map(c => c.id);
  works = structuredClone(st['home.works'] || (demo.works || []).map(w => ({ id: w.id, category: w.category, title: w.title, description: w.description, image: w.image, link: w.link || '' })));
  texts = { ...(st['home.texts'] || {}) };
  renderFeatured(); renderWorks(); renderTexts();
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
