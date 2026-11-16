/**
 * popup 交互 e2e：验证风格预设下拉能填充，选中后整段替换人设/规则/长度/温度。
 * popup 依赖 chrome.* API，这里用 CDP 在页面加载前注入最小 stub。
 *
 * 用法: node test/run-popup.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9337;
const PAGE = pathToFileURL(resolve('popup.html')).href;

const profile = mkdtempSync(join(tmpdir(), 'xar-pop-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=520,900',
  'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page');
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
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面异常: ' + (d.exception && d.exception.description || d.text));
    }
    return r.result.value;
  }
}

const STUB = `
window.__stored = { cfg: {} };
window.chrome = {
  storage: {
    local: {
      get: async (k) => {
        if (typeof k === 'string') return { [k]: window.__stored[k] };
        return Object.assign({}, window.__stored);
      },
      set: async (o) => { Object.assign(window.__stored, o); }
    },
    onChanged: { addListener() {} }
  },
  runtime: {
    lastError: null,
    sendMessage: async (msg) => {
      if (msg && msg.type === 'XAR_SET_CFG') {
        window.__stored.cfg = Object.assign({}, window.__stored.cfg, msg.patch);
        return { ok: true, data: window.__stored.cfg };
      }
      if (msg && msg.type === 'XAR_GENERATE') return { ok: true, data: '测试回复', model: 'mock' };
      return { ok: true, data: 'pong' };
    }
  },
  tabs: { create: async () => {} }
};
`;

let pass = 0, fail = 0, code = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ⚠ ${name}${extra !== undefined ? ' — ' + extra : ''}`); }
};

try {
  const target = await waitTarget();
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1200);

  /* 1. 预设下拉被填充 */
  const opts = await cdp.eval(`(() => {
    const s = document.getElementById('preset');
    return s ? [...s.options].map(o => ({ v: o.value, t: o.textContent })) : null;
  })()`);
  check('找到 #preset 下拉', Array.isArray(opts));
  check('包含占位项 + 4 个预设', opts && opts.length === 5, opts && opts.length);
  check('有 friend 选项', !!opts && opts.some(o => o.v === 'friend'));
  check('有 stall 选项', !!opts && opts.some(o => o.v === 'stall'));

  /* 2. 选中交友预设 → 字段被整段替换 */
  const before = await cdp.eval(`document.getElementById('persona').value.slice(0, 20)`);
  await cdp.eval(`(() => {
    const s = document.getElementById('preset');
    s.value = 'friend';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(150);

  const after = await cdp.eval(`(() => ({
    persona: document.getElementById('persona').value,
    rules: document.getElementById('rules').value,
    maxLen: document.getElementById('maxLen').value,
    temp: document.getElementById('temperature').value,
    raw: document.getElementById('rawCfg').value,
    status: document.getElementById('status').textContent
  }))()`);

  check('人设被替换', after.persona !== before && after.persona.includes('搭话'));
  check('规则被替换成交友版', /钩子|具体/.test(after.rules));
  check('maxLen 变成 60', String(after.maxLen) === '60', after.maxLen);
  check('temperature 变成 1', parseFloat(after.temp) === 1, after.temp);
  check('提示了要点保存', /保存配置/.test(after.status), after.status);

  /* 3. 原始 JSON 同步了 maxTokens */
  let rawObj = null;
  try { rawObj = JSON.parse(after.raw); } catch (_) {}
  check('原始 JSON 可解析', !!rawObj);
  check('JSON 里 maxTokens=200', rawObj && rawObj.maxTokens === 200, rawObj && rawObj.maxTokens);
  check('JSON 里 maxLen=60', rawObj && rawObj.maxLen === 60, rawObj && rawObj.maxLen);

  /* 4. 点保存 → 写进 storage */
  await cdp.eval(`document.getElementById('btnSave').click(); true`);
  await sleep(300);
  const saved = await cdp.eval(`(() => {
    const c = window.__stored.cfg || {};
    return { maxLen: c.maxLen, temp: c.temperature, tokens: c.maxTokens, persona: (c.persona||'').slice(0,12) };
  })()`);
  check('保存后 storage 里 maxLen=60', saved.maxLen === 60, saved.maxLen);
  check('保存后 storage 里 maxTokens=200', saved.tokens === 200, saved.tokens);

  console.log(`\n${fail === 0 ? '✅ popup 预设链路通过' : '⚠ 有失败项'} — 通过 ${pass}，失败 ${fail}`);
  code = fail === 0 ? 0 : 1;
} catch (e) {
  console.error('✗ 测试异常:', e.message);
  code = 1;
} finally {
  try { chrome.kill(); } catch (_) {}
}

process.exit(code);
