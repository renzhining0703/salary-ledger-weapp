/**
 * 验证:自动续费管家 T1.1 数据层
 * - utils/util.js: nextChargeOf 纯函数 + 导出
 * - utils/db.js:  5 个订阅方法(addSubscription / listSubscriptions / updateSubscription / removeSubscription / nextChargeOf) + 缓存 + RECYCLE_COLS + batchHomeRead 集成
 * - cloudfunctions/dbRead/index.js: RECYCLE_COLS 含 subscriptions + listSubscriptions 读取 + switch 分支 + batchHomeRead Promise.all + 返回字段
 *
 * 运行: node scripts/verify-subscriptions-data.js
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

/* ---------------- 1. utils/util.js: nextChargeOf 实现 + 导出 ---------------- */
console.log('== 1. utils/util.js nextChargeOf ==')
const util = read('utils/util.js')
ok(/function nextChargeOf\(/.test(util), 'nextChargeOf 函数定义存在')
ok(/dayInMonth\(/.test(util), '复用 dayInMonth clamp 逻辑')
ok(/fmtDate\(/.test(util), '返回 YYYY-MM-DD 字符串')
ok(/cycle === 'yearly'/.test(util), '处理 yearly（cycleDay=MM-DD）')
ok(/cycle === 'weekly'/.test(util), '处理 weekly（每次推进 7 天）')
ok(/cycle === 'monthly'[\s\S]*?cycle === 'quarterly'/.test(util), '处理 monthly/quarterly')
ok(/nextChargeOf,/.test(util), 'nextChargeOf 在 module.exports 列表里')

// custom 周期分支(腾讯视频半年包 88 等)
ok(/nextChargeOf\s*\(\s*cycle,\s*currentNextCharge,\s*now,\s*customMonths\s*\)/.test(util), 'nextChargeOf 签名:currentNextCharge 第 2 参 + customMonths 第 4 参(滚动语义)')
ok(/cycle\s*===\s*'custom'[\s\S]*?customMonths[\s\S]*?1\s*\|\|\s*cm\s*<\s*1\s*\|\|\s*cm\s*>\s*36/.test(util) || /cycle\s*===\s*'custom'[\s\S]*?customMonths[\s\S]*?Number\.isInteger[\s\S]*?1[\s\S]*?36/.test(util), 'nextChargeOf:custom 时校验 customMonths 1-36 整数')
ok(/cycle\s*===\s*'custom'[\s\S]*?totalM\s*=\s*cy\s*\*\s*12\s*\+\s*cm0\s*\+\s*cm|custom[\s\S]*?整月累加|custom[\s\S]*?\+\s*customMonths/.test(util), 'nextChargeOf:custom 从 currentNextCharge 按整月推进 (+customMonths 月)')

/* ---------------- 2. utils/db.js: 5 个方法 + 缓存 + RECYCLE_COLS + batchHomeRead ---------------- */
console.log('\n== 2. utils/db.js subscriptions ==')
const db = read('utils/db.js')
ok(/async function addSubscription\(/.test(db), 'addSubscription 方法存在')
ok(/async function listSubscriptions\(/.test(db), 'listSubscriptions 方法存在')
ok(/async function updateSubscription\(/.test(db), 'updateSubscription 方法存在')
ok(/async function removeSubscription\(/.test(db), 'removeSubscription 方法存在')
ok(/const nextChargeOf = util\.nextChargeOf/.test(db), 'nextChargeOf 5th 方法从 util 引入并 re-export')
ok(/subscriptions: null/.test(db), 'cache 对象含 subscriptions 字段')
ok(/cache\.subscriptions = null/.test(db), 'invalidate() 清除 subscriptions 缓存')
ok(/fresh\(cache\.subscriptions\)/.test(db), 'listSubscriptions 使用 60s TTL 缓存')
ok(/cloudRead\('listSubscriptions'\)/.test(db), 'listSubscriptions 走 cloudRead')
ok(/byNextChargeAsc/.test(db), '提供 nextCharge 升序排序器（最近要扣的在前）')
ok(/RECYCLE_COLS = \[[\s\S]*?'subscriptions'[\s\S]*?\]/.test(db), 'RECYCLE_COLS 含 subscriptions')
ok(/clear\('subscriptions'\)/.test(db), 'clearAllData 同步清空 subscriptions 集合')
ok(/listSubscriptions\(force\)/.test(db), 'batchHomeRead 降级路径 Promise.all 含 listSubscriptions')
ok(/cache\.subscriptions = \{ t: now, d: d\.subscriptions \}/.test(db), 'batchHomeRead 回填 subscriptions 缓存')
ok(/d\.subscriptions = [\s\S]*?\.sort\(byNextChargeAsc\)/.test(db), 'batchHomeRead 客户端按 nextCharge 升序排序')
ok(/addSubscription,\s*\n\s*listSubscriptions,\s*\n\s*updateSubscription,\s*\n\s*removeSubscription,\s*\n\s*nextChargeOf/.test(db), 'addSubscription/listSubscriptions/updateSubscription/removeSubscription/nextChargeOf 均出现在 module.exports(可附带 deriveCycleDay 等)')
ok(/deriveCycleDay/.test(db), 'deriveCycleDay 也导出(4.3 节主录入字段用)')

/* ---------------- 3. cloudfunctions/dbRead/index.js: RECYCLE_COLS + listSubscriptions + batchHomeRead + switch ---------------- */
console.log('\n== 3. cloudfunctions/dbRead/index.js subscriptions ==')
const dbRead = read('cloudfunctions/dbRead/index.js')
ok(/const RECYCLE_COLS = \[[\s\S]*?'subscriptions'[\s\S]*?\]/.test(dbRead), 'RECYCLE_COLS 含 subscriptions')
ok(/async function listSubscriptions\(openid\)/.test(dbRead), 'listSubscriptions 云函数实现存在')
ok(/db\.collection\('subscriptions'\)/.test(dbRead), 'listSubscriptions 查询 subscriptions 集合')
ok(/deleted: _\.neq\(true\)/.test(dbRead.match(/async function listSubscriptions\(openid\) \{[\s\S]*?\n\}/)[0]), 'listSubscriptions 过滤 deleted=true')
ok(/case 'listSubscriptions':/.test(dbRead), 'switch 含 listSubscriptions 分支')
ok(/listSubscriptions\(OPENID\)\.catch\(missingAsEmpty\)/.test(dbRead), 'listSubscriptions 在 switch 中走 missingAsEmpty 兜底')
ok(/listSubscriptions\(openid\)\.catch\(missingAsEmpty\)/.test(dbRead), 'batchHomeRead 中 listSubscriptions 走 missingAsEmpty 兜底')
const batchBody = dbRead.match(/async function batchHomeRead\(openid, event\) \{[\s\S]*?\n\}/)
ok(batchBody && /return \{ user, salary, cards, expenses, trend, subscriptions, expAgg, reconciled \}/.test(batchBody[0]), 'batchHomeRead 返回对象含 subscriptions 字段')
ok(batchBody && /listExpensesRange\(openid, event\.startMonth, event\.month\),[\s\S]*?listSubscriptions\(openid\)/.test(batchBody[0]), 'batchHomeRead Promise.all 末尾含 listSubscriptions')

/* ---------------- 4. 语法检查 ---------------- */
console.log('\n== 4. 语法检查 ==')
for (const f of ['utils/util.js', 'utils/db.js', 'cloudfunctions/dbRead/index.js']) {
  try {
    execSync(`"${NODE}" --check "${path.join(ROOT, f)}"`, { stdio: 'pipe' })
    pass++
    console.log(`  ✓ ${f} 语法通过`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${f} 语法错误: ${e.stderr.toString().split('\n')[0]}`)
  }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
