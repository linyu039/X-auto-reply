/* 验证「正文翻倍」不再发生：
 *   1) 框里已有同样长度的旧内容时，写入前必须先清空，不能叠成两倍
 *   2) 两个流程同时写同一个框时，只能有一个生效
 *   用法：node test/run-double.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9344;
const MOCK = path.resolve('test', 'mock-x.html').replace(/\\/g, '/');
const URL = `file:///${MOCK}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

const userDataDir = path.join(process.env.TEMP || '.', 'xar-double-' + Date.now());
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

const TARGET = '段落感确实是个取舍，我现在靠换键帽把手感找回来了一点。';   // 28 字

async function openModal() {
  await ev(`(() => {
    const btn = document.querySelectorAll('article[data-testid="tweet"]')[0].querySelector('button[data-testid="reply"]');
    btn.click();
  })()`);
  for (let i = 0; i < 40; i++) {
    const ready = await ev(`(() => {
      const d = document.querySelector('div[role="dialog"]');
      if (!d) return false;
      const e = d.querySelector('[contenteditable="true"]');
      return !!(e && e.getBoundingClientRect().width > 0);
    })()`);
    if (ready) return true;
    await sleep(200);
  }
  return false;
}

async function main() {
  await connect();
  await send('Page.enable');
  await sleep(1400);

  console.log('[0] 打开回复框');
  ok(await openModal(), '回复框已打开');

  console.log('[1] 框里已有同长度旧内容 → 写入前必须清空');
  await ev(`(() => {
    const ed = document.querySelector('div[role="dialog"] [contenteditable="true"]');
    ed.focus();
    document.execCommand('insertText', false, ${JSON.stringify(TARGET)});
  })()`);
  await sleep(400);
  const pre = await ev(`window.__XAR__.editorText().length`);
  ok(pre > 0, `预置成功（${pre} 字）`);

  const got = await ev(`window.__XAR__.typeInto(${JSON.stringify(TARGET)})`);
  const after = await ev(`window.__XAR__.editorText()`);
  ok(after === TARGET, `写完就是目标文本，没有叠加（${after.length} 字，目标 ${TARGET.length} 字）`);
  ok(after.length < TARGET.length * 2, '没有变成两倍');

  console.log('[2] 两个流程同时写同一个框 → 只能有一份');
  await ev(`window.__XAR__.editorText()`);
  const both = await ev(`Promise.all([
    window.__XAR__.typeInto(${JSON.stringify(TARGET)}),
    window.__XAR__.typeInto(${JSON.stringify(TARGET)})
  ]).then(() => window.__XAR__.editorText())`);
  ok(both === TARGET, `并发写入后仍然只有一份（${both.length} 字）`);

  console.log('[3] 空框写入正常');
  await ev(`(() => {
    const ed = document.querySelector('div[role="dialog"] [contenteditable="true"]');
    ed.focus();
    ed.innerHTML = '';
    ed.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
  })()`);
  await sleep(300);
  const clean = await ev(`window.__XAR__.typeInto('同事谢谢你，真的。')`);
  ok(clean === '同事谢谢你，真的。', '空框写入结果正确：' + JSON.stringify(clean));

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
