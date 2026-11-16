/**
 * 按钮灰掉的 e2e：「内容已经写对，但发送按钮一直是灰的」。
 *
 * 真实 X 上这件事有两种成因：
 *   ① 字数超限 —— 截短就亮；
 *   ② X 的编辑器状态没同步（DOM 有字，它自己以为空）—— 截多短都灰。
 * ② 只能绕过去：派发真实回车键（Enter 发送），或者摘掉按钮的禁用标记硬点。
 *
 * 用法: node test/run-grey.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9342;
const PAGE = pathToFileURL(resolve('test/mock-x.html')).href;

const profile = mkdtempSync(join(tmpdir(), 'xar-grey-'));
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

try {
  const page = await waitJsonList();
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');

  for (let i = 0; i < 60; i++) {
    const ok = await cdp.eval(`!!(window.__XAR__ && document.getElementById('xar-host'))`);
    if (ok) break;
    await sleep(200);
  }

  /* ---------------- 1. 打开「按钮永远灰」的仿真开关 ---------------- */
  console.log('[1] 打开仿真开关：框里有字，按钮也保持灰');
  await cdp.eval(`window.__MOCK_STALE_BTN__ = true, true`);
  await cdp.eval(`(async () => {
    await chrome.storage.local.set({ repliedIds: [] });
    return true;
  })()`);
  await setCfg(cdp, {
    autoSend: true, loopMode: false, autoLike: false, autoFollow: false, maxPerRun: 1
  });
  await sleep(400);

  /* ---------------- 2. 跑一条 ---------------- */
  console.log('\n[2] 点「回下一条」，看它能不能绕过灰按钮');
  await cdp.eval(`document.getElementById('xar-host').shadowRoot.getElementById('btnRun').click(), true`);
  for (let i = 0; i < 200; i++) {
    await sleep(300);
    const st = await cdp.eval(`window.__XAR__.state()`);
    if (!st.running && st.stats.done + st.stats.fail > 0) break;
  }
  await sleep(1200);

  const st = await cdp.eval(`window.__XAR__.state()`);
  const logs = st.logs || [];
  const sentTexts = await cdp.eval(`window.__MOCK.sentTexts`);
  const mockSent = await cdp.eval(`window.__MOCK.sent`);

  console.log('  统计:', JSON.stringify(st.stats), '| mock 发出:', mockSent);
  logs.slice(-12).forEach(l => console.log('  ' + l));

  check(mockSent >= 1, '内容发出去了（绕过了灰按钮）', `实际 ${mockSent}`);
  check(st.stats.done >= 1, '统计里记为成功', JSON.stringify(st.stats));
  check(sentTexts.length >= 1 && sentTexts[0].length >= 6, '发出的是完整句子', sentTexts[0] || '');

  const sawGray = logs.some(l => /发送按钮是灰的/.test(l));
  check(sawGray, '日志点明了按钮是灰的');

  const sawFallback = logs.some(l => /真实回车键|强行点按钮|走的回车键|走的强行点按钮/.test(l));
  check(sawFallback, '日志记录了兜底路径');

  /* ---------------- 3. 关掉仿真，确认正常路径没被影响 ---------------- */
  console.log('\n[3] 关掉仿真开关，恢复正常路径');
  await cdp.eval(`window.__MOCK_STALE_BTN__ = false, true`);
  await cdp.eval(`(async () => { await chrome.storage.local.set({ repliedIds: [] }); return true; })()`);
  await sleep(300);

  const before = await cdp.eval(`window.__MOCK.sent`);
  await cdp.eval(`document.getElementById('xar-host').shadowRoot.getElementById('btnRun').click(), true`);
  for (let i = 0; i < 200; i++) {
    await sleep(300);
    const s2 = await cdp.eval(`window.__XAR__.state()`);
    if (!s2.running && s2.stats.done + s2.stats.fail > 0) break;
  }
  await sleep(1000);

  const after = await cdp.eval(`window.__MOCK.sent`);
  check(after > before, '正常状态下也能发出去', `${before} → ${after}`);

  const st2 = await cdp.eval(`window.__XAR__.state()`);
  check(st2.stats.fail === 0, '全程没有失败计数', JSON.stringify(st2.stats));

  if (fails.length) {
    console.log('\n⚠ 失败项: ' + fails.join(' / '));
    code = 1;
  } else {
    console.log('\n✅ 灰按钮兜底通过');
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
