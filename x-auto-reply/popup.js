/* popup：读取/保存配置，测试接口连通性，原始 JSON 直接编辑 */
const DEFAULTS = window.XAR_DEFAULTS || {};
const PRESETS = window.XAR_PRESETS || {};
const $ = (id) => document.getElementById(id);

const TEXT_FIELDS = ['apiBase', 'apiKey', 'model', 'visionModel', 'persona', 'rules', 'myHandle'];
const NUM_FIELDS = ['temperature', 'maxPerHour', 'minDelay', 'maxDelay', 'maxPerRun', 'maxLen', 'maxLikes', 'maxFollows', 'followCooldownMin'];
const BOOL_FIELDS = ['autoSend', 'dryRun', 'autoScroll', 'skipOwn', 'skipVerified', 'followOnReply', 'followAutoSend', 'loopMode', 'visionEnabled', 'autoLike', 'likeMain', 'autoFollow'];
const SELECT_FIELDS = ['speed'];

let lastCfg = {};      // 当前生效的完整配置
let rawDirty = false;  // 用户手动改过原始 JSON

function status(msg, kind) {
  const el = $('status');
  el.textContent = msg || '';
  el.className = kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : '';
}

async function getCfg() {
  const r = await chrome.storage.local.get('cfg');
  return Object.assign({}, DEFAULTS, r.cfg || {});
}

function syncRaw(cfg) {
  if (rawDirty) return;
  $('rawCfg').value = JSON.stringify(cfg, null, 2);
}

function fill(cfg) {
  lastCfg = Object.assign({}, cfg);
  TEXT_FIELDS.forEach(k => { $(k).value = cfg[k] == null ? '' : String(cfg[k]); });
  NUM_FIELDS.forEach(k => { $(k).value = cfg[k] == null ? '' : cfg[k]; });
  BOOL_FIELDS.forEach(k => { $(k).checked = !!cfg[k]; });
  SELECT_FIELDS.forEach(k => { $(k).value = cfg[k] || 'fast'; });
  rawDirty = false;
  syncRaw(cfg);
  updateBadge(cfg);
}

/* 表单 → 配置对象（保留表单里没有的字段，如 customSelectors） */
function readForm() {
  const out = Object.assign({}, lastCfg);
  TEXT_FIELDS.forEach(k => { out[k] = $(k).value.trim(); });
  NUM_FIELDS.forEach(k => {
    const v = parseFloat($(k).value);
    out[k] = Number.isFinite(v) ? v : DEFAULTS[k];
  });
  BOOL_FIELDS.forEach(k => { out[k] = $(k).checked; });
  SELECT_FIELDS.forEach(k => { out[k] = $(k).value; });
  out.myHandle = String(out.myHandle || '').replace(/^@/, '');
  if (out.minDelay > out.maxDelay) {
    const t = out.minDelay; out.minDelay = out.maxDelay; out.maxDelay = t;
  }
  return out;
}

/* 最终要保存的配置：手改过 JSON 就听 JSON 的 */
function collect() {
  const formCfg = readForm();
  if (!rawDirty) return { cfg: formCfg, ok: true };

  const txt = $('rawCfg').value.trim();
  if (!txt) return { cfg: formCfg, ok: true };
  try {
    const parsed = JSON.parse(txt);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '原始 JSON 必须是对象' };
    }
    return { cfg: Object.assign({}, formCfg, parsed), ok: true };
  } catch (e) {
    return { ok: false, error: 'JSON 语法错误：' + e.message };
  }
}

function updateBadge(cfg) {
  const b = $('badge');
  if (cfg && cfg.apiKey) {
    b.textContent = '已配置';
    b.classList.add('ok');
  } else {
    b.textContent = '未配置';
    b.classList.remove('ok');
  }
}

async function save() {
  const got = collect();
  if (!got.ok) { status(got.error, 'err'); return; }
  const r = await chrome.runtime.sendMessage({ type: 'XAR_SET_CFG', patch: got.cfg });
  if (r && r.ok) {
    lastCfg = Object.assign({}, r.data);
    rawDirty = false;
    syncRaw(lastCfg);
    updateBadge(lastCfg);
    status('已保存，回到 X 页面即生效', 'ok');
  } else {
    status('保存失败：' + (r && r.error ? r.error : '未知错误'), 'err');
  }
  setTimeout(() => status(''), 2400);
}

async function test() {
  const got = collect();
  if (!got.ok) { status(got.error, 'err'); return; }
  if (!got.cfg.apiKey) { status('先填 API Key', 'err'); return; }
  status('测试中…');
  $('btnTest').disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'XAR_SET_CFG', patch: got.cfg });
    const r = await chrome.runtime.sendMessage({
      type: 'XAR_GENERATE',
      payload: {
        mainTweet: '今天把用了三年的机械键盘换成了静音红轴。',
        comment: '静音的真的好用吗？我一直觉得敲起来没手感。',
        handle: 'someone',
        recent: []
      }
    });
    if (r && r.ok) {
      status('接口正常 → 「' + r.data.slice(0, 60) + '」', 'ok');
      updateBadge(got.cfg);
    } else {
      status('接口报错：' + (r && r.error ? r.error : '无响应'), 'err');
    }
  } catch (e) {
    status('接口报错：' + e.message, 'err');
  } finally {
    $('btnTest').disabled = false;
  }
}

async function openX() {
  await chrome.tabs.create({ url: 'https://x.com/home' });
}

/* ---- 风格预设：整段替换人设/规则/长度/温度 ---- */
function fillPresets() {
  const sel = $('preset');
  if (!sel) return;
  Object.keys(PRESETS).forEach(key => {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = PRESETS[key].name || key;
    sel.appendChild(o);
  });
}

function applyPreset(key) {
  const p = PRESETS[key];
  if (!p) return;
  if (p.persona != null) $('persona').value = p.persona;
  if (p.rules != null) $('rules').value = p.rules;
  if (p.maxLen) $('maxLen').value = p.maxLen;
  if (typeof p.temperature === 'number') $('temperature').value = p.temperature;
  lastCfg = readForm();
  if (typeof p.maxTokens === 'number') lastCfg.maxTokens = p.maxTokens;
  syncRaw(lastCfg);
  status(`已套用「${p.name}」，点「保存配置」生效`, 'ok');
}

document.addEventListener('DOMContentLoaded', async () => {
  const cfg = await getCfg();
  fill(cfg);
  fillPresets();

  $('preset').addEventListener('change', (e) => {
    if (e.target.value) applyPreset(e.target.value);
  });

  $('btnSave').addEventListener('click', save);
  $('btnTest').addEventListener('click', test);
  $('btnOpen').addEventListener('click', openX);

  // 表单任何改动 → 同步到原始 JSON（除非用户正在手改 JSON）
  const allIds = [...TEXT_FIELDS, ...NUM_FIELDS, ...SELECT_FIELDS];
  allIds.forEach(k => {
    const el = $(k);
    if (!el) return;
    el.addEventListener('input', () => {
      lastCfg = readForm();
      syncRaw(lastCfg);
    });
    el.addEventListener('change', () => {
      lastCfg = readForm();
      syncRaw(lastCfg);
      if (k === 'apiKey' || k === 'model' || k === 'apiBase') updateBadge(lastCfg);
    });
  });
  BOOL_FIELDS.forEach(k => {
    $(k).addEventListener('change', () => {
      lastCfg = readForm();
      syncRaw(lastCfg);
    });
  });

  $('rawCfg').addEventListener('input', () => { rawDirty = true; });

  // 手改 JSON 后点别处，把值回填到表单，省得两处状态打架
  $('rawCfg').addEventListener('blur', () => {
    const txt = $('rawCfg').value.trim();
    if (!txt) { rawDirty = false; syncRaw(lastCfg); return; }
    try {
      const parsed = JSON.parse(txt);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        lastCfg = Object.assign({}, lastCfg, parsed);
      }
    } catch (_) { /* 留着让用户自己修 */ }
  });
});
