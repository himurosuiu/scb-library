// Reader for fan works (縦書き). The page layout is the same code as the world books (see studio/novel.js and tools/scb_render/fanbook.py).
const LINE_UNITS = 40, PAGE_LINES = 18, ITEMS_PER_BOOK = 15, MAX_VOLUMES = 8, MAX_ILL = 12;
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


// ---------------------------------------------------------------- reader
const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); e.append(...kids); return e; };
const safeImg = p => typeof p === 'string' && /^assets\/[A-Za-z0-9_./-]+\.(jpg|jpeg|png|webp)$/i.test(p) && !p.includes('..') && !p.includes('//');
const ROT = '\u2026\u2025\u2015\u2014\u2500';
function fillCol(div, t) { for (const ch of Array.from(t === '' ? ' ' : t)) { if (ROT.includes(ch)) div.append(el('span', { className: 'rot' }, ch)); else div.append(document.createTextNode(ch)); } }
let items = [], idx = 0, work = null;
function draw() {
  const pg = $('page'); pg.replaceChildren(); const it = items[idx]; $('colo').textContent = '';
  if (it.kind === 'image') {
    const box = el('div', { className: 'ill' }); if (safeImg(it.image)) box.append(el('img', { src: '../' + it.image, alt: '' })); if (it.caption) box.append(el('div', {}, it.caption)); pg.append(box);
  } else {
    for (const [k, t] of it.lines) { const d = el('div', { className: 'ln ' + (k === 'h' ? 'h' : '') }); fillCol(d, t); pg.append(d); }
    if (idx === items.length - 1) $('colo').textContent = `${work.title}　（完）\n作：${work.author || '—'}\n聖桜花女学園アーカイブ　二次創作`;
  }
  $('no').textContent = `${idx + 1} / ${items.length}`; $('prev').disabled = idx === 0; $('next').disabled = idx === items.length - 1;
  history.replaceState(null, '', location.pathname + location.search + '#' + (idx + 1)); $('page').scrollLeft = 0;
}
const go = d => { const n = idx + d; if (n >= 0 && n < items.length) { idx = n; draw(); } };
$('next').onclick = () => go(1); $('prev').onclick = () => go(-1);
document.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') go(1); else if (e.key === 'ArrowRight') go(-1); });
// ---------------------------------------------------------------- illustration / manga / music works
const okAudio = u => typeof u === 'string' && u.startsWith('https://') && u.includes('/storage/v1/object/public/scb-uploads/fan-') && u.endsWith('.mp3') && !u.includes('..') && !u.includes('?');
function showMedia() {
  const m = work.media || {}, imgs = (m.images || []).filter(x => safeImg(x.image));
  document.querySelector('.sheet').hidden = true; $('colo').hidden = true; document.querySelector('.hint').hidden = true;
  const box = el('div', { className: 'media' }); $('colo').after(box);
  if (work.summary) box.append(el('p', { className: 'hint' }, work.summary));
  if (work.category === '音楽') {
    if (safeImg(work.cover)) box.append(el('img', { src: '../' + work.cover, alt: '', className: 'mcover' }));
    if (okAudio(m.audioUrl)) { const a = el('audio', { controls: true, preload: 'none', src: m.audioUrl }); box.append(el('div', {}, a)); } else box.append(el('p', { className: 'err' }, '音源を読み込めませんでした。'));
    document.querySelector('.nav').hidden = true; return;
  }
  if (work.category === '漫画' && imgs.length) {
    const rtl = m.direction !== 'ltr'; const im = el('img', { alt: '', className: 'mpage' }); box.append(im); let i = 0;
    const show = () => { im.src = '../' + imgs[i].image; $('no').textContent = `${i + 1} / ${imgs.length}`; $('next').disabled = i === imgs.length - 1; $('prev').disabled = i === 0; history.replaceState(null, '', location.pathname + location.search + '#' + (i + 1)); };
    const step = d => { const n = i + d; if (n >= 0 && n < imgs.length) { i = n; show(); } };
    $('next').textContent = rtl ? '次のページ ←' : '次のページ →'; $('prev').textContent = rtl ? '→ 前のページ' : '← 前のページ';
    $('next').onclick = () => step(1); $('prev').onclick = () => step(-1);
    document.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') step(rtl ? 1 : -1); else if (e.key === 'ArrowRight') step(rtl ? -1 : 1); });
    im.onclick = () => step(1); const h = parseInt((location.hash || '').slice(1), 10); if (h >= 1 && h <= imgs.length) i = h - 1; show(); return;
  }
  document.querySelector('.nav').hidden = true;
  const grid = el('div', { className: 'gal' }); box.append(grid);
  for (const x of imgs) { const a = el('a', { href: '../' + x.image, target: '_blank', rel: 'noopener' }, el('img', { src: '../' + x.image, alt: x.caption || '', loading: 'lazy' })); grid.append(el('figure', {}, a, x.caption ? el('figcaption', {}, x.caption) : '')); }
}
fetch('../data/fanworks.json').then(r => r.json()).then(d => {
  const id = new URLSearchParams(location.search).get('id'); work = (d.works || []).find(w => w.id === id);
  if (!work) { $('title').textContent = '作品が見つかりません'; $('msg').textContent = '公開されていない、または削除された作品です。'; return; }
  document.title = work.title + ' | 二次創作ライブラリ | SALON CHERRY BLOSSOM';
  $('title').textContent = work.title; $('meta').textContent = [work.author, work.category, work.volumes > 1 ? `全${work.volumes}巻` : ''].filter(Boolean).join(' ・ ');
  if (['イラスト', '漫画', '音楽'].includes(work.category)) { showMedia(); return; }
  items = buildItems(paginate(work.body || ''), work.illustrations || []);
  const h = parseInt((location.hash || '').slice(1), 10); idx = h >= 1 && h <= items.length ? h - 1 : 0; draw();
}).catch(() => { $('title').textContent = '読み込めませんでした'; });
