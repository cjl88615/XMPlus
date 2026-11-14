// SPDX-License-Identifier: AGPL-3.0-or-later
// XMPlus Web HTTP adapter. Third-party API implementation: ./lib/xmly.js (MIT).
import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, createReadStream, createWriteStream, statSync, rmSync, readdirSync } from 'node:fs';
import { join, extname, resolve as resolvePath } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import {
  XmlyError, searchAlbums, searchTracks, albumSimple, albumTracks,
  resolvePlay, qrCreate, qrCheck, getCurrentUser, mySubscriptions, likeTracks,
  setSubscriptionAlbum, joinCookieMap, UA_WEB
} from './lib/xmly.js';

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 38110);
const HOST = process.env.HOST || '127.0.0.1';
const DATA = resolvePath(process.env.XMPLUS_DATA_DIR || join(import.meta.dirname || '.', '.data'));
const STATIC = join(import.meta.dirname || '.', 'public');
const DOWNLOADS = join(DATA, 'downloads');
const STATE_FILE = join(DATA, 'sessions.json');
const SESSION_AGE = 30 * 86400000;
const CACHE_MS = 2 * 60000;
const MAX_BATCH = 40;
const MAX_JOB_BYTES = 1024 * 1024 * 1024;
const MAX_AUDIO_BYTES = 160 * 1024 * 1024;
const allowedMediaHosts = ['xmcdn.com', 'ximalaya.com'];
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.png':'image/png', '.ico':'image/x-icon', '.svg':'image/svg+xml' };

mkdirSync(DATA, { recursive: true, mode: 0o700 });
mkdirSync(DOWNLOADS, { recursive: true, mode: 0o700 });
let sessions = new Map();
try {
  const items = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  if (Array.isArray(items)) for (const record of items) {
    if (typeof record.id !== 'string' || !/^[A-Za-z0-9_-]{30,64}$/.test(record.id) || Date.now() - record.last > SESSION_AGE) continue;
    record.jobs = Array.isArray(record.jobs) ? record.jobs : [];
    for (const job of record.jobs) if (job.status === 'running' || job.status === 'queued') { job.status = 'error'; job.error = '服务重启，任务已中断'; }
    record.favorites = Array.isArray(record.favorites) ? record.favorites : [];
    record.history = Array.isArray(record.history) ? record.history : [];
    record.cookies = record.cookies && typeof record.cookies === 'object' ? record.cookies : {};
    sessions.set(record.id, record);
  }
} catch { /* Fresh installation. */ }
function save() {
  const tmp = STATE_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify([...sessions.values()].map(s => ({
    id:s.id, last:s.last, cookies:s.cookies, user:s.user,
    favorites:s.favorites.slice(0, 150), history:s.history.slice(0, 200), jobs:s.jobs.slice(0, 30)
  }))), { encoding:'utf8', mode:0o600 });
  renameSync(tmp, STATE_FILE);
}
const now = () => Date.now();
const safeId = value => /^[1-9][0-9]{0,18}$/.test(String(value)) ? String(value) : null;
const positive = (value, fallback, max) => {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new XmlyError('分页参数无效', 'BAD_REQUEST', 400);
  return n;
};
const cleanTitle = t => String(t || 'XMPlus').normalize('NFC').replace(/[\\/\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '').slice(0, 88) || 'XMPlus';
function httpError(msg, status = 400, code = 'BAD_REQUEST') { throw new XmlyError(msg, code, status); }
function headers(res, status, values = {}) {
  res.writeHead(status, {
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY', 'cache-control':'no-store',
    'content-security-policy': "default-src 'self'; img-src 'self' data: https://*.xmcdn.com https://*.ximalaya.com; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    ...values
  });
}
function json(res, value, status = 200) {
  headers(res, status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
function sessionFor(req, res) {
  const raw = /(?:^|;\s*)xmplus_sid=([A-Za-z0-9_-]{30,64})(?:;|$)/.exec(req.headers.cookie || '');
  let s = raw ? sessions.get(raw[1]) : null;
  if (!s || now() - s.last > SESSION_AGE) {
    s = { id:randomBytes(32).toString('base64url'), last:now(), cookies:{}, user:null, favorites:[], history:[], jobs:[] };
    sessions.set(s.id, s);
    res.setHeader('set-cookie', 'xmplus_sid=' + s.id + '; Max-Age=2592000; HttpOnly; SameSite=Strict; Path=/');
    // Persist so the new browser continues to own its session after restart.
    save();
  }
  s.last = now();
  return s;
}
function privateState(s) {
  return {
    user:s.user || null,
    loggedIn:!!(s.user && s.user.uid),
    favorites:s.favorites.slice(0, 150),
    history:s.history.slice(0, 100),
    jobs:s.jobs.slice(0, 30).map(publicJob)
  };
}
function publicJob(job) {
  return { id:job.id, status:job.status, total:job.ids.length, completed:job.completed || 0, errors:job.errors || [], error:job.error || '', createdAt:job.createdAt, size:job.size || 0 };
}
function getCookie(s) { return joinCookieMap(s.cookies || {}); }
async function body(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk.toString('utf8');
    if (data.length > 65536) httpError('提交内容过大', 413);
  }
  if (!data.trim()) return {};
  try { const v = JSON.parse(data); if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error(); return v; }
  catch { httpError('请求格式无效'); }
}
function validAlbum(v) {
  const id = safeId(v && v.id);
  if (!id) httpError('专辑 ID 无效');
  return { id, title:String(v.title || '').slice(0, 200), cover:String(v.cover || '').slice(0, 500), anchorName:String(v.anchorName || '').slice(0, 100), trackCount:Math.max(0, Number(v.trackCount) || 0) };
}
function getMediaUrl(value) {
  let url;
  try { url = new URL(value); } catch { httpError('音频地址无效', 502, 'INVALID_MEDIA'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || !allowedMediaHosts.some(h => host === h || host.endsWith('.' + h))) {
    httpError('音频来源不受支持', 502, 'INVALID_MEDIA');
  }
  return url;
}
async function fetchMedia(url, range, signal) {
  for (let redirects = 0; redirects < 5; redirects++) {
    const parsed = getMediaUrl(url);
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(parsed, {
          headers:{ 'user-agent':UA_WEB, referer:'https://www.ximalaya.com/', ...(range ? {range} : {}) },
          redirect:'manual', signal
        });
        break;
      } catch (e) {
        if (signal?.aborted || attempt === 2) httpError('音频源连接失败', 502, 'AUDIO_NETWORK');
        await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const loc = response.headers.get('location');
      if (!loc) httpError('音频源跳转异常', 502, 'AUDIO_REDIRECT');
      try { await response.body?.cancel(); } catch {}
      url = new URL(loc, parsed).toString();
      continue;
    }
    return response;
  }
  httpError('音频源跳转次数过多', 502, 'AUDIO_REDIRECT');
}
async function audioFor(s, id) {
  s.audioCache ||= new Map();
  const cached = s.audioCache.get(id);
  if (cached && cached.until > now()) return cached.audio;
  const audio = await resolvePlay(id, getCookie(s));
  getMediaUrl(audio.url);
  s.audioCache.set(id, { audio, until:now() + 9 * 60000 });
  if (s.audioCache.size > 100) s.audioCache.delete(s.audioCache.keys().next().value);
  return audio;
}
async function streamAudio(req, res, s, id, download = false) {
  const audio = await audioFor(s, id);
  if (req.headers.range && !/^bytes=\d*-\d*$/.test(req.headers.range)) httpError('Range 格式无效', 416);
  const ctrl = new AbortController();
  let timeout = setTimeout(() => ctrl.abort(), 18000);
  let upstream = await fetchMedia(audio.url, req.headers.range, ctrl.signal);
  clearTimeout(timeout);
  if ([403,404].includes(upstream.status)) {
    s.audioCache.delete(id);
    const fresh = await audioFor(s, id);
    timeout = setTimeout(() => ctrl.abort(), 18000);
    upstream = await fetchMedia(fresh.url, req.headers.range, ctrl.signal);
    clearTimeout(timeout);
  }
  if (upstream.status !== 200 && upstream.status !== 206) {
    try { await upstream.body?.cancel(); } catch {}
    httpError('音频请求被拒绝（HTTP ' + upstream.status + '）', 502, 'AUDIO_UNAVAILABLE');
  }
  const length = Number(upstream.headers.get('content-length') || 0);
  if (length > MAX_AUDIO_BYTES) { await upstream.body?.cancel(); httpError('文件超过单曲大小限制', 413); }
  const type = upstream.headers.get('content-type') || 'audio/mp4';
  const extension = type.includes('mpeg') ? '.mp3' : type.includes('aac') ? '.aac' : '.m4a';
  const out = { 'content-type':type, 'accept-ranges':'bytes', 'cache-control':'private, no-store' };
  for (const h of ['content-length','content-range']) { const v=upstream.headers.get(h); if (v) out[h]=v; }
  if (download) out['content-disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(cleanTitle(audio.title || 'XMPlus-' + id) + extension);
  headers(res, upstream.status, out);
  if (req.method === 'HEAD') { await upstream.body?.cancel(); res.end(); return; }
  const stream = Readable.fromWeb(upstream.body);
  res.on('close', () => { stream.destroy(); ctrl.abort(); });
  stream.on('error', () => { try { res.destroy(); } catch {} });
  stream.pipe(res);
}
async function downloadOne(s, id, dest, budget) {
  const audio = await audioFor(s, id);
  const upstream = await fetchMedia(audio.url, undefined, AbortSignal.timeout(120000));
  if (upstream.status !== 200) {
    await upstream.body?.cancel(); httpError('该曲目无法下载（HTTP ' + upstream.status + '）', 502, 'AUDIO_UNAVAILABLE');
  }
  const size = Number(upstream.headers.get('content-length') || 0);
  if (size > MAX_AUDIO_BYTES || size > budget) { await upstream.body?.cancel(); httpError('文件超过下载限制', 413); }
  let count = 0;
  const stream = Readable.fromWeb(upstream.body);
  stream.on('data', chunk => {
    count += chunk.length;
    if (count > MAX_AUDIO_BYTES || count > budget) stream.destroy(new Error('文件大小超过限制'));
  });
  try { await pipeline(stream, createWriteStream(dest, {mode:0o600})); }
  catch (e) { try { rmSync(dest, {force:true}); } catch {} throw e; }
  if (!count) httpError('音频为空', 502, 'AUDIO_EMPTY');
  return count;
}
async function runJob(s, job) {
  job.status = 'running';
  save();
  const folder = join(DOWNLOADS, job.id);
  mkdirSync(folder, {recursive:true, mode:0o700});
  const files = [];
  let remaining = MAX_JOB_BYTES;
  for (let index = 0; index < job.ids.length; index++) {
    const id = job.ids[index];
    try {
      const audio = await audioFor(s, id);
      const extension = new URL(audio.url).pathname.toLowerCase().endsWith('.mp3') ? '.mp3' : '.m4a';
      const filename = String(index + 1).padStart(3, '0') + '-' + cleanTitle(audio.title || id) + extension;
      const dest = join(folder, filename);
      const amount = await downloadOne(s, id, dest, remaining);
      remaining -= amount;
      files.push(dest);
      job.size = (job.size || 0) + amount;
    } catch (e) {
      job.errors.push('第' + (index + 1) + '首：' + String(e.message || e).slice(0, 100));
    }
    job.completed = index + 1;
    save();
    if (remaining < 1024 * 1024) { job.errors.push('达到批量下载空间上限'); break; }
  }
  if (!files.length) {
    job.status = 'error';
    job.error = '全部下载失败';
  } else {
    try {
      const archive = join(DOWNLOADS, job.id + '.zip');
      await execFileAsync('zip', ['-q','-0','-j',archive,...files], {timeout:180000,maxBuffer:1024*1024});
      job.status = 'done';
    } catch (e) {
      job.status = 'error'; job.error = '打包失败';
    }
  }
  save();
  try { rmSync(folder, {recursive:true, force:true}); } catch {}
}
const CACHE = new Map();
async function cached(key, load) {
  const hit = CACHE.get(key);
  if (hit && hit.exp > now()) return hit.value;
  const value = await load();
  CACHE.set(key, {value, exp:now()+CACHE_MS});
  if (CACHE.size > 200) CACHE.delete(CACHE.keys().next().value);
  return value;
}
function serveStatic(req, res, path) {
  const filename = path === '/' ? 'index.html' : path.slice(1);
  if (!['index.html','app.css','app.js','favicon.svg','logo.png'].includes(filename)) return json(res,{error:'页面不存在'},404);
  const file = join(STATIC,filename);
  if (!existsSync(file)) return json(res,{error:'页面不存在'},404);
  headers(res,200,{'content-type':mime[extname(file)] || 'application/octet-stream'});
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}
const limits = new Map();
function checkRate(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const entry = limits.get(ip) || {start:now(), count:0};
  if (now() - entry.start > 60000) { entry.start=now();entry.count=0; }
  entry.count++;
  limits.set(ip,entry);
  if (entry.count > 240) httpError('操作频繁，请稍后再试',429,'RATE_LIMIT');
}
const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') httpError('请求方法不支持',405);
    if (method === 'POST' && req.headers.origin) {
      const origin = new URL(req.headers.origin);
      if (origin.host !== req.headers.host || !['http:','https:'].includes(origin.protocol)) httpError('跨站请求被拒绝',403,'CSRF');
    }
    checkRate(req);
    if (path === '/api/health' && method === 'GET') return json(res,{ok:true,app:'XMPlus Web',time:new Date().toISOString()});
    const s = sessionFor(req,res);
    if (path === '/api/session' && method === 'GET') return json(res,{ok:true,...privateState(s)});
    if (path === '/api/search' && method === 'GET') {
      const q=(url.searchParams.get('q') || '').trim(), kind=url.searchParams.get('type') || 'album';
      if (!q || q.length > 100) httpError('请输入 1-100 字搜索词');
      if (!['album','track'].includes(kind)) httpError('搜索类型无效');
      const page=positive(url.searchParams.get('page'),1,100);
      const result=await cached('s:'+kind+':'+page+':'+q,()=>kind==='album'?searchAlbums(q,page,20):searchTracks(q,page,20));
      return json(res,{ok:true,...result});
    }
    const album=path.match(/^\/api\/album\/([1-9][0-9]{0,18})$/);
    if (album && method==='GET') {
      const page=positive(url.searchParams.get('page'),1,10000);
      const [info, tracks] = await Promise.all([
        cached('a:'+album[1],()=>albumSimple(album[1])),
        cached('t:'+album[1]+':'+page,()=>albumTracks(album[1],page,30))
      ]);
      return json(res,{ok:true,album:info,...tracks});
    }
    if (path==='/api/qr' && method==='POST') {
      const qr=await qrCreate();
      s.qr={id:qr.qrId,exp:qr.expiresAt};
      return json(res,{ok:true,imageDataUrl:qr.imageDataUrl,expiresAt:qr.expiresAt});
    }
    if (path==='/api/qr/check' && method==='POST') {
      if (!s.qr || s.qr.exp < now()) httpError('二维码已过期，请刷新',410,'QR_EXPIRED');
      const checked=await qrCheck(s.qr.id);
      if (checked.status==='success') {
        const newCookies={...s.cookies,...checked.cookies};
        const user=await getCurrentUser(joinCookieMap(newCookies));
        if (!user || !user.uid) httpError('登录确认失败，请重试',401,'LOGIN_FAILED');
        s.cookies=newCookies;s.user=user;s.qr=null;s.audioCache?.clear();save();
        return json(res,{ok:true,status:'success',user});
      }
      return json(res,{ok:true,status:'waiting'});
    }
    if (path==='/api/logout' && method==='POST') {
      s.cookies={};s.user=null;s.qr=null;s.audioCache?.clear();save();return json(res,{ok:true});
    }
    if (path==='/api/favorites' && method==='POST') {
      const data=await body(req), item=validAlbum(data.album), on=!!data.on;
      s.favorites=s.favorites.filter(a=>a.id!==item.id);
      if (on) s.favorites.unshift(item);
      s.favorites=s.favorites.slice(0,150);save();
      return json(res,{ok:true,favorites:s.favorites});
    }
    if (path==='/api/history' && method==='POST') {
      const data=await body(req);
      const id=safeId(data.id);
      if (!id) httpError('曲目 ID 无效');
      const entry={id,title:String(data.title||'').slice(0,200),albumId:safeId(data.albumId)||'',albumTitle:String(data.albumTitle||'').slice(0,200),cover:String(data.cover||'').slice(0,500),when:now()};
      s.history=[entry,...s.history.filter(v=>v.id!==id)].slice(0,200);save();
      return json(res,{ok:true});
    }
    if (path==='/api/subscriptions' && method==='GET') {
      if (!s.user) httpError('请先登录喜马拉雅',401,'NEED_LOGIN');
      const page=positive(url.searchParams.get('page'),1,100);
      return json(res,{ok:true,...await mySubscriptions(page,30,getCookie(s))});
    }
    if (path==='/api/likes' && method==='GET') {
      if (!s.user) httpError('请先登录喜马拉雅',401,'NEED_LOGIN');
      const page=positive(url.searchParams.get('page'),1,100);
      return json(res,{ok:true,...await likeTracks(page,30,getCookie(s))});
    }
    if (path==='/api/subscriptions' && method==='POST') {
      if (!s.user) httpError('请先登录喜马拉雅',401,'NEED_LOGIN');
      const data=await body(req), id=safeId(data.albumId);
      if (!id || typeof data.on !== 'boolean') httpError('订阅参数无效');
      await setSubscriptionAlbum(id,data.on,getCookie(s));
      return json(res,{ok:true});
    }
    const media=path.match(/^\/api\/(stream|download)\/([1-9][0-9]{0,18})$/);
    if (media && ['GET','HEAD'].includes(method)) return await streamAudio(req,res,s,media[2],media[1]==='download');
    if (path==='/api/jobs' && method==='POST') {
      const data=await body(req);
      if (!Array.isArray(data.ids) || !data.ids.length || data.ids.length>MAX_BATCH) httpError('每批请选择 1-40 首');
      const ids=data.ids.map(safeId);
      if (ids.some(v=>!v)||new Set(ids).size!==ids.length) httpError('声音列表无效');
      if (s.jobs.some(j=>['queued','running'].includes(j.status))) httpError('请等待上一批下载完成',409,'BUSY');
      const job={id:randomBytes(12).toString('hex'),ids,status:'queued',createdAt:now(),completed:0,size:0,errors:[]};
      s.jobs.unshift(job);s.jobs=s.jobs.slice(0,30);save();
      void runJob(s,job).catch(e=>{job.status='error';job.error='下载任务失败';save();});
      return json(res,{ok:true,job:publicJob(job)},202);
    }
    if (path==='/api/jobs' && method==='GET') return json(res,{ok:true,jobs:s.jobs.map(publicJob)});
    const jobRoute=path.match(/^\/api\/jobs\/([0-9a-f]{24})(?:\/(file))?$/);
    if (jobRoute && method==='GET') {
      const job=s.jobs.find(j=>j.id===jobRoute[1]);
      if (!job) httpError('下载任务不存在',404,'NOT_FOUND');
      if (!jobRoute[2]) return json(res,{ok:true,job:publicJob(job),error:job.error||''});
      if (job.status!=='done') httpError('下载文件尚未就绪',409,'NOT_READY');
      const file=join(DOWNLOADS,job.id+'.zip');
      if (!existsSync(file)) httpError('下载文件已清理',410,'GONE');
      headers(res,200,{'content-type':'application/zip','content-length':String(statSync(file).size),'content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent('XMPlus-音频-'+job.id.slice(0,6)+'.zip')});
      return createReadStream(file).pipe(res);
    }
    if (path.startsWith('/api/')) return json(res,{ok:false,error:'接口不存在',code:'NOT_FOUND'},404);
    if (['GET','HEAD'].includes(method)) return serveStatic(req,res,path);
    httpError('请求方法不支持',405);
  } catch (e) {
    if (res.headersSent) { try {res.destroy();} catch {} return; }
    const code=e instanceof XmlyError?e.code:'INTERNAL';
    const status=e instanceof XmlyError?e.status:500;
    // Do not log cookies, QR login payloads, or upstream media URLs.
    if (status>=500) console.error('XMPlus Web: request failed',code,String(e.message||e).slice(0,150));
    json(res,{ok:false,error:e instanceof XmlyError?e.message:'服务暂时不可用',code},status);
  }
});
setInterval(() => {
  let changed=false;
  for (const [id,s] of sessions) if (now()-s.last>SESSION_AGE) {sessions.delete(id);changed=true;}
  for (const name of readdirSync(DOWNLOADS)) {
    if (!/^[0-9a-f]{24}\.zip$/.test(name)) continue;
    const file=join(DOWNLOADS,name);
    try { if (now()-statSync(file).mtimeMs>86400000) rmSync(file,{force:true}); } catch {}
  }
  for (const [ip,v] of limits) if (now()-v.start>120000) limits.delete(ip);
  if(changed) save();
},600000).unref();
server.listen(PORT,HOST,()=>console.log('XMPlus Web listening on '+HOST+':'+PORT));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
