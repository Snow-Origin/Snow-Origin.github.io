/* 解锁页：校验访问码，保存不可导出的内容密钥；注册 Service Worker 后重新载入原页面，没有可用的 Service Worker 时改为页内解密。 */
(async function () {
  'use strict';
  const lock = self.SiteLock;
  const form = document.getElementById('unlock-form');
  const input = document.getElementById('code');
  const error = document.getElementById('error');
  const button = form.querySelector('button');
  const label = button.textContent;
  const dir = new URL('.', location.href).pathname;
  const SW_READY_MS = 3000; // 注册后迟迟不激活，视为不可用
  const NAV_START = performance.timeOrigin || Date.now() - performance.now(); // 本次页面导航开始的时刻

  function fail(message) {
    error.textContent = message;
    error.hidden = false;
    button.disabled = false;
    button.textContent = label;
  }

  function readSession(name) { // sessionStorage 被禁用时视为空
    try {
      return sessionStorage.getItem(name + dir);
    } catch (_) {
      return null;
    }
  }

  function writeSession(name, value) { // value 为 null 时删除；返回是否写成
    try {
      if (value === null) sessionStorage.removeItem(name + dir);
      else sessionStorage.setItem(name + dir, value);
      return sessionStorage.getItem(name + dir) === value;
    } catch (_) {
      return false;
    }
  }

  // 本次用的访问码，内容打开前不丢：链接带的留在地址栏，手输的经 sessionStorage 带过重载；
  // 打不开时写回地址栏，“在浏览器中打开”后仍可一键解锁
  const fromLink = new URLSearchParams(location.hash.slice(1)).get('code'); // 链接 …/#code=XXXXX-XXXXX 自动解锁
  const linkCode = (raw) => {
    const n = lock.normalizeCode(raw);
    return n.length === 10 ? `${n.slice(0, 5)}-${n.slice(5)}` : n;
  };
  let code = readSession('site-lock-code:') || (fromLink ? linkCode(fromLink) : ''); // 手输的优先（链接码可能是错的）
  writeSession('site-lock-code:', null);

  // 先拦截提交，避免脚本等待期间回车走原生 GET 把访问码写进地址栏
  form.addEventListener('submit', (event) => event.preventDefault());

  if (!self.crypto || !crypto.subtle || !self.indexedDB) {
    form.hidden = true;
    document.getElementById('unsupported').hidden = false;
    return;
  }

  /** 'ok'：已保存的密钥能打开当前内容；'stale'：内容密钥已更换；'offline'：网络问题，无法判断。 */
  async function manifestState(key) {
    let bytes;
    try {
      const response = await fetch('_lock/manifest.bin', { cache: 'no-cache' });
      if (!response.ok) return 'offline';
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (_) {
      return 'offline';
    }
    try {
      await lock.openManifest(key, bytes);
      return 'ok';
    } catch (_) {
      return 'stale';
    }
  }

  /** 地址栏换成项目地址（有码时带 #code=），不产生新的历史记录。 */
  function keepCode() {
    history.replaceState(null, '', location.pathname + (code ? `#code=${code}` : ''));
  }

  async function inPage(access) {
    try {
      await lock.renderInPage(access);
    } catch (err) {
      keepCode();
      fail(`无法加载内容（${err.message}）：请点右上角“…”，选择在浏览器中打开。`);
    }
  }

  async function enter(access) {
    button.disabled = true;
    button.textContent = '正在打开 · Opening…';
    if (!('serviceWorker' in navigator) || readSession('site-lock-inpage:')) return inPage(access);
    try {
      await Promise.race([
        navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready),
        new Promise((_, reject) => setTimeout(reject, SW_READY_MS)),
      ]);
    } catch (_) {
      return inPage(access); // 注册失败或迟迟不激活
    }
    // 激活后的下一次导航即由它接管（含强制刷新后的页面）。本次导航紧接在重载标记之后却仍落在解锁页，
    // 说明未接管，本会话改用页内解密；sessionStorage 不可用时认不出重载回来，不重载
    if (Math.abs(NAV_START - Number(readSession('site-lock-reload:') || 0)) < 5000) {
      writeSession('site-lock-inpage:', '1');
      return inPage(access);
    }
    if (!writeSession('site-lock-reload:', String(Date.now())) || (code && !(fromLink && linkCode(fromLink) === code) && !writeSession('site-lock-code:', code))) {
      return inPage(access);
    }
    location.reload(); // 链接里的 #code 随之保留，打开后由页面末尾的脚本去掉
    return undefined;
  }

  async function submit() {
    error.hidden = true;
    button.disabled = true;
    try {
      const config = await (await fetch('_lock/lock.json', { cache: 'no-cache' })).json();
      const access = await lock.unlock(input.value, config);
      if (!access) {
        fail('访问码无效，请核对后重试。');
        return;
      }
      code = linkCode(input.value);
      const saved = await lock.saveAccess(access).then(() => true, () => false);
      await (saved ? enter(access) : inPage(access)); // 存不下密钥时只能本页内查看
    } catch (err) {
      fail(`解锁失败：${err.message}`);
    }
  }

  form.addEventListener('submit', submit);

  const saved = await lock.loadAccess().catch(() => null);
  if (saved) {
    button.disabled = true; // 自动进入期间不接受手动提交
    const state = await manifestState(saved.key);
    if (state === 'ok') {
      await enter(saved);
      return;
    }
    if (state === 'offline') {
      fail('网络异常，请稍后刷新重试。');
      return;
    }
    await lock.clearAccess();
    fail('访问码已更新，请重新输入。');
  }

  if (fromLink) {
    input.value = fromLink;
    submit();
  }
})();
