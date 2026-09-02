/**
 * 验证:T1.3 订阅到期提醒(remind 云函数加订阅分支)
 * - cloudfunctions/remind/index.js:
 *   1. SUB_TEMPLATE_ID 常量(占位串 + 与 utils/config.js 同步注释)
 *   2. 订阅到期扫描:subscriptions 集合 + status=active + deleted filter
 *   3. 日期过滤:nextCharge === tomorrowStr 或 todayStr
 *   4. 按 _openid 聚合 + 多笔合并推送
 *   5. cloud.openapi.subscribeMessage.send 调用 + 新模板 ID + 跳订阅页
 *   6. 日期工具用 nowInChina/fmtDate(不裸用 new Date)
 * - utils/config.js:SUBSCRIPTION_REMIND_TEMPLATE_ID 字段存在
 *
 * 运行: node scripts/verify-subscriptions-remind.js
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

/* ---------------- 1. cloudfunctions/remind/index.js ---------------- */
console.log('== 1. cloudfunctions/remind/index.js ==')
const code = read('cloudfunctions/remind/index.js')

/* ----- 1.1 SUB_TEMPLATE_ID 常量 ----- */
ok(/const\s+SUB_TEMPLATE_ID\s*=\s*['"]/.test(code), 'SUB_TEMPLATE_ID 常量声明')
ok(/SUB_TEMPLATE_ID[\s\S]{0,300}?SUBSCRIPTION_REMIND_TEMPLATE_ID/.test(code), 'SUB_TEMPLATE_ID 注释提醒同步 utils/config.js SUBSCRIPTION_REMIND_TEMPLATE_ID')

/* ----- 1.2 订阅到期扫描 ----- */
ok(/db\.collection\('subscriptions'\)/.test(code), '读 subscriptions 集合')
ok(/db\.collection\('subscriptions'\)[\s\S]*?status:\s*'active',\s*deleted:\s*_\.neq\(true\)/.test(code), '过滤 active + 非删除(deleted !== true)')
ok(/\.limit\(1000\)/.test(code), '扫描限 1000 条')
ok(/s\.nextCharge\s*===\s*tomorrowStr\s*\|\|\s*s\.nextCharge\s*===\s*todayStr/.test(code) || /s\.nextCharge\s*===\s*todayStr\s*\|\|\s*s\.nextCharge\s*===\s*tomorrowStr/.test(code), '过滤 nextCharge = tomorrowStr 或 todayStr')

/* ----- 1.3 日期工具 ----- */
ok(/nowInChina\(\)/.test(code), '用 nowInChina() 取当前时间(非裸 new Date)')
ok(/fmtDate\(now\)/.test(code), 'todayStr = fmtDate(now)(非裸拼接)')

/* ----- 1.4 按 _openid 聚合 ----- */
ok(/subByUser\[uid\]\s*=\s*\[\]/.test(code) || /subByUser\[uid\]\s*=\s*subByUser\[uid\]\s*\|\|\s*\[\]/.test(code), '按 _openid 建桶')
ok(/_openid\s*\|\|\s*\w*\.?openid/.test(code), '兼容 _openid/openid 两种字段')
ok(/subByUser\[uid\]\.push\(s\)/.test(code) || /subByUser\[uid\]\)\.push\(s\)/.test(code), '订阅条目 push 进用户桶')

/* ----- 1.5 推送 ----- */
ok(/cloud\.openapi\.subscribeMessage\.send\(/.test(code), '调 cloud.openapi.subscribeMessage.send')
ok(/templateId:\s*SUB_TEMPLATE_ID/.test(code), '推送用 SUB_TEMPLATE_ID(订阅专用模板)')
ok(/page:\s*'pages\/subscriptions\/subscriptions'/.test(code), '推送跳转订阅页')
ok(/miniprogramState:\s*'formal'/.test(code), 'miniprogramState = formal(正式版)')

/* ----- 1.6 合并推送文案 ----- */
ok(/thing1[\s\S]*?firstName[\s\S]*?等\d+笔/.test(code) || /thing1[\s\S]*?list\.length\s*===\s*1/.test(code), '多笔订阅时 thing1 = 「首笔+等N笔」合并文案')
ok(/amount3[\s\S]*?total\.toFixed/.test(code), 'amount3 = 总金额(多笔合并)')
ok(/date2[\s\S]*?earliest/.test(code), 'date2 = 最早扣费日(可能为今天)')

/* ----- 1.7 集合未创建兜底 ----- */
ok(/errCode\s*===\s*-502005/.test(code), '订阅集合未创建 -502005 静默兜底')

/* ----- 1.8 还款段未破坏 ----- */
ok(/const\s+TEMPLATE_ID\s*=\s*'wA_ZPWiHPGe4kD17FfpT2HFKPEHBOXmMXDi03viQczM'/.test(code), '原还款 TEMPLATE_ID 保留')
ok(/db\.collection\('cards'\)/.test(code), '原还款 cards 集合扫描保留')
ok(/calcDueDate/.test(code), '原还款 calcDueDate 用法保留')

/* ---------------- 2. utils/config.js ---------------- */
console.log('\n== 2. utils/config.js ==')
const cfg = read('utils/config.js')
ok(/SUBSCRIPTION_REMIND_TEMPLATE_ID\s*:/.test(cfg), 'utils/config.js 声明 SUBSCRIPTION_REMIND_TEMPLATE_ID')
ok(/[\s\S]{0,400}?cloudfunctions\/remind[\s\S]{0,80}?SUB_TEMPLATE_ID[\s\S]{0,80}?SUBSCRIPTION_REMIND_TEMPLATE_ID\s*:/.test(cfg), 'config 注释提醒同步位置 cloudfunctions/remind SUB_TEMPLATE_ID')

/* ---------------- 3. 语法检查 ---------------- */
console.log('\n== 3. 语法检查 ==')
for (const f of ['cloudfunctions/remind/index.js', 'utils/config.js']) {
  try {
    if (f.endsWith('.js')) {
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