/* 页内解密：浏览器没有可用的 Service Worker（微信、飞书等内置浏览器）时，在解锁页内解密并渲染入口页。
   小文件渲染前解密为 Blob URL，并改写入口页、CSS 与脚本里对它们的引用；页面运行时经 src／poster／href、
   innerHTML 与 fetch 取到的本目录文件同样就地解密；音视频等大文件在被设为 src 时才整段下载解密（页面上的视频等进入视口附近），同时最多两个。 */
(function (root) {
  'use strict';

  const EAGER_BYTES = 4 * 1024 * 1024; // 不超过此大小的非音视频文件在渲染前解密
  const PARALLEL = 2; // 大文件同时下载数：首屏视频之外留一路给用户新点的视频
  // 引用的三组依次为前缀、引号、地址，只替换地址
  const ATTR = /(\s(?:src|href|poster)\s*=\s*)(["'])([^"']*)\2/gi;
  const CSS_URL = /(url\(\s*)(["']?)([^"')\s]+)\2/gi;
  const CSS_IMPORT = /(@import\s+)(["'])([^"']+)\2/gi;
  const JS_IMPORT = /(\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?|\bexport\s*[\w$*{}\s,]*?\s*from\s*|\bimport\s*\(\s*)(["'])([^"'\n]+)\2/g;
  const PATTERNS = { html: [ATTR, CSS_URL, CSS_IMPORT, JS_IMPORT], css: [CSS_URL, CSS_IMPORT], js: [JS_IMPORT] };

  /**
   * 把 text（kind：html／css／js）里的引用按 base 解析为绝对地址交给 lookup，替换为其返回值；返回假值则保持原样。
   * 页内锚点、data:／blob: 地址与脚本的裸模块名不改。
   */
  function rewrite(text, kind, base, lookup) {
    for (const pattern of PATTERNS[kind]) {
      text = text.replace(pattern, (whole, prefix, quote, ref) => {
        if (!ref || ref[0] === '#' || /^(?:data|blob|javascript|mailto):/i.test(ref)) return whole;
        if (pattern === JS_IMPORT && !/^(?:\.{0,2}\/|https?:)/.test(ref)) return whole;
        let url;
        try {
          url = new URL(ref, base).href;
        } catch (_) {
          return whole;
        }
        const mapped = lookup(url);
        return mapped ? prefix + quote + mapped + quote : whole;
      });
    }
    return text;
  }

  let rendered = false;

  /** 用已解开的内容密钥 access {key, label} 解密入口页并替换当前文档；页面打开前的失败抛出，由解锁页提示。 */
  async function renderInPage(access) {
    const lock = root.SiteLock;
    const doc = root.document;
    const base = new URL('.', root.location.href);
    const nativeFetch = root.fetch.bind(root);
    const response = await nativeFetch(new URL('_lock/manifest.bin', base).href, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`清单读取失败 ${response.status}`);
    const manifest = await lock.openManifest(access.key, new Uint8Array(await response.arrayBuffer()));
    const files = manifest.files;
    if (!files['index.html']) throw new Error('缺少入口页 index.html');

    const hrefOf = (rel) => new URL(rel.split('/').map(encodeURIComponent).join('/'), base).href;
    /** 本目录内、清单中有的地址返回其相对路径；html 为假时排除网页（链接与导航不改写）。 */
    function relOf(href, html) {
      let url;
      try {
        url = new URL(href, doc.baseURI);
      } catch (_) {
        return null;
      }
      if (url.protocol !== base.protocol || url.host !== base.host || !url.pathname.startsWith(base.pathname)) return null;
      let rel;
      try {
        rel = decodeURIComponent(url.pathname.slice(base.pathname.length));
      } catch (_) {
        return null;
      }
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      const entry = files[rel];
      return entry && (html || !entry.type.startsWith('text/html')) ? rel : null;
    }

    /** 下载并逐块解密一个文件为 Blob；边下载边解密，不另存整份密文。 */
    async function decrypt(entry, signal) {
      const parts = [];
      if (entry.size > 0) {
        const res = await nativeFetch(new URL(`_lock/b/${entry.blob}`, base).href, signal ? { signal } : {});
        if (!res.ok) throw new Error(`密文读取失败 ${res.status}`);
        const record = manifest.chunk + lock.OVERHEAD;
        const reader = res.body && res.body.getReader ? res.body.getReader() : null;
        if (!reader) {
          parts.push(await lock.decryptRecords(access.key, entry.path, manifest.chunk, 0, new Uint8Array(await res.arrayBuffer())));
        } else {
          const buffer = new Uint8Array(record);
          let filled = 0;
          const flush = async () => {
            parts.push(await lock.decryptRecords(access.key, entry.path, manifest.chunk, parts.length, buffer.slice(0, filled)));
            filled = 0;
          };
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (let at = 0; at < value.length;) {
              const n = Math.min(record - filled, value.length - at);
              buffer.set(value.subarray(at, at + n), filled);
              filled += n;
              at += n;
              if (filled === record) await flush();
            }
          }
          if (filled) await flush();
        }
      }
      return new Blob(parts, { type: entry.type });
    }

    // ---------- 小文件：渲染前解密；CSS 与脚本按依赖顺序改写引用后再生成地址 ----------
    const urls = new Map(); // rel → Blob URL
    const blobs = new Map(); // rel → Blob
    const kindOf = (type) => (type.startsWith('text/css') ? 'css' : type.includes('javascript') ? 'js' : null);
    const hashOf = (href) => {
      try {
        return new URL(href, doc.baseURI).hash;
      } catch (_) {
        return '';
      }
    };
    /** 已解密的小文件返回其 Blob URL（保留 #片段），否则 null。 */
    const readyUrl = (href) => {
      const rel = relOf(href, false);
      return rel && urls.has(rel) ? urls.get(rel) + hashOf(href) : null;
    };
    // CSS 与脚本变成 Blob URL 后无法再按相对路径解析，未解密的引用一律写成绝对地址
    const fileUrl = (href) => readyUrl(href) || href;
    const publish = (rel, blob) => {
      blobs.set(rel, blob);
      urls.set(rel, URL.createObjectURL(blob));
    };
    const eager = Object.keys(files).filter((rel) => files[rel].size <= EAGER_BYTES && !/^(?:video|audio|text\/html)/.test(files[rel].type));
    const plain = await Promise.all(eager.map((rel) => decrypt(files[rel])));
    const texts = new Map(); // rel → {kind, text}，待改写
    for (let i = 0; i < eager.length; i += 1) {
      const kind = kindOf(files[eager[i]].type);
      if (kind) texts.set(eager[i], { kind, text: await new Response(plain[i]).text() });
      else publish(eager[i], plain[i]);
    }
    const pendingDeps = (rel, item) => {
      const deps = [];
      rewrite(item.text, item.kind, hrefOf(rel), (url) => {
        const dep = relOf(url, false);
        if (dep && dep !== rel && texts.has(dep)) deps.push(dep);
        return null;
      });
      return deps;
    };
    while (texts.size) {
      let ready = [...texts].filter(([rel, item]) => pendingDeps(rel, item).length === 0);
      if (!ready.length) ready = [...texts]; // 循环引用：剩余引用保持原样
      for (const [rel, item] of ready) {
        texts.delete(rel);
        publish(rel, new Blob([rewrite(item.text, item.kind, hrefOf(rel), fileUrl)], { type: files[rel].type }));
      }
    }
    const page = await new Response(await decrypt(files['index.html'])).text();
    const html = rewrite(lock.finishPage(page, access.label), 'html', base.href, readyUrl);

    // ---------- 大文件：被设为 src 时排队下载解密；没有元素等待或使用时中止下载或回收地址 ----------
    const lazy = new Map(); // rel → {rel, promise, url, controller, waiting, users}
    const slots = new WeakMap(); // 元素 → Map(属性 → {want, hold, job, deferred})
    const queue = [];
    let active = 0;

    function pump() {
      while (active < PARALLEL && queue.length) run(queue.shift());
    }

    async function run(job) {
      active += 1;
      try {
        if (lazy.get(job.item.rel) !== job.item) throw new Error('已无元素需要');
        const blob = await decrypt(files[job.item.rel], job.item.controller && job.item.controller.signal);
        if (lazy.get(job.item.rel) !== job.item) throw new Error('已无元素需要');
        job.item.url = URL.createObjectURL(blob);
        job.resolve(job.item.url);
      } catch (err) {
        if (lazy.get(job.item.rel) === job.item) lazy.delete(job.item.rel);
        job.reject(err);
      }
      active -= 1;
      pump();
      if (!active && deferred.size) wake(deferred.values().next().value); // 空闲时预取屏幕外的视频
    }

    function request(rel) {
      let item = lazy.get(rel);
      if (!item) {
        item = { rel, url: null, waiting: 0, users: 0, controller: typeof AbortController === 'function' ? new AbortController() : null };
        item.promise = new Promise((resolve, reject) => queue.push({ item, resolve, reject }));
        item.promise.catch(() => {});
        lazy.set(rel, item);
        pump();
      }
      return item;
    }

    function settle(item) {
      if (item.waiting || item.users || lazy.get(item.rel) !== item) return;
      lazy.delete(item.rel);
      if (item.url) URL.revokeObjectURL(item.url);
      else if (item.controller) item.controller.abort();
    }

    function slotOf(el, attr) {
      let map = slots.get(el);
      if (!map) slots.set(el, (map = new Map()));
      if (!map.has(attr)) map.set(attr, { want: null, hold: null, job: null, deferred: null });
      return map.get(attr);
    }

    const nativeSetAttribute = Element.prototype.setAttribute;
    const nativeRemoveAttribute = Element.prototype.removeAttribute;
    const nativeLoad = HTMLMediaElement.prototype.load;
    const nativePlay = HTMLMediaElement.prototype.play;

    // 页面上不在视口附近（上下各一屏）的视频等进入附近或下载空闲时才开始，首屏视频不被抢带宽
    const near = new WeakSet();
    const deferred = new Set(); // 推迟下载的媒体元素
    const watcher = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (entry.isIntersecting) wake(entry.target);
    }), { rootMargin: '100% 0px' }) : null;
    function wake(el) {
      near.add(el);
      deferred.delete(el);
      watcher.unobserve(el);
      const slot = slotOf(el, 'src');
      const start = slot.deferred;
      slot.deferred = null;
      if (start) start();
    }

    /** 元素 el 的 attr 被设为 value：本目录文件换成解密后的地址，其余原样交给 set。 */
    function route(el, attr, value, set) {
      const slot = slotOf(el, attr);
      const old = [slot.want, slot.hold];
      const rel = relOf(value, false);
      const big = rel && !urls.has(rel);
      const media = attr === 'src' && el instanceof HTMLMediaElement;
      const later = big && media && watcher && el.isConnected && !near.has(el);
      const item = big && !later ? request(rel) : null; // 先占用新文件再释放旧的，重设同一文件不重新下载
      if (item) item.waiting += 1;
      if (slot.want) slot.want.waiting -= 1;
      if (slot.hold) slot.hold.users -= 1;
      slot.want = item;
      slot.hold = slot.job = slot.deferred = null;
      if (media) deferred.delete(el);
      old.forEach((o) => o && settle(o));
      if (!big) return set(rel ? urls.get(rel) + hashOf(value) : value);

      if (media) { // 先清空旧视频，显示封面
        nativeRemoveAttribute.call(el, 'src');
        nativeLoad.call(el);
      }
      if (later) {
        slot.deferred = () => route(el, attr, value, set);
        deferred.add(el);
        watcher.observe(el);
        if (!active) wake(el); // 没有其他下载时不必等
        return undefined;
      }
      slot.job = item.promise.then((url) => {
        if (slot.want !== item) return;
        slot.want = slot.job = null;
        item.waiting -= 1;
        item.users += 1;
        slot.hold = item;
        set(url + hashOf(value));
        if (el instanceof HTMLSourceElement && el.parentElement instanceof HTMLMediaElement) nativeLoad.call(el.parentElement);
      }, () => {
        if (slot.want !== item) return;
        slot.want = slot.job = null;
        item.waiting -= 1;
      });
      return undefined;
    }

    const routed = (el, attr) => (attr === 'href' ? el instanceof HTMLLinkElement : (attr === 'src' || attr === 'poster') && attr in el);
    function fix(el) {
      ['src', 'poster', 'href'].forEach((attr) => {
        const value = el.getAttribute(attr);
        if (value && routed(el, attr) && relOf(value, false)) route(el, attr, value, (v) => nativeSetAttribute.call(el, attr, v));
      });
    }

    // ---------- 打补丁后替换文档；同一页面全局，补丁在新文档中继续生效。此后不再等待，重复调用只生效一次 ----------
    if (rendered) return;
    rendered = true;
    [[HTMLImageElement, 'src'], [HTMLMediaElement, 'src'], [HTMLSourceElement, 'src'], [HTMLScriptElement, 'src'],
      [HTMLVideoElement, 'poster'], [HTMLLinkElement, 'href']].forEach(([type, attr]) => {
      const desc = Object.getOwnPropertyDescriptor(type.prototype, attr);
      if (!desc || !desc.set) return;
      Object.defineProperty(type.prototype, attr, {
        ...desc, set(value) { route(this, attr, String(value), (v) => desc.set.call(this, v)); },
      });
    });
    Element.prototype.setAttribute = function (name, value) {
      const attr = String(name).toLowerCase();
      if (!routed(this, attr)) return nativeSetAttribute.call(this, name, value);
      return route(this, attr, String(value), (v) => nativeSetAttribute.call(this, name, v));
    };
    const inner = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    if (inner && inner.set) {
      Object.defineProperty(Element.prototype, 'innerHTML', {
        ...inner, set(value) { inner.set.call(this, rewrite(String(value), 'html', doc.baseURI, readyUrl)); },
      });
    }
    HTMLMediaElement.prototype.play = function () { // 视频还在解密时，等设好地址再播放
      const map = slots.get(this);
      const job = map && map.get('src') && map.get('src').job;
      if (!job) return nativePlay.call(this);
      const now = nativePlay.call(this); // 趁用户手势先登记播放（iOS 要求），地址设好后即开始
      if (now && now.catch) now.catch(() => {});
      return job.then(() => nativePlay.call(this));
    };
    root.fetch = function (input, init) {
      const isRequest = typeof Request === 'function' && input instanceof Request;
      const method = String((init && init.method) || (isRequest ? input.method : 'GET')).toUpperCase();
      const rel = method === 'GET' ? relOf(isRequest ? input.url : String(input), true) : null;
      if (!rel) return nativeFetch(input, init);
      const type = files[rel].type;
      return (blobs.has(rel) ? Promise.resolve(blobs.get(rel)) : decrypt(files[rel]))
        .then((blob) => new Response(blob, { status: 200, headers: { 'Content-Type': type } }));
    };

    const observer = new MutationObserver((records) => records.forEach((record) => {
      if (record.type === 'attributes') {
        fix(record.target);
        return;
      }
      record.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        fix(node);
        node.querySelectorAll('[src],[poster],[href]').forEach(fix);
      });
    }));
    doc.open();
    observer.observe(doc, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'poster', 'href'] });
    doc.write(html);
    doc.close();
  }

  root.SiteLock.rewrite = rewrite;
  root.SiteLock.renderInPage = renderInPage;
})(typeof self !== 'undefined' ? self : globalThis);
