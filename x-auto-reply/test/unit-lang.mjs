/* 质检三件套的边界单测：语言跑偏 / 自我重复 / 话说半截。
 * 直接从 content.js 里抠出这几个纯函数来跑，避免为测试改动源码结构。
 *   用法：node test/unit-lang.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync('content.js', 'utf8');

function grab(name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('找不到 ' + name);
  // 从函数名开始数花括号，配平为止
  const start = src.indexOf('{', src.indexOf(')', i));
  let depth = 0, j = start;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(i, j);
}

const m = src.match(/const normText = [\s\S]*?;\n/);
if (!m) throw new Error('找不到 normText');
const normTextSrc = m[0];
const code = [
  normTextSrc,
  grab('cjkRatio'),
  grab('langMismatch'),
  grab('repeatedChunk'),
  grab('looksTruncated'),
  'module.exports = { cjkRatio, langMismatch, repeatedChunk, looksTruncated };'
].join('\n');

const sandbox = { module: { exports: {} }, console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const { cjkRatio, langMismatch, repeatedChunk, looksTruncated } = sandbox.module.exports;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

console.log('[语言跑偏]');
ok(cjkRatio('同事谢谢你。真的。') > 0.7, '全中文占比很高（标点不算汉字）');
ok(cjkRatio('Appreciate the honest take.') === 0, '全英文占比为 0');
ok(langMismatch('Appreciate the take.', '静音红轴打字声音是小了') === '中文评论配了英文回复', '中文评论回英文 → 判定跑偏');
ok(langMismatch('这个点很实在', 'Honestly I switched to silent switches') === '英文评论配了中文回复', '英文评论回中文 → 判定跑偏');
ok(langMismatch('段落感确实是个取舍', '静音红轴打字声音是小了') === '', '中文配中文 → 不报');
ok(langMismatch('Appreciate the take', 'Honestly I switched too') === '', '英文配英文 → 不报');
ok(langMismatch('段落感确实是个取舍，I agree', '静音红轴打字声音是小了') === '', '中英混写但有中文 → 不报（不能太激进）');
ok(langMismatch('OK', '静音红轴打字声音是小了') === '中文评论配了英文回复', '极短英文回复也算跑偏');

console.log('[自我重复]');
ok(repeatedChunk('下雨下天下雨下留下雨下天下雨下客下') !== '', '「下雨下天…」碎片被抓住');
ok(repeatedChunk('这个点很实在，不过我打字轻，软一点反而没那么累。') === '', '正常句子不报重复');
ok(repeatedChunk('好的好的好的好的好的好的') !== '', '叠词三次以上被抓住');
ok(repeatedChunk('哈哈哈哈') === '', '短于 12 字不做判断');
ok(repeatedChunk('段落感确实是个取舍，段落感确实是个取舍，段落感确实是个取舍') !== '', '整句重复三次被抓住');

console.log('[话说半截]');
ok(looksTruncated('这个点很实在，不过') === true, '结尾停在连接词 → 判半截');
ok(looksTruncated('我大概两小时就开始有感觉了') === false, '正常结尾 → 不报');
ok(looksTruncated('他说「静音红轴') === true, '引号没闭合 → 判半截');
ok(looksTruncated('这个点很实在。') === false, '句号结尾 → 不报');
ok(looksTruncated('因为') === true, '只有连接词 → 判半截');

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
