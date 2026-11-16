/**
 * 自动点赞 e2e：
 *   1. autoLike 开启时，回完一条顺手赞一条
 *   2. 关掉 autoLike 后不再点赞
 *   3. 打开 likeMain 后，评论和主推文各赞一个
 *   4. 已经赞过的不会重复点
 *
 * 用法: node test/run-like.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9338;
const PAGE = pathToFileURL(resolve('test/mock-x.html')).href;

const profile = mkdtempSync(join(tmpdir(), 'xar-like-'));
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
const fails = [];
const check = (cond, label, detail = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label} ${detail}`); fails.push(label); }
};

async function runOnce(cdp, expectDone) {
  await cdp.eval(`document.getElementById('xar-host').shadowRoot.getElementById('btnRun').click(), true`);
  for (let i = 0; i < 90; i++) {
    await sleep(300);
    const d = await cdp.eval(`window.__XAR__.state().stats.done`);
    const running = await cdp.eval(`window.__XAR__.state().running`);
    if (d >= expectDone && !running) return d;
  }
  return await cdp.eval(`window.__XAR__.state().stats.done`);
}

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
    const ok = await cdp.eval(`!!(window.__XAR__ && window.__XAR__.state && document.getElementById('xar-host'))`);
    if (ok) break;
    await sleep(200);
  }

  const likeBtns = await cdp.eval(`document.querySelectorAll('button[data-testid="like"]').length`);
  console.log('内容脚本已注入 | 页面上未点赞按钮:', likeBtns, '个');
  if (likeBtns < 2) { console.log('⚠ mock 页里点赞按钮太少，测试无意义'); code = 1; }

  /* ---------------- 1. 开着点赞跑一条 ---------------- */
  console.log('\n[1] autoLike = true');
  await setCfg(cdp, { autoLike: true, likeMain: false, loopMode: false });
  await sleep(400);
  let d = await runOnce(cdp, 1);
  await sleep(900);

  let liked = await cdp.eval(`window.__MOCK.liked`);
  let unlike = await cdp.eval(`document.querySelectorAll('button[data-testid="unlike"]').length`);
  check(d >= 1, '回复了 1 条', `实际 done=${d}`);
  check(liked === 1, '点赞数 = 1', `实际 ${liked}`);
  check(unlike === 1, '页面上出现 1 个已赞按钮', `实际 ${unlike}`);

  let st = await cdp.eval(`window.__XAR__.state()`);
  check((st.stats.liked || 0) === 1, '面板统计里赞数 = 1', `实际 ${st.stats.liked}`);
  const hasLikeLog = (st.logs || []).some(l => /👍 已点赞/.test(l));
  check(hasLikeLog, '日志里有「👍 已点赞」');

  /* ---------------- 2. 关掉点赞 ---------------- */
  console.log('\n[2] autoLike = false');
  await setCfg(cdp, { autoLike: false });
  await sleep(400);
  d = await runOnce(cdp, 2);
  await sleep(900);

  liked = await cdp.eval(`window.__MOCK.liked`);
  check(d >= 2, '又回复了 1 条', `实际 done=${d}`);
  check(liked === 1, '关掉后点赞数没变（仍是 1）', `实际 ${liked}`);

  /* ---------------- 3. 打开 likeMain ---------------- */
  console.log('\n[3] autoLike = true + likeMain = true');
  await setCfg(cdp, { autoLike: true, likeMain: true });
  await sleep(400);
  const before = await cdp.eval(`window.__MOCK.liked`);
  d = await runOnce(cdp, 3);
  await sleep(1400);

  liked = await cdp.eval(`window.__MOCK.liked`);
  check(d >= 3, '再回复 1 条', `实际 done=${d}`);
  check(liked >= before + 2, '评论 + 主推文各赞一个（+2）', `之前 ${before} 现在 ${liked}`);

  /* ---------------- 4. 已赞不重复 ---------------- */
  console.log('\n[4] 同一条不重复赞');
  const beforeRepeat = await cdp.eval(`window.__MOCK.liked`);
  const r1 = await cdp.eval(`window.__XAR__.like(document.querySelectorAll('article[data-testid="tweet"]')[1])`);
  const r2 = await cdp.eval(`window.__XAR__.like(document.querySelectorAll('article[data-testid="tweet"]')[2])`);
  await sleep(900);
  const afterRepeat = await cdp.eval(`window.__MOCK.liked`);
  st = await cdp.eval(`window.__XAR__.state()`);

  // 第 1 条在第 1 步已经赞过 → already；第 2 条只回复过没赞 → ok
  check(r1 === 'already', '再点已赞的那条返回 already', `实际 ${r1}`);
  check(r2 === 'ok' || r2 === 'already', '未赞的那条能正常补赞', `实际 ${r2}`);
  check(afterRepeat === beforeRepeat + (r2 === 'ok' ? 1 : 0), '赞数只增加实际点掉的那个', `之前 ${beforeRepeat} 现在 ${afterRepeat}`);

  console.log('\n--- 统计 ---');
  console.log('成功:', st.stats.done, ' 失败:', st.stats.fail, ' 跳过:', st.stats.skip, ' 赞:', st.stats.liked);
  console.log('\n--- 插件日志（尾部）---');
  (st.logs || []).slice(-16).forEach(l => console.log('  ' + l));

  // 每轮换新评论，重复赞的分支靠 __XAR__.like 直接验证
  if (fails.length) {
    console.log('\n⚠ 失败项: ' + fails.join(' / '));
    code = 1;
  } else {
    console.log('\n✅ 自动点赞通过');
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
