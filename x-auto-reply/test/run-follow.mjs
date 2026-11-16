/**
 * 跟随模式 e2e：不点面板「开始」，直接模拟用户点开某条评论的「回复」按钮，
 * 验证 content.js 会自动生成并把回复填进去（必要时发送）。
 *
 * 用法: node test/run-follow.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const PAGE = pathToFileURL(resolve('test/mock-x.html')).href;

const profile = mkdtempSync(join(tmpdir(), 'xar-fol-'));
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
      }, 30000);
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
try {
  const page = await waitJsonList();
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');

  for (let i = 0; i < 60; i++) {
    const ok = await cdp.eval(`!!(window.__XAR__ && window.__XAR__.state && document.getElementById('xar-host'))`);
    if (ok) break;
    await sleep(200);
  }
  console.log('内容脚本已注入');

  const followOn = await cdp.eval(`window.__XAR__.state().cfg.followOnReply !== false`);
  const followAuto = await cdp.eval(`window.__XAR__.state().cfg.followAutoSend === true`);
  console.log('跟随模式:', followOn ? '开' : '关', '| 填完自动发:', followAuto ? '是' : '否');
  if (!followOn) { console.log('⚠ 跟随模式是关闭的，测试无意义'); code = 1; }

  // 面板「开始」不点，模拟用户手点第一条的回复按钮
  await cdp.eval(`(() => {
    const art = document.querySelectorAll('article[data-testid="tweet"]')[1];
    const btn = art.querySelector('button[data-testid="reply"]');
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    btn.click();
    return true;
  })()`);
  console.log('已模拟点击第一条回复按钮，等待自动代写…');

  let snap = { t: '', done: 0, open: false };
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    snap = await cdp.eval(`(() => {
      const dlg = document.querySelector('div[role="dialog"]');
      const open = !!dlg && getComputedStyle(dlg.parentElement).display !== 'none';
      let t = '';
      if (dlg) {
        const ed = dlg.querySelector('[data-testid^="tweetTextarea_"] [contenteditable="true"]');
        t = ed ? (ed.innerText || '').trim() : '';
      }
      return { t, done: window.__XAR__.state().stats.done, open };
    })()`);
    if (snap.t && snap.done > 0) break;
  }

  console.log('\n--- 编辑器内容 ---');
  console.log(snap.t ? '「' + snap.t + '」' : '（空 —— 没写进去）');
  console.log('弹窗是否仍打开:', snap.open ? '是' : '否');

  await sleep(2000);   // 多等一会，确认插件没有自作主张发出去
  const st = await cdp.eval(`window.__XAR__.state()`);
  const marks = await cdp.eval(`Array.from(document.querySelectorAll('.sent-mark')).map(e=>e.textContent)`);
  const stillOpen = await cdp.eval(`(() => {
    const dlg = document.querySelector('div[role="dialog"]');
    return !!dlg && getComputedStyle(dlg.parentElement).display !== 'none';
  })()`);

  console.log('\n--- 统计 ---');
  console.log('成功:', st.stats.done, ' 失败:', st.stats.fail, ' 跳过:', st.stats.skip);
  console.log('页面上的已发送标记:', marks.length ? marks : '（无 —— 符合预期，等你手动发）');
  console.log('2 秒后弹窗:', stillOpen ? '仍然打开' : '已关闭');

  console.log('\n--- 插件日志 ---');
  (st.logs || []).slice(-14).forEach(l => console.log('  ' + l));

  // 模拟用户手动点发送，然后再点下一条的回复，验证能一条条接
  if (snap.t && !followAuto) {
    await cdp.eval(`(() => { const b = document.querySelector('#dialog-host #tweetButton'); if (b) b.click(); return true; })()`);
    await sleep(700);
    const afterSend = await cdp.eval(`document.querySelectorAll('.sent-mark').length`);
    console.log('\n手动点发送后，页面标记数:', afterSend);

    await cdp.eval(`(() => {
      const arts = document.querySelectorAll('article[data-testid="tweet"]');
      const art = arts[2] || arts[1];
      const btn = art.querySelector('button[data-testid="reply"]');
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      btn.click();
      return true;
    })()`);
    await sleep(2600);
    const second = await cdp.eval(`(() => {
      const dlg = document.querySelector('div[role="dialog"]');
      const ed = dlg && dlg.querySelector('[data-testid^="tweetTextarea_"] [contenteditable="true"]');
      return ed ? (ed.innerText || '').trim() : '';
    })()`);
    console.log('点开第二条后自动填入:', second ? '「' + second + '」' : '（空）');
    if (!second) { console.log('⚠ 第二条没有自动填充'); code = 1; }
  }

  if (!snap.t) {
    console.log('\n⚠ 跟随模式没写入内容');
    code = 1;
  } else if (followAuto) {
    console.log('\n✅ 跟随模式通过（自动发送档）');
  } else if (marks.length > 0) {
    console.log('\n⚠ 关掉了自动发送，却还是有内容被发了出去');
    code = 1;
  } else if (!stillOpen) {
    console.log('\n⚠ 填完后弹窗被关掉了，应该停住等你操作');
    code = 1;
  } else if (code === 0) {
    console.log('\n✅ 跟随模式通过（只填不发，停在弹窗，可连续手点）');
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
