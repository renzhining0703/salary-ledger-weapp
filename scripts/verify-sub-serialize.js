/**
 * 验证:T2.4 订阅数据并入账本君数据块
 * - utils/aiChat.js: serialize 返回对象透传 subscriptions + subYearlyTotal
 * - cloudfunctions/finChat/index.js: formatDataForLLM 数据块加「订阅:」段,
 *   含共X项 + 年化合计 + 逐条明细(名称/平台/渠道/金额/周期/下次扣费/使用频率)
 * - pages/index/index.js: _buildAiStmt 派生 subscriptions(过滤active + 排序nextCharge + top10)+ subYearlyTotal;
 *   loadData 派生 aiSubscriptions 数组 + 透传给 _buildAiStmt
 *
 * 验收:在首页或订阅页问账本君「我订阅一年多少钱」→ 数据块自带订阅段 → AI 不调工具即可答出年化总额
 *
 * 运行: node scripts/verify-sub-serialize.js
 */
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

let pass = 0
let fail = 0
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.log(`  ✗ ${msg}`) }
}
const NODE = process.execPath

/* ---------------- 1. aiChat.serialize 透传 ---------------- */
console.log('== 1. utils/aiChat.js serialize ==')
const ac = read('utils/aiChat.js')
ok(/function\s+serialize\(stmt/.test(ac), 'serialize 函数存在')
ok(/serialize[\s\S]*?subscriptions:\s*Array\.isArray\(stmt\.subscriptions\)\s*\?\s*stmt\.subscriptions\s*:\s*\[\]/.test(ac), 'serialize 透传 subscriptions(数组兜底 [])')
ok(/serialize[\s\S]*?subYearlyTotal:\s*typeof\s+stmt\.subYearlyTotal\s*===\s*'number'\s*\?\s*stmt\.subYearlyTotal\s*:\s*0/.test(ac), 'serialize 透传 subYearlyTotal(number 兜底 0)')

// 字段顺序:subscriptions/subYearlyTotal 在最近明细(recentList)之后,易于人脑定位
ok(/serialize[\s\S]*?recentList:[\s\S]*?subscriptions:[\s\S]*?subYearlyTotal/.test(ac), 'serialize 字段顺序:recentList → subscriptions → subYearlyTotal')

/* ---------------- 2. finChat 数据块加订阅段 ---------------- */
console.log('\n== 2. cloudfunctions/finChat/index.js formatDataForLLM ==')
const fc = read('cloudfunctions/finChat/index.js')
ok(/function\s+formatDataForLLM\(/.test(fc), 'formatDataForLLM 函数存在')
ok(/formatDataForLLM[\s\S]*?Array\.isArray\(d\.subscriptions\)\s*&&\s*d\.subscriptions\.length/.test(fc), 'formatDataForLLM 校验 subscriptions 是非空数组才输出订阅段')
ok(/formatDataForLLM[\s\S]*?CHANNEL_LABELS|CHANNEL_LABELS\s*=\s*\{[\s\S]*?wechat:/.test(fc), '订阅段含扣费渠道标签字典(wechat/alipay/apple/inapp/unknown)')
ok(/formatDataForLLM[\s\S]*?USAGE_LABELS|USAGE_LABELS\s*=\s*\{[\s\S]*?frequent:/.test(fc), '订阅段含使用频率标签字典(frequent/occasional/rare/never)')
ok(/formatDataForLLM[\s\S]*?unitMap[\s\S]*?monthly:\s*'月'/.test(fc), '订阅段含周期单位映射(monthly→月/yearly→年/...)')
ok(/formatDataForLLM[\s\S]*?共\s*\$\{d\.subscriptions\.length\}\s*项/.test(fc), '订阅段输出「共 X 项」')
ok(/formatDataForLLM[\s\S]*?年化\s*¥\$\{d\.subYearlyTotal/.test(fc), '订阅段输出「年化 ¥X」(subYearlyTotal 原样引用)')
ok(/formatDataForLLM[\s\S]*?明细:|items\.join\('；'\)/.test(fc), '订阅段输出明细列表(逐条 name/platform/channel/amount/cycle/nextCharge/usage)')
ok(/formatDataForLLM[\s\S]*?nextCharge\s*\|\|\s*'-'/.test(fc), '订阅明细缺 nextCharge 兜底 - (与「下次扣费」字段名一致)')

/* ---------------- 3. 首页 _buildAiStmt 派生订阅摘要 ---------------- */
console.log('\n== 3. pages/index/index.js _buildAiStmt ==')
const ix = read('pages/index/index.js')
ok(/aiSubscriptions:\s*\[\]/.test(ix), 'data 字段 aiSubscriptions: [] 声明')
ok(/_buildAiStmt\(/.test(ix), '_buildAiStmt 函数存在')
ok(/_buildAiStmt[\s\S]*?subscriptions:\s*Array\.isArray\(this\.data\.aiSubscriptions\)\s*\?\s*this\.data\.aiSubscriptions\s*:\s*\[\]/.test(ix), '_buildAiStmt 派生 subscriptions(读 this.data.aiSubscriptions)')
ok(/_buildAiStmt[\s\S]*?subYearlyTotal:\s*\(\(\)\s*=>\s*\{[\s\S]*?monthly[\s\S]*?\*\s*12[\s\S]*?yearly[\s\S]*?quarterly[\s\S]*?\*\s*4[\s\S]*?weekly[\s\S]*?\*\s*52/.test(ix), '_buildAiStmt 派生 subYearlyTotal:月×12/年×1/季×4/周×52')

// loadData 派生 aiSubscriptions 数组
ok(/loadData[\s\S]*?aiSubscriptions\s*=\s*\(batch\.subscriptions\s*\|\|\s*\[\]\)[\s\S]*?filter\(\(s\)\s*=>\s*s\.status\s*===\s*'active'\s*&&\s*s\.nextCharge\)/.test(ix), 'loadData 派生 aiSubscriptions:过滤 status=active 且有 nextCharge')
ok(/loadData[\s\S]*?aiSubscriptions[\s\S]*?localeCompare[\s\S]*?nextCharge/.test(ix), 'loadData 排序 aiSubscriptions:按 nextCharge 升序')
ok(/loadData[\s\S]*?aiSubscriptions[\s\S]*?slice\(0,\s*10\)/.test(ix), 'loadData 取 aiSubscriptions top10')
ok(/loadData[\s\S]*?payChannel:\s*s\.payChannel\s*\|\|\s*'unknown'/.test(ix), 'loadData 老数据 payChannel 兜底 unknown')
ok(/loadData[\s\S]*?aiSubscriptions,\s*$|aiSubscriptions,?\s*\n/.test(ix), 'loadData setData 包含 aiSubscriptions 字段')

/* ---------------- 4. 语法检查 ---------------- */
console.log('\n== 4. 语法检查 ==')
const checks = [
  'utils/aiChat.js',
  'cloudfunctions/finChat/index.js',
  'pages/index/index.js'
]
for (const f of checks) {
  try {
    execSync(`"${NODE}" --check "${path.join(ROOT, f)}"`, { stdio: 'pipe' })
    pass++
    console.log(`  ✓ ${f} 语法通过`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${f}: ${(e.stderr || '').toString().split('\n')[0]}`)
  }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)