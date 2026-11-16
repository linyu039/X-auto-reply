/**
 * 无头 Chrome 跑 test/mock-x.html，验证 content.js 的完整链路：
 * 抓评论 → 调（假）模型 → 打开回复框 → 模拟输入 → 点发送 → 弹窗关闭。
 *
 * 用法: node test/run-check.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const PAGE = pathToFileURL(resolve('test/mock-x.html')).href;

const profile = mkdtempSync(join(tmpdir(), 'xar-chk-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=900,1200',
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
      this.ws.onerror = (e) => rej(new Error('ws error'));
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); }
      }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true
    });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  }
}

let code = 0;
try {
  const page = await waitJsonList();
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');

  // 等 content.js 启动
  for (let i = 0; i < 60; i++) {
    const ok = await cdp.eval(`!!(window.__XAR__ && document.getElementById('xar-host'))`);
    if (ok) break;
    await sleep(200);
  }
  console.log('内容脚本已注入，面板已挂载');

  const sentBefore = await cdp.eval(`document.querySelectorAll('.sent-mark').length`);
  console.log('起始已发送标记数:', sentBefore);

  // 先显式切成单步（loopMode 现在默认是 true），验证点一次只处理一条
  await cdp.eval(`(async () => {
    const r = await chrome.storage.local.get('cfg');
    await chrome.storage.local.set({ cfg: Object.assign({}, r.cfg, { loopMode: false }) });
    return true;
  })()`);
  await sleep(400);
  await cdp.eval(`document.getElementById('xar-host').shadowRoot.getElementById('btnRun').click()`);
  console.log('已点击「回下一条」（单步）…');

  let last = null;
  for (let i = 0; i < 240; i++) {
    const st = await cdp.eval(`window.__XAR__.state()`);
    last = st;
    if (!st.running) break;
    await sleep(400);
  }
  const afterOne = await cdp.eval(`document.querySelectorAll('.sent-mark').length`);
  console.log('单步结束后标记数:', afterOne, afterOne === 1 ? '✓ 只处理了一条' : '⚠ 不止一条');
  if (afterOne !== 1) code = 1;

  // 切到循环模式，把剩下的跑完
  await cdp.eval(`(async () => {
    const r = await chrome.storage.local.get('cfg');
    await chrome.storage.local.set({ cfg: Object.assign({}, r.cfg, { loopMode: true }) });
    return true;
  })()`);
  await sleep(400);
  await cdp.eval(`document.getElementById('xar-host').shadowRoot.getElementById('btnRun').click()`);
  console.log('已切循环模式，继续跑…');

  for (let i = 0; i < 240; i++) {
    const st = await cdp.eval(`window.__XAR__.state()`);
    last = st;
    if (!st.running) break;
    await sleep(500);
  }

  const marks = await cdp.eval(`Array.from(document.querySelectorAll('.sent-mark')).map(e=>e.textContent)`);
  const logText = await cdp.eval(`document.getElementById('mocklog').textContent`);

  console.log('\n--- 统计 ---');
  console.log('成功:', last.stats.done, ' 失败:', last.stats.fail, ' 跳过:', last.stats.skip);
  console.log('页面上已发布的回复:');
  marks.forEach(m => console.log('  ' + m));

  console.log('\n--- 插件日志 ---');
  (last.logs || []).forEach(l => console.log('  ' + l));

  if (last.stats.done !== marks.length) {
    console.log('\n⚠ 统计与页面标记不一致');
    code = 1;
  }
  if (marks.length === 0) {
    console.log('\n⚠ 一条都没发出去');
    code = 1;
  }
  if (marks.length > 0 && last.stats.fail === 0) {
    console.log('\n✅ 全链路通过');
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
