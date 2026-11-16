/**
 * 单元测试：buildMessages 的多模态拼装与降级。
 * 在 vm 里加载真实的 defaults.js + background.js，用假的 chrome API 撑住。
 *
 * 用法: node test/unit-vision.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';

const sandbox = {
  console,
  self: null,
  importScripts: () => {},
  chrome: {
    runtime: {
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} }
    },
    storage: { local: { get: async () => ({}), set: async () => {} } }
  },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  AbortController,
  setTimeout,
  clearTimeout
};
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('defaults.js', 'utf8'), sandbox);
vm.runInContext(fs.readFileSync('background.js', 'utf8'), sandbox);

const { buildMessages, stripImages, hasImages, pickModel } = sandbox;
const D = sandbox.XAR_DEFAULTS;

if (typeof buildMessages !== 'function') {
  console.error('✗ 没拿到 buildMessages');
  process.exit(1);
}

const base = {
  mainTweet: '今天把机械键盘换成了静音红轴。',
  comment: '静音的真的没手感，我试过。',
  handle: 'alice_cn',
  recent: []
};
const imgs = [
  'https://pbs.twimg.com/media/AAA?format=jpg&name=large',
  'https://pbs.twimg.com/media/BBB?format=png&name=large'
];

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ⚠ ${name}${extra ? ' — ' + extra : ''}`); }
};

/* 1. 关掉视觉 → 纯文本 */
{
  const cfg = Object.assign({}, D, { visionEnabled: false });
  const m = buildMessages(cfg, Object.assign({}, base, { images: imgs }));
  console.log('\n[1] visionEnabled = false');
  check('user content 是纯字符串', typeof m[1].content === 'string');
  check('没有 image_url', !hasImages(m));
  check('仍然带上了评论正文', m[1].content.includes('静音的真的没手感'));
}

/* 2. 打开视觉 + 有图 → 多模态 */
{
  const cfg = Object.assign({}, D, { visionEnabled: true });
  const m = buildMessages(cfg, Object.assign({}, base, { images: imgs }));
  console.log('\n[2] visionEnabled = true，带 2 张图');
  check('content 是数组', Array.isArray(m[1].content));
  const urlParts = m[1].content.filter(c => c.type === 'image_url');
  check('有 2 个 image_url 段', urlParts.length === 2, `实际 ${urlParts.length}`);
  check('第一张图 URL 正确', urlParts[0].image_url.url === imgs[0]);
  const textPart = m[1].content.find(c => c.type === 'text');
  check('文本段提示了图片数量', textPart && /附了 2 张图/.test(textPart.text));
}

/* 3. 视觉开着但没有图 → 退回纯文本 */
{
  const cfg = Object.assign({}, D, { visionEnabled: true });
  const m = buildMessages(cfg, Object.assign({}, base, { images: [] }));
  console.log('\n[3] visionEnabled = true，但没有图');
  check('content 是纯字符串', typeof m[1].content === 'string');
}

/* 4. 超过 4 张 → 截断 */
{
  const cfg = Object.assign({}, D, { visionEnabled: true });
  const many = Array.from({ length: 9 }, (_, i) => `https://pbs.twimg.com/media/X${i}?name=large`);
  const m = buildMessages(cfg, Object.assign({}, base, { images: many }));
  console.log('\n[4] 给了 9 张图');
  const n = m[1].content.filter(c => c.type === 'image_url').length;
  check('截断到 4 张', n === 4, `实际 ${n}`);
}

/* 5. 非法 URL 被过滤 */
{
  const cfg = Object.assign({}, D, { visionEnabled: true });
  const m = buildMessages(cfg, Object.assign({}, base, { images: ['', 'javascript:alert(1)', imgs[0]] }));
  console.log('\n[5] 混入非法 URL');
  const n = m[1].content.filter(c => c.type === 'image_url').length;
  check('只保留合法 http(s) URL', n === 1, `实际 ${n}`);
}

/* 6. stripImages 降级 */
{
  const cfg = Object.assign({}, D, { visionEnabled: true });
  const m = buildMessages(cfg, Object.assign({}, base, { images: imgs }));
  const stripped = stripImages(m);
  console.log('\n[6] stripImages 降级');
  check('降级后没有 image_url', !hasImages(stripped));
  check('降级后正文还在', stripped[1].content.includes('静音的真的没手感'));
  check('降级后仍提示图片（文字形式）', /附了 2 张图/.test(stripped[1].content));
}

/* 7. 上下文去重仍然生效 */
{
  const cfg = Object.assign({}, D, { visionEnabled: true });
  const same = '这是一段完全相同的文字内容';
  const m = buildMessages(cfg, {
    mainTweet: same, comment: same, handle: 'x', recent: [], images: []
  });
  console.log('\n[7] 原推文与评论相同');
  check('没有重复塞入主贴', !m[1].content.includes('背景资料'));
}

/* 8. 带图时自动切视觉模型 */
{
  console.log('\n[8] 模型自动切换');
  check('pickModel 是函数', typeof pickModel === 'function');
  if (typeof pickModel === 'function') {
    const cfg = Object.assign({}, D, { model: 'deepseek-chat', visionModel: 'deepseek-flash', visionEnabled: true });
    const withImg = buildMessages(cfg, Object.assign({}, base, { images: imgs }));
    const noImg = buildMessages(cfg, Object.assign({}, base, { images: [] }));
    check('带图 → deepseek-flash', pickModel(withImg, cfg) === 'deepseek-flash', pickModel(withImg, cfg));
    check('无图 → deepseek-chat', pickModel(noImg, cfg) === 'deepseek-chat', pickModel(noImg, cfg));

    const cfg2 = Object.assign({}, cfg, { visionModel: '' });
    check('visionModel 留空 → 仍用主模型', pickModel(withImg, cfg2) === 'deepseek-chat', pickModel(withImg, cfg2));

    check('默认视觉模型是 deepseek-flash', D.visionModel === 'deepseek-flash', D.visionModel);
  }
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '⚠ 有失败项'} — 通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
