/* 解锁页：校验访问码，保存不可导出的内容密钥；注册 Service Worker 后重新载入原页面，没有可用的 Service Worker 时改为页内解密。
   各步骤写入诊断日志（不含访问码与密钥，点报错文字才显示）并设超时，卡住时停在报错，便于内置浏览器里截图排查。 */
(async function () {
  'use strict';
  const lock = self.SiteLock;
  const form = document.getElementById('unlock-form');
  const input = document.getElementById('code');
  const error = document.getElementById('error');
  const diag = document.getElementById('diag');
  const button = form.querySelector('button');
  const label = button.textContent;
  const dir = new URL('.', location.href).pathname;
  const SW_READY_MS = 3000; // 注册后迟迟不激活，视为不可用
  const RELOAD_MS = 8000; // 交给 Service Worker 的重载迟迟不返回，视为卡住
  const NO_SW_DAYS = 30; // 确认重载后页面未被 Service Worker 接管时，本浏览器这么久内直接页内解密
  const NAV_START = performance.timeOrigin || Date.now() - performance.now(); // 本次页面导航开始的时刻
  const T0 = performance.now();

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

  // ---------- 诊断日志：每行带距页面打开的秒数；访问码一律打码 ----------
  const lines = [];
  if (diag && /(?:^#|&)diag=1(?:&|$)/.test(location.hash)) diag.hidden = false; // 仅供排查：…&diag=1 一开始就显示日志
  const scrub = (text) => String(text).replace(/#code=[^\s&]*/gi, '#code=…').replace(/\b[A-HJKMNP-Z2-9]{5}-?[A-HJKMNP-Z2-9]{5}\b/g, '…');
  function log(message, key) { // 同一 key 的进度行原地更新
    const line = { key, text: `${((performance.now() - T0) / 1000).toFixed(2)}s ${scrub(message)}` };
    if (key && lines.length && lines[lines.length - 1].key === key) lines[lines.length - 1] = line;
    else lines.push(line);
    if (diag) diag.textContent = lines.map((l) => l.text).join('\n');
  }
  const previous = readSession('site-lock-log:'); // 重载前那一页的日志
  writeSession('site-lock-log:', null);
  if (previous) {
    previous.split('\n').forEach((text) => lines.push({ text }));
    lines.push({ text: '—— 重载后 ——' });
  }
  const ua = navigator.userAgent;
  const app = /Lark|Feishu/i.test(ua) ? '飞书' : /MicroMessenger/i.test(ua) ? '微信' : '其他';
  log(`${app} · SW ${'serviceWorker' in navigator ? '有' : '无'}${navigator.serviceWorker && navigator.serviceWorker.controller ? '（已接管）' : ''}`
    + ` · subtle ${self.crypto && crypto.subtle ? '有' : '无'} · IDB ${self.indexedDB ? '有' : '无'} · ${ua.slice(0, 180)}`);
  self.addEventListener('error', (event) => log(`脚本错误：${event.message}`));
  self.addEventListener('unhandledrejection', (event) => log(`未处理的异常：${event.reason && event.reason.message || event.reason}`));

  /** 记录一步的开始、耗时与结果；超过 ms 毫秒按失败处理（原操作仍在后台，结果被丢弃）。 */
  function step(name, promise, ms) {
    const start = performance.now();
    log(`${name}…`, name);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name}超时（${ms / 1000} s）`)), ms);
    });
    return Promise.race([Promise.resolve(promise), timeout]).then((value) => {
      clearTimeout(timer);
      log(`${name} ✓ ${Math.round(performance.now() - start)} ms`, name);
      return value;
    }, (err) => {
      clearTimeout(timer);
      log(`${name} ✗ ${(err && err.message) || err}`, name);
      throw err;
    });
  }

  // 本次用的访问码，内容打开前不丢：链接带的留在地址栏，手输的经 sessionStorage 带过重载；
  // 打不开时写回地址栏，“在浏览器中打开”后仍可一键解锁
  const hashParams = new URLSearchParams(location.hash.slice(1));
  const fromLink = hashParams.get('code'); // 链接 …/#code=XXXXX-XXXXX 自动解锁
  const forceInPage = hashParams.get('inpage') === '1'; // 仅供测试：…/#code=…&inpage=1 在有 Service Worker 的浏览器里也走页内
  const linkCode = (raw) => {
    const n = lock.normalizeCode(raw);
    return n.length === 10 ? `${n.slice(0, 5)}-${n.slice(5)}` : n;
  };
  let code = readSession('site-lock-code:') || (fromLink ? linkCode(fromLink) : ''); // 手输的优先（链接码可能是错的）
  writeSession('site-lock-code:', null);

  function fail(message) {
    error.textContent = message;
    error.hidden = false;
    button.disabled = false;
    button.textContent = label;
  }

  /** 打不开内容：地址栏放回一键解锁链接（“在浏览器中打开”后可直接进入），只提示网络问题；原因记在诊断日志。 */
  function stuck(reason) {
    log(`停止：${reason}`);
    history.replaceState(null, '', location.pathname + (code ? `#code=${code}` : ''));
    fail('网络异常，内容加载失败，请稍后重试。');
  }
  error.addEventListener('click', () => { if (diag && lines.length) diag.hidden = false; }); // 排查用：点报错文字显示诊断日志

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
      const response = await step('读取清单', fetch('_lock/manifest.bin', { cache: 'no-cache' }), 15000);
      if (!response.ok) return 'offline';
      bytes = new Uint8Array(await step('下载清单', response.arrayBuffer(), 15000));
    } catch (_) {
      return 'offline';
    }
    try {
      await step('核对密钥', lock.openManifest(key, bytes), 15000);
      return 'ok';
    } catch (_) {
      return 'stale';
    }
  }

  // ---------- Service Worker 不可用的记录：确认不接管后注销，本浏览器一段时间内直接页内 ----------
  function noSwRecently() {
    try {
      return Date.now() - Number(localStorage.getItem(`site-lock-nosw:${dir}`) || 0) < NO_SW_DAYS * 864e5;
    } catch (_) {
      return false;
    }
  }

  function giveUpSw(reason) {
    log(`Service Worker 不可用：${reason}，改为页内解密`);
    writeSession('site-lock-inpage:', '1');
    try {
      localStorage.setItem(`site-lock-nosw:${dir}`, String(Date.now()));
    } catch (_) { /* 只记本会话 */ }
    try { // 注销，免得以后的导航再经过它
      navigator.serviceWorker.getRegistration().then((r) => r && r.unregister()).catch(() => {});
    } catch (_) { /* 不支持 */ }
  }

  async function inPage(access) {
    const cancel = { aborted: false };
    try {
      await step('页内解密', lock.renderInPage(access, { log, cancel }), 20000);
    } catch (err) {
      cancel.aborted = true; // 超时后迟到的结果不再替换页面
      stuck(err.message);
    }
  }

  async function enter(access) {
    button.disabled = true;
    button.textContent = '正在打开 · Opening…';
    if (!('serviceWorker' in navigator) || forceInPage) return inPage(access);
    if (readSession('site-lock-inpage:') || noSwRecently()) {
      log('此前 Service Worker 不可用，直接页内解密');
      return inPage(access);
    }
    try {
      await step('注册 Service Worker', navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready), SW_READY_MS);
    } catch (_) {
      writeSession('site-lock-inpage:', '1');
      return inPage(access); // 注册失败或迟迟不激活
    }
    // 激活后的下一次导航即由它接管（含强制刷新后的页面）。本次导航紧接在重载标记之后却仍落在解锁页，
    // 说明未接管；sessionStorage 不可用时认不出重载回来，不重载
    if (Math.abs(NAV_START - Number(readSession('site-lock-reload:') || 0)) < 5000) {
      if (navigator.serviceWorker.controller) { // 接管了但没及时解出页面（如 IndexedDB 挂起）：只在本会话改页内
        log('Service Worker 已接管但未解出页面，本次改为页内解密');
        writeSession('site-lock-inpage:', '1');
      } else {
        giveUpSw('重载后未接管');
      }
      return inPage(access);
    }
    if (!writeSession('site-lock-reload:', String(Date.now())) || (code && !(fromLink && linkCode(fromLink) === code) && !writeSession('site-lock-code:', code))) {
      writeSession('site-lock-inpage:', '1');
      return inPage(access);
    }
    log('重载，交给 Service Worker 解密');
    writeSession('site-lock-log:', lines.map((l) => l.text).join('\n'));
    location.reload(); // 链接里的 #code 随之保留，打开后由页面末尾的脚本去掉
    setTimeout(() => { // 重载迟迟不返回（Service Worker 卡住或网络慢）：停掉导航，本会话留在本页解密
      window.stop();
      log(`重载 ${RELOAD_MS / 1000} s 未返回，本次改为页内解密`);
      writeSession('site-lock-inpage:', '1');
      inPage(access);
    }, RELOAD_MS);
    return undefined;
  }

  function mask() { // 解锁开始后输入框显示为圆点，截图诊断时不露出访问码；重新输入时恢复
    input.style.webkitTextSecurity = 'disc';
    input.addEventListener('input', () => { input.style.webkitTextSecurity = ''; }, { once: true });
  }

  async function submit() {
    error.hidden = true;
    button.disabled = true;
    mask();
    try {
      const config = await step('读取 lock.json', fetch('_lock/lock.json', { cache: 'no-cache' }).then((r) => r.json()), 15000);
      const access = await step('校验访问码', lock.unlock(input.value, config), 20000);
      if (!access) {
        input.style.webkitTextSecurity = ''; // 让用户核对输入
        fail('访问码无效，请核对后重试。');
        return;
      }
      code = linkCode(input.value);
      log(`访问码编号 ${access.label}`);
      // 内置浏览器里 IndexedDB 存不可导出密钥可能失败或挂起：存不下时只在本页内存中持有
      const saved = await step('保存密钥（IndexedDB）', lock.saveAccess(access), 5000).then(() => true, () => false);
      await (saved ? enter(access) : inPage(access));
    } catch (err) {
      stuck(err.message);
    }
  }

  form.addEventListener('submit', submit);

  const saved = await step('读取已存密钥（IndexedDB）', lock.loadAccess(), 5000).catch(() => null);
  if (saved) {
    button.disabled = true; // 自动进入期间不接受手动提交
    const state = await manifestState(saved.key);
    if (state === 'ok') {
      await enter(saved);
      return;
    }
    if (state === 'offline') {
      stuck('网络异常，读不到清单');
      return;
    }
    await lock.clearAccess().catch(() => {});
    fail('访问码已更新，请重新输入。');
  }

  if (fromLink) {
    input.value = fromLink;
    submit();
  }
})();
