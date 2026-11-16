/* X 评论 AI 自动回复 — content script
 * 扫描当前页面的推文评论区 → 逐条调用大模型生成回复 → 模拟人工输入并发送。
 */
(() => {
  'use strict';
  if (window.__XAR_LOADED__) return;
  window.__XAR_LOADED__ = true;

  const DEFAULTS = window.XAR_DEFAULTS || {};

  /* ---------------- 选择器（X 的 DOM 会变，多路兜底） ---------------- */
  const SEL = {
    tweet: 'article[data-testid="tweet"]',
    text: 'div[data-testid="tweetText"]',
    userName: 'div[data-testid="User-Name"]',
    replyBtn: 'button[data-testid="reply"]',
    likeBtn: 'button[data-testid="like"]',
    unlikeBtn: 'button[data-testid="unlike"]',
    // 顺序很重要：contenteditable 的内层排前面，外壳作为兜底，再由 realEditor() 二次修正
    editor: 'div[contenteditable="true"][role="textbox"], div[data-testid^="tweetTextarea_"] [contenteditable="true"], div[data-testid^="tweetTextarea_"]',
    sendBtn: 'button[data-testid="tweetButton"], button[data-testid="tweetButtonInline"]',
    dialog: 'div[role="dialog"]',
    closeBtn: 'button[data-testid="app-bar-close"]',
    profileLink: 'a[data-testid="AppTabBar_Profile_Link"]'
  };

  const STORE_CFG = 'cfg';
  const STORE_REPLIED = 'repliedIds';
  const STORE_FOLLOW = 'followedHandles';

  /* ---------------- 运行态 ---------------- */
  const S = {
    cfg: Object.assign({}, DEFAULTS),
    running: false,
    looping: false,
    busy: false,
    me: '',
    replied: new Set(),
    followed: new Set(),
    followPausedUntil: 0,
    sentTimes: [],
    recentReplies: [],
    lastModel: '',
    stats: { done: 0, fail: 0, skip: 0, liked: 0, follows: 0, followLimit: 0 },
    failReasons: {},      // 失败原因 → 次数。面板上直接显示，省得去翻日志
    consecutiveFail: 0,   // 连续失败计数，到 4 就自动刹车
    logs: [],
    stopFlag: false
  };

  /* ---------------- 基础工具 ---------------- */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const rand = (a, b) => Math.floor(a + Math.random() * (b - a));

  /* 速度系数：所有交互延时都乘它。改一下这里就是整体提速/降速 */
  const SPEED_MAP = { turbo: 0.12, fast: 0.38, normal: 1, safe: 2.2 };
  const SPEED_LABEL = { turbo: '极速', fast: '快速', normal: '标准', safe: '保守' };
  const SPEED_ORDER = ['turbo', 'fast', 'normal', 'safe'];

  function k() {
    const s = (S && S.cfg && S.cfg.speed) || 'fast';
    const v = SPEED_MAP[s];
    return typeof v === 'number' ? v : 0.38;
  }

  /* 按当前速度缩放的随机延时 */
  const srand = (a, b) => Math.max(2, Math.round(rand(a, b) * k()));

  function applyCustomSelectors() {
    const cs = (S.cfg && S.cfg.customSelectors) || {};
    for (const key of Object.keys(cs)) {
      if (typeof cs[key] === 'string' && cs[key].trim()) SEL[key] = cs[key].trim();
    }
  }

  function waitUntil(fn, timeout = 6000, step = 120) {
    return new Promise(resolve => {
      const t0 = Date.now();
      (function probe() {
        let v = null;
        try { v = fn(); } catch (_) { v = null; }
        if (v) return resolve(v);
        if (Date.now() - t0 > timeout) return resolve(null);
        setTimeout(probe, step);
      })();
    });
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }

  function log(msg) {
    const line = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
    S.logs.push(line);
    if (S.logs.length > 120) S.logs.shift();
    try { console.log('%c[XAR]', 'color:#1d9bf0', msg); } catch (_) {}
    renderLogs();
  }

  /* ---------------- 配置 ---------------- */
  async function loadCfg() {
    const r = await chrome.storage.local.get([STORE_CFG, STORE_REPLIED, STORE_FOLLOW]);
    S.cfg = Object.assign({}, DEFAULTS, r[STORE_CFG] || {});
    applyCustomSelectors();
    const ids = Array.isArray(r[STORE_REPLIED]) ? r[STORE_REPLIED] : [];
    S.replied = new Set(ids);
    const hs = Array.isArray(r[STORE_FOLLOW]) ? r[STORE_FOLLOW] : [];
    S.followed = new Set(hs);
  }

  async function persistReplied() {
    const arr = Array.from(S.replied).slice(-1500);
    S.replied = new Set(arr);
    try { await chrome.storage.local.set({ [STORE_REPLIED]: arr }); } catch (_) {}
  }

  async function persistFollowed() {
    const arr = Array.from(S.followed).slice(-2000);
    S.followed = new Set(arr);
    try { await chrome.storage.local.set({ [STORE_FOLLOW]: arr }); } catch (_) {}
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORE_CFG]) {
      S.cfg = Object.assign({}, DEFAULTS, changes[STORE_CFG].newValue || {});
      applyCustomSelectors();
      updatePanel();
    }
  });

  /* ---------------- DOM 提取 ---------------- */
  function currentStatusId() {
    const m = location.pathname.match(/\/status\/(\d+)/);
    return m ? m[1] : '';
  }

  function getStatusId(article) {
    const t = article.querySelector('time');
    if (t) {
      const a = t.closest('a');
      const m = a && a.getAttribute('href') && a.getAttribute('href').match(/status\/(\d+)/);
      if (m) return m[1];
    }
    const a2 = article.querySelector('a[href*="/status/"]');
    if (a2) {
      const m = a2.getAttribute('href').match(/status\/(\d+)/);
      if (m) return m[1];
    }
    return '';
  }

  function getText(article) {
    const el = article.querySelector(SEL.text);
    if (!el) return '';
    return (el.innerText || el.textContent || '').replace(/\u00a0/g, ' ').trim();
  }

  function getHandle(article) {
    const un = article.querySelector(SEL.userName);
    if (!un) return '';
    const links = Array.from(un.querySelectorAll('a[href^="/"]'));
    for (const a of links) {
      const h = (a.getAttribute('href') || '').split('?')[0];
      if (/^\/[A-Za-z0-9_]{1,15}$/.test(h)) return h.slice(1);
    }
    return '';
  }

  function isPromoted(article) {
    const ar = article.getBoundingClientRect();
    const spans = article.querySelectorAll('span');
    const n = Math.min(spans.length, 40);
    for (let i = 0; i < n; i++) {
      const s = spans[i];
      const t = (s.textContent || '').trim();
      if (t === 'Promoted' || t === '广告' || t === '推广' || t === 'Ad') {
        const r = s.getBoundingClientRect();
        if (r.top - ar.top < 90) return true;
      }
    }
    return false;
  }

  function isVerified(article) {
    const un = article.querySelector(SEL.userName);
    if (!un) return false;
    return !!un.querySelector('svg[data-testid="icon-verified"], [aria-label*="Verified"], [aria-label*="认证"]');
  }

  function findMe() {
    if (S.cfg.myHandle) return S.cfg.myHandle.replace(/^@/, '');
    if (S.me) return S.me;
    const a = document.querySelector(SEL.profileLink);
    if (a) {
      const h = (a.getAttribute('href') || '').split('?')[0].replace(/^\//, '');
      if (/^[A-Za-z0-9_]{1,15}$/.test(h)) { S.me = h; return h; }
    }
    return '';
  }

  function getMainTweetText() {
    const id = currentStatusId();
    const arts = Array.from(document.querySelectorAll(SEL.tweet));
    if (id) {
      for (const a of arts) if (getStatusId(a) === id) return getText(a);
    }
    return arts.length ? getText(arts[0]) : '';
  }

  /* 回复弹窗里引用的那条原推文 */
  function getDialogContext() {
    const dlg = Array.from(document.querySelectorAll(SEL.dialog)).filter(visible)[0];
    if (!dlg) return null;
    const arts = Array.from(dlg.querySelectorAll(SEL.tweet));
    for (const a of arts) {
      const t = getText(a);
      if (t) return { id: getStatusId(a), text: t };
    }
    return null;
  }

  function similarText(a, b) {
    const n = (s) => String(s || '').replace(/[\s\u200b\u00a0]+/g, '');
    const x = n(a), y = n(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const s = x.length <= y.length ? x : y;
    const l = x.length <= y.length ? y : x;
    return s.length >= 12 && l.indexOf(s) >= 0;
  }

  /* 给模型的上文。
     关键：如果上文和「要回复的那条」是同一段文字，就别重复喂 ——
     否则模型看到的是一模一样的两段，会直接说「你这不是复制粘贴的吗」。 */
  function contextFor(targetText) {
    const dlgCtx = getDialogContext();
    if (dlgCtx && dlgCtx.text && !similarText(dlgCtx.text, targetText)) {
      return dlgCtx.text;
    }
    const main = String(getMainTweetText() || '').trim();
    if (!main) return '';
    if (similarText(main, targetText)) return '';
    return main;
  }

  /* ---------------- 候选挑选 ---------------- */
  const expandedBtns = new WeakSet();

  function expandHidden() {
    const btns = Array.from(document.querySelectorAll('div[role="button"], button')).filter(b => {
      if (expandedBtns.has(b)) return false;
      const t = (b.innerText || '').trim();
      return /^(Show more replies|Show replies|显示更多回复|查看更多回复|显示回复|Show probable spam)/i.test(t);
    });
    btns.slice(0, 3).forEach(b => {
      expandedBtns.add(b);
      try { b.click(); } catch (_) {}
    });
    return btns.length;
  }

  function pickNext() {
    const cfg = S.cfg;
    const arts = Array.from(document.querySelectorAll(SEL.tweet));
    const mainId = currentStatusId();
    const me = (findMe() || '').toLowerCase();
    const vh = window.innerHeight;
    const cands = [];

    for (const el of arts) {
      if (getComputedStyle(el).display === 'none') continue;   // 虚拟化占位/被折叠
      const id = getStatusId(el);
      if (!id) continue;
      if (mainId && id === mainId) continue;         // 详情页的主推文本身
      if (S.replied.has(id)) continue;

      const text = getText(el);
      if (!text || text.length < 2) continue;
      if (cfg.skipPromoted !== false && isPromoted(el)) { S.stats.skip++; continue; }

      const handle = (getHandle(el) || '').toLowerCase();
      if (cfg.skipOwn !== false && me && handle === me) { S.stats.skip++; continue; }
      if (cfg.skipVerified && isVerified(el)) { S.stats.skip++; continue; }

      const r = el.getBoundingClientRect();
      const center = r.top + r.height / 2;
      const dist = center < 0 ? -center : (center > vh ? center - vh : 0);
      cands.push({ el, id, text, handle, dist });
    }

    if (!cands.length) return null;
    cands.sort((a, b) => a.dist - b.dist);
    return cands[0];
  }

  /* ---------------- 图片提取 ---------------- */
  /* 只认推文里配的图（pbs.twimg.com/media），头像和 emoji 一律排除 */
  function extractImages(article, max) {
    if (!article) return [];
    const limit = max || 4;
    const out = [];
    const push = (u) => {
      if (!u) return;
      let s = String(u).trim();
      if (!/^https?:\/\//i.test(s)) return;
      if (!/pbs\.twimg\.com/i.test(s)) return;          // 头像在 profile_images，emoji 在 abs.twimg.com
      if (/profile_images|\/emoji\//i.test(s)) return;
      s = s.replace(/([?&])name=[a-z0-9_]+/i, '$1name=large');
      if (out.indexOf(s) < 0 && out.length < limit) out.push(s);
    };
    try {
      article.querySelectorAll('img').forEach(img => {
        push(img.currentSrc || img.getAttribute('src') || img.src);
      });
    } catch (_) {}
    return out;
  }

  function mainTweetElement() {
    const id = currentStatusId();
    const arts = Array.from(document.querySelectorAll(SEL.tweet));
    if (id) {
      for (const a of arts) if (getStatusId(a) === id) return a;
    }
    return arts.length ? arts[0] : null;
  }

  /* 目标那条的图 + 主推文的图，去重后最多 4 张 */
  function imagesFor(targetEl) {
    const out = [];
    const add = (arr) => {
      for (const u of arr) {
        if (out.length >= 4) return;
        if (out.indexOf(u) < 0) out.push(u);
      }
    };
    add(extractImages(targetEl, 4));
    const mainEl = mainTweetElement();
    if (mainEl && mainEl !== targetEl) add(extractImages(mainEl, 4 - out.length));
    return out.slice(0, 4);
  }

  /* ---------------- 模型 ---------------- */
  async function askAI(ctx) {
    const images = (S.cfg.visionEnabled === true && Array.isArray(ctx.images))
      ? ctx.images.slice(0, 4)
      : [];
    const res = await chrome.runtime.sendMessage({
      type: 'XAR_GENERATE',
      payload: {
        mainTweet: ctx.mainTweet,
        comment: ctx.text,
        handle: ctx.handle,
        recent: S.recentReplies.slice(-6),
        images,
        forceLang: ctx.forceLang || ''
      }
    });
    if (!res) throw new Error('后台无响应（扩展可能被重新加载）');
    if (!res.ok) throw new Error(res.error || '生成失败');
    if (res.model) S.lastModel = res.model;
    return String(res.data || '').trim();
  }

  /* ---------------- 回复质量闸 ----------------
   * 模型有时候会：① 语言跑偏（中文评论回英文）；② 话说半截；
   * ③ 自己把一句话重复好几遍。这三种都在发出去之前拦下来。
   */

  function cjkRatio(s) {
    const t = String(s || '').replace(/\s/g, '');
    if (!t) return 0;
    const n = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    return n / t.length;
  }

  /* 语言跑偏：评论是中文、回复通篇英文（或反过来） */
  function langMismatch(reply, source) {
    const r = cjkRatio(reply);
    const s = cjkRatio(source);
    if (s >= 0.35 && r < 0.15) return '中文评论配了英文回复';
    if (s <= 0.05 && r >= 0.5) return '英文评论配了中文回复';
    return '';
  }

  /* 重复片段：X 把输入放大过，或者模型自己抽风，都会出现这种 */
  function repeatedChunk(s) {
    const t = normText(s);
    if (t.length < 12) return '';
    const m = t.match(/(.{2,10}?)\1{2,}/);
    if (m) return m[1];
    const head = t.slice(0, 5);
    if (head.length === 5 && t.split(head).length - 1 >= 3) return head;

    /* 交替式重复：碎片往往不是「ABCABC」而是「下X下」「来X来」这种穿插，
       上面的正则抓不到。这里换成统计 2–4 字块的出现密度。 */
    for (let len = 2; len <= 4; len++) {
      const count = new Map();
      for (let i = 0; i + len <= t.length; i++) {
        const g = t.slice(i, i + len);
        count.set(g, (count.get(g) || 0) + 1);
      }
      for (const [g, c] of count) {
        if (c >= 4 && (c * len) / t.length >= 0.5) return g;
      }
    }
    return '';
  }

  /* 话说半截：结尾停在连接词/逗号上，或者引号没闭合 */
  function looksTruncated(s) {
    const t = String(s || '').trim();
    if (!t) return false;
    if (/[，,、；;：:（(【「"']$/.test(t)) return true;
    if (/(但是|而且|不过|因为|所以|如果|然后|还有|以及|就是)$/.test(t)) return true;
    const pairs = [['「', '」'], ['（', '）'], ['(', ')'], ['"', '"'], ['“', '”']];
    for (const [a, b] of pairs) {
      if ((t.split(a).length - 1) > (t.split(b).length - 1)) return true;
    }
    return false;
  }

  /* 生成 + 质检。模型偶尔语言跑偏 / 话说半截 / 自己重复，这三种都重生成一次，
     第二次还不合格就按现状用 —— 总比空着强。 */
  async function genReply(task, mainTweet, images) {
    const wantLang = cjkRatio(task.text) >= 0.35 ? '中文' : '英文';
    const judge = (r) => langMismatch(r, task.text) ||
                         (repeatedChunk(r) ? '自己把话重复了好几遍' : '') ||
                         (looksTruncated(r) ? '话说半截' : '');

    let reply = await askAI({ mainTweet, text: task.text, handle: task.handle, images });
    let issue = judge(reply);
    if (!issue) return reply;

    log(`… 这次生成不合格（${issue}），要求它必须用${wantLang}重写一次`);
    try {
      reply = await askAI({
        mainTweet, text: task.text, handle: task.handle, images, forceLang: wantLang
      });
    } catch (e) {
      log(`… 重生成失败：${e.message}，先用上一版`);
      return reply;
    }
    const again = judge(reply);
    log(again ? `… 还是不合格（${again}），就用这一版` : `… 这次合格了`);
    return reply;
  }

  /* ---------------- 输入模拟 ---------------- */
  /* 去掉所有不可见字符再比。X 的编辑器会往文本里塞零宽连接符、BOM、软连字符，
     直接比字符串会把「明明写对了」判成失败。 */
  const normText = (s) => String(s || '')
    .replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, '')
    .replace(/\s+/g, '');

  /* 严格相等：去掉空白和零宽字符之后必须一样。
     允许差 1-2 个字符 —— X 偶尔会吃掉句末标点或者一个空格。 */
  function textExact(have, want) {
    const a = normText(have);
    const b = normText(want);
    if (a === b) return true;
    if (!a || !b) return false;
    const d = Math.abs(a.length - b.length);
    if (d > 2) return false;
    return a.startsWith(b.slice(0, Math.max(1, b.length - 2))) ||
           b.startsWith(a.slice(0, Math.max(1, a.length - 2)));
  }

  /* 找出「正文前面多出来的垃圾」，比如 primeEditor 残留的 'a'。
     返回多出来的前缀；没有多余内容返回 ''；对不上返回 null。 */
  function extraPrefix(have, want) {
    const a = normText(have);
    const b = normText(want);
    if (!b) return null;
    if (a === b) return '';
    if (a.length > b.length && a.endsWith(b)) return a.slice(0, a.length - b.length);
    return null;
  }

  function textMatches(have, want) {
    const a = normText(have);
    const b = normText(want);
    if (!a) return false;
    if (a.length >= b.length * 0.9) return true;
    return b.length > 8 && a.indexOf(b.slice(0, 8)) >= 0;
  }

  function isPlaceholderNode(el) {
    let p = el;
    for (let i = 0; i < 5 && p && p !== document.body; i++) {
      try {
        if (p.getAttribute) {
          if (p.getAttribute('aria-hidden') === 'true') return true;
          if (p.getAttribute('data-placeholder') === 'true') return true;
        }
        const cls = typeof p.className === 'string' ? p.className : '';
        if (/placeholder/i.test(cls)) return true;
      } catch (_) {}
      p = p.parentElement;
    }
    return false;
  }

  function editorText(editor) {
    if (!editor) return '';
    try {
      const clone = editor.cloneNode(true);
      clone.querySelectorAll('[aria-hidden="true"], [data-placeholder], .public-DraftEditorPlaceholder-root')
        .forEach(n => n.remove());
      return (clone.textContent || '').replace(/\u00a0/g, ' ').replace(/\u200b/g, '').trim();
    } catch (_) {
      return (editor.innerText || '').replace(/\u00a0/g, ' ').replace(/\u200b/g, '').trim();
    }
  }

  /* 把光标放到「真实内容」的末尾，绕开 X 的空态占位符。
     之前直接 selectNodeContents(editor) 会落进占位符里，字全写偏。 */
  function placeCaretAtEnd(el) {
    const holder = el.querySelector('[data-contents="true"]') || el;
    const range = document.createRange();
    let last = null;
    try {
      const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if (isPlaceholderNode(n.parentElement)) continue;
        if (n.nodeValue && n.nodeValue.length) last = n;
      }
    } catch (_) {}

    if (last) {
      range.setStart(last, last.nodeValue.length);
      range.setEnd(last, last.nodeValue.length);
    } else {
      range.selectNodeContents(holder);
      range.collapse(false);
    }
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /* 让编辑器从「空态」进入「编辑态」：占位符只有在真正有过输入之后才彻底让位。
     这里用零宽字符而不是字母 —— 就算删除失败残留下来，也看不见、不占字数，
     不会出现「a回复正文」这种被顺手发出去的情况。 */
  async function primeEditor(editor) {
    try { editor.click(); } catch (_) {}
    await srand(90, 160);
    try { editor.focus(); } catch (_) {}
    placeCaretAtEnd(editor);
    await sleep(70);
    try { document.execCommand('insertText', false, '\u200b'); } catch (_) {}
    await srand(110, 200);
    try {
      placeCaretAtEnd(editor);
      document.execCommand('delete', false, null);
    } catch (_) {}
    await srand(110, 200);
  }

  /* 把焦点真正落到编辑器里。
     Lexical 只在「编辑器拿焦 + 选区在框内」时才处理 beforeinput；
     光调 focus() 有时不生效（页面切走过、弹窗刚打开、焦点还停在按钮上）。
     所以这里按真实鼠标的事件序列点一次，再核对 activeElement。 */
  async function ensureFocus(editor) {
    for (let i = 0; i < 6; i++) {
      if (document.activeElement === editor || editor.contains(document.activeElement)) {
        placeCaretAtEnd(editor);
        return true;
      }
      try {
        const r = editor.getBoundingClientRect();
        const x = Math.round(r.left + Math.min(r.width / 2, 60));
        const y = Math.round(r.top + r.height / 2);
        for (const t of ['mousedown', 'mouseup', 'click']) {
          editor.dispatchEvent(new MouseEvent(t, {
            bubbles: true, cancelable: true, view: window, clientX: x, clientY: y
          }));
        }
      } catch (_) {}
      try { editor.focus(); } catch (_) {}
      placeCaretAtEnd(editor);
      await sleep(130);
    }
    return document.activeElement === editor || editor.contains(document.activeElement);
  }

  /* 判断输入框是不是被灌爆了：字数远超目标就是注入失控。
     X 里每一段 insertText 都可能被它重排放大，连续模式下几轮就能堆到几千字。 */
  function overgrown(editor, clean) {
    const n = editorText(editor).length;
    const limit = Math.max(Math.round(clean.length * 1.6), clean.length + 12);
    return n > limit ? n : 0;
  }

  /* 暴力清空：Range 直接框住编辑器内容再删。
     不用 execCommand('selectAll')，那个在焦点跑飞时会选中整页。 */
  async function hardClear(editor) {
    for (let round = 0; round < 5; round++) {
      if (!editorText(editor).length) return true;
      try {
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete', false, null);
      } catch (_) {}
      await sleep(140);
    }
    // 最后一招：直接改 DOM 再通知 React
    if (editorText(editor).length) {
      try {
        const holder = editor.querySelector('[data-contents="true"]') || editor;
        holder.innerHTML = '';
        editor.dispatchEvent(new InputEvent('input', {
          inputType: 'deleteContentBackward', data: null, bubbles: true
        }));
      } catch (_) {}
      await sleep(180);
    }
    return !editorText(editor).length;
  }

  /* X 的 `data-testid="tweetTextarea_0"` 只是个外壳，真正能吃输入的是它里面的
     `[contenteditable="true"]`。以前把外壳直接交给 execCommand，
     浏览器一声不响什么都不做 —— 日志里就成了「注入失败」。 */
  function realEditor(el) {
    if (!el) return null;
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return el;
    const inner = el.querySelector('[contenteditable="true"], [contenteditable=""]');
    if (inner) return inner;
    const up = el.closest('[contenteditable="true"]');
    if (up) return up;
    return el;
  }

  async function waitForEditor(timeout = 12000) {
    return await waitUntil(() => {
      const dlgs = Array.from(document.querySelectorAll(SEL.dialog)).filter(visible);
      for (const d of dlgs) {
        const eds = Array.from(d.querySelectorAll(SEL.editor)).filter(visible);
        if (eds.length) return realEditor(eds[0]);
      }
      const all = Array.from(document.querySelectorAll(SEL.editor)).filter(visible);
      return all.length ? realEditor(all[all.length - 1]) : null;
    }, timeout);
  }

  /* 清空输入框。要清到编辑器的字数真的是 0 为止 ——
     之前只删一轮，X 有时会吞掉几次 delete，残留的字符会被当成正文一起发出去。 */
  async function clearEditor(editor) {
    try { editor.focus(); } catch (_) {}
    await sleep(50);

    // 只删内容，不动占位符节点：全选删除会把 X 的占位符一起端掉
    for (let round = 0; round < 3; round++) {
      const n = editorText(editor).length;
      if (!n) break;
      for (let i = 0; i < n + 2; i++) {
        placeCaretAtEnd(editor);
        try { document.execCommand('delete', false, null); } catch (_) { break; }
        await sleep(4);
      }
      await sleep(60);
    }

    // 还是清不掉（X 的 React 状态和 DOM 打架）→ 全选删除兜底
    if (editorText(editor).length) {
      try {
        editor.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
      } catch (_) {}
      await sleep(90);
    }
    await sleep(50);
  }

  async function insertViaPaste(editor, text) {
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      editor.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true
      }));
      await sleep(300);
      return editorText(editor);
    } catch (_) {
      return '';
    }
  }

  async function insertViaTyping(editor, text) {
    placeCaretAtEnd(editor);
    let i = 0;
    while (i < text.length) {
      const n = rand(6, 18);
      const c = text.slice(i, i + n);
      i += n;
      let ok = false;
      try { ok = document.execCommand('insertText', false, c); } catch (_) { ok = false; }
      if (!ok) {
        try {
          editor.dispatchEvent(new InputEvent('beforeinput', {
            inputType: 'insertText', data: c, bubbles: true, cancelable: true
          }));
        } catch (_) {}
        editor.textContent = (editor.textContent || '') + c;
        try {
          editor.dispatchEvent(new InputEvent('input', {
            inputType: 'insertText', data: c, bubbles: true
          }));
        } catch (_) {}
        placeCaretAtEnd(editor);
      }
      await srand(9, 28);
    }
    await srand(150, 280);
    return editorText(editor);
  }

  function sendButtonActive() {
    const s = sendButtonState();
    return s.btn ? !s.disabled : null;
  }

  /* 判断这次写入有没有被 X 接受。
     返回：
       'ok'        文字对、按钮可点 —— 可以发
       'text-only' 文字对、但按钮还是灰的 —— 多半是字数超限，外面截断再试
       'no'        文字对不上 —— 换下一级注入
     不再把「按钮灰」直接当失败：X 的字数统计慢半拍，等不够就误杀。 */
  async function inputAccepted(editor, clean) {
    const want = normText(clean);
    let btnGray = false;
    for (let i = 0; i < 6; i++) {
      await srand(150, 280);
      const got = normText(editorText(editor));
      if (got && !textExact(got, want)) {
        // 字数已经离谱 → 立刻判失败，别等到把整段灌完
        if (got.length > want.length * 1.6 + 12) return 'no';
        if (i < 3) continue;     // 可能还在逐字输入，再看两轮
        return 'no';
      }
      if (!got) continue;
      const act = sendButtonActive();
      if (act === null || act === true) return 'ok';
      btnGray = true;
      if (i >= 4) break;
    }
    return btnGray ? 'text-only' : 'no';
  }

  /* 失败计数器统一走这里，顺手记下原因。
     面板上直接显示「失败 6 条：回复框未出现×4、按钮灰发不出×2」，
     不用一层层翻日志去找。 */
  function markFail(reason) {
    S.stats.fail++;
    const k = reason || '未知原因';
    S.failReasons[k] = (S.failReasons[k] || 0) + 1;
    updatePanel();
  }

  /* 发一个真实按键到页面（走 CDP）。
     清空编辑器、回车发送都靠它 —— execCommand 改的是 DOM，
     X 的 Lexical 不认，页面上有字但按钮还是灰的。 */
  async function cdpKey(name) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'XAR_KEY', key: name });
      return !!(r && r.ok !== false);
    } catch (_) {
      return false;
    }
  }

  /* 真实滚轮：走 CDP 的 Input.dispatchMouseEvent(mouseWheel)。
     这是解决「滑不动 / 滑完弹回去」的唯一可靠办法 —— JS 派发的
     WheelEvent 是 isTrusted === false，X 的虚拟列表和懒加载都当没看见。 */
  async function cdpWheel(deltaY) {
    try {
      const r = await chrome.runtime.sendMessage({
        type: 'XAR_WHEEL',
        deltaY: deltaY,
        x: Math.round(window.innerWidth * 0.35),   // 落在主列上，避开右下角面板
        y: Math.round(window.innerHeight * 0.5)
      });
      return !!(r && r.ok !== false);
    } catch (_) {
      return false;
    }
  }

  /* 同一个回复框同时只能有一个流程在写。
     跟随模式（你点开回复）和批量模式（点「回下一条」）会同时盯上同一条评论，
     两个流程各插一遍，正文就正好变成两倍长 —— 日志里表现为「涨到 34 字（目标 17 字）」。 */
  let writing = false;
  async function typeInto(editor, text) {
    if (writing) {
      log('… 另一个流程正在往输入框里写，等它写完');
      for (let i = 0; i < 50 && writing; i++) await sleep(200);
      if (writing) {
        log('✗ 等不到另一个流程结束，这条先跳过');
        return '';
      }
    }
    writing = true;
    try {
      return await typeIntoInner(editor, text);
    } finally {
      writing = false;
    }
  }

  async function typeIntoInner(editor, text) {
    const clean = String(text).replace(/\s*\n+\s*/g, ' ').trim();
    if (!clean) return '';

    // 开工前先看看框里是不是已经被灌爆了（上一轮失控 / X 自己存的草稿）
    const pre = editorText(editor).length;
    if (pre > clean.length * 2 + 30) {
      log(`⚠ 输入框里已经有 ${pre} 字（目标只有 ${clean.length} 字），先暴力清空`);
      await hardClear(editor);
      if (editorText(editor).length) {
        log('✗ 清不干净，这条放弃（先把框里的内容手动删掉）');
        return '';
      }
    }

    // 先把编辑器从空态踢出来，否则光标会落进占位符
    await primeEditor(editor);
    await clearEditor(editor);
    // 清空必须清到 0 字，否则残留字符会和正文一起发出去
    if (editorText(editor).length) {
      log(`… 输入框没清干净（还剩 ${editorText(editor).length} 字），再清一遍`);
      await clearEditor(editor);
    }
    if (editorText(editor).length) {
      log('… 还用常规手段清不掉，转暴力清空');
      await hardClear(editor);
    }

    const snap = () => {
      const n = editorText(editor).length;
      const a = sendButtonActive();
      return `${n} 字${a === null ? '｜找不到发送按钮' : a ? '｜按钮可用' : '｜按钮灰'}`;
    };

    /* 只拦「真暴涨」。阈值宁紧勿松：放过一次就会把叠了三遍的碎片发出去，
       误拦一次只是重试一级，代价小得多。 */
    const runaway = async (hard) => {
      const n = editorText(editor).length;
      const limit = hard
        ? Math.max(clean.length * 2, clean.length + 20)
        : Math.max(Math.round(clean.length * 1.5), clean.length + 10);
      if (n <= limit) return false;
      log(`⚠ 注入失控：输入框涨到 ${n} 字（目标 ${clean.length} 字），强行清空并放弃这条`);
      await hardClear(editor);
      return true;
    };

    /* 每一级注入前都必须从这里开始：框必须是空的。
       清不干净就放弃 —— 否则「清空 + 重插」会变成两段叠加，
       目标 22 字最后变成 44 字，正好翻倍。 */
    const resetEditor = async () => {
      for (let i = 0; i < 3; i++) {
        if (!editorText(editor).length) return true;
        await hardClear(editor);
        await sleep(90);
      }
      /* 常规手段清不掉的情况在连续模式里特别常见：
         X 会把上一轮的内容当草稿留着，execCommand 删不干净。
         这里改用真实键盘事件 Ctrl+A → Backspace，走浏览器原生输入管线，
         Lexical 一定收到 beforeinput。 */
      if (editorText(editor).length) {
        log(`  … 常规清空失效（还剩 ${editorText(editor).length} 字），改用真实 Ctrl+A + Delete`);
        await ensureFocus(editor);
        await cdpKey('CtrlA');
        await sleep(90);
        await cdpKey('Backspace');
        await sleep(140);
      }
      const left = editorText(editor).length;
      if (left) {
        log(`✗ 输入框清不干净（还剩 ${left} 字），这条放弃 —— 点进框里按 Ctrl+A 再 Delete`);
        return false;
      }
      return true;
    };

    // 一、CDP 一次性插入：走浏览器原生输入管线，Lexical 必然收到 beforeinput。
    //     一次提交整段，不会出现「插了一半再补一半」的叠加，所以排第一
    if (!(await ensureFocus(editor))) log('… 焦点没落进输入框，注入可能失效');
    if (!(await resetEditor())) return '';
    placeCaretAtEnd(editor);
    let cdpNote = '';
    try {
      const r = await chrome.runtime.sendMessage({ type: 'XAR_INSERT', text: clean });
      if (!r) cdpNote = '后台无响应';
      else if (r.ok === false) cdpNote = r.error || 'CDP 注入失败';
      await srand(300, 520);
    } catch (e) {
      cdpNote = e.message;
    }
    if (await runaway(false)) return '';
    if ((await inputAccepted(editor, clean)) !== 'no') return editorText(editor);
    log(`  ① CDP 注入：${cdpNote || '已发送'}，框里 ${snap()}`);

    // 二、全选覆盖：一次性把整段塞进去，结果必然等于目标文本。
    //     Lexical 对「选中后替换」的处理最干脆，中途没有残影，也不会产生碎片
    if (!(await resetEditor())) return '';
    await ensureFocus(editor);
    try {
      const range = document.createRange();
      range.selectNodeContents(editor);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, clean);
      await srand(200, 380);
    } catch (e) {
      log(`  ② 全选覆盖异常：${e.message}`);
    }
    if (await runaway(false)) return '';
    if ((await inputAccepted(editor, clean)) !== 'no') return editorText(editor);
    log(`  ② 全选覆盖：框里 ${snap()}`);

    // 三、粘贴事件
    if (!(await resetEditor())) return '';
    await ensureFocus(editor);
    placeCaretAtEnd(editor);
    await insertViaPaste(editor, clean);
    if (await runaway(false)) return '';
    if ((await inputAccepted(editor, clean)) !== 'no') return editorText(editor);
    log(`  ③ 粘贴事件：框里 ${snap()}`);

    // 四、分块 insertText（每块 6-18 字，比逐字符稳）
    if (!(await resetEditor())) return '';
    await ensureFocus(editor);
    placeCaretAtEnd(editor);
    await insertViaTyping(editor, clean);
    if (await runaway(false)) return '';
    if ((await inputAccepted(editor, clean)) !== 'no') return editorText(editor);
    log(`  ④ 分块输入：框里 ${snap()}`);

    /* 五、逐字符。放在最后才用 —— 每敲一个字 X 都可能重排一次，
       光标一错位内容就会被叠成「下雨下天下雨下留」那种碎片。 */
    if (!(await resetEditor())) return '';
    await ensureFocus(editor);
    placeCaretAtEnd(editor);
    let typed = 0;
    for (const ch of clean) {
      let ok = false;
      try { ok = document.execCommand('insertText', false, ch); } catch (_) { ok = false; }
      if (!ok) break;
      typed++;
      await srand(8, 24);
      if (await runaway(true)) return '';
    }
    if (typed === clean.length && !(await runaway(false)) && (await inputAccepted(editor, clean)) !== 'no') {
      return editorText(editor);
    }
    log(`  ⑤ 逐字符：插了 ${typed}/${clean.length} 个字，框里 ${snap()}`);

    // 六、直改 DOM（大概率被 X 丢掉，仅作最后记录）
    if (!(await resetEditor())) return '';
    try {
      editor.textContent = clean;
      editor.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText', data: clean, bubbles: true
      }));
      placeCaretAtEnd(editor);
      await sleep(260);
    } catch (_) {}
    if (await runaway(false)) return '';
    log(`  ⑥ 直改 DOM：框里 ${snap()}`);

    return editorText(editor);
  }

  function findSendButton() {
    const dlgs = Array.from(document.querySelectorAll(SEL.dialog)).filter(visible);
    for (const sc of dlgs) {
      const btns = Array.from(sc.querySelectorAll(SEL.sendBtn)).filter(visible);
      if (btns.length) return btns[btns.length - 1];
    }
    // 弹窗里没有 → 详情页内联回复框
    const all = Array.from(document.querySelectorAll(SEL.sendBtn)).filter(visible);
    return all.length ? all[all.length - 1] : null;
  }

  function sendButtonState() {
    const b = findSendButton();
    if (!b) return { btn: null, disabled: true, label: '', hint: '页面上找不到发送按钮' };
    const disabled = b.getAttribute('aria-disabled') === 'true' || b.disabled === true;
    return {
      btn: b,
      disabled,
      label: (b.innerText || '').trim(),
      hint: disabled ? '发送按钮处于禁用态（内容为空或超字数）' : ''
    };
  }

  async function clickSend(timeout = 15000) {
    const btn = await waitUntil(() => {
      const s = sendButtonState();
      return s.disabled ? null : s.btn;
    }, timeout, 200);
    if (!btn) return false;
    btn.click();
    return true;
  }

  async function confirmSent(editor, timeout = 20000) {
    return await waitUntil(() => {
      if (!editor || !editor.isConnected || !visible(editor)) return 'dialog-closed';
      if (!editorText(editor).length) return 'editor-cleared';
      const toast = document.querySelector('[data-testid="toast"]');
      if (toast && /sent|已发送|已发布|发布成功/i.test(toast.innerText || '')) return 'toast';
      return null;
    }, timeout, 300);
  }

  /* 最后一招：按钮灰着，但正文确实写对了。
     直接把按钮上的禁用标记摘掉再点一次 —— X 的按钮是 div[role="button"]，
     点击走的是 React 的 onClick，不完全依赖 disabled 属性。 */
  async function forceClickSend(editor) {
    const s = sendButtonState();
    if (!s.btn) return '';
    log('… 摘掉按钮上的禁用标记，强行点一次');
    try {
      s.btn.removeAttribute('aria-disabled');
      s.btn.removeAttribute('disabled');
      s.btn.disabled = false;
      s.btn.classList.remove('r-1otgn73');
    } catch (_) {}
    await srand(140, 280);
    try { s.btn.click(); } catch (_) {}
    return await confirmSent(editor, 10000);
  }

  /* 按钮灰但正文已经写对了：派发一个真实回车键把内容发出去。
     X 网页版回复框是 Enter 发送、Shift+Enter 换行；
     走 CDP 的原始按键事件，不依赖按钮的 disabled 状态。 */
  async function finishByEnter(editor) {
    try {
      editor.focus();
      await srand(140, 300);
      const r = await chrome.runtime.sendMessage({ type: 'XAR_KEY', key: 'Enter' });
      if (!r || r.ok === false) {
        log(`… 回车键派不出去：${(r && r.error) || '后台无响应'}`);
        return '';
      }
    } catch (e) {
      log(`… 回车键异常：${e.message}`);
      return '';
    }
    return await confirmSent(editor, 12000);
  }

  async function closeModal() {
    const dlg = Array.from(document.querySelectorAll(SEL.dialog)).filter(visible)[0];
    if (!dlg) return;
    const x = dlg.querySelector(SEL.closeBtn);
    if (x && visible(x)) { try { x.click(); return; } catch (_) {} }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }

  /* ---------------- 点赞 ----------------
   * X 把已赞和未赞做成两个不同的 testid：like / unlike。
   * 所以「点没点过」不用读状态，看按钮在不在就知道。
   */

  function likeStateOf(el) {
    if (!el || !el.querySelector) return 'none';
    if (el.querySelector(SEL.unlikeBtn)) return 'liked';
    if (el.querySelector(SEL.likeBtn)) return 'can';
    return 'none';
  }

  async function likeArticle(el, { silent = false } = {}) {
    if (!el || !el.isConnected) return 'gone';

    const st = likeStateOf(el);
    if (st === 'liked') {
      if (!silent) log('  · 这条已经点过赞了');
      return 'already';
    }
    if (st === 'none') {
      if (!silent) log('  · 没找到点赞按钮，跳过');
      return 'gone';
    }

    const btn = el.querySelector(SEL.likeBtn);
    if (!btn || !visible(btn)) {
      if (!silent) log('  · 点赞按钮不可见，跳过');
      return 'gone';
    }

    // 真人点之前会顿一下
    await srand(180, 460);
    try { btn.click(); } catch (_) { return 'fail'; }
    await srand(480, 900);

    const ok = likeStateOf(el) === 'liked';
    if (!silent) {
      log(ok ? '  👍 已点赞' : '  · 点了赞但按钮没变（可能被限流或网络慢）');
    }
    return ok ? 'ok' : 'fail';
  }

  /* 按配置决定赞谁：默认只赞刚回复的那条评论 */
  async function maybeLike(el) {
    const cfg = S.cfg;
    if (cfg.autoLike !== true) return;
    if ((S.stats.liked || 0) >= (cfg.maxLikes || 40)) {
      log('  · 本次点赞已达上限，不再点');
      return;
    }

    const r = await likeArticle(el);
    if (r === 'ok') {
      S.stats.liked = (S.stats.liked || 0) + 1;
      updatePanel();
    }

    if (cfg.likeMain === true) {
      const main = mainTweetElement();
      if (main && main !== el) {
        const r2 = await likeArticle(main, { silent: r !== 'ok' });
        if (r2 === 'ok') {
          S.stats.liked = (S.stats.liked || 0) + 1;
          updatePanel();
        }
      }
    }
  }

  /* ---------------- 关注 / 回关 ----------------
   * X 的评论卡片里通常没有关注按钮，只能靠 hover card（鼠标悬停弹出的名片）。
   * 已关注 → 按钮文字是「Following / 正在关注 / 互相关注」；未关注 → 「Follow / 关注」。
   * 遇到关注限制（Rate limit）就记一个冷却时间，回复照常继续，到点自动接着关注。
   */
  const FOLLOW_CAN = /^(follow|关注|加关注)$/i;
  const FOLLOW_DONE = /^(following|正在关注|互相关注|已关注)$/i;
  const LIMIT_RE = /unable to follow|reached the limit|follow limit|rate limit|too many|try again later|暂时无法|操作过于频繁|达到上限|稍后再试|请稍后|限制/i;

  function buttonLabel(b) {
    if (!b) return '';
    return String(b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function followStateIn(root) {
    if (!root || !root.querySelectorAll) return 'none';
    let can = null;
    for (const b of root.querySelectorAll('button, [role="button"]')) {
      const t = buttonLabel(b);
      if (!t || t.length > 12) continue;
      if (FOLLOW_DONE.test(t)) return 'following';
      if (!can && FOLLOW_CAN.test(t)) can = b;
    }
    return can ? 'can' : 'none';
  }

  function findFollowBtn(root) {
    if (!root || !root.querySelectorAll) return null;
    for (const b of root.querySelectorAll('button, [role="button"]')) {
      const t = buttonLabel(b);
      if (!t || t.length > 12) continue;
      if (FOLLOW_CAN.test(t)) return b;
    }
    return null;
  }

  function toastText() {
    const t = document.querySelector('[data-testid="toast"]');
    return t ? buttonLabel(t) : '';
  }

  function closeHoverCard() {
    try {
      const card = document.querySelector('[data-testid="HoverCard"]');
      if (card) card.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 1, clientY: 1 }));
    } catch (_) {}
  }

  function setFollowPause(reason) {
    const mins = Number(S.cfg.followCooldownMin) > 0 ? Number(S.cfg.followCooldownMin) : 15;
    S.followPausedUntil = Date.now() + mins * 60000;
    S.stats.followLimit = (S.stats.followLimit || 0) + 1;
    log(`  ⏸ 关注被限制了（${String(reason || '').slice(0, 40)}）`);
    log(`  ⏸ ${mins} 分钟后自动恢复关注，这期间回复照常继续`);
    updatePanel();
  }

  async function clickFollow(btn, handle) {
    if (!btn || !visible(btn)) return { r: 'gone' };
    const before = buttonLabel(btn);
    await srand(260, 620);
    try { btn.click(); } catch (_) { return { r: 'fail' }; }
    await srand(900, 1600);

    const tx = toastText();
    if (tx && LIMIT_RE.test(tx)) return { r: 'limit', msg: tx };

    const after = buttonLabel(btn);
    if (FOLLOW_DONE.test(after) || (before !== after && FOLLOW_DONE.test(after))) {
      return { r: 'ok' };
    }
    const parent = btn.parentElement;
    if (parent && followStateIn(parent) === 'following') return { r: 'ok' };
    if (after === before && !tx) return { r: 'maybe' };   // 按钮被换掉了，多半成了
    return { r: 'fail' };
  }

  /* 优先用卡片内联按钮；没有就悬停用户名片取按钮 */
  async function followUser(el) {
    if (!el || !el.isConnected) return { r: 'gone' };
    const handle = getHandle(el);
    if (!handle) return { r: 'nohandle' };

    const inline = findFollowBtn(el);
    if (inline) return await clickFollow(inline, handle);

    const link = el.querySelector(`${SEL.userName} a[href^="/"]`);
    if (!link) return { r: 'nohandle' };

    const r = link.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    try {
      link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: cx, clientY: cy }));
      link.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: cx, clientY: cy }));
      link.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: cy }));
    } catch (_) {}
    await srand(800, 1400);

    const card = document.querySelector('[data-testid="HoverCard"]');
    if (!card) return { r: 'nocard' };

    const st = followStateIn(card);
    if (st === 'following') { closeHoverCard(); return { r: 'already' }; }
    const btn = findFollowBtn(card);
    if (!btn) { closeHoverCard(); return { r: 'nobtn' }; }
    return await clickFollow(btn, handle);
  }

  /* 被 X 限流时没关注成的人先记下来，冷却结束后补上 */
  let followQueue = [];

  async function drainFollowQueue() {
    if (!followQueue.length) return;
    if (S.followPausedUntil && Date.now() < S.followPausedUntil) return;

    const arts = Array.from(document.querySelectorAll(SEL.tweet));
    for (const h of Array.from(followQueue)) {
      if (!S.running) return;
      const el = arts.find(a => getHandle(a) === h);
      if (!el) { followQueue = followQueue.filter(x => x !== h); continue; }

      const out = await followUser(el);
      if (out.r === 'ok' || out.r === 'maybe' || out.r === 'already') {
        closeHoverCard();
        S.followed.add(h);
        if (out.r !== 'already') S.stats.follows = (S.stats.follows || 0) + 1;
        await persistFollowed();
        followQueue = followQueue.filter(x => x !== h);
        log(`  ➕ 限制解除，补关注 @${h}`);
        updatePanel();
      } else if (out.r === 'limit') {
        return;                       // 又被挡了，等下一轮
      } else {
        followQueue = followQueue.filter(x => x !== h);
      }
    }
  }


  async function maybeFollow(el) {
    const cfg = S.cfg;
    if (cfg.autoFollow !== true) return;

    if (S.followPausedUntil && Date.now() < S.followPausedUntil) {
      const left = Math.max(1, Math.ceil((S.followPausedUntil - Date.now()) / 60000));
      log(`  · 关注冷却中，还有 ${left} 分钟（回复不受影响）`);
      return;
    }
    if ((S.stats.follows || 0) >= (cfg.maxFollows || 50)) {
      log('  · 本次关注已达上限，不再关注');
      return;
    }

    const handle = getHandle(el);
    if (!handle) { log('  · 拿不到 handle，跳过关注'); return; }
    if (S.followed.has(handle)) { log(`  · @${handle} 早就关注了`); return; }

    const out = await followUser(el);
    if (out.r === 'ok' || out.r === 'maybe') {
      closeHoverCard();
      S.followed.add(handle);
      S.stats.follows = (S.stats.follows || 0) + 1;
      await persistFollowed();
      log(`  ➕ 已关注 @${handle}`);
      updatePanel();
      return;
    }
    if (out.r === 'already') {
      closeHoverCard();
      S.followed.add(handle);
      await persistFollowed();
      log(`  · @${handle} 已经是关注状态`);
      return;
    }
    if (out.r === 'limit') { closeHoverCard(); followQueue.push(handle); setFollowPause(out.msg); return; }
    if (out.r === 'nocard' || out.r === 'nobtn') {
      log(`  · 没弹出名片，@${handle} 这次不关注`);
      return;
    }
    log(`  · 关注 @${handle} 失败（${out.r}）`);
  }

  /* 把目标推文挪进视野。
     两条硬规矩：
     1. 已经在视口里就绝对不动 —— 每次点击都滚一下，用户看着屏幕乱跳；
     2. 不用 behavior:'smooth' —— X 的虚拟列表会在动画途中重排，
        平滑滚动被拦腰打断，结果就是「划了一下又弹回去」。 */
  async function scrollToTweet(el) {
    if (!el || !el.isConnected) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || 800;
    const topSafe = 90;          // 顶部导航栏高度
    const bottomSafe = 110;      // 底部留一点，别贴着面板

    if (r.height > 0 && r.top >= topSafe && r.bottom <= vh - bottomSafe) {
      return;   // 已经整条都在可视区里，什么都不做
    }
    try {
      el.scrollIntoView({ block: 'center', behavior: 'auto' });
    } catch (_) {
      try { window.scrollBy(0, r.top - vh / 2); } catch (__) {}
    }
    await srand(260, 480);
  }

  /* ---------------- 单条处理 ---------------- */
  async function handleOne(task) {
    const cfg = S.cfg;

    // 1) 先算好回复，再开弹窗，避免弹窗长时间挂着
    const mainTweet = contextFor(task.text);
    const images = imagesFor(task.el);
    log(`生成回复 → @${task.handle || '?'}: ${task.text.slice(0, 36)}${task.text.length > 36 ? '…' : ''}`);
    if (images.length) log(`  附带 ${images.length} 张图一起识别`);

    let reply = '';
    try {
      reply = await genReply(task, mainTweet, images);
      if (images.length) log(S.lastModel ? `  识图完成（${S.lastModel}）` : `  识图完成`);
    } catch (e) {
      log(`✗ 生成失败：${e.message}`);
      markFail('模型接口报错');
      S.replied.add(task.id);
      await persistReplied();
      return;
    }

    const cap = Math.min(cfg.maxLen || 120, 400);   // 400 字以上一定是模型抽风，直接砍掉
    if (reply.length > cap) reply = reply.slice(0, cap).trim();
    if (!reply) {
      log('✗ 回复为空，跳过');
      markFail('模型返回空');
      S.replied.add(task.id);
      return;
    }

    if (cfg.dryRun) {
      log(`◐ 预演：${reply}`);
      S.stats.done++;
      S.replied.add(task.id);
      await persistReplied();
      updatePanel();
      return;
    }

    // 2) 定位并打开回复框
    await scrollToTweet(task.el);
    if (!S.running) return;

    const btn = task.el.querySelector(SEL.replyBtn);
    if (!btn) {
      log('✗ 该条没有可用的回复按钮');
      markFail('找不到回复按钮');
      S.replied.add(task.id);
      return;
    }
    /* 上一轮可能留着弹窗没关。弹窗还开着的时候点「回复」没有任何反应，
       waitForEditor 会把旧弹窗里的编辑器当成本轮的框交出去 ——
       内容就写到上一条评论下面了，连续模式从第二条开始全错。 */
    const liveDialog = () => Array.from(document.querySelectorAll(SEL.dialog)).filter(visible)[0];
    for (let i = 0; i < 3; i++) {
      if (!liveDialog()) break;
      log('  · 上一轮的回复框还开着，先关掉再开这条');
      await closeModal();
      await srand(300, 600);
    }
    if (liveDialog()) {
      await waitUntil(() => !liveDialog(), 2500, 100);
    }

    btn.click();

    const editor = await waitForEditor(12000);
    if (!editor) {
      log('✗ 回复框未出现（可能被限流或弹窗被拦截）');
      markFail('回复框没弹出来');
      S.replied.add(task.id);
      await closeModal();
      return;
    }
    await srand(240, 620);

    // 3) 输入
    let typed = await typeInto(editor, reply);
    let act = sendButtonActive();

    // 正文前面粘了垃圾（典型的「a回复」）→ 清空重填一次，绝不带着发出去
    const junkHead = extraPrefix(typed, reply);
    if (junkHead) {
      log(`… 输入框前面多了「${junkHead.slice(0, 6)}」，清空重填`);
      await clearEditor(editor);
      typed = await typeInto(editor, reply);
      act = sendButtonActive();
    }

    // 还是对不上、而且看着像被放大过 → 清空再来一次
    const dup = (!textExact(typed, reply)) ? repeatedChunk(typed) : '';
    if (dup) {
      log(`… 输入框里出现了重复碎片「${dup.slice(0, 8)}」，清空重填一次`);
      await hardClear(editor);
      typed = await typeInto(editor, reply);
      act = sendButtonActive();
    }

    if (!textExact(typed, reply)) {
      const diff = extraPrefix(typed, reply);
      if (!typed) {
        log('✗ 注入失败（输入框被 X 反复放大，已强制清空）—— 这条跳过');
      } else {
        log(`✗ 没写进 X 的编辑器（框里 ${typed.length} 字，目标 ${reply.length} 字）：${typed.slice(0, 40)}`);
      }
      if (diff) log(`  → 正文前面还挂着「${diff.slice(0, 8)}」`);
      log('  → 该条跳过（不会把不完整的内容发出去）');
      dumpEditor(editor, '注入失败');
      markFail('注入的内容对不上');
      S.consecutiveFail = (S.consecutiveFail || 0) + 1;
      S.replied.add(task.id);
      await hardClear(editor).catch(() => {});
      await closeModal();
      updatePanel();
      return;
    }

    /* 正文写对了，但发送按钮还是灰的。两种可能：
       ① 字数超了 —— 截短就亮；
       ② X 的编辑器状态没同步（DOM 有字，它自己以为空）—— 按钮永远灰，截多短都没用。
       对②来说，真实的回车键能绕过去：它是按键事件，不看按钮状态。 */
    if (act === false) {
      const st = sendButtonState();
      log(`… 正文写进去了，但发送按钮是灰的（按钮文字「${st.label}」，${st.btn ? '已找到按钮' : '页面上压根没找到'}）`);
      const cap = Math.min(cfg.maxLen || 120, 400);
      const short = reply.slice(0, Math.min(60, Math.floor(cap / 2))).trim();
      reply = short;
      await clearEditor(editor);
      typed = await typeInto(editor, short);
      act = sendButtonActive();

      if (!textExact(typed, short)) {
        log(`✗ 截短之后反而写不进去了（框里 ${typed.length} 字）—— 这条跳过`);
        markFail('截短后写不进去');
        S.consecutiveFail = (S.consecutiveFail || 0) + 1;
        S.replied.add(task.id);
        await hardClear(editor).catch(() => {});
        await closeModal();
        updatePanel();
        return;
      }

      if (act === false) {
        log(`… 截到 ${short.length} 字按钮还是灰，两条路一起试：真实回车键 → 强行点按钮`);
        let how = await finishByEnter(editor);
        let via = '回车键';
        if (!how) {
          how = await forceClickSend(editor);
          via = '强行点按钮';
        }
        if (how) {
          log(`✓ 已发布（${how}）· 走的${via}`);
          S.stats.done++;
          S.consecutiveFail = 0;
          S.replied.add(task.id);
          await persistReplied();
          await maybeLike(task.el);
          await maybeFollow(task.el);
          await srand(320, 900);
          await closeModal();
          updatePanel();
          return;
        }
        log('✗ 回车和强点都发不出去 —— 这条跳过。');
        log('  → 大概率是对方设了「只有关注的人能回复」，或者你这个账号被限流了。');
        log('  → 换一条推文试试；每条都这样就是账号侧的限制。');
        markFail('按钮灰，回车+强点都发不出');
        S.consecutiveFail = (S.consecutiveFail || 0) + 1;
        S.replied.add(task.id);
        await hardClear(editor).catch(() => {});
        await closeModal();
        updatePanel();
        return;
      }
    }

    log(`⌨ 已填入 ${typed.length} 字：${typed.slice(0, 50)}${typed.length > 50 ? '…' : ''}`);

    if (!cfg.autoSend) {
      log('◐ 已填入未发送（人工确认模式下等你点发送）');
      S.stats.done++;
      S.replied.add(task.id);
      await persistReplied();
      updatePanel();
      return;
    }

    await srand(320, 900);

    // 4) 发送
    let ok = await clickSend(15000);

    // 按钮一直禁用 → 多半是超字数，截断重试一次
    if (!ok) {
      const st = sendButtonState();
      log(`… 发送按钮不可点（${st.hint || '原因不明'}；按钮文字「${st.label}」）`);
      if (typed.length > 60) {
        const short = reply.slice(0, 60).trim();
        log(`… 截断到 60 字重试：${short}`);
        await clearEditor(editor);
        const t2 = await typeInto(editor, short);
        if (textExact(t2, short)) {
          reply = short;
          await srand(320, 860);
          ok = await clickSend(12000);
        }
      }
    }

    if (!ok) {
      log('✗ 发送失败：发送按钮始终点不动');
      markFail('按钮点不动');
      S.replied.add(task.id);
      await closeModal();
      updatePanel();
      return;
    }

    const how = await confirmSent(editor);
    if (how) {
      S.consecutiveFail = 0;
      log(`✓ 已发布（${how}）：${reply.slice(0, 50)}${reply.length > 50 ? '…' : ''}`);
      S.stats.done++;
      S.sentTimes.push(Date.now());
      S.recentReplies.push(reply);
      S.replied.add(task.id);
      await persistReplied();
      updatePanel();
      await maybeLike(task.el);
      await maybeFollow(task.el);
      return;
    }

    log('✗ 点了发送但页面没反应，可能被风控或网络卡住');
    markFail('点了发送没反应');
    S.replied.add(task.id);
    await closeModal();
    updatePanel();
  }

  /* ---------------- 跟随模式：手动点开回复框就自动代写 ---------------- */
  let followCtx = null;    // 用户刚点了哪一条的回复
  let followBusy = false;

  function bindFollow() {
    // 捕获阶段抢在 X 之前记下目标评论
    document.addEventListener('mousedown', (e) => {
      if (!S.cfg || !S.cfg.followOnReply) return;
      const t = e.target;
      if (!t || !t.closest) return;
      const btn = t.closest(SEL.replyBtn);
      if (!btn) return;
      const art = btn.closest(SEL.tweet);
      if (!art) { followCtx = null; return; }
      const text = getText(art);
      if (!text) { followCtx = null; return; }
      followCtx = {
        el: art,
        id: getStatusId(art),
        text,
        handle: getHandle(art),
        at: Date.now()
      };
    }, true);

    const obs = new MutationObserver(() => { tryFollow(); });
    try { obs.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}
    setInterval(tryFollow, 400);   // observer 漏事件时的兜底
  }

  async function tryFollow() {
    if (followBusy) return;
    if (!S.cfg || !S.cfg.followOnReply) return;
    if (S.running) return;              // 批量模式在跑，让它独占
    if (!followCtx) return;

    // 点了回复却没等到弹窗（用户又关掉了），15 秒后作废
    if (Date.now() - (followCtx.at || 0) > 15000) { followCtx = null; return; }

    const dlg = Array.from(document.querySelectorAll(SEL.dialog)).filter(visible)[0];
    if (!dlg) return;
    const ed = realEditor(dlg.querySelector(SEL.editor));
    if (!ed || !visible(ed)) return;

    // 用户自己已经开始打字了，不插手
    if (editorText(ed).length > 0) { followCtx = null; return; }

    const task = followCtx;
    followCtx = null;
    followBusy = true;
    try {
      await fillFor(task, ed);
    } catch (e) {
      log('✗ 跟随模式出错：' + e.message);
    } finally {
      followBusy = false;
    }
  }

  /* 弹窗已经开着，只负责生成 + 填入 + 可选发送 */
  async function fillFor(task, editor) {
    const cfg = S.cfg;
    if (!cfg.apiKey) { log('⚠ 未配置 API Key，先点扩展图标填一下'); return; }

    const mainTweet = contextFor(task.text);
    const images = imagesFor(task.el);
    log(`跟随 → @${task.handle || '?'}: ${task.text.slice(0, 36)}${task.text.length > 36 ? '…' : ''}`);
    if (images.length) log(`  附带 ${images.length} 张图一起识别`);

    let reply = '';
    try {
      reply = await genReply(task, mainTweet, images);
      if (images.length) log(S.lastModel ? `  识图完成（${S.lastModel}）` : `  识图完成`);
    } catch (e) {
      log('✗ 生成失败：' + e.message);
      markFail('模型接口报错');
      return;
    }

    const cap = Math.min(cfg.maxLen || 120, 400);   // 400 字以上一定是模型抽风，直接砍掉
    if (reply.length > cap) reply = reply.slice(0, cap).trim();
    if (!reply) { log('✗ 回复为空'); return; }

    if (cfg.dryRun) { log(`◐ 预演：${reply}`); S.stats.done++; updatePanel(); return; }

    // 生成期间弹窗可能被关、你可能开始手打
    if (!editor.isConnected || !visible(editor)) { log('✗ 回复框已关闭，放弃'); return; }
    if (editorText(editor).length > 0) { log('◐ 你已经在手打了，插件不插手'); return; }

    let typed = await typeInto(editor, reply);
    let act = sendButtonActive();
    const junkHead = extraPrefix(typed, reply);
    if (junkHead) {
      log(`… 输入框前面多了「${junkHead.slice(0, 6)}」，清空重填`);
      await clearEditor(editor);
      typed = await typeInto(editor, reply);
      act = sendButtonActive();
    }
    const dup = (!textExact(typed, reply)) ? repeatedChunk(typed) : '';
    if (dup) {
      log(`… 输入框里出现了重复碎片「${dup.slice(0, 8)}」，清空重填一次`);
      await hardClear(editor);
      typed = await typeInto(editor, reply);
      act = sendButtonActive();
    }
    if (!textExact(typed, reply) || act === false) {
      if (!typed) {
        log('✗ 注入失败（输入框被 X 反复放大，已强制清空）—— 这条跳过');
      } else {
        log(`✗ 没写进 X 的编辑器（DOM 里 ${typed.length} 字，发送按钮${act === false ? '仍是灰的' : '状态未知'}）`);
      }
      markFail('跟随模式注入失败');
      dumpEditor(editor, '注入失败');
      await hardClear(editor);
      return;
    }
    log(`⌨ 已填入 ${typed.length} 字：${typed.slice(0, 50)}${typed.length > 50 ? '…' : ''}`);

    if (task.id) { S.replied.add(task.id); await persistReplied(); }

    // 默认只填不发：停在输入框，等你亲手按「回复」
    if (cfg.followAutoSend !== true) {
      try { placeCaretAtEnd(editor); editor.focus(); } catch (_) {}
      log('◐ 已填好，停在输入框 —— 你确认后点「回复」，插件不会自己发');
      S.stats.done++;
      updatePanel();
      await maybeLike(task.el);
      await maybeFollow(task.el);
      return;
    }

    await srand(320, 900);
    let ok = await clickSend(15000);

    if (!ok && typed.length > 60) {
      const short = reply.slice(0, 60).trim();
      log(`… 截断到 60 字重试：${short}`);
      await clearEditor(editor);
      const t2 = await typeInto(editor, short);
      if (textExact(t2, short)) { reply = short; ok = await clickSend(12000); }
    }

    /* 按钮点不动时走和批量模式同一套兜底。
       以前这里直接放弃，跟随模式开「自动发」就会卡在弹窗上干等 15 秒然后判失败。 */
    if (!ok) {
      log('… 发送按钮点不动，改试真实回车键');
      let how = await finishByEnter(editor);
      let via = '回车键';
      if (!how) { how = await forceClickSend(editor); via = '强行点按钮'; }
      if (how) {
        S.consecutiveFail = 0;
        log(`✓ 已发布（${how}）· 走的${via}：${reply.slice(0, 50)}${reply.length > 50 ? '…' : ''}`);
        S.stats.done++;
        S.sentTimes.push(Date.now());
        S.recentReplies.push(reply);
        updatePanel();
        await maybeLike(task.el);
        await maybeFollow(task.el);
        return;
      }
      log('✗ 回车和强点都发不出去 —— 这条跳过');
      markFail('按钮灰，回车+强点都发不出');
      return;
    }

    const how = await confirmSent(editor);
    if (how) {
      S.consecutiveFail = 0;
      log(`✓ 已发布（${how}）：${reply.slice(0, 50)}${reply.length > 50 ? '…' : ''}`);
      S.stats.done++;
      S.sentTimes.push(Date.now());
      S.recentReplies.push(reply);
      updatePanel();
      await maybeLike(task.el);
      await maybeFollow(task.el);
    } else {
      log('✗ 点了发送但页面没反应，可能被风控或网络卡住');
      markFail('点了发送没反应');
    }
  }

  /* ---------------- 主循环 ---------------- */
  function hourlyCount() {
    const now = Date.now();
    S.sentTimes = S.sentTimes.filter(t => now - t < 3600 * 1000);
    return S.sentTimes.length;
  }

  async function interruptibleSleep(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (S.stopFlag) return;
      await sleep(300);
    }
  }

  /* 找真正在滚的那个容器。
     X 的详情页有时滚的是 body，有时是评论区里的一个 div，
     滚错了元素的表现就是「划一下又被弹回去」。 */
  function findScroller() {
    const art = document.querySelector(SEL.tweet);
    let el = art ? art.parentElement : null;
    while (el && el !== document.body && el !== document.documentElement) {
      const st = getComputedStyle(el);
      if (/(auto|scroll)/.test(st.overflowY || '') && el.scrollHeight > el.clientHeight + 20) return el;
      el = el.parentElement;
    }

    let best = null, bestDiff = 0;
    for (const d of document.querySelectorAll('div, main, section')) {
      if (!d.offsetParent && d !== document.body) continue;
      const st = getComputedStyle(d);
      if (!/(auto|scroll)/.test(st.overflowY || '')) continue;
      const diff = d.scrollHeight - d.clientHeight;
      if (diff > bestDiff) { bestDiff = diff; best = d; }
    }
    if (best && bestDiff > 40) return best;

    return document.scrollingElement || document.documentElement;
  }

  function lastArticle() {
    const arts = Array.from(document.querySelectorAll(SEL.tweet))
      .filter(a => a.getBoundingClientRect().height > 0);
    return arts.length ? arts[arts.length - 1] : null;
  }

  async function scrollMore() {
    const artsBefore = document.querySelectorAll(SEL.tweet).length;

    /* 弹窗开着的时候页面是模态的，滚不动，而且滚动会让弹窗跟着乱跑。
       先关掉，滚完再用。 */
    const dlg = Array.from(document.querySelectorAll(SEL.dialog)).filter(visible)[0];
    if (dlg) {
      await closeModal();
      await srand(320, 520);
    }

    const sc = findScroller();
    const isDoc = sc === document.scrollingElement || sc === document.documentElement;
    const scName = isDoc ? '整页' : (sc.getAttribute('data-testid') || String(sc.className || '').split(' ')[0] || '评论容器');
    const readTop = () => (isDoc ? window.scrollY : sc.scrollTop);
    const beforeTop = readTop();
    const beforeH = sc.scrollHeight;
    const viewH = isDoc ? window.innerHeight : (sc.clientHeight || window.innerHeight);
    const step = Math.round(viewH * 0.8);

    /* 用真实滚轮推进。最多试三次，步长 1 / 0.6 / 1.4 倍 ——
       X 的虚拟列表偶尔会吞掉第一次滚动。 */
    let cdpOk = false;
    let tries = 0;
    for (let i = 0; i < 3; i++) {
      const dy = Math.round(step * (i === 0 ? 1 : i === 1 ? 0.6 : 1.4));
      const ok = await cdpWheel(dy);
      tries = i + 1;
      if (ok) cdpOk = true;
      await srand(420, 680);

      const movedNow = Math.abs(readTop() - beforeTop) > 30;
      const grewNow = sc.scrollHeight > beforeH + 40;
      if (movedNow || grewNow) break;
      if (!ok) break;   // CDP 通道不通，别在这儿空转三次
    }

    /* CDP 不通时的退路：直接改滚动位置。
       注意这条路对 X 常常无效（下一帧就被拉回去），只当作兜底。 */
    if (Math.abs(readTop() - beforeTop) < 10) {
      const last = lastArticle();
      if (last) {
        try { last.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (_) {}
      }
      try {
        if (isDoc) window.scrollTo(0, beforeTop + step);
        else sc.scrollTop = beforeTop + step;
      } catch (_) {}
      await srand(200, 340);
    }

    await srand(1100, 1700);

    const afterTop = readTop();
    const afterH = sc.scrollHeight;
    const artsAfter = document.querySelectorAll(SEL.tweet).length;
    const newArts = artsAfter - artsBefore;
    const moved = Math.abs(afterTop - beforeTop) > 30;
    const grew = afterH > beforeH + 40;
    const bounced = afterTop < beforeTop - 20;

    if (newArts > 0) log(`  ⤓ 下滑 · 多出 ${newArts} 条评论`);
    else if (grew) log(`  ⤓ 下滑 · ${scName} 变长 ${afterH - beforeH}px，还在加载`);
    else if (bounced) log(`  ⤓ ${scName} 把滚动弹回去了（${Math.round(beforeTop)}→${Math.round(afterTop)}）`);
    else if (moved) log(`  ⤓ 下滑 · ${scName} 到 ${Math.round(afterTop)}px，还没出新评论`);
    else if (!cdpOk) log(`  ⤓ 滑不动 · 滚轮通道没通（试了 ${tries} 次），检查浏览器顶部的调试黄条有没有被点掉`);
    else log(`  ⤓ 滑不动 · ${scName}（可滚高度 ${afterH}，可视 ${sc.clientHeight}）`);

    return newArts > 0 || grew || moved;
  }

  async function runLoop() {
    if (S.looping) return;
    if (!checkCtx()) return;
    S.looping = true;
    S.running = true;
    S.stopFlag = false;
    updatePanel();

    if (!S.cfg.apiKey) {
      log('⚠ 未配置 API Key，请点扩展图标填写');
      S.running = false; S.looping = false; updatePanel();
      return;
    }

    /* 跟随模式可能正在写这一条（你刚点开回复框，插件已经在代写了）。
       不等它写完就开跑，两个流程会抢同一个输入框 —— 正文直接翻倍。
       但也别死等：跟随模式卡在发送确认上最长能挂 20 秒，
       批量这边会一直显示「处理中…」，看着像死机。 */
    if (followBusy || writing) {
      log('跟随模式正在写这条，先等它一下');
      for (let i = 0; i < 16 && (followBusy || writing); i++) await sleep(250);
      if (followBusy || writing) {
        log('… 跟随模式还没写完，先不抢这个输入框。等你这条发出去再点「回下一条」');
        S.running = false;
        S.looping = false;
        updatePanel();
        return;
      }
    }

    /* 你可能正开着回复框在写东西。这时候开跑会把你的框抢走 ——
       正文被覆盖，或者干脆把框关掉，看起来就是「界面自己跳走了」。
       所以：框里有字就完全不碰，等你自己发出去或关掉。 */
    const openDlg = Array.from(document.querySelectorAll(SEL.dialog)).filter(visible)[0];
    if (openDlg) {
      const ed0 = realEditor(openDlg.querySelector(SEL.editor));
      const hadText = ed0 ? editorText(ed0).length > 0 : false;
      if (hadText) {
        log('… 你的回复框里已经有字，先不抢。发出去或关掉之后再点「回下一条」');
        S.running = false;
        S.looping = false;
        updatePanel();
        return;
      }
      await closeModal();
      await srand(300, 520);
    }

    let ver = '?';
    try { ver = chrome.runtime.getManifest().version; } catch (_) {}
    log(`开始运行 · v${ver} · 账号 @${findMe() || '未识别'} · 模型 ${S.cfg.model}`);
    S.consecutiveFail = 0;

    const limit = S.cfg.maxPerRun || 8;
    const loop = S.cfg.loopMode === true;
    log(loop
      ? `循环模式：一条接一条，本次最多 ${limit} 条`
      : `单步模式：这次只处理一条（想连续跑，去设置里勾「循环模式」）`);

    try {
      let idleRounds = 0;
      let runCount = 0;   // 本次点按钮处理了几条
      while (S.running) {
        if (S.cfg.autoFollow === true) await drainFollowQueue();
        if (hourlyCount() >= (S.cfg.maxPerHour || 12)) {
          log(`达到每小时上限 ${S.cfg.maxPerHour || 12} 条，停止（等一小时或去设置里调高）`);
          break;
        }
        if (runCount >= limit) { log(`本轮已处理 ${runCount} 条，达到本次上限，停止`); break; }
        if (S.consecutiveFail >= 4) {
          log('⛔ 连续 4 条失败，自动停下（多半是被风控或者页面结构变了，先刷新页面试试）');
          break;
        }

        if (expandHidden()) { await srand(700, 1200); }

        const task = pickNext();
        if (!task) {
          if (S.cfg.autoScroll && idleRounds < 12) {
            const progressed = await scrollMore();
            idleRounds++;
            // 单次滑不动不等于到底 —— X 偶尔会吞掉一次滚动，多试几次再说
            if (!progressed) {
              /* 分清两种「滑不动」：
                 1. 已经贴到底了 —— 那就是真的没有了，别再空转 12 次；
                 2. 还有可滚空间但这一下被吞了 —— 值得再试。 */
              const sc2 = findScroller();
              const isDoc2 = sc2 === document.scrollingElement || sc2 === document.documentElement;
              const top2 = isDoc2 ? window.scrollY : sc2.scrollTop;
              const h2 = sc2 ? sc2.scrollHeight : 0;
              const vh2 = isDoc2 ? window.innerHeight : ((sc2 && sc2.clientHeight) || window.innerHeight);
              const atBottom = top2 + vh2 >= h2 - 24;
              const canScroll = h2 > vh2 + 8;

              if (!canScroll || atBottom) {
                log('已经滚到最底部，没有更多评论了');
                break;
              }
              if (idleRounds >= 12) {
                log(`连续下滑 ${idleRounds} 次都没有把新评论拉出来 —— 这个帖子下面真的到底了`);
                break;
              }
              log(`  滑不动，再试（${idleRounds}/12）`);
              await srand(900, 1500);
              continue;
            }
            continue;
          }
          log(S.cfg.autoScroll === false
            ? '当前可见的评论都处理完了（自动下滑是关着的，打开它才能继续）'
            : `下滑 ${idleRounds} 次仍没有新评论，停下`);
          break;
        }
        idleRounds = 0;
        log(`— 本轮第 ${runCount + 1}/${limit} 条 —`);

        await handleOne(task);
        runCount++;
        updatePanel();
        if (!S.running) break;

        // 单步模式：一条做完立刻收手，绝不自己往下跑
        if (!loop) {
          log('单步完成 —— 要再回一条，再点一次「回下一条」');
          break;
        }

        if (S.cfg.autoSend && !S.cfg.dryRun) {
          const wait = Math.max(1, Math.round(rand(S.cfg.minDelay || 30, S.cfg.maxDelay || 75) * k()));
          log(`… 等待 ${wait}s（防风控）`);
          await interruptibleSleep(wait * 1000);
        } else {
          await srand(700, 1200);
        }
      }
    } catch (e) {
      log('✗ 运行异常：' + e.message);
    } finally {
      S.running = false;
      S.looping = false;
      updatePanel();
      log('已停止');
    }
  }

  function stopRun() {
    S.running = false;
    S.stopFlag = true;
    updatePanel();
  }

  /* ---------------- 悬浮面板（Shadow DOM，隔离样式） ---------------- */
  let ui = null;

  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
    .wrap {
      position: fixed; right: 18px; bottom: 18px; width: 320px; z-index: 2147483647;
      background: #0f1419; color: #e7e9ea; border: 1px solid #2f3336; border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,.55); font-size: 12px; overflow: hidden;
      transition: height .18s ease;
    }
    .hd { display:flex; align-items:center; gap:8px; padding:10px 12px; background:#15181c; cursor:pointer; user-select:none; }
    .dot { width:8px; height:8px; border-radius:50%; background:#4b5563; flex:0 0 8px; }
    .dot.on { background:#00ba7c; box-shadow:0 0 0 3px rgba(0,186,124,.18); animation: bp 1.4s infinite; }
    @keyframes bp { 50% { opacity:.45; } }
    .title { font-weight:700; font-size:12px; letter-spacing:.2px; flex:1; }
    .mini { opacity:.55; font-size:11px; }
    .bd { padding: 10px 12px 12px; display:block; }
    .wrap.collapsed .bd { display:none; }
    .row { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
    .btn {
      flex:1; border:0; border-radius:9px; padding:8px 10px; font-size:12px; font-weight:700;
      cursor:pointer; background:#1d9bf0; color:#fff;
    }
    .btn.stop { background:#f4212e; }
    .btn.ghost { background:#1f2226; color:#c9ced4; border:1px solid #2f3336; }
    .btn:active { transform: translateY(1px); }
    .stat { display:flex; gap:10px; font-size:11px; opacity:.8; margin-bottom:8px; }
    .stat b { color:#1d9bf0; font-weight:700; }
    .logs {
      max-height: 132px; overflow-y:auto; background:#0a0d10; border:1px solid #22262b;
      border-radius:9px; padding:7px 8px; font-family: ui-monospace, Consolas, monospace;
      font-size:10.5px; line-height:1.5; color:#9aa4ae; white-space:pre-wrap; word-break:break-all;
    }
    .logs::-webkit-scrollbar { width:6px; }
    .logs::-webkit-scrollbar-thumb { background:#2f3336; border-radius:3px; }
    .warn { color:#ffd400; margin-bottom:8px; font-size:11px; line-height:1.5; }
    .tag { font-size:10px; padding:1px 6px; border-radius:999px; background:#1f2226; color:#8b98a5; }
  `;

  function buildPanel() {
    const host = document.createElement('div');
    host.id = 'xar-host';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${PANEL_CSS}</style>
      <div class="wrap" id="wrap">
        <div class="hd" id="hd">
          <span class="dot" id="dot"></span>
          <span class="title">AI 评论回复 <span style="opacity:.45;font-weight:400">v1.16.0</span></span>
          <span class="tag" id="tag">待机</span>
          <span class="mini" id="fold">—</span>
        </div>
        <div class="bd">
          <div id="warn"></div>
          <div class="stat">
            <span>成功 <b id="sDone">0</b></span>
            <span>失败 <b id="sFail">0</b></span>
            <span>跳过 <b id="sSkip">0</b></span>
            <span>赞 <b id="sLike">0</b></span>
            <span>关注 <b id="sFlw">0</b></span>
          </div>
          <div class="warn" id="failWhy" style="display:none"></div>
          <div class="row">
            <button class="btn" id="btnFollow" style="flex:2">跟随模式 · 开</button>
            <button class="btn ghost" id="btnLike" style="flex:1">点赞 · 关</button>
          </div>
          <div class="row">
            <button class="btn ghost" id="btnRun">回下一条</button>
            <button class="btn ghost" id="btnStop">停止</button>
          </div>
          <div class="row">
            <button class="btn ghost" id="btnAutoFollow" style="flex:1;font-size:11px">关注 · 关</button>
            <button class="btn ghost" id="btnSpeed" style="flex:1;font-size:11px">速度 · 快速</button>
            <button class="btn ghost" id="btnCheck" style="flex:1;font-size:11px">体检</button>
          </div>
          <div class="row">
            <button class="btn ghost" id="btnDiag" style="flex:1;font-size:11px">诊断输入</button>
            <button class="btn ghost" id="btnSendTest" style="flex:1;font-size:11px">发送测试</button>
            <button class="btn ghost" id="btnCopy" style="flex:1;font-size:11px">复制日志</button>
          </div>
          <div class="logs" id="logs"></div>
        </div>
      </div>`;
    document.documentElement.appendChild(host);

    const $ = (id) => root.getElementById(id);
    $('hd').addEventListener('click', () => {
      $('wrap').classList.toggle('collapsed');
      $('fold').textContent = $('wrap').classList.contains('collapsed') ? '+' : '—';
    });
    $('btnRun').addEventListener('click', () => {
      if (S.running) return;
      runLoop();
    });
    $('btnStop').addEventListener('click', stopRun);
    $('btnCheck').addEventListener('click', selfCheck);
    $('btnDiag').addEventListener('click', diagnoseInput);
    if ($('btnSendTest')) $('btnSendTest').addEventListener('click', sendTest);
    $('btnCopy').addEventListener('click', copyLogs);
    $('btnSpeed').addEventListener('click', cycleSpeed);
    $('btnFollow').addEventListener('click', toggleFollow);
    $('btnLike').addEventListener('click', toggleLike);
    $('btnAutoFollow').addEventListener('click', toggleAutoFollow);

    ui = { root, $ };
    updatePanel();
    renderLogs();
  }

  /* 页面结构自检：发送不出去时先点这个，日志会说明卡在哪一环 */
  function selfCheck() {
    let V = '?';
    try { V = chrome.runtime.getManifest().version; } catch (_) {}
    const cfg = S.cfg;
    const isDetail = /\/status\/\d+/.test(location.pathname);

    log(`体检 · v${V} · ${isDetail ? '推文详情页' : '⚠ 不在推文详情页'}`);
    log(`  开关：跟随=${cfg.followOnReply !== false ? '开' : '关'} 自动发=${cfg.autoSend === true ? '开' : '关'} 预演=${cfg.dryRun === true ? '开' : '关'} 循环=${cfg.loopMode === true ? '开' : '关'} 点赞=${cfg.autoLike === true ? '开' : '关'}`);
    log(`  API：${cfg.apiKey ? '已填（' + String(cfg.apiKey).length + ' 位）' : '❌ 没填'} · 模型=${cfg.model || '默认'} · 视觉=${cfg.visionEnabled === true ? '开' : '关'} · 间隔=${cfg.minDelay}-${cfg.maxDelay}s`);

    const arts = Array.from(document.querySelectorAll(SEL.tweet));
    const mainId = currentStatusId();
    const me = (findMe() || '').toLowerCase();
    log(`  页面推文=${arts.length} 条 · 主推文ID=${mainId || '无'} · 已回复记录=${S.replied.size} 条 · 账号=@${me || '未识别'}`);

    /* 逐条说明为什么选不上 —— 这一步能直接看出卡在哪 */
    let usable = 0;
    const reasons = {};
    arts.forEach((el, i) => {
      let why = '';
      const id = getStatusId(el);
      const text = getText(el);
      if (getComputedStyle(el).display === 'none') why = '被折叠或还没加载';
      else if (!id) why = '拿不到 status id';
      else if (mainId && id === mainId) why = '这是主推文本身';
      else if (S.replied.has(id)) why = '已经回复过';
      else if (!text || text.length < 2) why = '正文是空的';
      else if (cfg.skipPromoted !== false && isPromoted(el)) why = '推广';
      else if (cfg.skipOwn !== false && me && (getHandle(el) || '').toLowerCase() === me) why = '自己的评论';
      else if (cfg.skipVerified && isVerified(el)) why = '认证账号（你设了跳过）';

      if (!why) {
        usable++;
        if (usable <= 3) log(`  ✅ 可回复 #${i}：@${getHandle(el) || '?'} 「${text.slice(0, 22)}…」`);
      } else {
        reasons[why] = (reasons[why] || 0) + 1;
        if (i < 6) log(`  · #${i} 跳过：${why}`);
      }
    });

    const rs = Object.entries(reasons).map(([k, v]) => `${k}×${v}`).join('，');
    log(`  👉 可回复 ${usable} 条 / 总共 ${arts.length} 条${rs ? '（' + rs + '）' : ''}`);

    if (!usable) {
      if (!arts.length) log('  ⚠ 一条都没抓到：确认已打开某条推文的详情页，且页面加载完成');
      else if (!isDetail) log('  ⚠ 请在推文详情页里运行（地址栏要有 /status/数字），首页时间线不行');
      else log('  ⚠ 有推文但都不可回复，看上面对应的跳过原因');
    }

    const dlgs = Array.from(document.querySelectorAll(SEL.dialog)).filter(visible);
    const eds = Array.from(new Set(Array.from(document.querySelectorAll(SEL.editor)).map(realEditor)));
    const btns = Array.from(document.querySelectorAll(SEL.sendBtn));
    log(`  当前弹窗=${dlgs.length} 编辑器=${eds.length} 发送按钮=${btns.length}`);

    eds.slice(0, 2).forEach((e, i) => {
      log(`  编辑器#${i}：可见=${visible(e)} 内容=${editorText(e).length}字`);
    });
    btns.slice(0, 3).forEach((b, i) => {
      log(`  按钮#${i}：aria-disabled=${b.getAttribute('aria-disabled')} 文字「${(b.innerText || '').trim()}」`);
    });
    if (!btns.length) log('  ⚠ 找不到发送按钮，X 可能改了结构');

    if (cfg.enabled === true) log('  ⚠ 配置里 enabled 还是开着，这只影响 popup 的提示，不影响面板按钮');
    log('  体检完成 —— 把这几行整段发我就能定位');
  }

  /* 输入通道诊断：自动打开第一条的回复框，五种注入方式逐个实测，
     每种都报告「DOM 里几个字」和「发送按钮有没有变黑」。 */
  /* 一键把日志复制到剪贴板，方便发给别人看 */
  /* 把编辑器的真实结构打出来。
     注入失败时自动跑一次 —— 这样「复制日志」里就带着判断依据，
     不用再让人一层层点诊断。 */
  function dumpEditor(editor, tag = '诊断') {
    try {
      if (!editor) { log(`  [${tag}] 没有编辑器可看`); return; }
      const ce = editor.getAttribute('contenteditable');
      const lexical = !!editor.closest('[data-lexical-editor]') || /lexical/i.test(editor.className || '');
      log(`  [${tag}] 编辑器 <${editor.tagName.toLowerCase()}> contenteditable=${ce} lexical=${lexical} 字数=${editorText(editor).length}`);
      const kids = Array.from(editor.children).slice(0, 5).map(c => c.tagName.toLowerCase() + (c.getAttribute('data-testid') ? '[' + c.getAttribute('data-testid') + ']' : ''));
      log(`  [${tag}] 子节点 ${editor.children.length} 个：${kids.join(' ') || '（无）'}`);
      const html = String(editor.innerHTML || '').replace(/\s+/g, ' ').slice(0, 110);
      log(`  [${tag}] HTML：${html}`);
      const btns = Array.from(document.querySelectorAll(SEL.sendBtn)).map(b => `${(b.textContent || '').trim()}:${b.getAttribute('aria-disabled')}`);
      log(`  [${tag}] 发送按钮 ${btns.length} 个：${btns.join(' ') || '（一个都没找到）'}`);
      const dlgs = document.querySelectorAll(SEL.dialog).length;
      log(`  [${tag}] 弹窗 ${dlgs} 个，焦点在 ${document.activeElement ? document.activeElement.tagName.toLowerCase() : '无'}`);
    } catch (e) {
      log(`  [${tag}] 打印结构出错：${e.message}`);
    }
  }

  /* 「发送测试」：框里已经有字的情况下，把三条发送路全试一遍。
     用来把问题一刀切开 ——
       能发出去 → 文字注入没问题，卡在注入；
       发不出去 → 跟注入无关，是账号侧限制（对方不让回、被限流）。
     用法：自己手打几个字，点这个按钮。 */
  async function sendTest() {
    const dlg = Array.from(document.querySelectorAll(SEL.dialog)).filter(visible)[0];
    if (!dlg) {
      log('发送测试：先点开一条推文的回复框，再点这个按钮');
      return;
    }
    const editor = realEditor(dlg.querySelector(SEL.editor)) || dlg.querySelector(SEL.editor);
    if (!editor) { log('发送测试：弹窗里找不到输入框'); return; }

    const n = editorText(editor).length;
    const st = sendButtonState();
    const btnOk = !!st.btn && !st.disabled;
    log(`— 发送测试 · 框里 ${n} 字｜按钮${st.btn ? (btnOk ? '可用' : '灰的') : '找不到'}（文字「${st.label}」）—`);
    dumpEditor(editor, '发送测试');

    if (!n) {
      log('发送测试：框里是空的。先自己手打几个字，再点这个按钮 —— 这样才能单独验证「发送」这一环');
      return;
    }

    const steps = [];
    let how = '';

    await ensureFocus(editor);
    if (btnOk) {
      const okBtn = await clickSend(12000);
      if (okBtn) how = await confirmSent(editor, 12000);
      steps.push(`点按钮 ${okBtn ? (how ? '✓' : '点了没反应') : '×'}`);
    } else {
      steps.push('点按钮 跳过（按钮是灰的）');
    }

    if (!how) {
      log('  改试真实回车键');
      how = await finishByEnter(editor);
      steps.push(`回车 ${how ? '✓' : '×'}`);
    }
    if (!how) {
      log('  改试摘掉禁用标记强点');
      how = await forceClickSend(editor);
      steps.push(`强点 ${how ? '✓' : '×'}`);
    }

    log(`  结果：${steps.join(' / ')}`);
    if (how) {
      log(`✅ 发送测试通过（走的${how}）—— 说明页面能发，问题在「把文字写进去」这一环`);
      S.stats.done++;
      updatePanel();
    } else {
      log('✗ 三种方式都发不出去 —— 跟注入无关，是账号或对方设置的限制');
      log('  → 手动点一下这个「回复」按钮试试，手动也发不出就是账号侧问题');
      S.stats.fail++;
      S.failReasons['发送测试失败'] = (S.failReasons['发送测试失败'] || 0) + 1;
      updatePanel();
    }
  }

  async function copyLogs() {
    const text = S.logs.slice(-60).join('\n');
    if (!text) { log('日志是空的'); return; }
    try {
      await navigator.clipboard.writeText(text);
      log('📋 日志已复制到剪贴板（60 行），直接粘贴发出去就行');
    } catch (_) {
      // 剪贴板被拒（页面没焦点）→ 退回到 textarea + execCommand
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        log('📋 日志已复制到剪贴板（60 行），直接粘贴发出去就行');
      } catch (e) {
        log('✗ 复制失败：' + e.message + '（手动截图也行）');
      }
    }
  }

  async function diagnoseInput() {
    if (S.running) { log('先点停止，再诊断'); return; }

    const arts = Array.from(document.querySelectorAll(SEL.tweet))
      .filter(el => getComputedStyle(el).display !== 'none');
    if (!arts.length) { log('✗ 页面上没抓到任何推文'); return; }

    const target = arts.find(a => a.querySelector(SEL.replyBtn));
    if (!target) { log('✗ 找不到回复按钮'); return; }

    log('—— 输入通道诊断开始 ——');
    target.querySelector(SEL.replyBtn).click();

    const editor = await waitForEditor(15000);
    if (!editor) { log('✗ 回复框 15 秒内没出现'); return; }
    log(`回复框就绪，testid=${editor.getAttribute('data-testid') || '无'}`);
    const ph = editor.querySelector('[aria-hidden="true"], [data-placeholder], .public-DraftEditorPlaceholder-root');
    log(`空态占位符：${ph ? '存在（"发布你的回复"就是它）' : '无'}`);

    const s0 = sendButtonState();
    log(`初始按钮：aria-disabled=${s0.btn ? s0.btn.getAttribute('aria-disabled') : '无按钮'} 文字「${s0.label}」`);

    // 编辑器是什么实现：X 换过一次（DraftJS → Lexical），结构变了注入方式也得变
    try {
      const isLexical = !!editor.closest('[data-lexical-editor]') ||
                        !!document.querySelector('[data-lexical-editor]') ||
                        /lexical/i.test(editor.className || '');
      const kids = Array.from(editor.children)
        .map(e => e.tagName.toLowerCase() + (e.getAttribute('data-testid') ? `[${e.getAttribute('data-testid')}]` : ''))
        .join(' / ');
      log(`编辑器实现：${isLexical ? 'Lexical' : '未知/DraftJS'}｜contenteditable=${editor.getAttribute('contenteditable')}`);
      log(`  子节点：${kids.slice(0, 150) || '（空）'}`);
      log(`  框内可见字数：${editorText(editor).length}`);
    } catch (_) {}

    const probe = '测试probeABC123';
    const ways = [
      ['① 全选覆盖 insertText', async () => {
        await primeEditor(editor); await clearEditor(editor);
        editor.focus();
        const r = document.createRange();
        r.selectNodeContents(editor);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(r);
        document.execCommand('insertText', false, probe);
        await sleep(300);
      }],
      ['② 逐字符 insertText', async () => {
        await primeEditor(editor); await clearEditor(editor); placeCaretAtEnd(editor);
        for (const ch of probe) { try { document.execCommand('insertText', false, ch); } catch (_) {} await sleep(25); }
      }],
      ['③ CDP Input.insertText', async () => {
        await primeEditor(editor); await clearEditor(editor); placeCaretAtEnd(editor);
        const r = await chrome.runtime.sendMessage({ type: 'XAR_INSERT', text: probe });
        log(`    CDP 返回：${JSON.stringify(r)}`);
        await sleep(420);
      }],
      ['④ 粘贴事件', async () => {
        await primeEditor(editor); await clearEditor(editor); placeCaretAtEnd(editor);
        await insertViaPaste(editor, probe);
      }],
      ['⑤ 分块 insertText', async () => {
        await primeEditor(editor); await clearEditor(editor); placeCaretAtEnd(editor);
        await insertViaTyping(editor, probe);
      }],
      ['⑥ 直改 DOM', async () => {
        await primeEditor(editor); await clearEditor(editor); placeCaretAtEnd(editor);
        editor.textContent = probe;
        editor.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: probe, bubbles: true }));
        await sleep(320);
      }]
    ];

    for (const [name, fn] of ways) {
      try { await fn(); } catch (e) { log(`  ${name}：抛异常 ${e.message}`); continue; }
      await sleep(420);
      const dom = editorText(editor);
      const st = sendButtonState();
      const dis = st.btn ? st.btn.getAttribute('aria-disabled') : '无按钮';
      const mark = (dis === 'false') ? '✅ 生效' : (dom.length ? '⚠ 有字但按钮仍灰' : '✗ 完全没进去');
      log(`  ${name}：DOM ${dom.length} 字｜aria-disabled=${dis}｜${mark}`);
    }

    await clearEditor(editor);
    await closeModal();
    log('—— 诊断结束，点「复制日志」发我 ——');
  }

  function renderLogs() {
    if (!ui) return;
    const box = ui.$('logs');
    if (!box) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    box.textContent = S.logs.slice(-40).join('\n');
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  /* 面板上点一下循环切档，即时生效，不用重载扩展 */
  async function cycleSpeed() {
    const cur = S.cfg.speed || 'fast';
    const idx = SPEED_ORDER.indexOf(cur);
    const next = SPEED_ORDER[(idx + 1) % SPEED_ORDER.length];
    const cfg = Object.assign({}, S.cfg, { speed: next });
    S.cfg = cfg;
    try {
      const r = await chrome.storage.local.get('cfg');
      await chrome.storage.local.set({ cfg: Object.assign({}, r.cfg || {}, { speed: next }) });
    } catch (_) {}
    log(`速度切到「${SPEED_LABEL[next]}」—— 交互延时 ×${SPEED_MAP[next]}，回复间隔也跟着缩放`);
    updatePanel();
  }

  /* 跟随模式开关：开了以后点开任意回复框就自动代写 */
  async function toggleFollow() {
    const next = !(S.cfg.followOnReply !== false);
    S.cfg = Object.assign({}, S.cfg, { followOnReply: next });
    if (!next) followCtx = null;
    try {
      const r = await chrome.storage.local.get('cfg');
      await chrome.storage.local.set({ cfg: Object.assign({}, r.cfg || {}, { followOnReply: next }) });
    } catch (_) {}
    log(next ? '跟随模式已开：点开任意一条的「回复」，我自动代写' : '跟随模式已关：只能点「开始」批量跑');
    updatePanel();
  }

  /* 点赞开关：回复时顺手把这条评论点个赞 */
  async function toggleLike() {
    const next = S.cfg.autoLike !== true;
    S.cfg = Object.assign({}, S.cfg, { autoLike: next });
    try {
      const r = await chrome.storage.local.get('cfg');
      await chrome.storage.local.set({ cfg: Object.assign({}, r.cfg || {}, { autoLike: next }) });
    } catch (_) {}
    log(next
      ? '点赞已开：每条回复完顺手点一个赞' + (S.cfg.likeMain === true ? '（主推文也赞）' : '')
      : '点赞已关');
    updatePanel();
  }

  /* 关注开关：评论完顺手关注对方 */
  async function toggleAutoFollow() {
    const next = S.cfg.autoFollow !== true;
    S.cfg = Object.assign({}, S.cfg, { autoFollow: next });
    try {
      const r = await chrome.storage.local.get('cfg');
      await chrome.storage.local.set({ cfg: Object.assign({}, r.cfg || {}, { autoFollow: next }) });
    } catch (_) {}
    log(next
      ? `关注已开：每条评论完自动关注对方（已关注的跳过，本次最多 ${S.cfg.maxFollows || 50} 个）`
      : '关注已关');
    updatePanel();
  }

  function updatePanel() {
    if (!ui) return;
    const { $ } = ui;
    if (ctxDead) {
      try {
        $('tag').textContent = '需刷新';
        $('tag').style.color = '#f4212e';
        $('warn').innerHTML = '<div style="color:#f4212e;margin-bottom:6px">扩展已更新，本页需要刷新（Ctrl+R）</div>';
      } catch (_) {}
      return;
    }
    const dot = $('dot'), tag = $('tag'), btn = $('btnRun'), warn = $('warn');    if (S.running) {
      dot.classList.add('on');
      tag.textContent = '运行中';
      btn.textContent = '处理中…';
      btn.style.opacity = '.55';
      btn.style.pointerEvents = 'none';
    } else {
      dot.classList.remove('on');
      tag.textContent = S.looping ? '收尾' : '待机';
      btn.textContent = S.cfg.loopMode === true ? '开始连续' : '回下一条';
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
    }
    $('sDone').textContent = S.stats.done;
    $('sFail').textContent = S.stats.fail;
    $('sSkip').textContent = S.stats.skip;
    if ($('sLike')) $('sLike').textContent = S.stats.liked || 0;
    if ($('sFlw')) $('sFlw').textContent = S.stats.follows || 0;

    /* 失败原因直接摊在面板上。
       「失败 6 条」本身没信息量，得让人一眼看出是卡在哪一步。 */
    const fw = $('failWhy');
    if (fw) {
      const why = Object.entries(S.failReasons || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([r, n]) => `${r}×${n}`)
        .join('、');
      if (why) {
        fw.style.display = 'block';
        fw.textContent = `失败 ${S.stats.fail} 条：${why}`;
      } else {
        fw.style.display = 'none';
      }
    }

    const fo = $('btnAutoFollow');
    if (fo) {
      const on = S.cfg.autoFollow === true;
      const cooling = S.followPausedUntil && Date.now() < S.followPausedUntil;
      fo.textContent = !on ? '关注 · 关'
        : (cooling ? '关注 · 冷却中' : '关注 · 开');
      fo.style.opacity = on ? '1' : '.6';
      fo.style.color = (on && cooling) ? '#f7b928' : '';
    }

    const lk = $('btnLike');
    if (lk) {
      const on = S.cfg.autoLike === true;
      lk.textContent = on ? '点赞 · 开' : '点赞 · 关';
      lk.style.opacity = on ? '1' : '.6';
    }

    const sp = $('btnSpeed');
    if (sp) {
      const cur = S.cfg.speed || 'fast';
      const d = Math.round(k() * 100);
      sp.textContent = `速度 · ${SPEED_LABEL[cur] || '快速'} ${d}%`;
    }

    const fb = $('btnFollow');
    if (fb) {
      const on = S.cfg.followOnReply !== false;
      const auto = S.cfg.followAutoSend === true;
      fb.textContent = !on
        ? '跟随模式 · 关'
        : (auto ? '跟随模式 · 开（自动发）' : '跟随模式 · 开（只填不发）');
      fb.style.opacity = on ? '1' : '.6';
    }

    const msgs = [];
    if (!S.cfg.apiKey) msgs.push('未配置 API Key');
    if (S.cfg.dryRun) msgs.push('预演模式（不发送）');
    else if (!S.cfg.autoSend) msgs.push('人工确认模式');
    warn.innerHTML = msgs.length
      ? `<div class="warn">⚠ ${msgs.join(' · ')}</div>`
      : '';
  }

  /* 扩展重载后，旧页面里的 content script 会被「孤立」：
     面板还在、按钮还能点，但所有 chrome.* 调用静默失效。
     这是「明明装好了却点不动」最常见的原因，所以单独盯一下。 */
  function ctxAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  let ctxDead = false;
  function checkCtx() {
    if (ctxDead) return false;
    if (ctxAlive()) return true;
    ctxDead = true;
    S.running = false;
    S.looping = false;
    log('⚠ 扩展已被重载，本页的内容脚本失效了 —— 按 Ctrl+R 刷新这个页面就好');
    if (ui) {
      try {
        ui.$('tag').textContent = '需刷新';
        ui.$('tag').style.color = '#f4212e';
        ui.$('warn').innerHTML = '<div style="color:#f4212e;margin-bottom:6px">扩展已更新，本页需要刷新（Ctrl+R）</div>';
      } catch (_) {}
    }
    return false;
  }

  /* ---------------- 启动 ---------------- */
  async function boot() {
    await loadCfg();
    findMe();
    buildPanel();
    bindFollow();
    log(S.cfg.followOnReply
      ? '插件已就绪 · 跟随模式：你点开任意一条的「回复」，我自动代写'
      : '插件已就绪，打开任意推文评论区后点「开始」');

    // 页面切换（SPA）时刷新账号识别
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        S.me = '';
        findMe();
      }
      checkCtx();
    }, 2000);
  }

  // 对外命令（popup 也可通过 storage 触发）
  window.__XAR__ = {
    start: () => { if (!S.running) runLoop(); },
    stop: () => stopRun(),
    state: () => ({ running: S.running, stats: S.stats, cfg: S.cfg, logs: S.logs.slice(-40) }),
    // 手动滚一次：返回 true 表示「有进展」（多出评论 / 变长 / 位置动了）
    scroll: () => scrollMore(),
    // 直接发一个 CDP 滚轮，测通道用
    wheel: (dy) => cdpWheel(dy),
    // 手动点赞：传 article 元素，返回 'ok' | 'already' | 'gone' | 'fail'
    like: (el) => likeArticle(el || mainTweetElement()),
    // 手动关注：返回 'ok' | 'already' | 'gone' | 'nocard' | 'nobtn' | 'limit'
    follow: async (el) => {
      const target = el || document.querySelectorAll(SEL.tweet)[1];
      const out = await followUser(target);
      if (out.r === 'ok' || out.r === 'maybe') {
        const h = getHandle(target);
        if (h) { S.followed.add(h); await persistFollowed(); }
        S.stats.follows = (S.stats.follows || 0) + 1;
        updatePanel();
        return 'ok';
      }
      return out.r;
    },
    // 调试用：直接往当前编辑器里填一段文字，返回最终读到的文本
    typeInto: (text, editor) => typeInto(realEditor(editor) || realEditor(document.querySelector(SEL.editor)), text),
    editorText: (editor) => editorText(realEditor(editor) || realEditor(document.querySelector(SEL.editor)))
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
