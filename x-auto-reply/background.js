/* X 评论 AI 自动回复 — service worker
 * 职责：配置读写、大模型调用（OpenAI 兼容 /chat/completions）、给 content 转发结果。
 */
importScripts('defaults.js');

const DEFAULTS = self.XAR_DEFAULTS;

/* ---------------- 配置 ---------------- */

async function getCfg() {
  const r = await chrome.storage.local.get('cfg');
  return Object.assign({}, DEFAULTS, r.cfg || {});
}

async function setCfg(patch) {
  const cfg = Object.assign(await getCfg(), patch || {});
  await chrome.storage.local.set({ cfg });
  return cfg;
}

/* ---------------- 工具 ---------------- */

function normalizeBase(base) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) b = DEFAULTS.apiBase;
  if (/\/chat\/completions$/.test(b)) return b;
  return b + '/chat/completions';
}

function cleanReply(s) {
  let t = String(s || '').trim();
  // 去掉整体包裹的引号 / 书名号 / 括号
  for (let i = 0; i < 3; i++) {
    t = t.replace(/^["'“”「」『』【】\(\)（）\s]+/g, '').replace(/["'“”「」『』【】\(\)（）\s]+$/g, '');
  }
  // 去掉模型常见的“回复：”前缀
  t = t.replace(/^(回复|Reply|回答|Output|AI)\s*[:：]\s*/i, '');
  // 去掉 markdown 包裹
  t = t.replace(/^\*\*(.*)\*\*$/s, '$1');
  t = t.replace(/^`+(.*)`+$/s, '$1');
  return t.trim();
}

function normForDup(s) {
  return String(s || '').replace(/[\s\u200b\u00a0]+/g, '');
}

function isDuplicateContext(mainTweet, comment) {
  const a = normForDup(mainTweet);
  const b = normForDup(comment);
  if (!a || !b) return false;
  if (a === b) return true;
  const s = a.length <= b.length ? a : b;
  const l = a.length <= b.length ? b : a;
  return s.length >= 12 && l.indexOf(s) >= 0;
}

function buildMessages(cfg, { mainTweet, comment, handle, recent, images, forceLang }) {
  const system = [
    cfg.persona || DEFAULTS.persona,
    '',
    '【硬性规则】',
    cfg.rules || DEFAULTS.rules,
    '',
    `单条回复总长度不要超过 ${cfg.maxLen || 220} 个字符。`
  ].join('\n');

  const cm = String(comment || '').trim();
  const mt = String(mainTweet || '').trim();
  const dup = isDuplicateContext(mt, cm);

  const wantImg = cfg.visionEnabled === true && Array.isArray(images);
  const imgList = (wantImg ? images : [])
    .filter(u => typeof u === 'string' && /^https?:\/\//i.test(u))
    .slice(0, 4);

  const parts = [];
  // 原推文和要回复的内容是同一段时，不再重复喂，否则模型会以为对方在复制粘贴
  if (mt && !dup) {
    parts.push(`【这条推文所在主贴的正文，只是背景资料，不是你要回复的对象】\n${mt.slice(0, 1200)}`);
  }
  parts.push(`【你要回复的就是下面这条】\n@${handle || 'someone'}: ${cm.slice(0, 800)}`);
  if (imgList.length) {
    parts.push(`【附了 ${imgList.length} 张图，就是这条推文配的图片。先看清图里是什么（画面内容、文字、梗点），再结合它说话。看不清或和话题无关就正常回文字，别硬扯图片。】`);
  }
  if (recent && recent.length) {
    parts.push(`【你刚刚已经发过的回复（不要重复这些说法和句式）】\n${recent.slice(-6).map(x => '- ' + x).join('\n')}`);
  }
  if (forceLang) {
    parts.push(`【语言】这次必须用${forceLang}写，不要翻译成别的语言，也不要中英混着写。`);
  }
  parts.push('只输出回复正文本身，不要任何前缀、引号或解释。');

  const textBlock = parts.join('\n\n');

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: imgList.length
        ? [{ type: 'text', text: textBlock }].concat(
            imgList.map(url => ({ type: 'image_url', image_url: { url } }))
          )
        : textBlock
    }
  ];
}

/* 把多模态消息降级成纯文本（模型不支持图片时用） */
function stripImages(messages) {
  return messages.map(m => {
    if (!Array.isArray(m.content)) return m;
    const text = m.content
      .filter(c => c && c.type === 'text')
      .map(c => c.text || '')
      .join('\n\n');
    return { role: m.role, content: text };
  });
}

function hasImages(messages) {
  return messages.some(m => Array.isArray(m.content) && m.content.some(c => c && c.type === 'image_url'));
}

/* ---------------- 模型调用 ---------------- */

/* 带图时切到视觉模型：DeepSeek 的视觉模型是 deepseek-flash，
 * 文本模型 deepseek-chat 收图会直接 400。两者 base_url 相同，只换 model 名。
 */
function pickModel(messages, cfg) {
  const withImage = hasImages(messages);
  const vision = String(cfg.visionModel || '').trim();
  if (withImage && vision) return vision;
  return cfg.model || DEFAULTS.model;
}

async function callAI(messages, cfg) {
  if (!cfg.apiKey) throw new Error('未配置 API Key（点扩展图标填入）');
  const url = normalizeBase(cfg.apiBase);

  const body = {
    model: pickModel(messages, cfg),
    messages,
    temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.95,
    max_tokens: cfg.maxTokens || 300,
    stream: false
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    let res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });

    // 降级重试：先去掉图片（模型不支持视觉），再去掉可选参数
    if (res.status === 400 || res.status === 422) {
      const txt = await res.clone().text();
      const looksLikeImageErr = hasImages(messages) &&
        /image|vision|multimodal|content\[|invalid type|not support/i.test(txt);
      if (looksLikeImageErr) {
        // 视觉模型不认这张图时，退回文本模型继续答，别整条废掉
        const bodyImg = Object.assign({}, body, {
          model: cfg.model || DEFAULTS.model,
          messages: stripImages(messages)
        });
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + cfg.apiKey
          },
          body: JSON.stringify(bodyImg),
          signal: ctrl.signal
        });
      }
      if (res.status === 400 || res.status === 422) {
        const txt2 = await res.clone().text();
        if (/max_tokens|temperature|unsupported|invalid/i.test(txt2)) {
          const body2 = {
            model: body.model,
            messages: hasImages(messages) && looksLikeImageErr ? stripImages(messages) : messages,
            stream: false
          };
          res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + cfg.apiKey
            },
            body: JSON.stringify(body2),
            signal: ctrl.signal
          });
        }
      }
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${txt.slice(0, 300)}`);
    }

    const data = await res.json();
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    let content = msg ? msg.content : '';

    // 推理模型可能把正文放在 reasoning_content 之外的空 content 里
    if ((!content || !String(content).trim()) && msg && msg.reasoning_content) {
      content = msg.reasoning_content;
    }
    // 兼容 content 为分段数组的返回
    if (Array.isArray(content)) {
      content = content.map(p => (typeof p === 'string' ? p : p.text || '')).join('');
    }
    content = cleanReply(content);
    if (!content) throw new Error('模型返回空内容');
    callAI.lastModel = body.model;
    return content;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('模型请求超时（90s）');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 浏览器层面真实输入（兜底） ----------------
 * 用 chrome.debugger + Input.insertText，路径等同于 Chrome 自己往输入框里打字，
 * X 的编辑器无法分辨。仅在页面内 execCommand / paste 全部失效时调用。
 */

function dbgAttach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      resolve(err ? err.message : null);
    });
  });
}

function dbgDetach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function dbgSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(res);
    });
  });
}

async function cdpInsertText(tabId, text) {
  const attachErr = await dbgAttach(tabId);
  if (attachErr && !/already attached/i.test(attachErr)) throw new Error(attachErr);
  try {
    /* 一次性提交整段，走的是浏览器自己的 IME 上屏路径。
       千万不要逐字符派发 —— 每插一个字 X 都可能重排一次，
       重排时光标错位会把整段内容越叠越长（就是那个 -7520 字的毛病）。 */
    await dbgSend(tabId, 'Input.insertText', { text: String(text) });
    await new Promise(r => setTimeout(r, 350));   // 让 React 把状态刷完再 detach
  } finally {
    await dbgDetach(tabId);
  }
}

/* 真实滚轮。这是解决「页面滑不动 / 滑完弹回去」的唯一可靠办法。
 *
 * 为什么不能只用 window.scrollTo 或 JS 派发 WheelEvent：
 *   1. X 的时间线是虚拟列表，它自己在 scroll 事件里把位置算回去，
 *      你赋值 scrollTop 它下一帧就拉回来；
 *   2. JS 派发的 WheelEvent 是 isTrusted === false，
 *      X 的懒加载监听器会直接忽略，一条都不会多加载。
 *
 * CDP 的 Input.dispatchMouseEvent(mouseWheel) 是浏览器层面真滚轮，
 * isTrusted === true，走的和用户滚鼠标滚轮完全一样的路径。
 */
async function cdpWheel(tabId, deltaY, x, y) {
  const attachErr = await dbgAttach(tabId);
  if (attachErr && !/already attached/i.test(attachErr)) throw new Error(attachErr);
  try {
    const px = Math.round(x || 400);
    const py = Math.round(y || 400);
    await dbgSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: px, y: py,
      deltaX: 0,
      deltaY: Math.round(deltaY),
      modifiers: 0,
      pointerType: 'mouse'
    });
    // 收尾：再发一次 0 位移，告诉页面「滚完了」
    await dbgSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: px, y: py,
      deltaX: 0,
      deltaY: 0,
      modifiers: 0,
      pointerType: 'mouse'
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 120));
  } finally {
    await dbgDetach(tabId);
  }
}

/* 真实按键（回车发送 / Tab / Esc）。按钮灰的时候用它兜底发出去。 */
const KEYMAP = {
  Enter:   { code: 'Enter',      vk: 13, text: '\r' },
  Tab:     { code: 'Tab',        vk: 9,  text: '\t' },
  Escape:  { code: 'Escape',     vk: 27, text: null },
  Backspace: { code: 'Backspace', vk: 8, text: '\b' },
  // Ctrl+A：清空编辑器专用。modifiers 2 = Ctrl。
  // 这条走浏览器原生输入管线，X 的 Lexical 一定认，比 execCommand 可靠。
  CtrlA:   { code: 'KeyA',       vk: 65, text: null, modifiers: 2 }
};

async function cdpPressKey(tabId, keyName) {
  const k = KEYMAP[keyName];
  if (!k) throw new Error('不支持的按键: ' + keyName);
  const attachErr = await dbgAttach(tabId);
  if (attachErr && !/already attached/i.test(attachErr)) throw new Error(attachErr);
  try {
    const mod = k.modifiers || 0;
    await dbgSend(tabId, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: keyName, code: k.code,
      windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: mod
    });
    if (k.text) {
      await dbgSend(tabId, 'Input.dispatchKeyEvent', {
        type: 'char', text: k.text, unmodifiedText: k.text,
        key: keyName, code: k.code, modifiers: mod
      });
    }
    await dbgSend(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: keyName, code: k.code,
      windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: mod
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 200));
  } finally {
    await dbgDetach(tabId);
  }
}

/* ---------------- 消息路由 ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'XAR_GET_CFG': {
          sendResponse({ ok: true, data: await getCfg() });
          break;
        }
        case 'XAR_SET_CFG': {
          sendResponse({ ok: true, data: await setCfg(msg.patch) });
          break;
        }
        case 'XAR_GENERATE': {
          const cfg = await getCfg();
          const messages = buildMessages(cfg, msg.payload || {});
          const text = await callAI(messages, cfg);
          sendResponse({
            ok: true,
            data: text,
            model: callAI.lastModel || pickModel(messages, cfg),
            withImage: hasImages(messages)
          });
          break;
        }
        case 'XAR_INSERT': {
          const tabId = sender && sender.tab ? sender.tab.id : null;
          if (tabId == null) throw new Error('拿不到标签页 id');
          await cdpInsertText(tabId, String(msg.text || ''));
          sendResponse({ ok: true, data: 'inserted' });
          break;
        }
        case 'XAR_KEY': {
          const tabId = sender && sender.tab ? sender.tab.id : null;
          if (tabId == null) throw new Error('拿不到标签页 id');
          await cdpPressKey(tabId, String(msg.key || 'Enter'));
          sendResponse({ ok: true, data: 'pressed' });
          break;
        }
        case 'XAR_WHEEL': {
          const tabId = sender && sender.tab ? sender.tab.id : null;
          if (tabId == null) throw new Error('拿不到标签页 id');
          await cdpWheel(tabId, Number(msg.deltaY) || 0, msg.x, msg.y);
          sendResponse({ ok: true, data: 'wheeled' });
          break;
        }
        case 'XAR_PING': {
          sendResponse({ ok: true, data: 'pong' });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message: ' + (msg && msg.type) });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true; // 异步响应
});

chrome.runtime.onInstalled.addListener(async () => {
  const r = await chrome.storage.local.get('cfg');
  if (!r.cfg) await chrome.storage.local.set({ cfg: DEFAULTS });
});
