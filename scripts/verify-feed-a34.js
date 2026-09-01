/**
 * 验证:账本君数据喂养 A3+A4(当日已支出 + 累计可用余额)
 * 链路:首页 _buildAiStmt 组装 → aiChat.serialize 透传 → finChat formatDataForLLM 输出
 * 运行:node scripts/verify-feed-a34.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

let pass = 0
let fail = 0
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.log(`  ✗ ${msg}`) }
}

/** 提取函数体:优先 function name( 形式,回退 Page 对象方法 name() { 形式 */
function fnBody(src, name) {
  let idx = src.indexOf(`function ${name}(`)
  let closer = '\n}'
  if (idx < 0) {
    idx = src.indexOf(`${name}() {`)
    closer = '\n  },'
  }
  if (idx < 0) return ''
  const end = src.indexOf(closer, idx)
  return src.slice(idx, end > 0 ? end : undefined)
}

console.log('== 1. pages/index/index.js _buildAiStmt ==')
const idx = read('pages/index/index.js')
const stmt = fnBody(idx, '_buildAiStmt')
ok(stmt.length > 0, '_buildAiStmt 函数体提取成功')
ok(/viewMonth === util\.thisMonthStr\(\)/.test(stmt), '仅查看当前月时聚合当日支出')
ok(/todayExpense = 0/.test(stmt) && /recentList\.forEach/.test(stmt), '从 recentExpenses 聚合 today 支出')
ok(/x\.date === t/.test(stmt), '按 todayStr 精确匹配日期')
ok(/todayExpense \+= \(x\.amount \|\| 0\)/.test(stmt), 'amount 空值兜底 0')
ok(stmt.indexOf('todayExpenseCount++') > 0, '统计当日笔数')
ok(/todayExpense,\s*\n\s*todayExpenseCount,/.test(stmt), '两字段写入 stmt 返回对象')
ok(/available: board\._availableNum \|\| 0/.test(stmt), 'available 已在 stmt(滚动结转口径)')

console.log('== 2. utils/aiChat.js serialize ==')
const ai = read('utils/aiChat.js')
const ser = fnBody(ai, 'serialize')
ok(ser.length > 0, 'serialize 函数体提取成功')
ok(/available:\s*typeof stmt\.available === 'number' \? stmt\.available : null/.test(ser), 'available 数字校验后透传')
ok(/todayExpense:\s*typeof stmt\.todayExpense === 'number' \? stmt\.todayExpense : null/.test(ser), 'todayExpense 数字校验后透传(null 安全)')
ok(/todayExpenseCount:\s*typeof stmt\.todayExpenseCount === 'number' \? stmt\.todayExpenseCount : 0/.test(ser), 'todayExpenseCount 透传(0 兜底)')
// 本地模板兜底(finTemplate.build)不应被注入新字段
const tplStart = ai.indexOf('finTemplate.build({')
const tplEnd = ai.indexOf('})', tplStart)
const tplBlock = ai.slice(tplStart, tplEnd)
ok(!tplBlock.includes('todayExpense') && !tplBlock.includes('available:'), '本地模板兜底不注入新字段')

console.log('== 3. cloudfunctions/finChat/index.js formatDataForLLM ==')
const fc = read('cloudfunctions/finChat/index.js')
const fmt = fnBody(fc, 'formatDataForLLM')
ok(fmt.length > 0, 'formatDataForLLM 函数体提取成功')
ok(/累计可用余额（含历史结转）/.test(fmt), '输出「累计可用余额（含历史结转）」')
ok(/Math\.abs\(d\.available\)\.toFixed\(0\)/.test(fmt), '负余额取绝对值带符号输出')
ok(/typeof d\.available === 'number'/.test(fmt), 'available 非数字(null/缺失)跳过')
ok(/今日已支出：¥/.test(fmt), '输出「今日已支出：¥X」')
ok(/d\.todayExpenseCount > 0 \? `（\$\{d\.todayExpenseCount\} 笔）` : ''/.test(fmt), '笔数>0 时带「（N 笔）」')
ok(/typeof d\.todayExpense === 'number'/.test(fmt), 'todayExpense null(历史月)跳过')

// 顺序断言:available 行在收支行后、对比行前;今日已支出行在日预算行前
const posFin = fmt.indexOf('收支：')
const posAvail = fmt.indexOf('累计可用余额')
const posCmp = fmt.indexOf('对比：')
const posToday = fmt.indexOf('今日已支出')
const posDaily = fmt.indexOf('日预算：')
const posStatus = fmt.indexOf('状态：')
ok(posAvail > posFin && (posCmp < 0 || posAvail < posCmp), '可用余额行位于收支行后、对比行前')
ok(posToday > 0 && posDaily > 0 && posToday < posDaily, '今日已支出行位于日预算行前')
ok(posDaily > posStatus, '日预算行仍位于状态行后(顺序未被破坏)')

console.log('== 4. finReport 副本不受影响 ==')
const fr = read('cloudfunctions/finReport/index.js')
ok(!fr.includes('todayExpense') && !fr.includes('累计可用余额'), 'finReport 不涉及新字段')

console.log('== 5. 语法检查 ==')
const { execSync } = require('child_process')
const NODE = '/Users/renzhining/.workbuddy/binaries/node/versions/22.22.2/bin/node'
for (const f of ['pages/index/index.js', 'utils/aiChat.js', 'cloudfunctions/finChat/index.js']) {
  try {
    execSync(`"${NODE}" --check "${path.join(ROOT, f)}"`, { stdio: 'pipe' })
    pass++
    console.log(`  ✓ ${f} 语法通过`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${f} 语法错误: ${e.stderr}`)
  }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
