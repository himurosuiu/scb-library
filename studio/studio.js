import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const $=id=>document.getElementById(id);
const cfg=window.SCB_SUPABASE_CONFIG||{};
const ready=/^https:\/\/[\w-]+\.supabase\.co$/.test(cfg.url)&&!!cfg.anonKey;
let api=null,user=null,record=null,original=null,admin=false,state={};
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
async function initialize(){try{const {data:{user:u},error}=await api.auth.getUser();if(error)throw error;user=u;$('login').hidden=!!user;$('logout').hidden=!user;$('cloudUser').textContent=user?'ログイン中：'+(user.email||user.id):'未ログイン';if(!user)return;const {data:role,error:er}=await api.rpc('is_scb_super_admin');if(er)throw er;admin=role===true;$('privilege').textContent=admin?'権限：super_admin（全人物を編集可能）':'権限：個別許可がある人物のみ編集可能';const {data:items,error:err}=await api.from('character_records').select('id,data,revision').order('id');if(err)throw err;const allowed=[];for(const p of items){if(admin){allowed.push(p);continue;}const {data:yes,error:e}=await api.rpc('can_edit_scb_character',{cid:p.id});if(e)throw e;if(yes)allowed.push(p);}const select=$('character');select.replaceChildren();if(!allowed.length){select.add(new Option('編集権限がありません',''));return;}for(const p of allowed)select.add(new Option(p.data.name+' ('+p.id+')',p.id));select.disabled=false;select.onchange=()=>load(allowed.find(p=>p.id===select.value));load(allowed[0]);}catch(e){say('初期化失敗: '+e.message);}}
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
 state.status=p.data.status||'active';const st=el('select',{name:'status'});st.add(new Option('在籍中','active'));st.add(new Option('卒業','graduated'));st.value=state.status;st.onchange=()=>{state.status=st.value;};form.append(el('label',{},'在籍状況',st));
 state.kind=p.data.kind||'student';const kd=el('select',{name:'kind',disabled:!admin});kd.add(new Option('生徒','student'));kd.add(new Option('教員','teacher'));kd.value=state.kind;kd.onchange=()=>{state.kind=kd.value;};form.append(el('label',{},'区分'+(admin?'':'（管理者のみ変更可）'),kd));
 // colour
 state.color=p.data.color||'';const col=el('input',{name:'color',value:state.color,placeholder:'#RRGGBB',maxLength:7});const pick=el('input',{type:'color',value:/^#[0-9a-f]{6}$/i.test(state.color)?state.color:'#d9c3cf'});
 col.oninput=()=>{state.color=col.value.trim();if(/^#[0-9a-f]{6}$/i.test(state.color))pick.value=state.color;};pick.oninput=()=>{state.color=pick.value;col.value=pick.value;};
 form.append(el('label',{},'イメージカラー',col),pick);
 // about
 state.about=typeof p.data.about==='string'?p.data.about:'';const ab=el('textarea',{id:'f_about',name:'about',value:state.about,maxLength:2000});ab.oninput=()=>{state.about=ab.value;};form.append(el('label',{},'人物紹介（2000 文字まで）',ab));
 // single images
 for(const [k,label,max] of IMAGES){state[k]=p.data[k]||null;const box=el('div',{className:'fs'});form.append(box);renderSingle(box,k,label,max);}
 // outfits
 state.outfits=structuredClone(Array.isArray(p.data.outfits)?p.data.outfits:[]);const ow=el('div',{className:'fs'});form.append(ow);renderOutfits(ow);
 $('saveCloud').disabled=false;$('discardFields').disabled=false;say('この操作は草稿保存のみで、公開されません。');$('conflictOutput').hidden=true;}

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

$('discardFields').onclick=()=>{if(record)load(record);};
function collect(){const patch={},expected={};
 const take=(k,v)=>{const was=original[k]??null;if(norm(v)!==norm(was)){patch[k]=v;expected[k]=was;}};
 for(const [k,,max] of TEXT){const v=(state[k]||'').trim();if(v.length>max)throw new Error(k+' が長すぎます');take(k,v);}
 take('status',state.status);if(admin)take('kind',state.kind);
 const c=(state.color||'').trim();if(c&&!/^#[0-9A-Fa-f]{6}$/.test(c))throw new Error('カラーは #RRGGBB 形式で入力してください。');take('color',c||null);
 take('about',state.about.replace(/\r\n?/g,'\n'));
 for(const [k] of IMAGES){if(state[k]&&!SAFE_PATH.test(state[k]))throw new Error('画像パスが不正です');take(k,state[k]||null);}
 const outfits=state.outfits.map(o=>({label:(o.label||'').trim(),images:(o.images||[]).filter(Boolean)}));
 for(const o of outfits){if(!o.label)throw new Error('衣装名を入力してください（空の衣装は削除してください）');if(o.images.some(x=>!SAFE_PATH.test(x)))throw new Error('画像パスが不正です');}
 take('outfits',outfits);
 return {patch,expected};}
$('saveCloud').onclick=async()=>{if(!record||!user)return;let patch,expected;try{({patch,expected}=collect());}catch(e){say(e.message);return;}
 if(!Object.keys(patch).length){say('変更はありません');return;}
 $('saveCloud').disabled=true;try{const {data,error}=await api.rpc('save_scb_draft',{cid:record.id,patch,expected,expected_revision:record.revision});if(error)throw error;if(!data.ok){$('conflictOutput').hidden=false;$('conflictOutput').textContent=JSON.stringify(data.conflicts,null,2);say('競合があります。最新データを確認し、再読み込み後に編集してください。');return;}say('クラウド草稿を保存しました（未公開）'+(data.baseChanged?'。公開 DB に別の更新があります。':''));}catch(e){say('保存失敗: '+e.message);}finally{$('saveCloud').disabled=false;}};
