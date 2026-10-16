 'use strict';
let data={characters:[],works:[]};
let searchablePeople=[];
const byId=id=>document.getElementById(id);
const info=byId('infoDialog');
function notice(title,body){byId('infoTitle').textContent=title;byId('infoBody').textContent=body;info.showModal();}
const imgPath=c=>c.portrait||c.image||'';
const personSubtitle=c=>c.group||[c.grade,c.club].filter(Boolean).join(' ')||(c.kind==='teacher'?'教員':'所属未登録');
function isFeatured(c){return c.featured===true && c.status==='active';}
function normalizeJapanese(s){return String(s||'').normalize('NFKC').toLocaleLowerCase('ja').replace(/[\s\u3000・･_-]+/g,'').replace(/[\u30a1-\u30f6]/g,ch=>String.fromCharCode(ch.charCodeAt(0)-0x60));}
function renderCharacters(characters){
 const root=byId('characterCards');root.replaceChildren();
 for(const [i,c] of characters.filter(isFeatured).entries()){
  const b=document.createElement('button');b.className='polaroid';b.type='button';
  b.style.setProperty('--rotation',`${[-3,2,-2,3,-1,2,-3,3,-1,2][i%10]}deg`);
  b.setAttribute('aria-label',`${c.name} の人物紹介（デモ）`);
  const img=document.createElement('img');img.src=imgPath(c);img.alt=`${c.name} の写真`;
  img.loading='lazy';img.decoding='async';
  const n=document.createElement('strong');n.textContent=c.name;
  const s=document.createElement('small');s.textContent=personSubtitle(c);
  if(c.color){b.style.setProperty('--person-color',c.color);}else{b.classList.add('color-unspecified');}
  b.append(img,n,s);
  b.addEventListener('click',()=>{location.href='characters/?id='+encodeURIComponent(c.id);});
  root.append(b);
 }
}
function renderWorks(works){
 const root=byId('workCards');root.replaceChildren();
 for(const w of works){const b=document.createElement('button');b.className='work-card';b.type='button';const img=document.createElement('img');img.src=w.image;img.alt='';img.loading='lazy';const box=document.createElement('div');box.className='work-card-body';const cat=document.createElement('span');cat.className='category';cat.textContent=w.category;const h=document.createElement('h3');h.textContent=w.title;const p=document.createElement('p');p.textContent=w.description;const arrow=document.createElement('div');arrow.className='arrow';arrow.textContent='→';box.append(cat,h,p,arrow);b.append(img,box);b.addEventListener('click',()=>{if(w.link){location.href=w.link;}else{notice(w.title,w.demo===false?(w.description||''):'この作品は画面レイアウト確認用のデモコンテンツです。実際の投稿作品ではありません。');}});root.append(b);}
}
function renderSearch(query){
 const root=byId('searchResults');root.replaceChildren();const q=normalizeJapanese(query);
 const matches=searchablePeople.filter(c=>!q||[c.name,c.nameKana,c.romaji].some(v=>normalizeJapanese(v).includes(q)));
 if(!matches.length){const p=document.createElement('p');p.textContent='該当する人物が見つかりません。';root.append(p);return;}
 for(const c of matches){const b=document.createElement('button');b.className='search-item';b.type='button';
  if(c.image){const img=document.createElement('img');img.src=imgPath(c);img.alt='';b.append(img);}
  else {const icon=document.createElement('span');icon.className='search-placeholder';icon.textContent='✿';icon.setAttribute('aria-hidden','true');b.append(icon);}
  const span=document.createElement('span');span.textContent=c.name;const small=document.createElement('small');small.textContent=`${personSubtitle(c)}${c.status==='graduated'?' · 卒業':''}`;span.append(small);b.append(span);
  b.addEventListener('click',()=>{byId('searchDialog').close();location.href='characters/?id='+encodeURIComponent(c.id);});root.append(b);}
}
byId('menuToggle').addEventListener('click',()=>{const n=byId('siteNav');const open=n.classList.toggle('open');byId('menuToggle').setAttribute('aria-expanded',String(open));});
document.querySelectorAll('.site-nav a').forEach(a=>a.addEventListener('click',()=>{byId('siteNav').classList.remove('open');byId('menuToggle').setAttribute('aria-expanded','false');}));
function openSearch(){byId('searchDialog').showModal();renderSearch('');byId('characterSearch').focus();}
byId('searchOpen').addEventListener('click',openSearch);
byId('characterSearch').addEventListener('input',e=>renderSearch(e.target.value.trim()));
byId('showCharacters').addEventListener('click',()=>{location.href='characters/';});
byId('relationshipPreview').addEventListener('click',()=>{location.href='relationships/';});
byId('worksMore').addEventListener('click',()=>{location.href='fan-library/';});
byId('groupsMore').addEventListener('click',()=>notice('学園案内','学年・クラス・クラブ・教員などのグループ一覧は次の工程で実装します。'));
byId('infoClose').addEventListener('click',()=>info.close());
async function loadJson(path){const r=await fetch(path);if(!r.ok)throw new Error(`${path}: HTTP ${r.status}`);return r.json();}
function applyTexts(texts){
 if(!texts||typeof texts!=='object')return;
 for(const [key,value] of Object.entries(texts)){
  if(typeof value!=='string'||!value.trim())continue;
  const el=document.querySelector('[data-text="'+key.replace(/[^A-Za-z0-9]/g,'')+'"]');
  if(!el)continue;
  el.replaceChildren();
  value.split('\n').forEach((line,i)=>{if(i)el.append(document.createElement('br'));el.append(document.createTextNode(line));});
 }
}
async function init(){
 try{data=await loadJson('data/public-demo.json');}catch(e){console.warn('Demo data unavailable:',e);data={characters:[],works:[]};}
 try{const all=await loadJson('data/public-people-all.json');const demomap=new Map(data.characters.map(c=>[c.id,c]));searchablePeople=(all.people||[]).map(p=>({...p,...(demomap.get(p.id)||{})}));for(const c of data.characters){if(!searchablePeople.some(p=>p.id===c.id))searchablePeople.push(c);}}
 catch(e){console.warn('Full public list unavailable:',e);searchablePeople=data.characters;}
 renderCharacters(data.characters);renderWorks(data.works);applyTexts(data.texts);
}
init();
