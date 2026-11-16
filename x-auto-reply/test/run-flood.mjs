/**
 * 输入框被灌爆（flood）e2e。
 *
 * 真实场景：X 的编辑器在某些时序下会把 insertText 的内容重复渲染，
 * 连续模式跑几轮后输入框涨到几千字，字数显示 -7520，回复按钮永久灰。
 *
 * 这里让 mock 主动「放大 3 倍」来复现，验证：
 *   1. 插件能检测到字数暴涨
 *   2. 检测到之后强行清空，而不是继续往里灌
 *   3. 清空后放弃这一条，不发送
 *   4. 关掉放大开关后能正常恢复
 *
 * 用法: node test/run-flood.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9341;
const PAGE = pathToFileURL(resolve('test/mock-x.html')).href;

const profile = mkdtempSync(join(tmpdir(), 'xar-flood-'));
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
      }, 60000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面异常: ' + ((d.exception && d.exception.description) || d.text));
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

try {
  const page = await waitJsonList();
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');

  for (let i = 0; i < 60; i++) {
    const ok = await cdp.eval(`!!(window.__XAR__ && window.__XAR__.typeInto)`);
    if (ok) break;
    await sleep(200);
  }
  if (!(await cdp.eval(`typeof window.__XAR__.typeInto === 'function'`))) {
    console.log('⚠ content.js 没有暴露 typeInto');
    process.exit(1);
  }

  await cdp.eval(`(async () => {
    await chrome.storage.local.set({
      cfg: { autoSend: false, loopMode: false, autoLike: false, autoFollow: false,
             apiKey: 'mock', model: 'deepseek-chat', maxLen: 60 }
    });
    return true;
  })()`);
  await sleep(300);

  /* ---------------- 打开回复框 ---------------- */
  console.log('[0] 打开回复框');
  const opened = await cdp.eval(`(() => {
    const a = document.querySelectorAll('article[data-testid="tweet"]')[0];
    const b = a && a.querySelector('button[data-testid="reply"]');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  check(opened, '回复框打开');
  await sleep(1200);

  /* ---------------- 1. 模拟编辑器放大 ---------------- */
  console.log('\n[1] 打开「编辑器放大 3 倍」开关，再填正文');
  const target = '这条评论说得挺在点上，我是这么想的';
  await cdp.eval(`(window.__MOCK_GROW__ = true, true)`);

  const t1 = await cdp.eval(`window.__XAR__.typeInto(${JSON.stringify(target)})`);
  const n1 = await cdp.eval(`window.__XAR__.editorText()`);
  console.log(`  typeInto 返回「${t1}」| 编辑器现在 ${n1.length} 字`);
  check(t1 === '' || t1 === target, '没有把暴涨的内容当成成功结果返回', `实际返回 ${t1.length} 字`);
  check(n1.length <= target.length * 2 + 30, '输入框被清回合理长度', `实际 ${n1.length} 字`);

  const logs1 = await cdp.eval(`window.__XAR__.state().logs`);
  const caught = logs1.filter(l => /注入失控/.test(l));
  const hardCleared = logs1.filter(l => /暴力清空|强行清空|再清一遍/.test(l));
  console.log('  捕获到的告警:', caught.length, '条');
  caught.slice(-2).forEach(l => console.log('   ' + l));
  check(caught.length >= 1, '插件识别出了「注入失控」');

  /* ---------------- 2. 不发送 ---------------- */
  console.log('\n[2] 不能把垃圾发出去');
  const sent1 = await cdp.eval(`window.__MOCK.sent`);
  check(sent1 === 0, '一条都没发出去', `实际发了 ${sent1} 条`);

  /* ---------------- 3. 关掉开关后恢复正常 ---------------- */
  console.log('\n[3] 关掉放大开关，重新填一次');
  await cdp.eval(`(window.__MOCK_GROW__ = false, growHits = 0, true)`);
  await sleep(300);
  const t2 = await cdp.eval(`window.__XAR__.typeInto(${JSON.stringify(target)})`);
  console.log(`  typeInto 返回「${t2}」`);
  check(t2 === target, '恢复正常，填的就是正文', `实际「${t2}」`);

  /* ---------------- 4. 手工塞炸弹也能清 ---------------- */
  console.log('\n[4] 框里已经有几千字垃圾时再填');
  await cdp.eval(`(() => {
    const ed = document.querySelector('div[data-testid^="tweetTextarea_"] [contenteditable="true"]');
    ed.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    let junk = '';
    for (let i = 0; i < 40; i++) junk += '下雨下天下雨下留下雨下天下雨下客下';
    document.execCommand('insertText', false, junk);
    return window.__XAR__.editorText().length;
  })()`);
  const before = await cdp.eval(`window.__XAR__.editorText().length`);
  console.log(`  塞进去 ${before} 字垃圾`);
  check(before > 600, '垃圾确实塞进去了', `实际 ${before} 字`);

  const t3 = await cdp.eval(`window.__XAR__.typeInto(${JSON.stringify(target)})`);
  const n3 = await cdp.eval(`window.__XAR__.editorText()`);
  console.log(`  typeInto 返回「${t3}」| 编辑器现在 ${n3.length} 字`);
  check(t3 === target, '垃圾被清掉，填进的是正文', `实际「${t3}」`);

  /* ---------------- 汇总 ---------------- */
  console.log('\n--- 插件日志（尾部）---');
  (await cdp.eval(`window.__XAR__.state().logs`)).slice(-16).forEach(l => console.log('  ' + l));

  if (fails.length) {
    console.log('\n⚠ 失败项: ' + fails.join(' / '));
    code = 1;
  } else {
    console.log('\n✅ 输入框暴涨防护通过');
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
