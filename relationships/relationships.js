"use strict";
const $=id=>document.getElementById(id);const svgNS='http://www.w3.org/2000/svg';
let rels=[],people=[],mode='samples',selected=null,zoom=1,panX=0,panY=0,focus=false;const samples=[{id:'sample-a',name:'サンプル A',x:260,y:190,color:'#c996b0'},{id:'sample-b',name:'サンプル B',x:510,y:130,color:'#a7bacc'},{id:'sample-c',name:'サンプル C',x:755,y:210,color:'#e0ad88'},{id:'sample-d',name:'サンプル D',x:250,y:480,color:'#9abfa8'},{id:'sample-e',name:'サンプル E',x:535,y:505,color:'#c9acc5'},{id:'sample-f',name:'サンプル F',x:780,y:485,color:'#d5bf87'}];
const sampleEdges=[['sample-a','sample-b','family'],['sample-b','sample-c','friend'],['sample-a','sample-d','school'],['sample-d','sample-e','friend'],['sample-e','sample-f','love'],['sample-c','sample-f','school'],['sample-b','sample-e','friend']];
const nrm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\s\u3000・･_-]+/g,'').replace(/[\u30a1-\u30f6]/g,ch=>String.fromCharCode(ch.charCodeAt(0)-96));
function el(tag,attrs={},txt){const v=document.createElementNS(svgNS,tag);Object.entries(attrs).forEach(([k,val])=>v.setAttribute(k,String(val)));if(txt!==undefined)v.textContent=txt;return v;}

/* ---- focus mode: the chosen person in the middle, only the people connected to them and those lines ---- */
const REL_JP={sister:'姉妹',blood:'血縁',friend:'友人',acquaintance:'知人',clan:'同族',rival:'ライバル',kusareen:'腐れ縁',gizagiza:'ギザギザ',other:'その他',one_sided:'片想い',tsuntsun:'ツンツン',honmei:'本命',oshi:'推し',amayakashi:'甘やかし',amae:'甘え',izon:'依存',kininaru:'気になる'};
const FOCUS_R=38;
const relClass=k=>['sister','blood','clan'].includes(k)?'family':['one_sided','honmei','oshi','kininaru','amae','amayakashi','izon'].includes(k)?'love':['friend','kusareen','tsuntsun'].includes(k)?'friend':'school';
const relDirected=k=>['one_sided','tsuntsun','honmei','oshi','amayakashi','amae','izon','kininaru'].includes(k);
function typeOn(type){const box=document.querySelector('input[value="'+type+'"]');return !box||box.checked}
function focusData(){
  if(mode!=='people'||!focus||!selected)return null;
  const c=people.find(p=>p.id===selected);if(!c)return null;
  const byId=new Map(),edges=[];
  for(const r of rels){
    if(r.a!==selected&&r.b!==selected)continue;
    if(!typeOn(relClass(r.kind)))continue;
    const oid=r.a===selected?r.b:r.a,o=people.find(x=>x.id===oid);if(!o)continue;
    if(!byId.has(oid))byId.set(oid,o);
    edges.push({r,oid,mine:r.a===selected});
  }
  const others=[...byId.values()],n=others.length;
  const center={...c,x:500,y:350,s:1.3};
  const nodes=[center];
  others.forEach((o,i)=>{const ang=-Math.PI/2+i*2*Math.PI/Math.max(n,1);nodes.push({...o,x:500+340*Math.cos(ang),y:350+235*Math.sin(ang)})});
  const pos=new Map(nodes.map(p=>[p.id,p]));
  const pairCount=new Map(),pairIndex=new Map();
  edges.forEach(e=>pairCount.set(e.oid,(pairCount.get(e.oid)||0)+1));
  edges.forEach(e=>{const k=pairIndex.get(e.oid)||0;pairIndex.set(e.oid,k+1);e.from=pos.get(e.r.a);e.to=pos.get(e.r.b);e.offset=pairCount.get(e.oid)>1?(k-(pairCount.get(e.oid)-1)/2):0;});
  return {center,nodes,edges,count:n};
}
function drawFocusEdges(vp,fd){
  const lines=el('g'),labels=el('g');
  for(const e of fd.edges){
    const p=e.from,q=e.to;if(!p||!q)continue;
    const dx=q.x-p.x,dy=q.y-p.y,len=Math.hypot(dx,dy)||1,ux=dx/len,uy=dy/len,off=e.offset*14,nx=-uy*off,ny=ux*off;
    const x1=p.x+ux*FOCUS_R+nx,y1=p.y+uy*FOCUS_R+ny,x2=q.x-ux*(FOCUS_R+(relDirected(e.r.kind)?6:0))+nx,y2=q.y-uy*(FOCUS_R+(relDirected(e.r.kind)?6:0))+ny;
    const type=relClass(e.r.kind);
    lines.append(el('line',{x1,y1,x2,y2,class:'edge '+type+' emphasized','stroke-dasharray':e.r.kind==='blood'?'10 6':'none',...(relDirected(e.r.kind)?{'marker-end':'url(#arrow)'}:{})}));
    const text=(e.mine?e.r.forA:e.r.forB)||e.r.label||REL_JP[e.r.kind]||'関係者';
    const mx=(x1+x2)/2,my=(y1+y2)/2,w=Math.min(190,text.length*13+18);
    const g=el('g',{class:'edge-label-g'});
    g.append(el('rect',{x:mx-w/2,y:my-11,width:w,height:22,rx:11,class:'edge-label-bg'}));
    g.append(el('text',{x:mx,y:my+1,class:'edge-label'},text.length>12?text.slice(0,11)+'…':text));
    labels.append(g);
  }
  vp.append(lines,labels);
}

/* ---- transition animation (focus in / switch / out): ease-in-out, 0.9 s, nodes and lines move together ---- */
let anim=null,animRaf=0,lastLayout=new Map(),lastEdges=[];
const easeIO=t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
function visibleEdges(fd){
  if(mode!=='people')return [];
  if(fd)return fd.edges.map(e=>e.r);
  const ids=new Set(activeNodes().map(n=>n.id));
  return rels.filter(r=>typeOn(relClass(r.kind))&&ids.has(r.a)&&ids.has(r.b));
}
function fullLayout(fd){
  const m=new Map(),grid=activeNodes(),fmap=fd?new Map(fd.nodes.map(n=>[n.id,n])):null;
  for(const n of grid){const f=fmap&&fmap.get(n.id);m.set(n.id,f?{x:f.x,y:f.y,s:f.s||1,o:1}:{x:n.x,y:n.y,s:1,o:fmap?0:1})}
  if(fmap)for(const n of fd.nodes)if(!m.has(n.id))m.set(n.id,{x:n.x,y:n.y,s:n.s||1,o:1});
  return m;
}
function startAnim(prevLayout,prevEdges,prevCam){
  const reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(mode!=='people'||reduce||!prevLayout||!prevLayout.size){anim=null;render();return}
  const fd=focusData();
  anim={t0:performance.now(),dur:900,from:prevLayout,to:fullLayout(fd),fromEdges:prevEdges||[],toEdges:visibleEdges(fd),cam:prevCam||{z:zoom,x:panX,y:panY}};
  buildAnim();
  if(animRaf)cancelAnimationFrame(animRaf);animRaf=requestAnimationFrame(tickAnim);
}
function buildAnim(){
  const root=$('relSvg');root.replaceChildren();root.classList.add('is-anim');
  const defs=el('defs');const marker=el('marker',{id:'arrow',markerWidth:10,markerHeight:8,refX:8,refY:4,orient:'auto'});marker.append(el('path',{d:'M0 0 L10 4 L0 8 Z',fill:'#af788a'}));defs.append(marker);root.append(defs);
  const vp=el('g');root.append(vp);anim.vp=vp;
  const eg=el('g'),ng=el('g');vp.append(eg,ng);
  const fe=new Set(anim.fromEdges),te=new Set(anim.toEdges);anim.edgeRefs=[];
  for(const r of new Set([...anim.fromEdges,...anim.toEdges])){
    const ln=el('line',{class:'edge '+relClass(r.kind)+' emphasized','stroke-dasharray':r.kind==='blood'?'10 6':'none',...(relDirected(r.kind)?{'marker-end':'url(#arrow)'}:{})});
    eg.append(ln);anim.edgeRefs.push({r,ln,inFrom:fe.has(r),inTo:te.has(r)});
  }
  const byId=new Map(people.map(p=>[p.id,p]));anim.nodeRefs=new Map();
  for(const id of new Set([...anim.from.keys(),...anim.to.keys()])){
    const p=byId.get(id);if(!p)continue;
    const g=makeNode({...p,x:0,y:0,s:1},defs);ng.append(g);anim.nodeRefs.set(id,g);
  }
  tickFrame(0);
}
function tickFrame(t){
  const a=anim,e=easeIO(t),cur=new Map();
  for(const [id,g] of a.nodeRefs){
    const f=a.from.get(id),to=a.to.get(id),A=f||{...to,o:0},B=to||{...f,o:0};
    const x=A.x+(B.x-A.x)*e,y=A.y+(B.y-A.y)*e,s=A.s+(B.s-A.s)*e,o=A.o+(B.o-A.o)*e;
    cur.set(id,{x,y,s,o});
    g.setAttribute('transform','translate('+x+' '+y+') scale('+s+')');g.setAttribute('opacity',o);
    g.style.display=o<.02?'none':'';g.style.pointerEvents=o<.5?'none':'';
  }
  for(const er of a.edgeRefs){
    const pa=cur.get(er.r.a),pb=cur.get(er.r.b);
    if(!pa||!pb||pa.o<.02||pb.o<.02){er.ln.style.display='none';continue}
    const k=er.inFrom&&er.inTo?1:er.inTo?e:1-e;
    er.ln.style.display='';er.ln.setAttribute('x1',pa.x);er.ln.setAttribute('y1',pa.y);er.ln.setAttribute('x2',pb.x);er.ln.setAttribute('y2',pb.y);
    er.ln.setAttribute('opacity',k*Math.min(pa.o,pb.o));
  }
  const z=a.cam.z+(zoom-a.cam.z)*e,px=a.cam.x+(panX-a.cam.x)*e,py=a.cam.y+(panY-a.cam.y)*e;
  a.vp.setAttribute('transform','translate('+px+' '+py+') scale('+z+')');
  lastLayout=cur;lastEdges=[...new Set([...a.fromEdges,...a.toEdges])];
}
function tickAnim(now){
  if(!anim)return;
  const t=Math.min(1,(now-anim.t0)/anim.dur);tickFrame(t);
  if(t<1)animRaf=requestAnimationFrame(tickAnim);else{anim=null;animRaf=0;render()}
}
function exitFocus(){if(!focus)return;const pl=lastLayout,pe=lastEdges,pc={z:zoom,x:panX,y:panY};focus=false;zoom=1;panX=panY=0;startAnim(pl,pe,pc);}
function activeNodes(){if(mode==='samples')return samples;const g=$('gradeSelect').value;const subset=people.filter(p=>g==='all'||(g==='teacher'?p.kind==='teacher':p.grade===g));return subset.map((p,i)=>({...p,x:110+(i%7)*130+(Math.floor(i/7)%2)*15,y:70+Math.floor(i/7)*94}));}
function makeNode(p0,defs){const p={...p0,x:0,y:0};const g=el('g',{class:(mode==='people'?'node-hit public-node':'node-hit')+(selected===p.id?' is-selected':''),tabindex:'0',role:'button','aria-label':p.name,transform:'translate('+p0.x+' '+p0.y+') scale('+(p0.s||1)+')'});g.append(el('circle',{cx:p.x,cy:p.y,r:mode==='people'?36:47,class:'node-halo','pointer-events':'none'}));
g.append(el('rect',{x:p.x-(mode==='people'?62:66),y:p.y+(mode==='people'?34:46),width:mode==='people'?124:132,height:mode==='people'?29:32,rx:5,class:'node-nameplate','pointer-events':'none'}));
g.append(el('circle',{cx:p.x,cy:p.y,r:mode==='people'?30:39,class:`node-circle ${selected===p.id?'selected':''}`}));const portrait=p.portrait||p.image;
if(mode==='people'&&typeof portrait==='string'&&/^assets\/[A-Za-z0-9_./-]+\.(png|jpg|jpeg|webp)$/i.test(portrait)&&!portrait.includes('..')){
const clipId='scb-node-'+String(p.id).replace(/[^a-zA-Z0-9_-]/g,'');const clip=el('clipPath',{id:clipId});clip.append(el('circle',{cx:p.x,cy:p.y,r:26}));defs.append(clip);
g.append(el('image',{href:'../'+portrait,x:p.x-26,y:p.y-26,width:52,height:52,'clip-path':`url(#${clipId})`,preserveAspectRatio:'xMidYMid slice',class:'node-portrait','pointer-events':'none'}));
}else{g.append(el('image',{href:'../assets/art-system/'+(p.kind==='teacher'?'v088/icon-book.svg':'v089/person.svg'),x:p.x-20,y:p.y-20,width:40,height:40,class:'node-symbol','pointer-events':'none'}));}g.append(el('text',{x:p.x,y:p.y+(mode==='people'?45:64),class:'node-name'},p.name));if(mode==='people')g.append(el('text',{x:p.x,y:p.y+61,class:'node-meta'},p.kind==='teacher'?'教員':p.grade||''));g.addEventListener('click',()=>choose(p.id));g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose(p.id)}});return g}
function render(){anim=null;const root=$('relSvg');root.classList.remove('is-anim');root.replaceChildren();const fd=focusData(),nodes=fd?fd.nodes:activeNodes(),ids=new Map(nodes.map(n=>[n.id,n]));const defs=el('defs');const marker=el('marker',{id:'arrow',markerWidth:10,markerHeight:8,refX:8,refY:4,orient:'auto'});marker.append(el('path',{d:'M0 0 L10 4 L0 8 Z',fill:'#af788a'}));defs.append(marker);root.append(defs);const viewport=el('g',{transform:`translate(${panX} ${panY}) scale(${zoom})`});root.append(viewport);if(mode==='samples')for(const [a,b,type] of sampleEdges){if(!document.querySelector(`input[value="${type}"]`).checked)continue;const p=ids.get(a),q=ids.get(b);if(p&&q)viewport.append(el('line',{x1:p.x,y1:p.y,x2:q.x,y2:q.y,class:`edge ${type}${selected?(a===selected||b===selected?' emphasized':' dimmed'):''}`}));}
const relClass=k=>['sister','blood','clan'].includes(k)?'family':['one_sided','honmei','oshi','kininaru','amae','amayakashi','izon'].includes(k)?'love':['friend','kusareen','tsuntsun'].includes(k)?'friend':'school';
const relDirected=k=>['one_sided','tsuntsun','honmei','oshi','amayakashi','amae','izon','kininaru'].includes(k);
if(fd)drawFocusEdges(viewport,fd);if(mode==='people'&&!fd)for(const r of rels){const type=relClass(r.kind),box=document.querySelector('input[value="'+type+'"]');if(box&&!box.checked)continue;const p=ids.get(r.a),q=ids.get(r.b);if(p&&q)viewport.append(el('line',{x1:p.x,y1:p.y,x2:q.x,y2:q.y,class:'edge '+type+(selected?(r.a===selected||r.b===selected?' emphasized':' dimmed'):''),'stroke-dasharray':r.kind==='blood'?'10 6':'none',...(relDirected(r.kind)?{'marker-end':'url(#arrow)'}:{})}));}
for(const p0 of nodes){viewport.append(makeNode(p0,defs))}$('mapTitle').textContent=mode==='samples'?'架空の関係サンプル':`公開人物一覧・${nodes.length}名${rels.length?'・関係 '+rels.length+' 件':'（関係未掲載）'}`;$('mapCaption').textContent=mode==='samples'?'架空のサンプル人物による操作確認用の図です。':rels.length?'公開承認済みの関係線のみ表示しています。人物を選ぶと、その人物の関係が強調されます。':'実在人物の基本情報のみ。関係線は公開承認されるまで表示しません。';if(fd){$('mapTitle').textContent='「'+fd.center.name+'」の関係・'+fd.count+'名';$('mapCaption').textContent=fd.count?'選んだ人物とつながりのある人物だけを表示しています。別の人物を押すとその人物が中心になります。余白を押すと全体に戻ります。':'公開承認済みの関係はまだありません。';}lastLayout=mode==='people'?fullLayout(fd):new Map();lastEdges=visibleEdges(fd);$('exitFocus').hidden=!fd;$('zoomLabel').textContent=Math.round(zoom*100)+'%';}
function choose(id){const pl=lastLayout,pe=lastEdges,pc={z:zoom,x:panX,y:panY},same=(selected===id&&focus&&mode==='people');selected=id;focus=(mode==='people');if(focus){zoom=1;panX=panY=0}const p=(mode==='samples'?samples:people).find(p=>p.id===id);if(!p)return;const box=$('selectedCard');box.replaceChildren();if(p.portrait||p.image){const img=document.createElement('img');img.className='selected-portrait';img.src='../'+(p.portrait||p.image).replace(/^assets\//,'assets/');img.alt=p.name;box.append(img)}else{const x=document.createElement('div');x.className='selected-placeholder';x.textContent='❀';box.append(x)}const name=document.createElement('h3');name.className='selected-name';name.textContent=p.name;box.append(name);if(mode==='samples'){const warning=document.createElement('p');warning.className='selected-unverified';warning.textContent='架空のサンプル人物です。実在の人物・関係ではありません。';box.append(warning)}else{const kana=document.createElement('p');kana.className='selected-kana';kana.textContent=p.nameKana||p.romaji||'';box.append(kana);for(const label of [p.kind==='teacher'?'教員':p.grade,p.club,p.status==='graduated'?'卒業':p.status==='transferred'?'転校':null].filter(Boolean)){const sp=document.createElement('span');sp.className='selected-tag';sp.textContent=label;box.append(sp)}const link=document.createElement('a');link.href='../characters/?id='+encodeURIComponent(p.id);link.className='selected-link';link.textContent='人物資料を開く →';box.append(link);const warning=document.createElement('p');warning.className='selected-unverified';const mine=rels.filter(r=>r.a===p.id||r.b===p.id);if(mine.length){const ul=document.createElement('ul');ul.className='selected-bonds';for(const r of mine){const o=people.find(x=>x.id===(r.a===p.id?r.b:r.a));if(!o)continue;const li=document.createElement('li');const a=document.createElement('a');a.href='../characters/?id='+encodeURIComponent(o.id);a.textContent=o.name;li.append(a,document.createTextNode(' — '+((r.a===p.id?r.forA:r.forB)||r.label||'関係者')));ul.append(li)}box.append(ul)}else{const warning=document.createElement('p');warning.className='selected-unverified';warning.textContent='公開承認済みの関係はまだありません。';box.append(warning)}}if(same)render();else startAnim(pl,pe,pc);}
function search(q){const panel=$('personMatches');panel.replaceChildren();if(!q.trim())return;const matches=people.filter(p=>[p.name,p.nameKana,p.romaji].some(v=>nrm(v).includes(nrm(q)))).slice(0,12);if(!matches.length){panel.textContent='該当する人物が見つかりません。';return}for(const p of matches){const b=document.createElement('button');b.textContent=p.name+' · '+(p.grade||'教員');b.addEventListener('click',()=>{mode='people';$('viewMode').value='people';$('gradeSelect').value='all';selected=p.id;zoom=1;const target=activeNodes().find(n=>n.id===p.id);panX=target?500-target.x:0;panY=target?350-target.y:0;render();choose(p.id);$('personSearch').value=p.name;panel.replaceChildren();$('mapViewport').scrollIntoView({behavior:'smooth',block:'nearest'})});panel.append(b)}}
function reset(){const pl=lastLayout,pe=lastEdges,pc={z:zoom,x:panX,y:panY},was=focus&&mode==='people';mode=$('viewMode').value;selected=null;focus=false;zoom=1;panX=panY=0;$('selectedCard').innerHTML='<div class="empty-selection"><span>❀</span><p>人物を選択すると、ここに基本情報が表示されます。</p></div>';if(was&&mode==='people')startAnim(pl,pe,pc);else render();}
$('menuToggle').addEventListener('click',()=>{const open=$('siteNav').classList.toggle('open');$('menuToggle').setAttribute('aria-expanded',String(open))});$('personSearch').addEventListener('input',e=>search(e.target.value));$('viewMode').addEventListener('change',reset);$('gradeSelect').addEventListener('change',()=>{if(mode==='people')reset()});document.querySelectorAll('#relationTypes input').forEach(el=>el.addEventListener('change',render));$('resetView').addEventListener('click',()=>{$('viewMode').value='samples';$('gradeSelect').value='all';$('personSearch').value='';$('personMatches').replaceChildren();document.querySelectorAll('#relationTypes input').forEach(x=>x.checked=true);reset()});function setZoom(z){zoom=Math.max(.6,Math.min(2.3,z));render()}$('zoomIn').addEventListener('click',()=>setZoom(zoom*1.2));$('zoomOut').addEventListener('click',()=>setZoom(zoom/1.2));$('fitView').addEventListener('click',()=>{zoom=1;panX=panY=0;render()});$('exitFocus').addEventListener('click',exitFocus);document.addEventListener('keydown',e=>{if(e.key==='Escape')exitFocus()});
const view=$('mapViewport');let dragging=false,dragAt=null,downAt=null;view.addEventListener('pointerdown',e=>{if(e.target.closest('.node-hit'))return;dragging=true;dragAt={x:e.clientX,y:e.clientY};downAt={x:e.clientX,y:e.clientY};view.setPointerCapture(e.pointerId)});view.addEventListener('pointermove',e=>{if(!dragging)return;const r=view.getBoundingClientRect();panX+=(e.clientX-dragAt.x)*1000/r.width;panY+=(e.clientY-dragAt.y)*700/r.height;dragAt={x:e.clientX,y:e.clientY};render()});view.addEventListener('pointerup',e=>{const was=dragging;dragging=false;if(was&&focus&&downAt&&Math.hypot(e.clientX-downAt.x,e.clientY-downAt.y)<6)exitFocus();downAt=null});view.addEventListener('pointercancel',()=>dragging=false);view.addEventListener('wheel',e=>{e.preventDefault();setZoom(zoom*(e.deltaY>0?.9:1.1))},{passive:false});view.addEventListener('keydown',e=>{if(e.key==='+')setZoom(zoom*1.2);else if(e.key==='-')setZoom(zoom/1.2);else if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();panX+=e.key==='ArrowLeft'?-35:e.key==='ArrowRight'?35:0;panY+=e.key==='ArrowUp'?-35:e.key==='ArrowDown'?35:0;render()}});
fetch('../data/public-people-all.json').then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(data=>{people=data.people||[];render()}).catch(err=>{console.warn('Public people data unavailable:',err);$('mapCaption').textContent='人物データを読み込めません。ローカルサーバーで開いてください。';render()});render();
fetch('../data/relations.json').then(r=>r.ok?r.json():{relations:[]}).then(d=>{rels=Array.isArray(d.relations)?d.relations:[];render()}).catch(()=>{});
