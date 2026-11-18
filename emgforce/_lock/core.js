/* 静态加密页运行时：访问码解锁、解密清单与分块文件；解锁页、Service Worker 与 Node 测试共用。 */
(function (root) {
  'use strict';

  const IV_BYTES = 12;
  const OVERHEAD = IV_BYTES + 16; // 每个密文记录 = IV + 密文 + GCM 标签
  const encoder = new TextEncoder();

  function normalizeCode(raw) {
    return String(raw).normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function decryptRecord(key, record, aad) {
    const bytes = record instanceof Uint8Array ? record : new Uint8Array(record);
    const plain = await root.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, IV_BYTES), additionalData: encoder.encode(aad) },
      key, bytes.subarray(IV_BYTES));
    return new Uint8Array(plain);
  }

  /** 用访问码解开内容密钥；成功返回 {key, label}（label 为两位访问码编号），失败返回 null。停用的码以 null 占位，编号不变。 */
  async function unlock(code, lock) {
    const subtle = root.crypto.subtle;
    const base = await subtle.importKey('raw', encoder.encode(normalizeCode(code)), 'PBKDF2', false, ['deriveKey']);
    const kek = await subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(lock.salt), iterations: lock.iterations },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    for (let i = 0; i < lock.wraps.length; i += 1) {
      if (!lock.wraps[i]) continue;
      let raw;
      try {
        raw = await decryptRecord(kek, fromBase64(lock.wraps[i]), 'wrap');
      } catch (_) {
        continue; // 不是这个访问码
      }
      const key = await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
      return { key, label: String(i + 1).padStart(2, '0') };
    }
    return null;
  }

  async function openManifest(key, bytes) {
    return JSON.parse(new TextDecoder().decode(await decryptRecord(key, bytes, 'manifest')));
  }

  /**
   * 解析单段 Range 请求头。返回明文闭区间 [start, end]；无效或缺失时返回 null（按整文件响应），
   * 起点越界返回 'unsatisfiable'（416）。无终点区间最多返回 streamBytes 字节，供视频边播边取。
   */
  function parseRange(header, size, streamBytes) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
    if (!match || (match[1] === '' && match[2] === '')) return null;
    if (match[1] === '') {
      const suffix = Number(match[2]);
      return suffix === 0 || size === 0 ? 'unsatisfiable' : [Math.max(size - suffix, 0), size - 1];
    }
    const start = Number(match[1]);
    if (match[2] !== '' && Number(match[2]) < start) return null; // 语法无效，忽略 Range
    if (start >= size) return 'unsatisfiable';
    const end = match[2] === '' ? Math.min(start + streamBytes, size) - 1 : Math.min(Number(match[2]), size - 1);
    return [start, end];
  }

  /** 明文闭区间 [start, end] 所在的记录序号与密文字节闭区间。 */
  function recordSpan(size, chunk, start, end) {
    const record = chunk + OVERHEAD;
    const count = Math.max(Math.ceil(size / chunk), 1);
    const first = Math.floor(start / chunk);
    const last = Math.floor(end / chunk);
    return { first, last, from: first * record, to: Math.min((last + 1) * record, size + count * OVERHEAD) - 1 };
  }

  /** 解密从第 first 个记录起的连续密文 bytes，返回拼接后的明文。 */
  async function decryptRecords(key, path, chunk, first, bytes) {
    const record = chunk + OVERHEAD;
    const parts = [];
    let total = 0;
    for (let offset = 0, index = first; offset < bytes.length; offset += record, index += 1) {
      const part = await decryptRecord(key, bytes.subarray(offset, Math.min(offset + record, bytes.length)), `${path}:${index}`);
      parts.push(part);
      total += part.length;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  /** 解锁页与 sw.js 都在项目根目录，按该目录分键，同域多个项目的授权互不覆盖。 */
  function accessKey() {
    return 'access:' + new URL('.', root.location.href).pathname;
  }

  function withStore(mode, action) {
    return new Promise((resolve, reject) => {
      const open = root.indexedDB.open('site-lock', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('kv', mode);
        const request = action(tx.objectStore('kv'));
        tx.oncomplete = () => { db.close(); resolve(request.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }

  root.SiteLock = {
    OVERHEAD,
    normalizeCode,
    unlock,
    openManifest,
    parseRange,
    recordSpan,
    decryptRecords,
    // 解锁状态 {key: 不可导出的 CryptoKey, label} 存在 IndexedDB，页面与 Service Worker 共用
    saveAccess: (access) => withStore('readwrite', (store) => store.put(access, accessKey())),
    loadAccess: () => withStore('readonly', (store) => store.get(accessKey())),
    clearAccess: () => withStore('readwrite', (store) => store.delete(accessKey())),
  };
})(typeof self !== 'undefined' ? self : globalThis);
