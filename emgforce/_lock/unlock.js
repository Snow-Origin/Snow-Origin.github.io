/* 解锁页：校验访问码，保存不可导出的内容密钥，注册 Service Worker 后重新载入原页面。 */
(async function () {
  'use strict';
  const lock = self.SiteLock;
  const form = document.getElementById('unlock-form');
  const input = document.getElementById('code');
  const error = document.getElementById('error');
  const button = form.querySelector('button');

  function fail(message) {
    error.textContent = message;
    error.hidden = false;
    button.disabled = false;
  }

  // 先拦截提交，避免脚本等待期间回车走原生 GET 把访问码写进地址栏
  form.addEventListener('submit', (event) => event.preventDefault());

  if (!('serviceWorker' in navigator) || !self.crypto || !crypto.subtle || !self.indexedDB) {
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

  async function enter() {
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready; // 激活后的下一次导航即由它接管（含强制刷新后的页面）
    const mark = 'site-lock-reload:' + new URL('.', location.href).pathname;
    const last = Number(sessionStorage.getItem(mark) || 0);
    if (Date.now() - last < 10000) { // 刚重载过仍停在解锁页：Service Worker 未生效
      fail('无法加载内容：请点右上角“…”，选择在浏览器中打开（Safari／Chrome）。');
      return;
    }
    sessionStorage.setItem(mark, String(Date.now()));
    location.replace(location.pathname);
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
      await lock.saveAccess(access);
      await enter();
    } catch (err) {
      fail(`解锁失败：${err.message}`);
    }
  }

  form.addEventListener('submit', submit);

  const saved = await lock.loadAccess().catch(() => null);
  if (saved) {
    const state = await manifestState(saved.key);
    if (state === 'ok') {
      await enter();
      return;
    }
    if (state === 'offline') {
      fail('网络异常，请稍后刷新重试。');
      return;
    }
    await lock.clearAccess();
    fail('访问码已更新，请重新输入。');
  }

  const fromLink = new URLSearchParams(location.hash.slice(1)).get('code'); // 链接 …/#code=XXXXX-XXXXX 自动解锁
  if (fromLink) {
    input.value = fromLink;
    submit();
  }
})();
