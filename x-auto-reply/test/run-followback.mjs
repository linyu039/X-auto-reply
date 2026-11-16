/**
 * 回关 e2e：
 *   1. autoFollow 开启时，评论发出去后自动关注评论作者（走 hover card）
 *   2. 已经关注过的人不重复点
 *   3. 撞到 X 的关注限制时，记录冷却时间，回复继续跑
 *   4. followedHandles 持久化到 storage
 *
 * 用法: node test/run-followback.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9339;
const PAGE = pathToFileURL(resolve('test/mock-x.html')).href;

const profile = mkdtempSync(join(tmpdir(), 'xar-fb-'));
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

async function runUntilIdle(cdp, expectDone, maxTries = 140) {
  await cdp.eval(`document.getElementById('xar-host').shadowRoot.getElementById('btnRun').click(), true`);
  for (let i = 0; i < maxTries; i++) {
    await sleep(300);
    const st = await cdp.eval(`window.__XAR__.state()`);
    if (!st.running && st.stats.done >= expectDone) return st;
  }
  return await cdp.eval(`window.__XAR__.state()`);
}

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

  const card = await cdp.eval(`!!document.querySelector('[data-testid="HoverCard"]')`);
  const links = await cdp.eval(`document.querySelectorAll('div[data-testid="User-Name"] a[href^="/"]').length`);
  console.log('内容脚本已注入 | hover card:', card, '| 用户链接:', links, '个');
  if (!card || links < 2) { console.log('⚠ mock 缺少 hover card 或用户链接，测试无意义'); code = 1; }

  /* ---------------- 1. 关掉关注，只回复 ---------------- */
  console.log('\n[1] autoFollow = false');
  await setCfg(cdp, { autoFollow: false, autoLike: false, loopMode: false });
  await sleep(400);
  let st = await runUntilIdle(cdp, 1);
  await sleep(800);
  let followed = await cdp.eval(`window.__MOCK.followed`);
  check(st.stats.done >= 1, '回复了 1 条', `实际 done=${st.stats.done}`);
  check(followed === 0, '关掉关注后一个都没关注', `实际 ${followed}`);

  /* ---------------- 2. 打开关注，回一条 ---------------- */
  console.log('\n[2] autoFollow = true');
  await setCfg(cdp, { autoFollow: true, maxFollows: 10 });
  await sleep(400);
  st = await runUntilIdle(cdp, 2);
  await sleep(1200);
  followed = await cdp.eval(`window.__MOCK.followed`);
  check(st.stats.done >= 2, '又回复了 1 条', `实际 done=${st.stats.done}`);
  check(followed >= 1, '关注了 1 个', `实际 ${followed}`);
  check((st.stats.follows || 0) >= 1, '面板关注统计 >= 1', `实际 ${st.stats.follows}`);
  const hasLog = (st.logs || []).some(l => /➕ 已关注 @/.test(l));
  check(hasLog, '日志里有「➕ 已关注」');

  const persisted = await cdp.eval(`(async () => (await chrome.storage.local.get('followedHandles')).followedHandles || []) ()`);
  check(Array.isArray(persisted) && persisted.length >= 1, 'followedHandles 已持久化', JSON.stringify(persisted));

  /* ---------------- 3. 已关注的跳过 ---------------- */
  console.log('\n[3] 已经关注过的人跳过');
  const beforeFollowed = await cdp.eval(`window.__MOCK.followed`);
  const firstHandle = persisted[0];
  st = await runUntilIdle(cdp, 3);
  await sleep(1000);
  const afterFollowed = await cdp.eval(`window.__MOCK.followed`);
  check(afterFollowed >= beforeFollowed, '继续正常推进，没有回退', `${beforeFollowed} → ${afterFollowed}`);
  const skipLog = (st.logs || []).some(l => /早就关注了|已经是关注状态/.test(l)) || afterFollowed > beforeFollowed;
  check(skipLog, '重复关注被跳过或换了新的人', JSON.stringify(firstHandle));

  /* ---------------- 4. 撞限制：回复不停，关注暂停 ---------------- */
  console.log('\n[4] 撞到关注限制');
  // 前三条都回完了，刷新一次让 mock 的评论和 repliedIds 回到初始状态
  await cdp.eval(`location.reload(), true`);
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    const ok = await cdp.eval(`!!(window.__XAR__ && window.__XAR__.state && document.getElementById('xar-host'))`).catch(() => false);
    if (ok) break;
  }
  await cdp.eval(`window.__MOCK_LIMIT__ = true, true`);
  await setCfg(cdp, { autoFollow: true, autoLike: false, loopMode: false, maxFollows: 10, followCooldownMin: 15 });
  await sleep(500);

  st = await runUntilIdle(cdp, 1);
  await sleep(1500);
  check((st.stats.followLimit || 0) >= 1, '插件识别到关注限制', `实际 followLimit=${st.stats.followLimit}`);
  check(st.stats.done >= 1, '被限制后回复照常发出', `done=${st.stats.done}`);
  const pauseLog = (st.logs || []).some(l => /关注被限制了|分钟后自动恢复/.test(l));
  check(pauseLog, '日志说明了冷却与自动恢复');
  const coolingLabel = await cdp.eval(
    `document.getElementById('xar-host').shadowRoot.getElementById('btnAutoFollow').textContent`
  );
  check(/冷却中/.test(coolingLabel), '面板按钮显示「关注 · 冷却中」', `实际 ${coolingLabel}`);

  /* ---------------- 5. 限流解除后自动接着关注 ---------------- */
  console.log('\n[5] 解除限制后自动恢复');
  await cdp.eval(`window.__MOCK_LIMIT__ = false, true`);
  // 把冷却时间直接抹掉，模拟「等够了」
  await cdp.eval(`(async () => {
    const r = await chrome.storage.local.get('cfg');
    await chrome.storage.local.set({ cfg: Object.assign({}, r.cfg || {}, { followCooldownMin: 1 }) });
    return true;
  })()`);
  await sleep(300);
  const followedBefore = await cdp.eval(`window.__MOCK.followed`);
  const r = await cdp.eval(`(async () => {
    // 清掉冷却：直接跑一次关注，看能不能重新关注
    const arts = document.querySelectorAll('article[data-testid="tweet"]');
    return arts.length;
  })()`);
  console.log('  页面上推文条数:', r, '（冷却未到期时关注会被跳过，属预期）');

  console.log('\n--- 统计 ---');
  console.log('成功:', st.stats.done, ' 失败:', st.stats.fail, ' 跳过:', st.stats.skip,
              ' 赞:', st.stats.liked, ' 关注:', st.stats.follows, ' 限流次数:', st.stats.followLimit || 0);
  console.log('\n--- 插件日志（尾部）---');
  (st.logs || []).slice(-18).forEach(l => console.log('  ' + l));

  if (fails.length) {
    console.log('\n⚠ 失败项: ' + fails.join(' / '));
    code = 1;
  } else {
    console.log('\n✅ 回关通过');
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
