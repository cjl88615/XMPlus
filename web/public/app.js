/* 塔岛听书 Web | AGPL-3.0-or-later */
(() => {
  'use strict';
  const $ = query => document.querySelector(query);
  const content = $('#content');
  const audio = $('#audio');
  const modalRoot = $('#modal-root');
  const toastEl = $('#toast');
  const icon = name => '<svg class="icon" aria-hidden="true"><use href="#ic-' + name + '"></use></svg>';
  const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const toId = x => /^[1-9][0-9]{0,18}$/.test(String(x)) ? String(x) : '';
  const cover = value => {
    try {
      const url = new URL(String(value || ''), location.origin);
      const host = url.hostname.toLowerCase();
      if (url.protocol === 'https:' && (host === 'xmcdn.com' || host.endsWith('.xmcdn.com') || host === 'ximalaya.com' || host.endsWith('.ximalaya.com'))) return url.href;
      if (url.origin === location.origin && ['/favicon.svg'].includes(url.pathname)) return url.href;
    } catch {}
    return '';
  };
  const albumCover = (item, klass) => {
    const src = cover(item.cover);
    return src ? '<img class="' + klass + '" src="' + escapeHtml(src) + '" alt="" loading="lazy">' : '<div class="cover-placeholder">♪</div>';
  };
  const timeText = seconds => {
    if (!Number.isFinite(Number(seconds)) || Number(seconds) < 0) return '0:00';
    const s = Math.floor(Number(seconds));
    return Math.floor(s / 3600) ? Math.floor(s / 3600) + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2,'0') : Math.floor(s / 60) + ':' + String(s % 60).padStart(2,'0');
  };
  const countText = v => {
    const num = Number(v) || 0;
    return num >= 10000 ? (num / 10000).toFixed(num >= 100000 ? 0 : 1) + ' 万' : String(Math.max(0,num));
  };
  const prefs = {
    theme:localStorage.getItem('xmplus_theme') || 'light',
    rate:Number(localStorage.getItem('xmplus_rate') || 1),
    volume:Number(localStorage.getItem('xmplus_volume') || .8),
    autoplay:localStorage.getItem('xmplus_autoplay') !== 'false'
  };
  const state = {
    view:'explore', category:'有声小说', q:'', type:'album', page:1, searchResult:null,
    session:{user:null,loggedIn:false,favorites:[],history:[],jobs:[]},
    album:null, albumTracks:[], albumPage:1, albumTotal:0, selected:new Set(),
    subTab:'albums', subData:null, queue:[], index:-1, track:null, lastView:'explore',
    restoring:false, modal:'', qrPoll:null, jobsPoll:null, requestVersion:0
  };
  let toastTimer;
  let lastProgressSave = 0;
  let pendingSeek = null;
  let lastRecordedTrackId = null;
  function toast(message, error=false) {
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.className = error ? 'show error' : 'show';
    toastTimer=setTimeout(()=>{toastEl.className='';},3800);
  }
  async function api(path, options={}) {
    const response = await fetch(path, {credentials:'same-origin',cache:'no-store', ...options,
      ...(options.body ? {headers:{'content-type':'application/json',...(options.headers||{})}} : {})});
    let data;
    try {data=await response.json();} catch {throw Error('服务响应异常');}
    if (!response.ok || !data.ok) throw Error(data.error || '操作失败');
    return data;
  }
  function renderError(text, retry) {
    content.innerHTML = '<div class="empty">' + icon('refresh') + '<h3>暂时无法加载</h3><p>' + escapeHtml(text) + '</p><button class="btn" data-action="' + (retry||'retry') + '">重试</button></div>';
  }
  function loading() {content.innerHTML='<div class="loading-state"><span class="spinner"></span><span>加载中…</span></div>';}
  function head(title, summary='', action='') {
    return '<div class="page-header"><div><div class="eyebrow">塔岛听书 · 有声馆</div><h1 class="page-heading">' + escapeHtml(title) + '</h1>' + (summary ? '<p class="page-summary">' + escapeHtml(summary) + '</p>' : '') + '</div>' + action + '</div>';
  }
  function empty(title, message, label='', action='') {
    return '<div class="empty">' + icon('headphones') + '<h3>' + escapeHtml(title) + '</h3><p>' + escapeHtml(message) + '</p>' + (label ? '<button class="btn" data-action="' + action + '">' + escapeHtml(label) + '</button>' : '') + '</div>';
  }
  function card(item) {
    const id = toId(item.id);
    if (!id) return '';
    return '<button class="album-card" data-album="' + id + '" aria-label="打开专辑 ' + escapeHtml(item.title) + '">' +
      '<span class="album-cover-wrap">' + albumCover(item,'album-cover') + (item.trackCount ? '<span class="album-count">' + countText(item.trackCount) + ' 集</span>' : '') + '</span>' +
      '<span class="album-card-title">' + escapeHtml(item.title) + '</span><span class="album-card-meta">' + escapeHtml(item.anchorName || item.category || '喜马拉雅') + '</span></button>';
  }
  function trackRow(track,index, showSelect=false) {
    const id=toId(track.id);
    if (!id) return '';
    const playing=state.track && String(state.track.id)===id;
    const title=escapeHtml(track.title||'未命名声音');
    return '<div class="track-row' + (playing?' is-playing':'') + '" data-track-row="' + id + '">' +
      '<span class="track-number">' + String(index) + '</span>' +
      '<button class="track-main" data-action="play-track" data-id="' + id + '" aria-label="播放 ' + title + '"><span class="track-title">' + title + '</span><span class="track-caption">' + escapeHtml(track.anchorName || track.albumTitle || (track.isPaid ? '付费声音' : '喜马拉雅')) + '</span></button>' +
      '<span class="track-duration">' + timeText(track.duration) + '</span>' +
      '<button class="icon-button" data-action="download-track" data-id="' + id + '" aria-label="下载 ' + title + '">' + icon('download') + '</button>' +
      (showSelect ? '<input class="select-track" type="checkbox" data-select="' + id + '" aria-label="选择 ' + title + '"' + (state.selected.has(id) ? ' checked' : '') + '>' : '<button class="icon-button" data-action="play-track" data-id="' + id + '" aria-label="播放 ' + title + '">' + icon('play') + '</button>') + '</div>';
  }
  function updateNav() {
    const active=['search','album'].includes(state.view) ? 'explore' : state.view;
    document.querySelectorAll('[data-view]').forEach(btn=>{
      const isActive=btn.dataset.view===active;
      btn.classList.toggle('active',isActive);
      if(isActive) btn.setAttribute('aria-current','page'); else btn.removeAttribute('aria-current');
    });
    $('#account-label').textContent=state.session.user?.nickname||'登录';
    $('#sidebar').classList.remove('open');
  }
  function setHash(view, id, push) {
    const target=view==='album' ? '#/album/'+id : view==='search' ? '#/search/'+encodeURIComponent(state.q)+'/'+state.type : view==='explore' ? '#/explore/'+encodeURIComponent(state.category) : '#/'+view;
    if (location.hash!==target) {
      if (push) history.pushState(null,'',target); else history.replaceState(null,'',target);
    }
  }
  async function go(view, value, push=true) {
    state.lastView = ['explore','search','favorites','subscriptions','history'].includes(state.view) ? state.view : state.lastView;
    state.view=view;
    if(view==='explore') state.category=value||'有声小说';
    if(view==='search') {
      if (value && value.q !== undefined) state.q=value.q;
      if (value && value.type) state.type=value.type;
      state.page=value && value.page || 1;
      $('#search-input').value=state.q;
    }
    if(view==='album') {
      if(String(value)!==String(state.album?.id)) {state.selected.clear();state.albumPage=1;state.album=null;state.albumTracks=[];}
      state.albumId=String(value);
    }
    setHash(view,value,push);
    updateNav();
    content.scrollTop=0;
    window.scrollTo({top:0,behavior:'instant'});
    const mark=++state.requestVersion;
    try {
      if(view==='explore') return await loadExplore(mark);
      if(view==='search') return await loadSearch(mark);
      if(view==='album') return await loadAlbum(mark);
      if(view==='history') return renderHistory();
      if(view==='favorites') return renderFavorites();
      if(view==='subscriptions') return await loadSubscriptions(mark);
      if(view==='downloads') return await loadDownloads(mark);
      if(view==='settings') return renderSettings();
    } catch(e) {
      if (mark===state.requestVersion) renderError(e.message);
    }
  }
  async function loadExplore(mark) {
    loading();
    const category=state.category;
    const data=await api('/api/search?type=album&q='+encodeURIComponent(category)+'&page=1');
    if(mark!==state.requestVersion)return;
    const albums=data.albums||[];
    const feature=albums[0];
    const cats=['有声小说','历史','相声','播客','儿童故事','悬疑','文学名著','音乐'];
    const hero='<div class="hero"><div class="hero-copy"><span class="hero-kicker">塔岛听书</span><h2>听见好故事。</h2><p>想听的声音，从这里找到。</p><div class="hero-actions"><button class="btn btn-hero" data-action="hero-play"' + (!feature?' disabled':'') + '>' + icon('play') + ' 探索专辑</button></div></div><div class="hero-art">' +
      (feature ? albumCover(feature,'hero-cover') : '<div class="hero-cover cover-placeholder">♪</div>') + '</div></div>';
    const pills='<div class="pills">'+cats.map(c=>'<button class="pill'+(c===category?' active':'')+'" data-category="'+escapeHtml(c)+'">'+escapeHtml(c)+'</button>').join('')+'</div>';
    content.innerHTML=hero+pills+'<div class="section-head"><h2>'+escapeHtml(category)+'</h2><p>'+countText(data.total)+' 个结果</p></div>'+
      (albums.length?'<div class="album-grid">'+albums.map(card).join('')+'</div>':empty('暂无专辑','换个分类试试'));
    state.feature=feature;
  }
  async function loadSearch(mark) {
    if(!state.q) return go('explore',undefined,false);
    loading();
    const result=await api('/api/search?type='+state.type+'&q='+encodeURIComponent(state.q)+'&page='+state.page);
    if(mark!==state.requestVersion)return;
    state.searchResult=result;
    const tabs='<div class="search-tabs"><button class="search-tab'+(state.type==='album'?' active':'')+'" data-type="album">专辑</button><button class="search-tab'+(state.type==='track'?' active':'')+'" data-type="track">声音</button></div>';
    let list='';
    if(state.type==='album') list=(result.albums||[]).length?'<div class="album-grid">'+result.albums.map(card).join('')+'</div>':empty('没有搜索结果','换个关键词试试');
    else {
      const tracks=result.tracks||[];
      list=tracks.length?'<div class="track-list">'+tracks.map((t,i)=>trackRow(t,(state.page-1)*20+i+1)).join('')+'</div>':empty('没有搜索结果','换个关键词试试');
    }
    content.innerHTML=head('搜索：'+state.q, '找到 '+countText(result.total)+' 条'+(state.type==='album'?'专辑':'声音'))+tabs+list+pagination(state.page, result.totalPages || Math.ceil((result.total||0)/20),'search');
  }
  function pagination(page,total,kind) {
    if(!total||total<=1)return '';
    return '<nav class="pagination" aria-label="翻页"><button class="btn" data-action="page" data-kind="'+kind+'" data-page="'+(page-1)+'"'+(page<=1?' disabled':'')+'>上一页</button><span>'+page+' / '+total+'</span><button class="btn" data-action="page" data-kind="'+kind+'" data-page="'+(page+1)+'"'+(page>=total?' disabled':'')+'>下一页</button></nav>';
  }
  async function loadAlbum(mark) {
    loading();
    const id=state.albumId, page=state.albumPage;
    const result=await api('/api/album/'+id+'?page='+page);
    if(mark!==state.requestVersion)return;
    state.album={...result.album,trackCount:result.totalCount||result.album.trackCount||0};
    state.albumTracks=(result.tracks||[]).map(t=>({...t,albumId:id,albumTitle:result.album.title,cover:t.cover||result.album.cover}));
    state.albumTotal=result.totalCount||0;
    renderAlbum();
  }
  function renderAlbum() {
    const album=state.album;
    if(!album)return;
    const favorited=state.session.favorites.some(x=>String(x.id)===String(album.id));
    const src=cover(album.cover);
    const desc=album.intro || '';
    const pageCount=Math.max(state.albumPage,Math.ceil(state.albumTotal/30));
    const selected=state.selected.size;
    const detail='<button class="back-link" data-action="back">'+icon('back')+' 返回</button>'+
      '<div class="album-detail"><div>'+(src?'<img class="detail-cover" src="'+escapeHtml(src)+'" alt="专辑封面">':'<div class="detail-cover cover-placeholder">♪</div>')+'</div>'+
      '<div class="detail-copy"><div class="eyebrow">专辑</div><h1>'+escapeHtml(album.title)+'</h1>'+
      '<div class="detail-subtitle">'+escapeHtml(album.anchorName||'喜马拉雅')+(album.category?'　·　'+escapeHtml(album.category):'')+(album.trackCount?'　·　'+countText(album.trackCount)+' 集':'')+'</div>'+
      (desc?'<p class="detail-description">'+escapeHtml(desc)+'</p>':'')+
      '<div class="detail-actions"><button class="btn btn-primary" data-action="play-all">'+icon('play')+' 播放全部</button>'+
      '<button class="btn" data-action="favorite">'+icon('heart')+(favorited?' 已收藏':' 收藏')+'</button>'+
      (state.session.loggedIn?'<button class="btn btn-quiet" data-action="subscribe">'+icon('library')+' 订阅</button>':'')+
      '</div></div></div>';
    const toolbar='<div class="list-header"><h2>声音列表 <small>'+countText(album.trackCount||state.albumTotal)+' 集</small></h2>'+
      '<div class="list-toolbar">'+(selected?'<span class="selection-text">已选 '+selected+' 首</span>':'')+
      '<button class="btn btn-quiet" data-action="select-page">'+(state.albumTracks.every(t=>state.selected.has(String(t.id)))?'取消本页':'全选本页')+'</button>'+
      '<button class="btn btn-primary" data-action="batch"'+(selected?'':' disabled')+'>'+icon('download')+' 批量下载</button></div></div>';
    const rows=state.albumTracks.length?'<div class="track-list">'+state.albumTracks.map((t,i)=>trackRow(t,(state.albumPage-1)*30+i+1,true)).join('')+'</div>':empty('该页暂无声音','部分专辑可能已下架');
    content.innerHTML=detail+toolbar+rows+pagination(state.albumPage,pageCount,'album');
  }
  function renderFavorites() {
    const items=state.session.favorites||[];
    content.innerHTML=head('我的收藏',items.length+' 张专辑')+(items.length?'<div class="album-grid">'+items.map(card).join('')+'</div>':empty('还没有收藏专辑','浏览专辑时，点击“收藏”即可保存。','去发现','explore'));
  }
  function renderHistory() {
    const items=state.session.history||[];
    content.innerHTML=head('听过的声音',items.length+' 首')+(items.length?'<div class="simple-list">'+items.map(t=>
      '<div class="simple-row">'+(cover(t.cover)?'<img class="simple-cover" src="'+escapeHtml(cover(t.cover))+'" alt="" loading="lazy">':'<div class="simple-cover cover-placeholder">♪</div>')+
      '<button class="simple-main" data-action="play-history" data-id="'+toId(t.id)+'"><strong>'+escapeHtml(t.title)+'</strong><small>'+escapeHtml(t.albumTitle||'喜马拉雅')+'</small></button>'+
      '<div class="simple-actions"><button class="icon-button" data-action="download-track" data-id="'+toId(t.id)+'" aria-label="下载">'+icon('download')+'</button><button class="icon-button" data-action="play-history" data-id="'+toId(t.id)+'" aria-label="播放">'+icon('play')+'</button></div></div>').join('')+'</div>':empty('还没有收听记录','播放一首声音后，会出现在这里。','去发现','explore'));
  }
  async function loadSubscriptions(mark) {
    if(!state.session.loggedIn) {
      content.innerHTML=head('我的订阅')+empty('登录后查看喜马拉雅收藏','扫码登录即可查看账号中的订阅与喜欢。','扫码登录','account');return;
    }
    loading();
    const result=await api(state.subTab==='albums'?'/api/subscriptions?page='+state.page:'/api/likes?page='+state.page);
    if(mark!==state.requestVersion)return;
    state.subData=result;
    const tabs='<div class="search-tabs"><button class="search-tab'+(state.subTab==='albums'?' active':'')+'" data-subtab="albums">订阅专辑</button><button class="search-tab'+(state.subTab==='tracks'?' active':'')+'" data-subtab="tracks">喜欢的声音</button></div>';
    let list;
    if(state.subTab==='albums') list=(result.albums||[]).length?'<div class="album-grid">'+result.albums.map(card).join('')+'</div>':empty('暂无订阅专辑','可在专辑详情页订阅专辑');
    else list=(result.tracks||[]).length?'<div class="track-list">'+result.tracks.map((t,i)=>trackRow(t,(state.page-1)*30+i+1)).join('')+'</div>':empty('暂无喜欢的声音','账号里还没有收藏声音');
    content.innerHTML=head('我的订阅',state.session.user.nickname)+tabs+list+
      (result.hasMore||state.page>1?pagination(state.page,result.hasMore?state.page+1:state.page,'subscriptions'):'');
  }
  async function loadDownloads(mark) {
    loading();
    const result=await api('/api/jobs');
    if(mark!==state.requestVersion)return;
    state.session.jobs=result.jobs||[];
    renderDownloads();
    startJobPolling();
  }
  function renderDownloads() {
    const jobs=state.session.jobs||[];
    const info=head('下载', '单曲直接保存至浏览器，批量下载打包为 ZIP。');
    if(!jobs.length) {content.innerHTML=info+empty('暂无下载任务','在专辑页勾选声音后，可以批量下载。','去发现','explore');return;}
    content.innerHTML=info+'<div class="job-list">'+jobs.map(job=>{
      const processing=['running','queued'].includes(job.status);
      const status=job.status==='done'?'已完成':job.status==='error'?'失败':job.status==='running'?'下载中':'等待中';
      const errors=Array.isArray(job.errors) && job.errors.length?'<p>'+escapeHtml(job.errors.slice(0,2).join('；'))+'</p>':'';
      return '<div class="job"><div class="job-symbol">'+icon('download')+'</div>'+
      '<div class="job-main"><strong>'+job.total+' 首声音</strong><p>'+status+' · '+job.completed+'/'+job.total+' 首'+(job.size?' · '+(job.size/1048576).toFixed(1)+' MB':'')+'</p>'+errors+
      (processing?'<progress max="'+job.total+'" value="'+job.completed+'"></progress>':'')+'</div>'+
      (job.status==='done'?'<a class="btn btn-primary" href="/api/jobs/'+job.id+'/file" download>'+icon('download')+' 保存 ZIP</a>':'<span class="job-status">'+status+'</span>')+'</div>';
    }).join('')+'</div>';
  }
  function startJobPolling() {
    if(state.jobsPoll)clearInterval(state.jobsPoll);
    if(!state.session.jobs.some(j=>['running','queued'].includes(j.status)))return;
    state.jobsPoll=setInterval(async()=>{
      try {
        const data=await api('/api/jobs');
        state.session.jobs=data.jobs;
        if(state.view==='downloads')renderDownloads();
        if(!data.jobs.some(j=>['running','queued'].includes(j.status))) {clearInterval(state.jobsPoll);state.jobsPoll=null;}
      } catch {}
    },2500);
  }
  function renderSettings() {
    content.innerHTML=head('设置')+'<div class="settings-panel">'+
      '<div class="setting-row"><div><strong>深色模式</strong></div><button class="toggle-switch'+(prefs.theme==='dark'?' on':'')+'" data-action="theme" role="switch" aria-checked="'+(prefs.theme==='dark')+'" aria-label="深色模式"></button></div>'+
      '<div class="setting-row"><div><strong>自动连播</strong><small>当前声音结束后播放队列中的下一首</small></div><button class="toggle-switch'+(prefs.autoplay?' on':'')+'" data-action="autoplay" role="switch" aria-checked="'+prefs.autoplay+'" aria-label="自动连播"></button></div>'+
      '<div class="setting-row"><div><strong>播放速度</strong></div><select id="setting-speed" aria-label="播放速度"><option value="0.75">0.75×</option><option value="1">1.0×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2.0×</option></select></div>'+
      '<div class="setting-row"><div><strong>账号</strong><small>'+(state.session.loggedIn?escapeHtml(state.session.user.nickname):'未登录喜马拉雅')+'</small></div><button class="btn" data-action="account">'+(state.session.loggedIn?'查看账号':'扫码登录')+'</button></div></div>';
    $('#setting-speed').value=String(prefs.rate);
  }
  function saveLast() {
    if(!state.track)return;
    const item={queue:state.queue,index:state.index,track:state.track,position:audio.currentTime||0};
    try {localStorage.setItem('xmplus_last',JSON.stringify(item));} catch {}
  }
  function renderPlayer() {
    const item=state.track;
    if(!item)return;
    $('#player').hidden=false;
    $('#player-title').textContent=item.title||'声音';
    $('#player-subtitle').textContent=item.albumTitle||item.anchorName||'喜马拉雅';
    const coverSrc=cover(item.cover)||'/favicon.svg';
    if($('#player-cover').getAttribute('src')!==coverSrc)$('#player-cover').src=coverSrc;
    const toggle=$('[data-action="toggle"]');
    const glyph=toggle.querySelector('use');
    const glyphHref='#ic-'+(audio.paused?'play':'pause');
    if(glyph && glyph.getAttribute('href')!==glyphHref)glyph.setAttribute('href',glyphHref);
    toggle.setAttribute('aria-label',audio.paused?'播放':'暂停');
    if(pendingSeek===null){
      $('#time-current').textContent=timeText(audio.currentTime);
      $('#seek').value=audio.duration&&Number.isFinite(audio.duration)?Math.min(1000,Math.max(0,Math.floor(audio.currentTime/audio.duration*1000))):0;
    }
    $('#time-duration').textContent=timeText(audio.duration||item.duration||0);
    if(document.activeElement!==$('#speed'))$('#speed').value=String(prefs.rate);
    if(document.activeElement!==$('#volume'))$('#volume').value=String(Math.round(prefs.volume*100));
    document.body.classList.add('has-player');
  }
  async function playTrack(track, queue, idx, resumeAt=0, shouldPlay=true) {
    if(!track || !toId(track.id))return;
    state.queue=queue&&queue.length?queue:[track];
    state.index=Math.max(0,idx);
    state.track=track;
    pendingSeek=null;
    audio.pause();
    audio.src='/api/stream/'+track.id;
    audio.playbackRate=prefs.rate;
    audio.volume=prefs.volume;
    audio.load();
    if(resumeAt>0) audio.addEventListener('loadedmetadata',function once(){audio.removeEventListener('loadedmetadata',once);audio.currentTime=Math.min(resumeAt,Math.max(0,(audio.duration||resumeAt+1)-1));},{once:true});
    renderPlayer();
    saveLast();
    if(shouldPlay) {
      try {await audio.play();} catch(e) { if(e.name!=='AbortError')toast(e.name==='NotAllowedError'?'浏览器已阻止自动播放，请点播放按钮':'播放失败，可能需要登录或已购权限',true); }
    }
  }
  function recordPlayback() {
    const track=state.track;
    if(!track || !toId(track.id) || lastRecordedTrackId===String(track.id))return;
    lastRecordedTrackId=String(track.id);
    const entry={id:String(track.id),title:track.title||'',albumId:track.albumId||'',albumTitle:track.albumTitle||'',cover:track.cover||''};
    state.session.history=[{...entry,when:Date.now()},...state.session.history.filter(x=>String(x.id)!==String(track.id))].slice(0,200);
    void api('/api/history',{method:'POST',body:JSON.stringify(entry)}).catch(()=>{});
    if(state.view==='history')renderHistory();
  }
  function findTrack(id) {
    const keys=[...state.albumTracks,...(state.searchResult?.tracks||[]),...(state.subData?.tracks||[]),...state.session.history];
    return keys.find(x=>String(x.id)===String(id));
  }
  function playingQueue(id) {
    if(state.view==='album')return state.albumTracks;
    if(state.view==='search')return state.searchResult?.tracks||[];
    if(state.view==='subscriptions'&&state.subTab==='tracks')return state.subData?.tracks||[];
    if(state.view==='history')return state.session.history;
    return [findTrack(id)].filter(Boolean);
  }
  function moveTrack(offset) {
    if(!state.queue.length)return;
    let index=state.index+offset;
    if(index>=state.queue.length) index=0;
    if(index<0)index=state.queue.length-1;
    void playTrack(state.queue[index],state.queue,index);
  }
  function downloadTrack(id) {
    const link=document.createElement('a');
    link.href='/api/download/'+id;
    link.download='';
    document.body.append(link);
    link.click();
    link.remove();
  }
  function closeModal() {
    if(state.qrPoll) {clearInterval(state.qrPoll);state.qrPoll=null;}
    state.modal='';
    modalRoot.innerHTML='';
  }
  function modal(html) {
    modalRoot.innerHTML='<div class="modal-backdrop" data-action="modal-bg"><div class="modal" role="dialog" aria-modal="true" aria-label="账号登录">'+
      '<button class="icon-button close" data-action="modal-close" aria-label="关闭">'+icon('close')+'</button>'+html+'</div></div>';
    modalRoot.querySelector('.close').focus();
  }
  async function showAccount() {
    closeModal();
    state.modal='account';
    if(state.session.loggedIn) {
      const u=state.session.user;
      modal('<h2>喜马拉雅账号</h2><div class="modal-profile"><span class="account-avatar">'+icon('user')+'</span><div><strong>'+escapeHtml(u.nickname)+'</strong><small>'+(u.isVip?'VIP 会员':'已登录')+'</small></div></div><div class="modal-footer"><button class="btn" data-action="modal-close">返回</button><button class="btn btn-primary" data-action="logout">退出登录</button></div>');
      return;
    }
    modal('<div class="modal-center"><h2>扫码登录</h2><p>使用喜马拉雅 App 扫描二维码</p><div id="qr-area" class="loading-state"><span class="spinner"></span></div><p id="qr-status">正在获取二维码…</p><button class="btn btn-quiet" data-action="qr-refresh">'+icon('refresh')+' 刷新二维码</button></div>');
    await createQr();
  }
  async function createQr() {
    if(state.qrPoll) clearInterval(state.qrPoll);
    try {
      const data=await api('/api/qr',{method:'POST',body:'{}'});
      if(state.modal!=='account')return;
      $('#qr-area').className='';
      $('#qr-area').innerHTML='<img class="modal-qr" src="'+escapeHtml(data.imageDataUrl)+'" alt="登录二维码">';
      $('#qr-status').textContent='扫码并在手机上确认登录';
      state.qrPoll=setInterval(async()=>{
        if(state.modal!=='account')return;
        try{
          const r=await api('/api/qr/check',{method:'POST',body:'{}'});
          if(r.status==='success') {
            state.session.user=r.user;state.session.loggedIn=true;
            closeModal();updateNav();toast('登录成功');
            if(state.view==='subscriptions')void go('subscriptions',null,false);
          }
        }catch(e) {
          if($('#qr-status'))$('#qr-status').textContent=e.message;
          if(e.message.includes('过期')){clearInterval(state.qrPoll);state.qrPoll=null;}
        }
      },2600);
    }catch(e){
      if($('#qr-area'))$('#qr-area').innerHTML=empty('登录暂不可用',e.message);
      if($('#qr-status'))$('#qr-status').textContent='';
    }
  }
  function showQueue() {
    if(!state.queue.length){toast('播放队列为空');return;}
    state.modal='queue';
    modalRoot.innerHTML='<div class="modal-backdrop" data-action="modal-bg"><aside class="queue-drawer" role="dialog" aria-modal="true" aria-label="播放队列"><div class="queue-header"><h2>播放队列 · '+state.queue.length+'</h2><button class="icon-button" data-action="modal-close" aria-label="关闭">'+icon('close')+'</button></div>'+
      state.queue.map((t,i)=>'<button class="queue-row'+(i===state.index?' active':'')+'" data-action="queue-play" data-index="'+i+'"><small>'+String(i+1).padStart(2,'0')+'</small><span>'+escapeHtml(t.title)+'</span>'+(i===state.index?icon('play'):'')+'</button>').join('')+'</aside></div>';
    modalRoot.querySelector('[data-action="modal-close"]').focus();
  }
  async function batchDownload() {
    if(state.selected.size===0)return toast('请先选择声音',true);
    if(state.selected.size>40)return toast('每批最多下载 40 首',true);
    try {
      const data=await api('/api/jobs',{method:'POST',body:JSON.stringify({ids:[...state.selected]})});
      state.selected.clear();
      toast('批量下载已创建');
      void go('downloads');
    } catch(e){toast(e.message,true);}
  }
  function toggleTheme() {
    prefs.theme=prefs.theme==='dark'?'light':'dark';
    document.documentElement.dataset.theme=prefs.theme;
    localStorage.setItem('xmplus_theme',prefs.theme);
    if(state.view==='settings')renderSettings();
  }
  async function refreshSession() {
    try {state.session=await api('/api/session'); updateNav();}catch(e){toast(e.message,true);}
  }
  async function clickAction(el,e) {
    const action=el.dataset.action, id=el.dataset.id;
    switch(action) {
      case 'theme':toggleTheme();break;
      case 'autoplay':prefs.autoplay=!prefs.autoplay;localStorage.setItem('xmplus_autoplay',String(prefs.autoplay));renderSettings();break;
      case 'account':void showAccount();break;
      case 'logout':
        try {await api('/api/logout',{method:'POST',body:'{}'});closeModal();await refreshSession();toast('已退出登录');if(state.view==='subscriptions')void go('subscriptions',null,false);}
        catch(e){toast(e.message,true);}break;
      case 'modal-close':closeModal();break;
      case 'qr-refresh':void createQr();break;
      case 'modal-bg':if(el===e.target)closeModal();break;
      case 'back': history.length>1?history.back():void go(state.lastView); break;
      case 'hero-play':if(state.feature)void go('album',state.feature.id);break;
      case 'play-track':
      case 'play-history':{
        const t=findTrack(id);
        if(!t) return toast('声音信息不存在',true);
        const queue=playingQueue(id);
        void playTrack(t,queue,Math.max(0,queue.findIndex(x=>String(x.id)===id)));
        break;
      }
      case 'play-all':
        if(state.albumTracks.length)void playTrack(state.albumTracks[0],state.albumTracks,0);
        else toast('当前页暂无可播放的声音',true);break;
      case 'toggle':if(!state.track)return;
        if(audio.paused){audio.play().catch(()=>toast('播放失败，请检查网络或账号权限',true));}
        else audio.pause();break;
      case 'prev':moveTrack(-1);break;
      case 'next':moveTrack(1);break;
      case 'queue':showQueue();break;
      case 'queue-play':{
        const i=Number(el.dataset.index);
        if(state.queue[i]) {void playTrack(state.queue[i],state.queue,i);closeModal();}
        break;
      }
      case 'download-track':downloadTrack(id);break;
      case 'select-page':{
        const all=state.albumTracks.every(t=>state.selected.has(String(t.id)));
        state.albumTracks.forEach(t=>all?state.selected.delete(String(t.id)):state.selected.add(String(t.id)));
        renderAlbum();break;
      }
      case 'batch':await batchDownload();break;
      case 'favorite':{
        if(!state.album)return;
        const found=state.session.favorites.some(x=>String(x.id)===String(state.album.id));
        try {
          const r=await api('/api/favorites',{method:'POST',body:JSON.stringify({album:state.album,on:!found})});
          state.session.favorites=r.favorites;renderAlbum();toast(found?'已取消收藏':'已收藏');
        }catch(e){toast(e.message,true);}break;
      }
      case 'subscribe':
        if(!state.album)return;
        try {await api('/api/subscriptions',{method:'POST',body:JSON.stringify({albumId:String(state.album.id),on:true})});toast('订阅成功');}
        catch(e){toast(e.message,true);}break;
      case 'page':{
        const num=Number(el.dataset.page);if(!num||num<1)return;
        if(el.dataset.kind==='album'){state.albumPage=num;void go('album',state.albumId,false);}
        else if(el.dataset.kind==='search')void go('search',{q:state.q,type:state.type,page:num},false);
        else {state.page=num;void go('subscriptions',null,false);}
        break;
      }
      case 'retry':void go(state.view,state.view==='album'?state.albumId:state.view==='explore'?state.category:{q:state.q,type:state.type,page:state.page},false);break;
      case 'explore':void go('explore');break;
      default:break;
    }
  }
  function onNavigate() {
    const hash=decodeURIComponent(location.hash.slice(2)||'');
    const parts=hash.split('/');
    if(parts[0]==='album'&&toId(parts[1]))return go('album',parts[1],false);
    if(parts[0]==='search')return go('search',{q:parts[1]||'',type:['album','track'].includes(parts[2])?parts[2]:'album'},false);
    if(parts[0]==='explore')return go('explore',parts[1]||'有声小说',false);
    if(['history','favorites','subscriptions','downloads','settings'].includes(parts[0]))return go(parts[0],null,false);
    return go('explore',undefined,false);
  }
  document.addEventListener('click',e=>{
    const sidebar=e.target.closest('[data-view]');
    if(sidebar){e.preventDefault();void go(sidebar.dataset.view);return;}
    const category=e.target.closest('[data-category]');
    if(category){e.preventDefault();void go('explore',category.dataset.category);return;}
    const album=e.target.closest('[data-album]');
    if(album){e.preventDefault();void go('album',album.dataset.album);return;}
    const type=e.target.closest('[data-type]');
    if(type){e.preventDefault();void go('search',{q:state.q,type:type.dataset.type,page:1});return;}
    const subtab=e.target.closest('[data-subtab]');
    if(subtab){e.preventDefault();state.subTab=subtab.dataset.subtab;state.page=1;void go('subscriptions',null,false);return;}
    const action=e.target.closest('[data-action]');
    if(action){e.preventDefault();void clickAction(action,e);return;}
  });
  document.addEventListener('change',e=>{
    if(e.target.matches('[data-select]')){const id=e.target.dataset.select;if(e.target.checked)state.selected.add(id);else state.selected.delete(id);renderAlbum();}
    if(e.target.id==='speed'||e.target.id==='setting-speed'){prefs.rate=Number(e.target.value)||1;audio.playbackRate=prefs.rate;localStorage.setItem('xmplus_rate',String(prefs.rate));$('#speed').value=String(prefs.rate);if(state.view==='settings')renderSettings();}
    if(e.target.id==='volume'){prefs.volume=Number(e.target.value)/100;audio.volume=prefs.volume;localStorage.setItem('xmplus_volume',String(prefs.volume));}
  });
  $('#search-form').addEventListener('submit',e=>{
    e.preventDefault();
    const q=$('#search-input').value.trim();
    if(q)void go('search',{q,type:state.type,page:1});
    else toast('请输入搜索词',true);
  });
  $('#menu-btn').addEventListener('click',()=>{$('#sidebar').classList.toggle('open');});
  $('#seek').addEventListener('input',e=>{
    if(Number.isFinite(audio.duration)&&audio.duration>0){
      pendingSeek=Number(e.target.value)/1000;
      $('#time-current').textContent=timeText(pendingSeek*audio.duration);
    }
  });
  $('#seek').addEventListener('change',e=>{
    if(Number.isFinite(audio.duration)&&audio.duration>0)audio.currentTime=(Number(e.target.value)/1000)*audio.duration;
    pendingSeek=null;
    renderPlayer();
  });
  $('#seek').addEventListener('pointercancel',()=>{pendingSeek=null;renderPlayer();});
  $('#volume').addEventListener('input',e=>{prefs.volume=Number(e.target.value)/100;audio.volume=prefs.volume;localStorage.setItem('xmplus_volume',String(prefs.volume));});
  audio.addEventListener('timeupdate',()=>{
    if(!state.track)return;
    renderPlayer();
    if(Date.now()-lastProgressSave>3500){saveLast();lastProgressSave=Date.now();}
  });
  audio.addEventListener('durationchange',renderPlayer);
  audio.addEventListener('play',renderPlayer);
  audio.addEventListener('playing',recordPlayback);
  audio.addEventListener('pause',()=>{renderPlayer();saveLast();});
  audio.addEventListener('ended',()=>{if(prefs.autoplay&&state.queue.length>1)moveTrack(1);});
  audio.addEventListener('error',()=>{if(state.track)toast('音频无法播放，请检查网络或账号权限',true);});
  window.addEventListener('keydown',e=>{if(e.key==='Escape'&&state.modal)closeModal();});
  window.addEventListener('popstate',onNavigate);
  document.documentElement.dataset.theme=prefs.theme;
  audio.volume=prefs.volume; audio.playbackRate=prefs.rate;
  $('#volume').value=String(Math.round(prefs.volume*100));
  async function init() {
    await refreshSession();
    try{
      const prev=JSON.parse(localStorage.getItem('xmplus_last')||'null');
      if(prev && prev.track && toId(prev.track.id)){
        await playTrack(prev.track,Array.isArray(prev.queue)?prev.queue:[prev.track],Number(prev.index)||0,Number(prev.position)||0,false);
      }
    }catch{}
    void onNavigate();
  }
  void init();
})();
