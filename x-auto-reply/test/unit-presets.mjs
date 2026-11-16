/**
 * 单元测试：风格预设的结构与可用性。
 * 用法: node test/unit-presets.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';

const sb = { console };
sb.self = sb;
vm.createContext(sb);
vm.runInContext(fs.readFileSync('presets.js', 'utf8'), sb);

const P = sb.XAR_PRESETS;
let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ⚠ ${name}${extra ? ' — ' + extra : ''}`); }
};

check('预设对象存在', !!P && typeof P === 'object');
check('包含交友预设 friend', !!P.friend);
check('包含出摊预设 stall', !!P.stall);
check('包含嘴臭预设 snark', !!P.snark);
check('包含默认预设 warm', !!P.warm);

for (const key of Object.keys(P)) {
  const p = P[key];
  console.log(`\n[${key}] ${p.name}`);
  check('有 name', typeof p.name === 'string' && p.name.length > 0);
  check('有 persona', typeof p.persona === 'string' && p.persona.length > 10, p.persona && p.persona.length);
  check('有 rules', typeof p.rules === 'string' && p.rules.split('\n').length >= 3, p.rules && p.rules.split('\n').length + ' 条');
  check('maxLen 是数字且合理', typeof p.maxLen === 'number' && p.maxLen >= 20 && p.maxLen <= 280, p.maxLen);
  check('temperature 在 0-2', typeof p.temperature === 'number' && p.temperature >= 0 && p.temperature <= 2, p.temperature);
  check('maxTokens 是数字', typeof p.maxTokens === 'number' && p.maxTokens >= 50, p.maxTokens);
  check('samples 是数组', Array.isArray(p.samples));
  const overs = (p.samples || []).filter(s => s.length > p.maxLen);
  check('样例都没超过 maxLen', overs.length === 0, overs.length ? overs[0] : '');
  // 只查“正向营销话术”。规则里把禁用词列成黑名单（含“不要/禁止/绝对不”）是好事，先剔掉那些行
  const positiveLines = p.rules
    .split('\n')
    .filter(l => !/[不要禁止别绝不无]/.test(l));
  const marketingHit = positiveLines.filter(l => /求关注|点个赞|感谢分享|加个微信|关注我/.test(l));
  check('没有正向营销号召的行', marketingHit.length === 0, marketingHit[0]);
}

/* 出摊预设：不能直说互关 */
{
  console.log('\n[stall 禁用词检查]');
  const s = P.stall;
  const BANNED = ['互关', '回关', '互粉', '互fo', '回fo', '关注我', '求关注', 'follow back', 'f4f', '互赞', '互推'];
  const hitSamples = [];
  (s.samples || []).forEach(txt => {
    BANNED.forEach(w => { if (txt.includes(w)) hitSamples.push(`${w} → ${txt}`); });
  });
  check('样例里一个禁用词都没有', hitSamples.length === 0, hitSamples[0]);

  check('样例长度都没超 maxLen', (s.samples || []).every(t => t.length <= s.maxLen));
  check('规则明确列了禁用词表', /互关.*回关.*互粉/.test(s.rules));
  check('规则要求只用一个隐喻', /只用其中一个|一个/.test(s.rules));
  check('规则包含浇水/串门/摊位/蹲守四类', ['浇水', '串门', '摊位', '蹲守'].every(w => s.rules.includes(w)));
  check('样例里至少出现一个隐喻', (s.samples || []).some(t => /摊|门|浇|串门|蹲/.test(t)));
}

/* 交友预设必须真的像在搭话 */
{
  console.log('\n[friend 语义检查]');
  const f = P.friend;
  check('人设提到搭话', /搭话|聊/.test(f.persona));
  check('规则要求抓具体信息点', /具体/.test(f.rules));
  check('规则排除了直球搭讪', /交个朋友|直球搭讪/.test(f.rules));
  check('长度上限适合评论区', f.maxLen <= 80, f.maxLen);
}

/* 嘴臭预设不许越界到人身攻击 */
{
  console.log('\n[snark 边界检查]');
  const s = P.snark;
  check('明确排除了骂家人/地域/长相', /家人|地域|长相/.test(s.rules));
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '⚠ 有失败项'} — 通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
