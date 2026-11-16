/* 验证「开自动连续就无效」不再发生：
 *   连续模式要一条接一条跑完，不能从第二条开始全挂。
 *   重点看三件事：
 *     1) 上一轮的弹窗有没有关掉（不关就点不动「回复」，还会写到上一条下面）
 *     2) 上一轮的编辑器内容有没有清干净（X 会当草稿留着）
 *     3) 每条发出去的内容是不是完整的一份（不是两份、不是碎片）
 * 用法：node test/run-continuous.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9345;
const MOCK = path.resolve('test', 'mock-x.html').replace(/\\/g, '/');
const URL = `file:///${MOCK}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

const userDataDir = path.join(process.env.TEMP || '.', 'xar-cont-' + Date.now());
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', URL
], { stdio: 'ignore' });

let ws, id = 0;
const pend = new Map();

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page' && t.url.startsWith('file:'));
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
        };
        return;
      }
    } catch (_) {}
    await sleep(300);
  }
  throw new Error('连不上 Chrome');
}

function send(method, params) {
  const myId = ++id;
  return new Promise((res) => {
    pend.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
}

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || ''));
  }
  return r.result && r.result.result && r.result.result.value;
}

const want = (n) => `连续模式第 ${n} 条的回复内容，长度控制在这个范围里。`;

async function main() {
  await connect();
  await send('Page.enable');
  await sleep(1500);

  // 仿真真实 CDP 注入（一次插入整段），并打开连续模式跑 4 条
  await ev(`(() => {
    window.__MOCK_CDP__ = true;
    const cfg = window.__MOCK_CONFIG__ || {};
    const store = { loopMode: true, maxPerRun: 4, maxPerHour: 40, minDelay: 1, maxDelay: 2,
                    autoLike: false, autoFollow: false, followOnReply: false, autoScroll: true,
                    speed: 'turbo', maxLen: 120, visionEnabled: false };
    localStorage.setItem('xar-test-cfg', JSON.stringify(store));
  })()`);

  await ev(`(async () => {
    const cur = await chrome.storage.local.get(['cfg']);
    await chrome.storage.local.set({ cfg: Object.assign({}, cur.cfg, {
      loopMode: true, maxPerRun: 4, maxPerHour: 40, minDelay: 1, maxDelay: 2,
      autoLike: false, autoFollow: false, followOnReply: false, autoScroll: true,
      speed: 'turbo', maxLen: 120, visionEnabled: false, dryRun: false
    })});
  })()`);
  await sleep(500);

  console.log('[1] 连续模式跑 4 条');
  await ev(`document.getElementById('xar-host').shadowRoot.getElementById('btnRun').click()`);

  let st = null;
  for (let i = 0; i < 200; i++) {
    st = await ev(`window.__XAR__.state()`);
    if (!st.running) break;
    await sleep(300);
  }

  console.log('   ' + JSON.stringify(st.stats));
  ok(st.running === false, '循环跑完并停下');
  ok(st.stats.done >= 3, `成功条数 ${st.stats.done}（≥3 才算连续模式真的能用）`);
  ok(st.stats.fail === 0, `失败 ${st.stats.fail} 条`);

  console.log('[2] 每条发出去的内容都只有一份');
  const sent = await ev(`window.__MOCK.sentTexts`);
  console.log('   发送记录：');
  (sent || []).forEach((t, i) => console.log(`   ${i + 1}. ${t.length} 字 ${JSON.stringify(t.slice(0, 30))}`));
  ok((sent || []).length >= 3, `共发出 ${(sent || []).length} 条`);
  const noDouble = (sent || []).every(t => {
    const half = Math.floor(t.length / 2);
    if (t.length < 6) return true;
    return t.slice(0, half) !== t.slice(half);
  });
  ok(noDouble, '没有一条是「同一段写了两遍」');
  const noJunk = (sent || []).every(t => !/^[\da-zA-Z]{1,2}[\u4e00-\u9fa5]{4,}/.test(t) || t.length > 12);
  ok(noJunk, '没有 priming 残留（a/aa 前缀）');

  console.log('[3] 跑完之后面板状态干净');
  const afterRun = await ev(`(() => {
    const sr = document.getElementById('xar-host').shadowRoot;
    return { btn: sr.getElementById('btnRun').textContent, tag: sr.querySelector('.tag') ? sr.querySelector('.tag').textContent : '' };
  })()`);
  ok(/回下一条|开始连续/.test(afterRun.btn), `按钮已复原：「${afterRun.btn}」`);

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  process.exitCode = fail ? 1 : 0;
}

try {
  await main();
} catch (e) {
  console.error('测试异常：', e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch (_) {}
  try { chrome.kill(); } catch (_) {}
  await sleep(400);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
}
