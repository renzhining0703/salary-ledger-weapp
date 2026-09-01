/**
 * 验证:账本君数据喂养 B5+B6+B7(断记天数 + 待记固定支出 + 逐卡实时明细)
 * 链路:首页 loadData/data → _buildAiStmt 组装 → aiChat.serialize 透传 → finChat formatDataForLLM 输出
 * 运行:node scripts/verify-feed-b57.js
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

/** 提取函数体:优先 function name( 形式,回退对象方法 name(args) { 形式 */
function fnBody(src, name) {
  let idx = src.indexOf(`function ${name}(`)
  let closer = '\n}'
  if (idx < 0) {
    // 对象方法形式(可带参数/async 前缀):name( ... ) {
    const re = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*\\{`)
    const m = re.exec(src)
    if (!m) return ''
    idx = m.index
    closer = '\n  },'
  }
  const end = src.indexOf(closer, idx)
  return src.slice(idx, end > 0 ? end : undefined)
}

console.log('== 1. pages/index/index.js data 声明 ==')
const idx = read('pages/index/index.js')
ok(/lastRecordGap: null,/.test(idx) && /距上次记账天数/.test(idx), 'data 声明 lastRecordGap')
ok(/aiCards: \[\],/.test(idx), 'data 声明 aiCards')
ok(/recurringList: \[\],/.test(idx), 'data 声明 recurringList')

console.log('== 2. loadData(函数体整体) ==')
const load = fnBody(idx, 'loadData')
ok(load.length > 0, 'loadData 函数体提取成功')
ok(/let lastRecordGap = null/.test(load), 'lastRecordGap 局部变量声明')
ok(/recentDates\.reduce\(\(a, b\) => \(a > b \? a : b\)\)/.test(load), 'recentDates 无序取最大日期')
ok(/Math\.max\(0, util\.daysBetween\(lastDate, today\)\)/.test(load), 'gap = daysBetween(最近记账日,今天) 且非负')
ok(/lastRecordGap,\s*\n\s*aiCards,/.test(load), 'setData 写入 lastRecordGap + aiCards')
ok(/dbApi\.listRecurring\(\)/.test(load), 'fire-and-forget 拉取 listRecurring')
ok(/seq === this\._loadSeq/.test(load.split('dbApi.listRecurring')[1] || ''), 'recurring 回调带 seq 竞态防护')
ok(/\.catch\(\(\) => \{\}\)/.test(load.split('dbApi.listRecurring')[1] || ''), 'recurring 拉取失败静默')
// aiCards 构造
ok(/filter\(\(c\) => c\.status !== 'paid'\)/.test(load), 'aiCards 只取未还卡')
ok(/days: util\.daysBetween\(today, util\.calcDueDate\(c\.repayDay, 'pending'\)\)/.test(load), 'aiCards.days 用 calcDueDate 实时计算')

console.log('== 3. _buildAiStmt ==')
const stmt = fnBody(idx, '_buildAiStmt')
ok(stmt.length > 0, '_buildAiStmt 函数体提取成功')
ok(/lastRecordGap: viewMonth === util\.thisMonthStr\(\) \? this\.data\.lastRecordGap : null/.test(stmt), 'lastRecordGap 仅当前月透传(历史月 null 屏蔽残留值)')
ok(/r\.active !== false && r\.lastRecorded !== viewMonth/.test(stmt), 'pendingRecurring 过滤 active 且 lastRecorded≠当月')
ok(/viewMonth === util\.thisMonthStr\(\)/.test(stmt.split('pendingRecurring')[1] || ''), 'pendingRecurring 仅当前月计算')
ok(/pendingCards: \(this\.data\.aiCards \|\| \[\]\)\.map/.test(stmt), 'pendingCards 从 aiCards 透传(不限月份)')

console.log('== 4. utils/aiChat.js serialize ==')
const ai = read('utils/aiChat.js')
const ser = fnBody(ai, 'serialize')
ok(ser.length > 0, 'serialize 函数体提取成功')
ok(/lastRecordGap:\s*typeof stmt\.lastRecordGap === 'number' \? stmt\.lastRecordGap : null/.test(ser), 'lastRecordGap 数字校验透传')
ok(/pendingRecurring:\s*Array\.isArray\(stmt\.pendingRecurring\) \? stmt\.pendingRecurring : \[\]/.test(ser), 'pendingRecurring 数组校验透传')
ok(/pendingCards:\s*Array\.isArray\(stmt\.pendingCards\) \? stmt\.pendingCards : \[\]/.test(ser), 'pendingCards 数组校验透传')
// 本地模板兜底不注入
const tplStart = ai.indexOf('finTemplate.build({')
const tplBlock = ai.slice(tplStart, ai.indexOf('})', tplStart))
ok(!tplBlock.includes('lastRecordGap') && !tplBlock.includes('pending'), '本地模板兜底不注入新字段')

console.log('== 5. cloudfunctions/finChat/index.js formatDataForLLM ==')
const fc = read('cloudfunctions/finChat/index.js')
const fmt = fnBody(fc, 'formatDataForLLM')
ok(fmt.length > 0, 'formatDataForLLM 函数体提取成功')
ok(/记账状态：/.test(fmt) && /距上次记账已 \$\{d\.lastRecordGap\} 天/.test(fmt), '输出「记账状态：距上次记账已 X 天」')
ok(/d\.lastRecordGap === 1 \? '今天还没记账（昨天记过）'/.test(fmt), 'gap=1 特殊文案「今天还没记账」')
ok(/typeof d\.lastRecordGap === 'number' && d\.lastRecordGap > 0/.test(fmt), 'gap=0(今天记过)不输出,null 跳过')
ok(/本月待记固定支出：/.test(fmt), '输出「本月待记固定支出：…」')
ok(/d\.pendingRecurring\.slice\(0, 6\)\.join\('、'\)/.test(fmt), '待记列表 top-6 顿号连接')
ok(/Array\.isArray\(d\.pendingRecurring\) && d\.pendingRecurring\.length/.test(fmt), 'pendingRecurring 空数组跳过')
ok(/未还信用卡：/.test(fmt), '输出「未还信用卡：…」逐卡明细')
ok(/c\.days < 0 \? `已逾期\$\{-c\.days\}天`/.test(fmt), '逾期卡输出「已逾期N天」')
ok(/c\.days === 0 \? '今天到期'/.test(fmt), '今天到期特殊文案')
ok(/\$\{c\.days\}天后到期/.test(fmt), '未来卡输出「N天后到期」')
ok(/Array\.isArray\(d\.pendingCards\) && d\.pendingCards\.length/.test(fmt), 'pendingCards 空数组(全部还清)跳过')
// 行序:待记固定支出+未还信用卡在固定支出行后;记账状态在今日已支出后、日预算前
const posRecur = fmt.indexOf('固定支出 ¥')
const posPending = fmt.indexOf('本月待记固定支出')
const posCards = fmt.indexOf('未还信用卡')
const posTodayExp = fmt.indexOf('今日已支出')
const posGap = fmt.indexOf('记账状态')
const posDaily = fmt.indexOf('日预算：')
ok(posPending > posRecur, '待记固定支出行位于固定支出行后')
ok(posCards > posPending, '未还信用卡行位于待记固定支出后')
ok(posGap > posTodayExp && posGap < posDaily, '记账状态行位于今日已支出与日预算之间')

console.log('== 6. finReport 副本不受影响 ==')
const fr = read('cloudfunctions/finReport/index.js')
ok(!fr.includes('lastRecordGap') && !fr.includes('pendingCards') && !fr.includes('未还信用卡'), 'finReport 不涉及新字段')

console.log('== 7. 语法检查 ==')
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
