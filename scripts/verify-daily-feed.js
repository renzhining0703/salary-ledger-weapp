/**
 * 验证:账本君数据喂养 A1+A2(今天日期+日预算余量)
 * 链路:首页 _buildAiStmt 组装 → aiChat.serialize 透传 → finChat formatDataForLLM 输出
 * 运行:node scripts/verify-daily-feed.js
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

/** 从源码中按「function name」提取到下一个顶级右花括号的函数体(边界:\n} ) */
function fnBody(src, name) {
  let idx = src.indexOf(`function ${name}(`)
  // Page 对象方法形式:name() {
  if (idx < 0) idx = src.indexOf(`${name}() {`)
  if (idx < 0) return ''
  const end = src.indexOf('\n  },', idx) >= 0 ? src.indexOf('\n  },', idx) : src.indexOf('\n}', idx)
  return src.slice(idx, end > 0 ? end : undefined)
}

console.log('== 1. pages/index/index.js _buildAiStmt ==')
const idx = read('pages/index/index.js')
const stmt = fnBody(idx, '_buildAiStmt')
ok(stmt.length > 0, '_buildAiStmt 函数体提取成功')
ok(/dailyBudget:\s*this\.data\.daily \? this\.data\.daily\.amount : null/.test(stmt), 'dailyBudget 取 daily.amount(null 兜底)')
ok(/dailyBudgetSub:\s*this\.data\.daily \? this\.data\.daily\.sub : ''/.test(stmt), 'dailyBudgetSub 取 daily.sub 口径说明')
ok(/dailyBudgetTip:\s*this\.data\.daily \? this\.data\.daily\.zeroTip : ''/.test(stmt), 'dailyBudgetTip 取 daily.zeroTip 告警')
ok(!/dailyBudget: this\.data\.daily \? this\.data\.daily\.amount : null,\s*\/\/ 日均可花/.test(stmt), '旧单字段注释已替换')

console.log('== 2. utils/aiChat.js serialize ==')
const ai = read('utils/aiChat.js')
const ser = fnBody(ai, 'serialize')
ok(ser.length > 0, 'serialize 函数体提取成功')
ok(/dailyBudget:\s*typeof stmt\.dailyBudget === 'number' \? stmt\.dailyBudget : null/.test(ser), 'dailyBudget 数字校验后透传(非数字→null)')
ok(/dailyBudgetSub:\s*stmt\.dailyBudgetSub \|\| ''/.test(ser), 'dailyBudgetSub 透传(空串兜底)')
ok(/dailyBudgetTip:\s*stmt\.dailyBudgetTip \|\| ''/.test(ser), 'dailyBudgetTip 透传(空串兜底)')

console.log('== 3. cloudfunctions/finChat/index.js formatDataForLLM ==')
const fc = read('cloudfunctions/finChat/index.js')
const fmt = fnBody(fc, 'formatDataForLLM')
ok(fmt.length > 0, 'formatDataForLLM 函数体提取成功')
ok(/今天：\$\{todayStr\}/.test(fmt), '输出「今天：YYYY-MM-DD」')
ok(/周\$\{wnames\[now\.getDay\(\)\]\}/.test(fmt), '今天行含周几')
ok(/本月还剩 \$\{daysLeft\} 天/.test(fmt), '今天行含本月剩余天数')
ok(/lastDayOfMonth - now\.getDate\(\) \+ 1/.test(fmt), 'daysLeft 含今天(+1)')
ok(/new Date\(now\.getFullYear\(\), now\.getMonth\(\) \+ 1, 0\)/.test(fmt), '月末天数用 Date(y, m+1, 0) 计算')
ok(/日预算：今天还能花/.test(fmt), '输出「日预算：今天还能花 ¥X」')
ok(/d\.dailyBudget > 0 \|\| d\.dailyBudgetTip/.test(fmt), 'amount=0 但带告警时也输出')
ok(/typeof d\.dailyBudget === 'number'/.test(fmt), '非数字(null/缺失)跳过,历史月份安全')
ok(/d\.dailyBudgetSub \? `，\$\{d\.dailyBudgetSub\}` : ''/.test(fmt) || /d\.dailyBudgetSub \?/.test(fmt), '日预算行拼接 sub 口径说明')
// 注入位置:今天行在「用户状态」之前、紧随本月行
const todayPos = fmt.indexOf('今天：')
const statePos = fmt.indexOf('用户状态：')
ok(todayPos > 0 && fmt.indexOf('本月：') < todayPos, '今天行位于本月行之后')
ok(statePos < 0 || todayPos < statePos, '今天行位于用户状态行之前')
// 日预算行在状态行之后(预算语境收尾)
const dailyPos = fmt.indexOf('日预算：')
ok(dailyPos > statePos, '日预算行位于状态行之后')

console.log('== 4. finReport 副本有意不同步 ==')
const fr = read('cloudfunctions/finReport/index.js')
ok(!fr.includes('今天：'), 'finReport 不注入今天行(月报场景,有意不同步)')
ok(!fr.includes('dailyBudget'), 'finReport 不涉及日预算字段')

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
