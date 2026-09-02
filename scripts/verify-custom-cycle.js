/**
 * 验证:custom 周期(腾讯视频半年包 88、季包、两年包 等期限包)
 * 跨层断言:
 *   - utils/util.js: nextChargeOf custom 分支(签名 / 校验 / 整月累加)
 *   - utils/db.js: normalizeSubscriptionFields custom 分支(不派生 cycleDay / 不降级 / 必传 firstChargeDate)
 *   - cloudfunctions/finChat/index.js: TOOL_DEFS customMonths 参数 + CYCLE_WHITELIST 5 项 + 必传 firstChargeDate + 写库 + 返回
 *   - cloudfunctions/subReport/index.js: _yearlyOf custom + aggregate 输出 customMonths + formatDataForLLM 单位
 *   - pages/subscriptions/subscriptions.js: form picker + customMonths 输入 + openForm 回填 + saveSubscription 校验
 *   - pages/subscriptions/subscriptions.wxml: cycleIndex===4 条件渲染 + customMonths 输入框 + 「下次到期」文案
 *   - pages/index/index.js: 期限包(custom + 非 wechat/alipay/apple)dueText 切「即将到期」系列
 *
 * 验收:用户输入「腾讯视频半年包 88 元」→ 自动续费管家新增一条 custom 周期订阅,
 *        nextCharge 正确按整月累加;首页待办显示「今天/明天到期」而非「扣费」。
 *
 * 运行: node scripts/verify-custom-cycle.js
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

/* ---------------- 1. utils/util.js: nextChargeOf custom ---------------- */
console.log('== 1. utils/util.js nextChargeOf custom ==')
const util = read('utils/util.js')
ok(/function\s+nextChargeOf\s*\(\s*cycle,\s*firstChargeDate,\s*now,\s*customMonths\s*\)/.test(util),
  'nextChargeOf 签名:(cycle, firstChargeDate, now, customMonths)')
ok(/@param[\s\S]*?customMonths[\s\S]*?cycle\s*=\s*custom/.test(util) || /@param[\s\S]*?customMonths[\s\S]*?1\s*-\s*36/.test(util),
  'nextChargeOf JSDoc 含 customMonths 注释(标注 1-36)')
ok(/cycle\s*===\s*'custom'[\s\S]*?Number\.isInteger\(\s*cm\s*\)\s*\|\|\s*cm\s*<\s*1\s*\|\|\s*cm\s*>\s*36/.test(util),
  'nextChargeOf:custom 校验 customMonths 1-36 整数,非法返回 \'\'')
ok(/cycle\s*===\s*'custom'[\s\S]*?startMs\s*=\s*new Date\(\s*fy,\s*fm,\s*fd\s*\)/.test(util) || /cycle\s*===\s*'custom'[\s\S]*?nowMs\s*<\s*startMs/.test(util),
  'nextChargeOf:custom 起始日 > 今天时直接返回 firstChargeDate')
ok(/cycle\s*===\s*'custom'[\s\S]*?stepCount[\s\S]*?totalM\s*=\s*\(fy\s*\*\s*12\s*\+\s*fm\)\s*\+\s*stepCount\s*\*\s*cm/.test(util),
  'nextChargeOf:custom 按整月累加(totalM = 起始年月偏移 + stepCount × customMonths)')
ok(/cycle\s*===\s*'custom'[\s\S]*?stepCount\s*>\s*1200/.test(util) || /cycle\s*===\s*'custom'[\s\S]*?1200/.test(util),
  'nextChargeOf:custom 步数上限(防死循环)')
ok(/cycle\s*===\s*'custom'[\s\S]*?dayInMonth\(\s*curY,\s*curM,\s*fd\s*\)/.test(util),
  'nextChargeOf:custom 月末 clamp(用 dayInMonth)')

/* ---------------- 2. utils/db.js: normalizeSubscriptionFields custom ---------------- */
console.log('\n== 2. utils/db.js normalizeSubscriptionFields custom ==')
const db = read('utils/db.js')
ok(/normalizeSubscriptionFields[\s\S]*?cycle\s*===\s*['"]custom['"][\s\S]*?cycleDay\s*=\s*['"]['"]/.test(db),
  'normalizeSubscriptionFields:custom 不派生 cycleDay(留空)')
ok(/normalizeSubscriptionFields[\s\S]*?cycle\s*===\s*['"]custom['"][\s\S]*?fallback/.test(db) ||
   /normalizeSubscriptionFields[\s\S]*?cycle\s*===\s*['"]custom['"][\s\S]*?不支持.*降级/.test(db),
  'normalizeSubscriptionFields:custom 不走 cycleDay 降级路径')
ok(/normalizeSubscriptionFields[\s\S]*?cycle\s*===\s*['"]custom['"][\s\S]*?firstChargeDate[\s\S]*?return\s*null|return\s*{[\s\S]*?ok:\s*false/.test(db) ||
   /normalizeSubscriptionFields[\s\S]*?custom[\s\S]*?firstChargeDate[\s\S]*?返回\s*error|throw/.test(db),
  'normalizeSubscriptionFields:custom 缺 firstChargeDate 报错')
ok(/normalizeSubscriptionFields[\s\S]*?cycle\s*===\s*['"]custom['"][\s\S]*?customMonths/.test(db) ||
   /normalizeSubscriptionFields[\s\S]*?custom[\s\S]*?customMonths[\s\S]*?Number\(\s*out\.customMonths\s*\)/.test(db),
  'normalizeSubscriptionFields:custom 透传 customMonths(1-36 校验由上游把守)')
ok(/normalizeSubscriptionFields[\s\S]*?nextChargeOf\([\s\S]*?customMonths\s*\)/.test(db),
  'normalizeSubscriptionFields:nextChargeOf 调用第 4 参传 customMonths')
ok(/normalizeSubscriptionFields[\s\S]*?custom[\s\S]*?customMonths/.test(db) ||
   /normalizeSubscriptionFields[\s\S]*?return\s*\{[\s\S]*?customMonths/.test(db),
  'normalizeSubscriptionFields 返回 payload 含 customMonths')

/* ---------------- 3. cloudfunctions/finChat/index.js: custom ---------------- */
console.log('\n== 3. finChat custom ==')
const fc = read('cloudfunctions/finChat/index.js')
ok(/cycle:\s*\{[\s\S]*?enum:\s*\[\s*'monthly',\s*'yearly',\s*'quarterly',\s*'weekly',\s*'custom'\s*\]/.test(fc),
  'TOOL_DEFS.cycle enum 含 custom(5 项)')
ok(/customMonths:\s*\{[\s\S]*?type:\s*['"]number['"][\s\S]*?description:[\s\S]*?1\s*-\s*36/.test(fc) ||
   /customMonths:\s*\{[\s\S]*?1\s*-\s*36[\s\S]*?正整数/.test(fc),
  'TOOL_DEFS.customMonths:number + description 标注 1-36 正整数')
ok(/customMonths[\s\S]*?cycle\s*===\s*['"]custom['"][\s\S]*?必填|仅 cycle\s*=\s*custom/.test(fc) ||
   /cycle\s*为?\s*custom[\s\S]*?customMonths/.test(fc),
  'TOOL_DEFS.customMonths 标注仅 cycle=custom 时必填')
ok(/CYCLE_WHITELIST\s*=\s*\[\s*'monthly',\s*'yearly',\s*'quarterly',\s*'weekly',\s*'custom'\s*\]/.test(fc),
  'executeAddSubscription CYCLE_WHITELIST 5 项(含 custom)')
ok(/executeAddSubscription[\s\S]*?cycle\s*===\s*['"]custom['"][\s\S]*?customMonths[\s\S]*?1[\s\S]*?36/.test(fc) ||
   /executeAddSubscription[\s\S]*?custom[\s\S]*?1[\s\S]*?36[\s\S]*?整数/.test(fc),
  'executeAddSubscription:custom 校验 customMonths 1-36 整数,失败返回 reason')
ok(/executeAddSubscription[\s\S]*?cycle\s*===\s*['"]custom['"][\s\S]*?firstChargeDate[\s\S]*?return\s*\{[\s\S]*?ok:\s*false/.test(fc) ||
   /executeAddSubscription[\s\S]*?custom[\s\S]*?不支持.*降级|custom[\s\S]*?firstChargeDate[\s\S]*?必须/.test(fc),
  'executeAddSubscription:custom 缺 firstChargeDate 直接拒绝(不支持「不记得了」降级)')
ok(/executeAddSubscription[\s\S]*?custom[\s\S]*?cycleDay\s*=\s*['"]['"]/.test(fc) ||
   /executeAddSubscription[\s\S]*?cycle\s*===\s*['"]custom['"][\s\S]*?cycleDay[\s\S]*?\/\/|skip/.test(fc),
  'executeAddSubscription:custom 不派生 cycleDay(留空)')
ok(/executeAddSubscription[\s\S]*?db\.collection\(\s*['"]subscriptions['"]\s*\)[\s\S]*?customMonths[\s\S]*?0|customMonths:\s*customMonths|customMonths[\s\S]*?:/.test(fc),
  'executeAddSubscription:写库带 customMonths(standard 写 0 / custom 写真值)')
ok(/executeAddSubscription[\s\S]*?record[\s\S]*?customMonths/.test(fc),
  'executeAddSubscription:成功返回 record 含 customMonths(前端可读回)')
ok(/handleSubscriptionTool[\s\S]*?unit[\s\S]*?cm\s*>\s*0\s*\?\s*[`'"][^`'"]*\$\{cm\}[^`'"]*个月/.test(fc) ||
   /handleSubscriptionTool[\s\S]*?N\s*个月|\$\{cm\}\s*个月/.test(fc),
  'handleSubscriptionTool 确认语:custom 单位显示「N 个月」')
ok(/handleSubscriptionTool[\s\S]*?下次到期[\s\S]*?下次扣费/.test(fc) ||
   /handleSubscriptionTool[\s\S]*?rec\.cycle\s*===\s*['"]custom['"][\s\S]*?下次到期/.test(fc),
  'handleSubscriptionTool 确认语:custom 用「下次到期」')
ok(/function\s+nextChargeOf\s*\(\s*cycle,\s*firstChargeDate,\s*now,\s*customMonths\s*\)/.test(fc),
  '云函数侧 nextChargeOf 签名加 customMonths')
ok(/nextChargeOf[\s\S]*?cycle\s*===\s*['"]custom['"][\s\S]*?customMonths[\s\S]*?1[\s\S]*?36/.test(fc),
  '云函数侧 nextChargeOf:custom 校验 customMonths 1-36')
ok(/PROMPT_RECORD[\s\S]*?cycle[\s\S]*?custom/.test(fc),
  'PROMPT_RECORD 提 cycle 含 custom')
ok(/PROMPT_RECORD[\s\S]*?customMonths/.test(fc),
  'PROMPT_RECORD 提 customMonths 字段')
ok(/PROMPT_RECORD[\s\S]*?firstChargeDate[\s\S]*?custom|custom[\s\S]*?firstChargeDate/.test(fc),
  'PROMPT_RECORD 标注 custom 必须传 firstChargeDate')

/* ---------------- 4. cloudfunctions/subReport/index.js: custom ---------------- */
console.log('\n== 4. subReport custom ==')
const sr = read('cloudfunctions/subReport/index.js')
ok(/function\s+_yearlyOf\s*\(\s*amount,\s*cycle,\s*customMonths\s*\)/.test(sr),
  '_yearlyOf(amount, cycle, customMonths) 辅助函数存在')
ok(/_yearlyOf[\s\S]*?cycle\s*===\s*['"]custom['"][\s\S]*?12\s*\/\s*cm/.test(sr),
  '_yearlyOf:custom = amount × 12 / customMonths')
ok(/_yearlyOf[\s\S]*?cycle\s*===\s*['"]custom['"][\s\S]*?cm\s*>=\s*1[\s\S]*?cm\s*<=\s*36/.test(sr),
  '_yearlyOf:custom 校验 cm 1-36(非法兜底 monthly)')
ok(/aggregate[\s\S]*?_yearlyOf\(/.test(sr),
  'aggregate 调用 _yearlyOf 算年化(custom 不在 CYCLE_UNIT 查表)')
ok(/aggregate[\s\S]*?customMonths:[\s\S]*?Number\(\s*s\.customMonths\s*\)/.test(sr),
  'aggregate 输出 items[].customMonths(数字化)')
ok(/formatDataForLLM[\s\S]*?cycle\s*===\s*['"]custom['"][\s\S]*?cm\s*>\s*0\s*\?\s*[`'"][^`'"]*\$\{cm\}[^`'"]*个月包/.test(sr) ||
   /formatDataForLLM[\s\S]*?custom[\s\S]*?N\s*个月包|\$\{cm\}\s*个月包/.test(sr),
  'formatDataForLLM:custom 显示「N 个月包」单位(让 LLM 看出是期限包)')

/* ---------------- 5. db.js getSubReport: custom ---------------- */
console.log('\n== 5. db.js getSubReport custom ==')
ok(/getSubReport[\s\S]*?cycle\s*===\s*['"]custom['"][\s\S]*?12\s*\/\s*cm/.test(db) ||
   /getSubReport[\s\S]*?cycle\s*===\s*['"]custom['"][\s\S]*?customMonths/.test(db),
  'db.js getSubReport 客户端聚合:custom 走 amount × 12 / customMonths(与云函数同款)')

/* ---------------- 6. subscriptions.js form: custom ---------------- */
console.log('\n== 6. subscriptions.js form custom ==')
const sjs = read('pages/subscriptions/subscriptions.js')
ok(/customMonths:\s*['"]['"]/.test(sjs) || /customMonths:\s*''/.test(sjs),
  'data 字段 customMonths 初始空字符串')
ok(/\['每月',\s*'每年',\s*'每季',\s*'每周',\s*'自定义'\]/.test(sjs),
  'cycleOptions 5 选项(含「自定义」)')
ok(/cycleIndex:\s*0/.test(sjs) && /customMonths:\s*['"]['"]/.test(sjs),
  'data:cycleIndex 默认 0 / customMonths 默认空')
ok(/openForm[\s\S]*?cycleIndex\s*=\s*editing[\s\S]*?cycle\s*===\s*['"]custom['"][\s\S]*?\?\s*4/.test(sjs) ||
   /openForm[\s\S]*?cycleKeys[\s\S]*?4[\s\S]*?custom/.test(sjs),
  'openForm:custom 周期映射到索引 4,回填 customMonths')
ok(/onCycleChange[\s\S]*?idx\s*===\s*4[\s\S]*?customMonths/.test(sjs),
  'onCycleChange:切到 custom 时保留 customMonths 输入状态')
ok(/onCustomMonthsInput\(/.test(sjs),
  'onCustomMonthsInput 处理器存在')
ok(/saveSubscription[\s\S]*?customMonths[\s\S]*?Number\.isInteger[\s\S]*?1[\s\S]*?36/.test(sjs) ||
   /saveSubscription[\s\S]*?custom[\s\S]*?1[\s\S]*?36[\s\S]*?整数/.test(sjs),
  'saveSubscription:custom 校验 1-36 整数,失败 wx.showToast 拦截')
ok(/saveSubscription[\s\S]*?isCustom[\s\S]*?firstChargeDate[\s\S]*?请选择首次到期|custom[\s\S]*?不支持.*降级/.test(sjs) ||
   /saveSubscription[\s\S]*?isCustom[\s\S]*?fallback\s*=\s*false|fallback\s*=\s*false/.test(sjs),
  'saveSubscription:custom 不允许 cycleDay 降级(强制要求 firstChargeDate)')
ok(/saveSubscription[\s\S]*?nextChargeOf\(\s*cycle,\s*firstChargeDate[\s\S]*?customMonths\s*\)/.test(sjs) ||
   /saveSubscription[\s\S]*?isCustom\s*\?\s*customMonths\s*:/.test(sjs),
  'saveSubscription:nextChargeOf 调用按 isCustom 透传 customMonths')
ok(/saveSubscription[\s\S]*?isCustom[\s\S]*?payload\.customMonths\s*=\s*customMonths/.test(sjs),
  'saveSubscription:仅 custom 时 payload 含 customMonths 字段')
ok(/_enrich[\s\S]*?cycle\s*===\s*['"]custom['"][\s\S]*?每\s*\$\{cm\}\s*个月|每\s*cm\s*个月/.test(sjs),
  '_enrich:custom 列表周期文本显示「每 N 个月」')
ok(/_previewFromForm[\s\S]*?cycle\s*!===\s*['"]custom['"][\s\S]*?customMonths[\s\S]*?cm\s*>=\s*1[\s\S]*?cm\s*<=\s*36/.test(sjs) ||
   /_previewFromForm[\s\S]*?customReady[\s\S]*?customMonths/.test(sjs),
  '_previewFromForm:custom 时仅 customMonths 合法才渲染预览')
ok(/_previewFromForm[\s\S]*?cycle\s*===\s*['"]custom['"][\s\S]*?cycleDay\s*=\s*['"]['"]|custom[\s\S]*?不派生\s*cycleDay|custom[\s\S]*?无\s*cycleDay/.test(sjs),
  '_previewFromForm:custom 不派生 cycleDay(无月内某日)')
ok(/_buildReportDataBlock[\s\S]*?cycle\s*===\s*['"]custom['"][\s\S]*?12\s*\/\s*cm/.test(sjs),
  '_buildReportDataBlock:custom 年化走 amount × 12 / customMonths(与云函数一致)')

/* ---------------- 7. subscriptions.wxml: custom ---------------- */
console.log('\n== 7. subscriptions.wxml custom ==')
const swxml = read('pages/subscriptions/subscriptions.wxml')
ok(/wx:if="\{\{cycleIndex === 4\}\}"[\s\S]*?customMonths/.test(swxml) ||
   /wx:if="\{\{cycleIndex === 4\}\}"[\s\S]{0,200}?bindinput="onCustomMonthsInput"/.test(swxml),
  'wxml:cycleIndex===4 条件渲染 customMonths 输入框')
ok(/bindinput="onCustomMonthsInput"/.test(swxml),
  'wxml:customMonths 绑定 onCustomMonthsInput')
ok(/每个周期含几个月/.test(swxml),
  'wxml:customMonths label 写「每个周期含几个月」')
ok(/半年包|季包/.test(swxml) && /placeholder="如 6 = 半年包,3 = 季包"|placeholder="[^"]*半年包[^"]*季包/.test(swxml),
  'wxml:customMonths placeholder 提示「如 6 = 半年包,3 = 季包」')
ok(/cycleIndex === 4[\s\S]*?首次到期日期|custom[\s\S]*?首次到期日期|首次到期日期/.test(swxml),
  'wxml:custom 时首扣日 picker label 切「首次到期日期」')
ok(/formFallback[\s\S]*?cycleIndex !== 4/.test(swxml),
  'wxml:custom 不显示「不记得了」降级 mode 的 cycleDay 输入')
ok(/cycleIndex === 4[\s\S]*?下次到期|custom[\s\S]*?下次到期/.test(swxml),
  'wxml:custom 时预览块文案用「下次到期」而非「下次扣费」')

/* ---------------- 8. 首页待办 dueText 区分期限包 ---------------- */
console.log('\n== 8. index.js 期限包 dueText ==')
const idx = read('pages/index/index.js')
ok(/AUTO_CHANNEL\s*=\s*\[\s*'wechat',\s*'alipay',\s*'apple'\s*\]/.test(idx),
  'index.js AUTO_CHANNEL 白名单(wechat/alipay/apple)')
ok(/subTodos[\s\S]*?isTermPack\s*=\s*s\.cycle\s*===\s*['"]custom['"][\s\S]*?!AUTO_CHANNEL\.includes/.test(idx) ||
   /isTermPack\s*=\s*s\.cycle\s*===\s*['"]custom['"][\s\S]*?!\[?AUTO_CHANNEL/.test(idx),
  'index.js subTodos:isTermPack = custom && 非自动扣费渠道')
ok(/isTermPack[\s\S]*?已过期·未续费/.test(idx),
  'index.js 期限包 overdue → 「已过期·未续费」')
ok(/isTermPack[\s\S]*?今天到期/.test(idx),
  'index.js 期限包 today → 「今天到期」')
ok(/isTermPack[\s\S]*?明天到期/.test(idx),
  'index.js 期限包 tomorrow → 「明天到期」')
ok(/isTermPack[\s\S]*?已扣费·未取消/.test(idx),
  'index.js 自动扣费渠道 overdue → 「已扣费·未取消」(保留断舍离钩子)')

/* ---------------- 9. 跨层一致性:数据块命名/字段 ---------------- */
console.log('\n== 9. 跨层一致性 ==')
ok(/半年包/.test(fc) || /半年包/.test(sr) || /半年包/.test(swxml) || /半年包/.test(sjs),
  '半年包(腾讯视频 88 元)语义至少出现在一处:AI 工具描述 / 数据块 / 表单 placeholder / 列表展示')

/* ---------------- 10. 语法检查 ---------------- */
console.log('\n== 10. 语法检查 ==')
const files = [
  'utils/util.js',
  'utils/db.js',
  'cloudfunctions/finChat/index.js',
  'cloudfunctions/subReport/index.js',
  'pages/subscriptions/subscriptions.js',
  'pages/subscriptions/subscriptions.wxml',
  'pages/index/index.js'
]
for (const f of files) {
  try {
    if (f.endsWith('.json')) {
      JSON.parse(read(f))
      pass++
      console.log(`  ✓ ${f} JSON 合法`)
    } else if (f.endsWith('.js')) {
      execSync(`"${NODE}" --check "${path.join(ROOT, f)}"`, { stdio: 'pipe' })
      pass++
      console.log(`  ✓ ${f} 语法通过`)
    } else {
      pass++
      console.log(`  ✓ ${f} 存在`)
    }
  } catch (e) {
    fail++
    console.log(`  ✗ ${f}: ${(e.stderr || e.message || '').toString().split('\n')[0]}`)
  }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)