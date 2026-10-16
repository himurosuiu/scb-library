/* 公開ページの美術設定。データの保存やイベントの置換は行わない。 */
(()=>{
 const root=document.documentElement.dataset.siteRoot||'./';
 const allow=p=>typeof p==='string'&&/^assets\/[A-Za-z0-9_./-]+\.(png|jpg|jpeg|webp|svg)$/i.test(p)&&!p.includes('..')&&!p.includes('//');
 const position=p=>typeof p==='string'&&/^\d{1,3}% \d{1,3}%$/.test(p)&&p.split(' ').every(v=>parseInt(v,10)<=100);
 let artSlots={};
 const applyCardArt=()=>{
  for(const image of document.querySelectorAll('.fan-card img')){
   const match=(image.dataset.scbOriginalArt||image.getAttribute('src')||'').match(/(?:^|\/)archive-([1-3])\.jpg$/);
   if(!match)continue;
   const slot=artSlots['archive'+match[1]];
   if(slot&&allow(slot.path)){
    if(!image.dataset.scbOriginalArt)image.dataset.scbOriginalArt=image.getAttribute('src');
    if(image.getAttribute('src')!==root+slot.path)image.src=root+slot.path;
    if(position(slot.positionDesktop))image.style.objectPosition=slot.positionDesktop;
   }
  }
 };
 const decorate=()=>{
  const selector='.feature-card,.detail-section,.fan-sidebar,.fan-pickup,.rel-filters,.rel-detail,.map-panel,.fan-tabs button';
  for(const panel of document.querySelectorAll(selector)){
   if(panel.classList.contains('scb-framed'))continue;
   panel.classList.add('scb-framed');
   for(const corner of ['tl','tr','bl','br']){
    const ornament=document.createElement('span');
    ornament.className='scb-frame-corner '+corner;
    ornament.setAttribute('aria-hidden','true');
    panel.append(ornament);
   }
  }
 };
 const init=()=>{
  const stage=document.createElement('div');
  stage.className='scb-stage';
  document.body.prepend(stage);
  for(const node of [...document.body.children])if(node.matches('.prototype-ribbon,.site-header,main,.site-footer'))stage.append(node);
  const sizeStage=()=>stage.style.setProperty('--scb-stage-scale',innerWidth>=981?String(Math.min(1,innerWidth/1440)):'1');
  sizeStage();
  addEventListener('resize',sizeStage,{passive:true});
  const iconNames={all:'all','小説・SS':'book','イベント記録':'camera','学園資料':'archive','イラスト':'pen','詩':'quill','漫画':'comic','音楽':'music'};
  for(const button of document.querySelectorAll('.fan-tabs button')){
   const copy=document.createElement('span');copy.className='scb-tab-copy';
   for(const node of [...button.childNodes]){
    if(node.nodeType===3)node.textContent=node.textContent.replace(/^[\s✎❀▤♫]+/,'');
    copy.append(node);
   }
   const icon=document.createElement('img');icon.className='scb-tab-icon';icon.alt='';icon.setAttribute('aria-hidden','true');
   icon.src=root+'assets/art-system/v088/icon-'+iconNames[button.dataset.type]+'.svg';
   button.append(icon,copy);
  }
  for(const side of ['left','right']){
   for(const location of ['top','chapter','interlude','bottom']){
    const margin=document.createElement('div');
    margin.className='scb-margin-art scb-margin-art-'+side+' scb-margin-'+location;
    margin.setAttribute('aria-hidden','true');stage.append(margin);
   }
  }
  if(document.querySelector('.rel-shell')){
   const artRoot=root+'assets/art-system/v089/';
   for(const [id,name] of [['zoomIn','zoom-in'],['zoomOut','zoom-out'],['fitView','center']]){
    const button=document.getElementById(id);if(!button)continue;
    const icon=document.createElement('img');icon.src=artRoot+name+'.svg';icon.alt='';
    button.replaceChildren(icon);button.title=button.getAttribute('aria-label');
   }
   const panel=document.querySelector('.map-panel');
   const legend=document.createElement('div');legend.className='rel-icon-legend';
   legend.setAttribute('aria-label','関係の種類の凡例（サンプル）');
   const legendTitle=document.createElement('strong');legendTitle.textContent='凡例（サンプル）';legend.append(legendTitle);
   for(const [name,label] of [['family','家族・姉妹'],['love','恋愛・感情'],['friend','友情・親友'],['school','学園・団体']]){
    const item=document.createElement('span');item.className='rel-legend-item '+name;
    const icon=document.createElement('img');icon.src=artRoot+name+'.svg';icon.alt='';
    const text=document.createElement('span');text.textContent=label;
    item.append(icon,text);legend.append(item);
   }
   if(panel)panel.append(legend);
  }
  decorate();
  const main=document.querySelector('main');
  if(main)new MutationObserver(records=>{
   if(records.some(record=>[...record.addedNodes].some(node=>node.nodeType===1&&!node.classList.contains('scb-frame-corner')))){decorate();applyCardArt();}
  }).observe(main,{childList:true,subtree:true});
 };
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
 (async()=>{try{
  const response=await fetch(root+'data/site-art.json',{cache:'no-cache'});if(!response.ok)return;
  const {slots={}}=await response.json();
  artSlots=slots;
  const vars={globalBackdrop:'--scb-art-backdrop',chapterFlourish:'--scb-art-divider',archiveCorner:'--scb-art-corner',cardSeal:'--scb-art-seal',libraryBackdrop:'--scb-library-backdrop',fanHero:'--scb-fan-hero',marginLeft:'--scb-margin-left',marginRight:'--scb-margin-right',chapterEmblem:'--scb-chapter-emblem'};
  for(const [key,variable] of Object.entries(vars))if(slots[key]&&allow(slots[key].path))document.documentElement.style.setProperty(variable,`url("${root+slots[key].path}")`);
  applyCardArt();
  const seal=document.querySelector('.footer-seal');
  if(seal&&slots.footerEmblem&&allow(slots.footerEmblem.path)){
   const image=document.createElement('img');image.src=root+slots.footerEmblem.path;image.alt='';
   seal.replaceChildren(image);
  }
  if(slots.fanHero){
   if(position(slots.fanHero.positionDesktop))document.documentElement.style.setProperty('--scb-fan-position-desktop',slots.fanHero.positionDesktop);
   if(position(slots.fanHero.positionMobile))document.documentElement.style.setProperty('--scb-fan-position-mobile',slots.fanHero.positionMobile);
  }
 }catch(error){console.warn('SCB art decoration defaults active',error);}})();
})();
