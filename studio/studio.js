import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const $=id=>document.getElementById(id);
const cfg=window.SCB_SUPABASE_CONFIG||{};
const ready=/^https:\/\/[\w-]+\.supabase\.co$/.test(cfg.url)&&!!cfg.anonKey;
let api=null,user=null,record=null,original=null,admin=false,state={},everyone=[];
const BUCKET='scb-uploads';
// Same rules as the server (supabase-sql/02 + 05). The server checks everything again.
const TEXT=[
 ['name','名前',100],['nameKana','よみがな',130],['romaji','ローマ字',130],['grade','学年（例：2年）',30],['club','所属（クラブ・委員会）',130],['group','副題（例：2年生 文学部）',150],
 ['species','種族',60],['height','身長',50],['likes','好きなもの',250],['dislikes','苦手なもの',250],['firstPerson','一人称',80],['secondPerson','二人称',80]];
const IMAGES=[['portrait','顔アイコン（正方形に近い画像）',1200],['fullBody','全身立ち絵（縦長の画像）',2000]];
const MAX_OUTFITS=8,MAX_IMAGES=10,MAX_BYTES=5*1024*1024;
const SAFE_PATH=/^assets\/(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9_./-]+\.(jpe?g|png|webp)$/i;
const norm=x=>JSON.stringify(x??null);
const say=s=>{$('cloudStatus').textContent=s};
const css=document.createElement('style');
css.textContent='.im-row{display:flex;flex-wrap:wrap;gap:.6rem;margin:.4rem 0}.im-box{position:relative;width:110px}.im-box img{width:110px;height:130px;object-fit:cover;border:1px solid #d6bcb9;border-radius:6px;background:#fff}.im-box button{margin:.15rem .15rem 0 0;padding:.2rem .5rem;font-size:.8rem}.fs{border:1px solid #d6bcb9;border-radius:10px;padding:.8rem;margin:.8rem 0}.fs h4{margin:.2rem 0 .5rem}.hint{font-size:.85rem;color:#8a7a6b}textarea#f_about{width:100%;min-height:150px;padding:.6rem}';
document.head.append(css);
$('login').disabled=!ready;
if(!ready){$('cloudUser').textContent='Supabase の接続先が未設定です。studio/config.js を設定してください。';}
else {api=createClient(cfg.url,cfg.anonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});initialize();}
async function initialize(){try{const {data:{user:u},error}=await api.auth.getUser();if(error&&error.name!=='AuthSessionMissingError')throw error;user=u;$('login').hidden=!!user;$('logout').hidden=!user;$('cloudUser').textContent=user?'ログイン中：'+(user.email||user.id):'未ログイン';if(!user)return;const {data:role,error:er}=await api.rpc('is_scb_super_admin');if(er)throw er;admin=role===true;$('privilege').textContent=admin?'権限：super_admin（全人物を編集可能）':'権限：個別許可がある人物のみ編集可能';const {data:items,error:err}=await api.from('character_records').select('id,data,revision').order('id');if(err)throw err;everyone=items;const allowed=[];for(const p of items){if(admin){allowed.push(p);continue;}const {data:yes,error:e}=await api.rpc('can_edit_scb_character',{cid:p.id});if(e)throw e;if(yes)allowed.push(p);}const select=$('character');select.replaceChildren();if(!allowed.length){select.add(new Option('編集権限がありません',''));return;}for(const p of allowed)select.add(new Option(p.data.name+' ('+p.id+')',p.id));select.disabled=false;const bl=$('bookLook');const upd=()=>{if(bl)bl.href='book-theme.html?person='+encodeURIComponent(select.value);};upd();select.onchange=()=>{upd();load(allowed.find(p=>p.id===select.value));};load(allowed[0]);}catch(e){say('初期化失敗: '+e.message);}}
$('login').onclick=async()=>{const redirectTo=location.origin+location.pathname;const {error}=await api.auth.signInWithOAuth({provider:'discord',options:{redirectTo,scopes:'identify'}});if(error)say(error.message);};
$('logout').onclick=async()=>{await api.auth.signOut();location.reload();};

// ---- helpers
const el=(tag,props={},...kids)=>{const e=document.createElement(tag);Object.assign(e,props);e.append(...kids);return e;};
function imgUrl(path){if(typeof path!=='string'||!SAFE_PATH.test(path))return '';const m=/^assets\/uploads\/(.+)$/.exec(path);return m?`${cfg.url}/storage/v1/object/public/${BUCKET}/${m[1]}`:'../'+path;}
function thumb(path){const i=el('img',{alt:'',loading:'lazy'});const u=imgUrl(path);if(u)i.src=u;i.onerror=()=>{i.style.opacity='.3';};return i;}
// Shrinks the picture in the browser (also removes camera/location data) and returns {blob, ext}.
async function prepare(file,maxSide){
 if(!/^image\/(jpeg|png|webp)$/.test(file.type))throw new Error('JPG / PNG / WebP の画像を選んでください');
 const bmp=await createImageBitmap(file);const k=Math.min(1,maxSide/Math.max(bmp.width,bmp.height));
 const c=document.createElement('canvas');c.width=Math.max(1,Math.round(bmp.width*k));c.height=Math.max(1,Math.round(bmp.height*k));
 c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);
 let blob=await new Promise(r=>c.toBlob(r,'image/webp',0.9));
 if(!blob||blob.type!=='image/webp')blob=await new Promise(r=>c.toBlob(r,'image/png'));
 const ext=blob.type==='image/webp'?'webp':'png';
 if(blob.size>MAX_BYTES)throw new Error('画像が大きすぎます（5MB 以下になるよう小さい画像を選んでください）');
 return {blob,ext};
}
async function upload(file,maxSide){
 const {blob,ext}=await prepare(file,maxSide);const name=`${record.id}/${crypto.randomUUID()}.${ext}`;
 const {error}=await api.storage.from(BUCKET).upload(name,blob,{contentType:blob.type,upsert:false});
 if(error)throw new Error('アップロード失敗: '+error.message);
 return 'assets/uploads/'+name;
}

// ---- form
function load(p){record=p;original=structuredClone(p.data);state={};$('personTitle').textContent=p.data.name;$('revision').textContent='公開 DB revision: '+p.revision;
 const form=$('cloudFields');form.replaceChildren();
 // text fields
 for(const [k,label,max] of TEXT){state[k]=typeof p.data[k]==='string'?p.data[k]:'';const i=el('input',{name:k,value:state[k],maxLength:max});i.oninput=()=>{state[k]=i.value;};form.append(el('label',{},label,i));}
 // status + kind
 state.status=p.data.status||'salon';const st=el('select',{name:'status'});st.add(new Option('サロン係（図書館に本を置く）','salon'));st.add(new Option('在籍中（禁書庫）','active'));st.add(new Option('卒業（禁書庫）','graduated'));st.add(new Option('転校（禁書庫）','transferred'));st.value=state.status;st.onchange=()=>{state.status=st.value;};form.append(el('label',{},'在籍状況',st));
 state.kind=p.data.kind||'student';const kd=el('select',{name:'kind',disabled:!admin});kd.add(new Option('生徒','student'));kd.add(new Option('教員','teacher'));kd.value=state.kind;kd.onchange=()=>{state.kind=kd.value;};form.append(el('label',{},'区分'+(admin?'':'（管理者のみ変更可）'),kd));
 // colour
 state.color=p.data.color||'';const col=el('input',{name:'color',value:state.color,placeholder:'#RRGGBB',maxLength:7});const pick=el('input',{type:'color',value:/^#[0-9a-f]{6}$/i.test(state.color)?state.color:'#d9c3cf'});
 col.oninput=()=>{state.color=col.value.trim();if(/^#[0-9a-f]{6}$/i.test(state.color))pick.value=state.color;};pick.oninput=()=>{state.color=pick.value;col.value=pick.value;};
 form.append(el('label',{},'イメージカラー',col),pick);
 // about
 state.about=typeof p.data.about==='string'?p.data.about:'';const ab=el('textarea',{id:'f_about',name:'about',value:state.about,maxLength:2000});ab.oninput=()=>{state.about=ab.value;};form.append(el('label',{},'人物紹介（2000 文字まで）',ab));
 // own extra setting: vertical-writing pages in the personal book, after ABOUT and before the gallery pages
 state.lore=typeof p.data.lore==='string'?p.data.lore:'';state.loreTitle=typeof p.data.loreTitle==='string'?p.data.loreTitle:'';
 const lt=el('input',{id:'f_loreTitle',name:'loreTitle',type:'text',value:state.loreTitle,maxLength:24,placeholder:'例：設定資料（空欄なら「設定」）'});lt.oninput=()=>{state.loreTitle=lt.value;};
 const lo=el('textarea',{id:'f_lore',name:'lore',value:state.lore,maxLength:2400});const lc=el('div',{className:'hint',id:'loreCount'});
 const loreUpdate=()=>{const n=[...lo.value].length;lc.textContent=`${n.toLocaleString()} / 2,400 字　（本では縦書きで約 ${Math.max(1,Math.ceil(n/650))} ページ。最大 4 ページまで）`;};lo.oninput=()=>{state.lore=lo.value;loreUpdate();};loreUpdate();
 form.append(el('fieldset',{style:'border:1px solid #d6bcb9;border-radius:10px;margin:.8rem 0;padding:.5rem .8rem'},el('legend',{},'追加の設定ページ（任意）'),el('p',{className:'hint'},'ここに書いた文章は、あなたの本の「人物紹介（ABOUT）」のあと・ギャラリーの前に、縦書きのページとして入ります。世界観・過去・口癖など自由に書けます。'),el('label',{},'見出し（24 文字まで）',lt),el('label',{},'本文（2400 文字まで。改行できます。「第一章：…」で始まる行、または行末が「：」の短い行は小見出しになります）',lo),lc));
 // the message that appears in the world when this person's bookmark (栞) is touched
 state.bookmarkMessage=typeof p.data.bookmarkMessage==='string'?p.data.bookmarkMessage:'';const bmI=el('textarea',{id:'f_bookmarkMessage',name:'bookmarkMessage',value:state.bookmarkMessage,maxLength:200,style:'min-height:5rem',placeholder:'空欄のままなら、いまのメッセージ（ワールドの標準）が表示されます'});bmI.oninput=()=>{state.bookmarkMessage=bmI.value;};
 form.append(el('fieldset',{style:'border:1px solid #d6bcb9;border-radius:10px;margin:.8rem 0;padding:.5rem .8rem'},el('legend',{},'栞メッセージ（任意）'),el('p',{className:'hint'},'World の栞に触れたときに表示される、あなた（この人物）のひとことです。200 文字まで・改行できます。**空欄のままなら、いまの標準メッセージのまま**です。反映は承認と公開作業のあと（最大 15 分）です。'),bmI));
 // single images
 for(const [k,label,max] of IMAGES){state[k]=p.data[k]||null;const box=el('div',{className:'fs'});form.append(box);renderSingle(box,k,label,max);}
 // outfits
 state.outfits=structuredClone(Array.isArray(p.data.outfits)?p.data.outfits:[]);const ow=el('div',{className:'fs'});form.append(ow);renderOutfits(ow);
 // personal book pages
 state.bookPages=structuredClone(Array.isArray(p.data.bookPages)?p.data.bookPages:[]);const bw=el('div',{className:'fs'});form.append(bw);renderBookPages(bw);
 $('saveCloud').disabled=false;$('discardFields').disabled=false;say('この操作は草稿保存のみで、公開されません。');$('conflictOutput').hidden=true;refreshRelations();}

function renderSingle(box,k,label,max){box.replaceChildren(el('h4',{},label));
 const row=el('div',{className:'im-row'});if(state[k])row.append(el('div',{className:'im-box'},thumb(state[k])));else row.append(el('span',{className:'hint'},'未登録'));box.append(row);
 const f=el('input',{type:'file',accept:'image/jpeg,image/png,image/webp'});f.onchange=async()=>{if(!f.files[0])return;say('アップロード中…');try{state[k]=await upload(f.files[0],max);say('アップロードしました。「クラウド草稿を保存」で確定します。');renderSingle(box,k,label,max);}catch(e){say(e.message);}};
 box.append(f);if(state[k]){const rm=el('button',{type:'button'},'画像を外す');rm.onclick=()=>{state[k]=null;renderSingle(box,k,label,max);};box.append(rm);}
 box.append(el('div',{className:'hint'},'JPG / PNG / WebP。自動で縮小されます（5MB 以下）。公開は管理者の承認後です。'));}

function renderOutfits(box){box.replaceChildren(el('h4',{},'ギャラリー（衣装ごと・各 10 枚まで）'));
 state.outfits.forEach((o,oi)=>{const fs=el('div',{className:'fs'});
  const lab=el('input',{value:o.label||'',maxLength:40,placeholder:'衣装名（例：制服）'});lab.oninput=()=>{o.label=lab.value;};fs.append(el('label',{},'衣装名',lab));
  const row=el('div',{className:'im-row'});
  (o.images||[]).forEach((path,ii)=>{const b=el('div',{className:'im-box'},thumb(path));
   const left=el('button',{type:'button'},'←');left.disabled=ii===0;left.onclick=()=>{const a=o.images;[a[ii-1],a[ii]]=[a[ii],a[ii-1]];renderOutfits(box);};
   const rm=el('button',{type:'button'},'外す');rm.onclick=()=>{o.images.splice(ii,1);renderOutfits(box);};b.append(el('div',{},left,rm));row.append(b);});
  fs.append(row);
  if((o.images||[]).length<MAX_IMAGES){const f=el('input',{type:'file',multiple:true,accept:'image/jpeg,image/png,image/webp'});f.onchange=async()=>{say('アップロード中…');try{for(const file of f.files){if(o.images.length>=MAX_IMAGES)break;o.images.push(await upload(file,2000));}say('アップロードしました。「クラウド草稿を保存」で確定します。');}catch(e){say(e.message);}renderOutfits(box);};fs.append(f);}
  const del=el('button',{type:'button'},'この衣装を削除');del.onclick=()=>{state.outfits.splice(oi,1);renderOutfits(box);};fs.append(del);box.append(fs);});
 if(state.outfits.length<MAX_OUTFITS){const add=el('button',{type:'button'},'衣装を追加');add.onclick=()=>{state.outfits.push({label:'',images:[]});renderOutfits(box);};box.append(add);}}

// Personal book: page 1 title, 2 profile, 3 introduction and 4 relations are made automatically; these are the free pages after them.
function renderBookPages(box){box.replaceChildren(el('h4',{},'個人ブックのページ（最大 8 ページ）'),el('p',{className:'hint'},'VRChat の個人ブックに、1 ページ 1 枚の画像（任意で短い説明文つき）として並びます。表紙・プロフィール・人物紹介・関係のページは自動で作られます。'));
 state.bookPages.forEach((pg,i)=>{const fs=el('div',{className:'fs'});const row=el('div',{className:'im-row'},el('div',{className:'im-box'},thumb(pg.image)));fs.append(el('strong',{},`ページ ${i+1}`),row);
  const cap=el('input',{value:pg.caption||'',maxLength:60,placeholder:'説明文（任意・60 文字まで）'});cap.oninput=()=>{pg.caption=cap.value;};fs.append(el('label',{},'説明文',cap));
  const up=el('button',{type:'button'},'↑ 前へ');up.disabled=i===0;up.onclick=()=>{const a=state.bookPages;[a[i-1],a[i]]=[a[i],a[i-1]];renderBookPages(box);};
  const rp=el('button',{type:'button'},'画像を差し替え');const f=el('input',{type:'file',accept:'image/jpeg,image/png,image/webp'});f.hidden=true;f.onchange=async()=>{if(!f.files[0])return;say('アップロード中…');try{pg.image=await upload(f.files[0],2000);say('アップロードしました。「クラウド草稿を保存」で確定します。');}catch(e){say(e.message);}renderBookPages(box);};rp.onclick=()=>f.click();
  const rm=el('button',{type:'button'},'このページを削除');rm.onclick=()=>{state.bookPages.splice(i,1);renderBookPages(box);};fs.append(up,rp,f,rm);box.append(fs);});
 if(state.bookPages.length<8){const f=el('input',{type:'file',multiple:true,accept:'image/jpeg,image/png,image/webp'});f.onchange=async()=>{say('アップロード中…');try{for(const file of f.files){if(state.bookPages.length>=8)break;state.bookPages.push({image:await upload(file,2000),caption:''});}say('アップロードしました。「クラウド草稿を保存」で確定します。');}catch(e){say(e.message);}renderBookPages(box);};box.append(el('div',{},'ページを追加（複数選択可）'),f);}}

$('discardFields').onclick=()=>{if(record)load(record);};
// Pasted text often carries invisible characters (zero-width spaces, tabs, Word line separators). Clean them here so the
// server rule ("plain characters only") is not tripped by something nobody can see, and say exactly what is not allowed.
const INVISIBLE=/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
function clean(s,multi,label){s=String(s??'').replace(/\r\n?/g,'\n').replace(/[\u2028\u2029\u000b\u000c\u0085]/g,'\n').replace(/\t/g,' ').replace(INVISIBLE,'').replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g,'');
 if(!multi)s=s.replace(/\n+/g,' ');
 const bad=/[<>]/.exec(s);if(bad){const line=s.slice(0,bad.index).split('\n').length;throw new Error(`${label}に使えない記号があります：「${bad[0]}」（${line} 行目付近）。< と > は使えません。全角の「＜」「＞」などに置き換えてください。`);}
 return s;}
function collect(){const patch={},expected={};
 const take=(k,v)=>{const was=original[k]??null;if(Array.isArray(v)&&!v.length&&was===null)return;if(norm(v)!==norm(was)){patch[k]=v;expected[k]=was;}};
 for(const [k,label,max] of TEXT){const v=clean(state[k],false,label).trim();if([...v].length>max)throw new Error(`${label}が長すぎます（${max} 文字まで）`);take(k,v);}
 take('status',state.status);if(admin)take('kind',state.kind);
 const c=(state.color||'').trim();if(c&&!/^#[0-9A-Fa-f]{6}$/.test(c))throw new Error('カラーは #RRGGBB 形式で入力してください。');take('color',c||null);
 const about=clean(state.about,true,'人物紹介');if([...about].length>2000)throw new Error(`人物紹介が長すぎます（2000 文字まで。いまは ${[...about].length} 文字）`);take('about',about);
 const bm=clean(state.bookmarkMessage,true,'栞メッセージ');if([...bm].length>200)throw new Error(`栞メッセージが長すぎます（200 文字まで。いまは ${[...bm].length} 文字）`);if(!(bm===''&&original.bookmarkMessage==null))take('bookmarkMessage',bm);
 const lore=clean(state.lore,true,'追加の設定');if([...lore].length>2400)throw new Error(`追加の設定が長すぎます（2400 文字まで。いまは ${[...lore].length} 文字）`);
 const loreTitle=clean(state.loreTitle,false,'追加の設定の見出し').trim();if([...loreTitle].length>24)throw new Error('追加の設定の見出しは 24 文字までです');
 if(!(lore===''&&original.lore==null))take('lore',lore);if(!(loreTitle===''&&original.loreTitle==null))take('loreTitle',loreTitle);
 for(const [k] of IMAGES){if(state[k]&&!SAFE_PATH.test(state[k]))throw new Error('画像パスが不正です');take(k,state[k]||null);}
 const outfits=state.outfits.map(o=>({label:clean(o.label,false,'衣装名').trim(),images:(o.images||[]).filter(Boolean)}));
 for(const o of outfits){if(!o.label)throw new Error('衣装名を入力してください（空の衣装は削除してください）');if(o.images.some(x=>!SAFE_PATH.test(x)))throw new Error('画像パスが不正です');}
 take('outfits',outfits);
 const bookPages=state.bookPages.map(b=>({image:b.image,caption:clean(b.caption,false,'ページの説明文').trim()}));
 for(const b of bookPages){if(!SAFE_PATH.test(b.image||''))throw new Error('ブックのページの画像パスが不正です');}
 take('bookPages',bookPages.map(b=>b.caption?b:{image:b.image}));
 return {patch,expected};}
$('saveCloud').onclick=async()=>{if(!record||!user)return;let patch,expected;try{({patch,expected}=collect());}catch(e){say(e.message);return;}
 if(!Object.keys(patch).length){say('変更はありません');return;}
 $('saveCloud').disabled=true;try{const {data,error}=await api.rpc('save_scb_draft',{cid:record.id,patch,expected,expected_revision:record.revision});if(error)throw error;if(!data.ok){$('conflictOutput').hidden=false;$('conflictOutput').textContent=JSON.stringify(data.conflicts,null,2);say('競合があります。最新データを確認し、再読み込み後に編集してください。');return;}say('クラウド草稿を保存しました（未公開）'+(data.baseChanged?'。公開 DB に別の更新があります。':''));}catch(e){say('保存失敗: '+e.message);}finally{$('saveCloud').disabled=false;}};

// ---- relations (propose -> the other side agrees -> administrator approves)
const KIND_WORDS={sister:'姉妹（お姉様と妹）',blood:'血縁',friend:'友人',acquaintance:'知人',clan:'同族',rival:'ライバル',kusareen:'腐れ縁',gizagiza:'ギザギザ',other:'その他',one_sided:'片想い',tsuntsun:'ツンツン',honmei:'本命',oshi:'推し',amayakashi:'甘やかし',amae:'甘え',izon:'依存',kininaru:'気になる'};
const ELDER_KINDS=['sister','blood'],DIRECTED_KINDS=['one_sided','tsuntsun','honmei','oshi','amayakashi','amae','izon','kininaru'];
const STATUS_WORDS={pending_counterpart:'相手の確認待ち',pending_admin:'管理者の承認待ち',approved:'公開対象（承認済み）',rejected:'却下'};
const relSay=t=>{$('relStatus').textContent=t;};
const nameOf=id=>(everyone.find(p=>p.id===id)||{data:{name:id}}).data.name||id;
async function refreshRelations(){
 if(!api||!user||!record)return;
 let rows=[];try{const {data,error}=await api.rpc('scb_my_relations');if(error)throw error;rows=data||[];}catch(e){relSay('関係の読み込みに失敗: '+e.message);return;}
 $('relBox').hidden=false;$('relTitle').textContent='関係（絆）：'+(record.data.name||record.id);
 // inbox: everything waiting for my answer, for all my characters
 const waiting=rows.filter(r=>r.can_respond);$('relInbox').hidden=!waiting.length;const ib=$('relInboxList');ib.replaceChildren();
 for(const r of waiting){const row=el('div',{className:'fs'});row.append(describe(r));
  const yes=el('button',{type:'button'},'同意する'),no=el('button',{type:'button'},'辞退する');yes.onclick=()=>answer(r.id,true);no.onclick=()=>answer(r.id,false);row.append(yes,no);ib.append(row);}
 // this character
 const mine=rows.filter(r=>r.a_id===record.id||r.b_id===record.id);const list=$('relList');list.replaceChildren();
 if(!mine.length)list.append(el('p',{className:'hint'},'この人物の関係はまだ登録されていません。'));
 for(const r of mine){const row=el('div',{className:'fs'});row.append(describe(r));
  if(r.removal_requested)row.append(el('div',{className:'hint'},'削除を申請中（管理者の判断待ち）'));
  if(r.status==='approved'&&!r.removal_requested){const b=el('button',{type:'button'},'削除を申請');b.onclick=()=>removal(r.id);row.append(b);}
  if(r.can_respond){const yes=el('button',{type:'button'},'同意する'),no=el('button',{type:'button'},'辞退する');yes.onclick=()=>answer(r.id,true);no.onclick=()=>answer(r.id,false);row.append(yes,no);}
  if(r.mine&&r.status!=='approved'){const b=el('button',{type:'button'},r.status==='rejected'?'この表示を消す':'提案を取り下げる');b.onclick=()=>withdraw(r.id);row.append(b);}
  list.append(row);}
 renderRelForm();
}
function describe(r){const d=el('div',{});const elder=ELDER_KINDS.includes(r.kind)?`（年長者：${r.a_name}）`:DIRECTED_KINDS.includes(r.kind)?`（${r.a_name} → ${r.b_name}）`:'';
 d.append(el('strong',{},`${r.a_name} ⇔ ${r.b_name}`),el('div',{},`${KIND_WORDS[r.kind]||r.kind}${elder}${r.label?' ／ 表示名：'+r.label:''}`));
 if(r.note)d.append(el('div',{className:'hint'},'メモ：'+r.note));
 d.append(el('div',{className:'hint'},'状態：'+(STATUS_WORDS[r.status]||r.status)+(r.status==='rejected'&&r.reject_reason?'（'+r.reject_reason+'）':'')));return d;}
async function relCall(fn,args,ok){try{const {data,error}=await api.rpc(fn,args);if(error)throw error;if(data&&data.ok===false&&data.error==='duplicate'){relSay('同じ組み合わせ・同じ種類の関係がすでに提案または登録されています。');return;}relSay(ok);await refreshRelations();}catch(e){relSay('失敗しました: '+e.message);}}
const answer=(id,yes)=>relCall('scb_respond_relation',{rid:id,accept:yes},yes?'同意しました。管理者の審査に進みます。':'辞退しました。');
const withdraw=id=>relCall('scb_withdraw_relation',{rid:id},'取り下げました。');
const removal=id=>{if(confirm('この関係の削除を管理者に申請しますか？（承認されるまで公開されたままです）'))relCall('scb_request_relation_removal',{rid:id},'削除を申請しました。');};
function renderRelForm(){const f=$('relForm');f.replaceChildren();
 const other=el('select',{});for(const p of everyone){if(p.id!==record.id)other.add(new Option(p.data.name+' ('+p.id+')',p.id));}
 const kind=el('select',{});for(const [k,v] of Object.entries(KIND_WORDS))kind.add(new Option(v,k));
 const elder=el('select',{});
 const label=el('input',{maxLength:40,placeholder:'表示名（任意・例：従姉妹、幼なじみ）'});const note=el('input',{maxLength:200,placeholder:'メモ（任意）'});
 const eldLabel=el('span',{},'向き');const eld=el('label',{},eldLabel,elder);
 const sync=()=>{const e=ELDER_KINDS.includes(kind.value),d=DIRECTED_KINDS.includes(kind.value);eld.style.display=(e||d)?'':'none';elder.replaceChildren();
  if(e){eldLabel.textContent='年長者';elder.add(new Option('この人物が年長者（お姉様・年上）','self'));elder.add(new Option('相手が年長者','other'));}
  else if(d){const w=KIND_WORDS[kind.value];eldLabel.textContent='向き（誰から誰へ）';elder.add(new Option(`この人物 → 相手（この人物が相手に「${w}」）`,'self'));elder.add(new Option(`相手 → この人物（相手がこの人物に「${w}」）`,'other'));}};kind.onchange=sync;sync();
 const go=el('button',{type:'button'},'この関係を提案する');
 go.onclick=()=>{let a=record.id,b=other.value;if((ELDER_KINDS.includes(kind.value)||DIRECTED_KINDS.includes(kind.value))&&elder.value==='other'){[a,b]=[b,a];}
  relCall('scb_propose_relation',{a,b,k:kind.value,lbl:label.value.trim(),nt:note.value.trim()},'提案しました。相手の担当者の同意と管理者の承認を待ちます。');};
 f.append(el('label',{},'相手',other),el('label',{},'種類',kind),eld,el('label',{},'表示名',label),el('label',{},'メモ',note),go);}
