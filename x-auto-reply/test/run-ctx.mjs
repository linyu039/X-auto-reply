/**
 * 上下文去重测试：
 * 验证「原推文」和「要回复的评论」是同一段文字时，不会把重复内容喂给模型
 * （喂了模型就会回一句「你这不是复制粘贴的吗」）。
 *
 * 用法: node test/run-ctx.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9336;
const PAGE = pathToFileURL(resolve('test/mock-x.html')).href;

const profile = mkdtempSync(join(tmpdir(), 'xar-ctx-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=900,1200', PAGE
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitJsonList() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
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
  ready() { return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; }); }
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
      throw new Error('页面异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
}

const openReply = (idx) => `(() => {
  const art = document.querySelectorAll('article[data-testid="tweet"]')[${idx}];
  const btn = art.querySelector('button[data-testid="reply"]');
  btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  btn.click();
  return true;
})()`;

const closeDialog = `(() => {
  const b = document.querySelector('#dialog-host [data-testid="app-bar-close"]');
  if (b) b.click();
  return true;
})()`;

let code = 0;
try {
  const page = await waitJsonList();
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');

  for (let i = 0; i < 60; i++) {
    if (await cdp.eval(`!!(window.__XAR__ && document.getElementById('xar-host'))`)) break;
    await sleep(200);
  }
  console.log('内容脚本已注入\n');

  // 场景 1：点主推文自己的回复 —— 原推文 == 要回复的内容
  await cdp.eval(`document.getElementById('mocklog').textContent = ''`);
  await cdp.eval(openReply(0));
  await sleep(2600);
  const log1 = await cdp.eval(`document.getElementById('mocklog').textContent`);
  const payload1 = (log1.match(/payload: 上文(\d+)字 \/ 评论(\d+)字/) || []).slice(1);
  console.log('[场景1] 回复主推文本身');
  console.log('  payload →', payload1.length ? `上文 ${payload1[0]} 字 / 评论 ${payload1[1]} 字` : '未捕获');
  console.log('  期望：上文 0 字（重复内容应被丢弃）');
  const ok1 = payload1[0] === '0';
  console.log(ok1 ? '  ✅ 通过' : '  ⚠ 失败：仍然把重复内容喂给了模型');
  if (!ok1) code = 1;

  await cdp.eval(closeDialog);
  await sleep(500);

  // 场景 2：点一条评论的回复 —— 原推文 != 评论
  await cdp.eval(`document.getElementById('mocklog').textContent = ''`);
  await cdp.eval(openReply(1));
  await sleep(2600);
  const log2 = await cdp.eval(`document.getElementById('mocklog').textContent`);
  const payload2 = (log2.match(/payload: 上文(\d+)字 \/ 评论(\d+)字 \/ 图(\d+)张/) || []).slice(1);
  console.log('\n[场景2] 回复评论区里的一条（这条带图）');
  console.log('  payload →', payload2.length ? `上文 ${payload2[0]} 字 / 评论 ${payload2[1]} 字 / 图 ${payload2[2]} 张` : '未捕获');
  console.log('  期望：上文 > 0 字，图 1 张');
  const ok2 = payload2.length && Number(payload2[0]) > 0;
  console.log(ok2 ? '  ✅ 通过' : '  ⚠ 失败：主推文上下文丢了');
  if (!ok2) code = 1;

  const ok3 = payload2.length && Number(payload2[2]) === 1;
  console.log(ok3 ? '  ✅ 图片被正确提取并传给模型' : '  ⚠ 失败：图片没被提取');
  if (!ok3) code = 1;

  const bigUrl = /name=large/.test(log2);
  console.log(bigUrl ? '  ✅ 缩略图 URL 已升级为 large' : '  ⚠ 失败：图片还是 small 尺寸');
  if (!bigUrl) code = 1;

  console.log('\n--- 完整仿真日志 ---');
  console.log(log2.trim());
} catch (e) {
  console.error('检查失败:', e.message);
  code = 1;
} finally {
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  process.exit(code);
}
