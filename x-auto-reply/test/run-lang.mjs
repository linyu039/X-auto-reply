/* 验证「语言跑偏」质检闸：
 *   让假模型第一次故意用错语言回，插件应该发现、要求重写，最终发出的是对的语言。
 *   用法：node test/run-lang.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9343;
const MOCK = path.resolve('test', 'mock-x.html').replace(/\\/g, '/');
const URL = `file:///${MOCK}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

const userDataDir = path.join(process.env.TEMP || '.', 'xar-lang-' + Date.now());
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDataDir}`,
  '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,900',
  URL
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
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true
  });
  if (r.result && r.result.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.result && r.result.result.description || ''));
  }
  return r.result && r.result.result && r.result.result.value;
}

async function main() {
  await connect();
  await send('Page.enable');
  await sleep(1200);

  console.log('[1] 让假模型故意用错语言回复');
  await ev(`window.__MOCK_LANG__ = 'bad'`);
  ok(await ev(`window.__MOCK_LANG__ === 'bad'`), '开关已设置');

  // 只回一条就停
  await ev(`(async () => {
    const r = await chrome.storage.local.get('cfg');
    await chrome.storage.local.set({ cfg: Object.assign({}, r.cfg, {
      enabled: true, loopMode: false, maxPerRun: 1, autoScroll: false,
      autoLike: false, autoFollow: false, dryRun: false, followOnReply: false,
      minDelay: 1, maxDelay: 2
    }) });
    return true;
  })()`);
  await sleep(400);

  await ev(`document.getElementById('xar-host').shadowRoot.getElementById('btnRun').click()`);

  for (let i = 0; i < 120; i++) {
    const st = await ev(`window.__XAR__.state()`);
    if (!st.running) break;
    await sleep(250);
  }

  const logs = await ev(`window.__XAR__.state().logs.join('\\n')`);
  const sent = await ev(`(window.__MOCK.sentTexts || []).slice(-1)[0] || ''`);

  ok(/不合格/.test(logs), '日志里指出了这一版不合格');
  ok(/要求它必须用中文重写|必须用中文/.test(logs), '日志里记录了要求用中文重写');
  ok(/这次合格了/.test(logs), '日志里记录了重写后合格');
  // 页面只跑「错语言会被自动改回来」这一半；语言判定的边界在 unit-lang.mjs 里测
  ok(sent.length > 0, '最终确实发出去了：' + JSON.stringify(sent));
  ok(/[\u4e00-\u9fff]/.test(sent), '最终发出去的是中文，不是英文');

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
