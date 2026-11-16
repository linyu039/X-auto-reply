/**
 * 验证「下滑」这条路走的是真实滚轮（CDP Input.dispatchMouseEvent），
 * 而不是 window.scrollTo / JS 派发的 WheelEvent —— 后者在 X 上完全无效。
 *
 * 用法: node test/run-scroll.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9351;
const PAGE = pathToFileURL(resolve('test/mock-x.html')).href;

const profile = mkdtempSync(join(tmpdir(), 'xar-scroll-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=800,600',
  PAGE
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find(t => t.type === 'page' && t.url.startsWith('file:'));
      if (p && p.webSocketDebuggerUrl) return p;
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
  ready() { return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws error')); }); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
      throw new Error('页面异常: ' + (d || r.exceptionDetails.text));
    }
    return r.result.value;
  }
}

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };

let code = 0;
try {
  const page = await waitPage();
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');

  for (let i = 0; i < 60; i++) {
    if (await cdp.eval(`!!(window.__XAR__ && window.__XAR__.scroll)`)) break;
    await sleep(200);
  }

  console.log('\n[1] 滚轮通道本身');
  const y0 = await cdp.eval(`window.scrollY`);
  const w1 = await cdp.eval(`window.__XAR__.wheel(300)`);
  await sleep(300);
  const y1 = await cdp.eval(`window.scrollY`);
  ok(w1 === true, '内容脚本能调通 CDP 滚轮（返回 true）');
  ok(y1 > y0, `页面真的滚动了（${Math.round(y0)} → ${Math.round(y1)}）`);
  const wheelCount = await cdp.eval(`window.__MOCK_WHEELS__ || 0`);
  ok(wheelCount >= 1, `滚轮消息到达页面（${wheelCount} 次）`);

  console.log('\n[2] scrollMore 走滚轮，并且能拉出新评论');
  // 前面的操作可能已经把那条藏起来的评论放出来了，重新藏回去再测
  await cdp.eval(`(() => {
    window.scrollTo(0, 0);
    window.__MOCK_WHEELS__ = 0;
    const arts = document.querySelectorAll('article[data-testid="tweet"]');
    if (arts[3]) arts[3].style.display = 'none';
    return true;
  })()`);
  await sleep(300);
  const artsBefore = await cdp.eval(`Array.from(document.querySelectorAll('article[data-testid="tweet"]')).filter(a => a.offsetHeight > 0).length`);
  const progressed = await cdp.eval(`window.__XAR__.scroll()`);
  await sleep(300);
  const artsAfter = await cdp.eval(`Array.from(document.querySelectorAll('article[data-testid="tweet"]')).filter(a => a.offsetHeight > 0).length`);
  const wheels2 = await cdp.eval(`window.__MOCK_WHEELS__ || 0`);
  const mockLog2 = await cdp.eval(`document.getElementById('mocklog').textContent`);
  ok(wheels2 >= 1, `scrollMore 里确实发了滚轮（${wheels2} 次）`);
  ok(artsAfter > artsBefore, `滚出了新评论（可见 ${artsBefore} → ${artsAfter} 条）`);
  ok(/懒加载/.test(mockLog2), 'mock 记录了懒加载被触发');
  ok(progressed === true, 'scrollMore 判定为「有进展」');

  console.log('\n[3] 滚轮通道不通时的提示');
  await cdp.eval(`window.__MOCK_WHEEL__ = false; window.scrollTo(0, 0);`);
  await sleep(200);
  const r3 = await cdp.eval(`window.__XAR__.scroll()`);
  await sleep(300);
  const logs3 = await cdp.eval(`window.__XAR__.state().logs.join('\\n')`);
  ok(/滚轮通道没通|滑不动|下滑/.test(logs3), '日志里说明了滑动的结果');
  console.log('  （无通道时 progressed =', r3, '）');

  // 恢复，别影响后面
  await cdp.eval(`window.__MOCK_WHEEL__ = true;`);

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  if (fail > 0) code = 1;
} catch (e) {
  console.error('测试失败:', e.message);
  code = 1;
} finally {
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  process.exit(code);
}
