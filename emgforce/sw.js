/* Service Worker：解锁后拦截本目录请求，取密文就地解密；未解锁或不在清单中的请求原样走网络。 */
importScripts('_lock/core.js?v=f9a20be2ed9a');

const lock = self.SiteLock;
const SCOPE = new URL(self.registration.scope).pathname;
const STREAM_BYTES = 2 * 1024 * 1024; // 无终点 Range（视频边播边取）每次最多返回 2 MiB
const IDB_MS = 5000; // 打开页面时 IndexedDB 读密钥挂起不再等：改走网络拿到解锁页，由它改用页内解密
let state = null; // {key, label, manifest}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return;
  let rel = decodeURIComponent(url.pathname.slice(SCOPE.length));
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  if (rel === 'sw.js' || rel.startsWith('_lock/')) return;
  event.respondWith(serve(event.request, rel).catch(() => fetch(event.request)));
});

async function load(navigate) {
  if (state) return state;
  const access = await (!navigate ? lock.loadAccess() : Promise.race([lock.loadAccess(), // 视频等请求照常等待
    new Promise((_, reject) => setTimeout(() => reject(new Error('IndexedDB 超时')), IDB_MS))]));
  if (!access) return null;
  const response = await fetch(`${SCOPE}_lock/manifest.bin`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`清单读取失败 ${response.status}`); // 网络问题：保留解锁状态
  const bytes = new Uint8Array(await response.arrayBuffer());
  try {
    state = { ...access, manifest: await lock.openManifest(access.key, bytes) };
    return state;
  } catch (_) {
    await lock.clearAccess(); // 内容密钥已更换，需重新输入访问码
    return null;
  }
}

async function readPlain(current, entry, start, end) {
  if (entry.size === 0) return new Uint8Array(0);
  const chunk = current.manifest.chunk;
  const span = lock.recordSpan(entry.size, chunk, start, end);
  const response = await fetch(`${SCOPE}_lock/b/${entry.blob}`, { headers: { Range: `bytes=${span.from}-${span.to}` } });
  if (!response.ok) throw new Error(`密文读取失败 ${response.status}`);
  let bytes = new Uint8Array(await response.arrayBuffer());
  if (response.status === 200) bytes = bytes.subarray(span.from, span.to + 1); // 服务器忽略了 Range
  const plain = await lock.decryptRecords(current.key, entry.path, chunk, span.first, bytes);
  const base = span.first * chunk;
  return plain.subarray(start - base, end - base + 1);
}

async function serve(request, rel) {
  if (request.mode === 'navigate') state = null; // 每次打开页面重读清单，跟上重新打包的内容
  const current = await load(request.mode === 'navigate');
  const entry = current && current.manifest.files[rel];
  if (!entry) return fetch(request);
  const headers = { 'Content-Type': entry.type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
  const range = lock.parseRange(request.headers.get('Range'), entry.size, STREAM_BYTES);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${entry.size}` } });
  }
  if (range) {
    const body = await readPlain(current, entry, range[0], range[1]);
    return new Response(body, {
      status: 206,
      headers: { ...headers, 'Content-Length': String(body.length), 'Content-Range': `bytes ${range[0]}-${range[1]}/${entry.size}` },
    });
  }
  let body = await readPlain(current, entry, 0, entry.size - 1);
  if (entry.type.startsWith('text/html')) body = new TextEncoder().encode(lock.finishPage(new TextDecoder().decode(body), current.label));
  return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(body.length) } });
}
