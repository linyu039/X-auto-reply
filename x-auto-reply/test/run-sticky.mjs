/**
 * 残留字符 e2e：连续运行时输入框被「a」「aa」这类垃圾污染的问题。
 *   1. 编辑器里预置 'aa' 再填正文，最终必须严格等于正文
 *   2. primeEditor 不留下字母残留（填完读回来不能有前缀）
 *   3. 连跑多条，每条发出去的文本都不带前缀垃圾
 *   4. 文本对不上时宁可不发，也不发半截
 *
 * 用法: node test/run-sticky.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9340;
const PAGE = pathToFileURL(resolve('test/mock-x.html')).href;

const profile = mkdtempSync(join(tmpdir(), 'xar-sticky-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=900,1400',
  PAGE
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitJsonList() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page' && t.url.startsWith('file:'));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (_) {}
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
  }
  ready() {
    return new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('ws error'));
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); }
      }, 40000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面异常: ' + (d.exception && d.exception.description || d.text));
    }
    return r.result.value;
  }
}

let code = 0;
const fails = [];
const check = (cond, label, detail = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label} ${detail}`); fails.push(label); }
};

const setCfg = (cdp, patch) => cdp.eval(`(async () => {
  const r = await chrome.storage.local.get('cfg');
  await chrome.storage.local.set({ cfg: Object.assign({}, r.cfg || {}, ${JSON.stringify(patch)}) });
  return true;
})()`);

const openReply = (cdp, idx) => cdp.eval(`(() => {
  const arts = document.querySelectorAll('article[data-testid="tweet"]');
  const b = arts[${idx}] && arts[${idx}].querySelector('button[data-testid="reply"]');
  if (!b) return false;
  b.click();
  return true;
})()`);

const closeReply = (cdp) => cdp.eval(`(() => {
  const c = document.querySelector('button[data-testid="app-bar-close"]');
  if (c) c.click();
  return true;
})()`);

try {
  const page = await waitJsonList();
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');

  for (let i = 0; i < 60; i++) {
    const ok = await cdp.eval(`!!(window.__XAR__ && window.__XAR__.typeInto && document.getElementById('xar-host'))`);
    if (ok) break;
    await sleep(200);
  }

  const hasApi = await cdp.eval(`typeof window.__XAR__.typeInto === 'function'`);
  console.log('typeInto 调试接口:', hasApi);
  if (!hasApi) { console.log('⚠ content.js 没有暴露 typeInto，测试无法进行'); process.exit(1); }

  /* ---------------- 1. 预置 aa 残留 ---------------- */
  console.log('\n[1] 编辑器里预置 "aa" 再填正文');
  await setCfg(cdp, { autoSend: false, loopMode: false, autoLike: false, autoFollow: false });
  await sleep(300);
  await openReply(cdp, 0);
  await sleep(1200);

  const seeded = await cdp.eval(`(() => {
    const ed = document.querySelector('div[data-testid^="tweetTextarea_"] [contenteditable="true"]');
    if (!ed) return 'no-editor';
    ed.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, 'aa');
    return window.__XAR__.editorText();
  })()`);
  check(seeded === 'aa', '预置成功，编辑器里是 aa', `实际「${seeded}」`);

  const typed1 = await cdp.eval(`window.__XAR__.typeInto('今天这个观点挺实在的')`);
  check(typed1 === '今天这个观点挺实在的', 'aa 被清掉，只剩正文', `实际「${typed1}」`);
  check(!/^a/.test(typed1), '开头没有残留的 a');

  /* ---------------- 2. primeEditor 不留字母 ---------------- */
  console.log('\n[2] 空编辑器直接填，不能留下 priming 字母');
  const typed2 = await cdp.eval(`(async () => {
    const ed = document.querySelector('div[data-testid^="tweetTextarea_"] [contenteditable="true"]');
    ed.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    return await window.__XAR__.typeInto('第二条测试内容');
  })()`);
  check(typed2 === '第二条测试内容', '没有 priming 残留', `实际「${typed2}」`);

  /* ---------------- 3. 连续跑 3 条，发出去的不带垃圾 ---------------- */
  console.log('\n[3] 连续模式跑 3 条');
  await cdp.eval(`(() => {
    const c = document.querySelector('button[data-testid="app-bar-close"]');
    if (c) c.click();
    return true;
  })()`);
  await sleep(600);

  await cdp.eval(`(async () => {
    const r = await chrome.storage.local.get('cfg');
    await chrome.storage.local.set({ cfg: Object.assign({}, r.cfg || {}, { autoSend: true, loopMode: true, maxPerRun: 3, autoLike: false, autoFollow: false }) });
    await chrome.storage.local.set({ repliedIds: [] });
    return true;
  })()`);
  await sleep(400);

  await cdp.eval(`document.getElementById('xar-host').shadowRoot.getElementById('btnRun').click(), true`);
  for (let i = 0; i < 160; i++) {
    await sleep(300);
    const st = await cdp.eval(`window.__XAR__.state()`);
    if (!st.running && st.stats.done + st.stats.fail >= 3) break;
  }
  await sleep(800);

  const st = await cdp.eval(`window.__XAR__.state()`);
  const sentTexts = await cdp.eval(`window.__MOCK.sentTexts`);
  const mockSent = await cdp.eval(`window.__MOCK.sent`);

  console.log('  统计:', JSON.stringify(st.stats), '| mock 发出:', mockSent);
  check(mockSent >= 3, '至少发了 3 条', `实际 ${mockSent}`);

  /* ---------------- 4. 真实发出去的文本逐条校验 ---------------- */
  console.log('\n[4] 发出去的文本逐条校验');
  sentTexts.forEach((t, i) => console.log(`  #${i + 1} 「${t}」`));
  const withPrefix = sentTexts.filter(t => /^a+[^a]/.test(t));
  check(withPrefix.length === 0, '没有一条带 a 前缀', withPrefix[0] || '');
  const tooShort = sentTexts.filter(t => t.replace(/\s/g, '').length < 5);
  check(tooShort.length === 0, '没有一条是残缺的短串', tooShort.join('|'));
  const dupStart = sentTexts.filter(t => /^(.)\1{2,}/.test(t));
  check(dupStart.length === 0, '没有开头重复字符', dupStart.join('|'));

  /* ---------------- 5. 日志里不该出现「前面多了」以外的异常 ---------------- */
  const logs = st.logs || [];
  const retried = logs.filter(l => /前面多了/.test(l));
  const failed = logs.filter(l => /✗ 没写进 X 的编辑器/.test(l));
  console.log('\n  清空重填次数:', retried.length, '| 输入失败次数:', failed.length);
  check(failed.length === 0, '一路没触发输入校验失败', `实际 ${failed.length} 次：${failed[0] || ''}`);

  const allMock = await cdp.eval(`window.__MOCK.logs ? window.__MOCK.logs.slice(-8) : []`);
  const bad = allMock.filter(x => /已发送 #\d+: a+[^a\s]/.test(x));
  check(bad.length === 0, '发出的内容没有 a 前缀', bad[0] || '');

  console.log('\n--- 插件日志（尾部）---');
  logs.slice(-14).forEach(l => console.log('  ' + l));
  console.log('\n--- mock 发送记录（尾部）---');
  allMock.slice(-5).forEach(l => console.log('  ' + l));

  if (fails.length) {
    console.log('\n⚠ 失败项: ' + fails.join(' / '));
    code = 1;
  } else {
    console.log('\n✅ 残留字符修复通过');
  }
} catch (e) {
  console.error('检查失败:', e.message);
  code = 1;
} finally {
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  process.exit(code);
}
