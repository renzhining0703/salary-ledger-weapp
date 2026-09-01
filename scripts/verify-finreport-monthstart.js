/**
 * 验证：账单页 AI 总结月初失真修复
 *
 * 背景 bug：9月2日,收入 ¥0、支出 ¥179、固定支出 ¥4100,
 *          formatDataForLLM 算出「固定支出占 2289%」塞给 LLM;
 *          且数据块没有累计可用/历史结余,AI 无从知道有上月结转。
 *
 * 验证方式：静态断言 + 抽取 formatDataForLLM 函数源码实跑失真场景。
 * 运行：node scripts/verify-finreport-monthstart.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const finReportPath = path.join(ROOT, 'cloudfunctions/finReport/index.js')
const stmtPath = path.join(ROOT, 'pages/statement/statement.js')

const finReport = fs.readFileSync(finReportPath, 'utf8')
const stmt = fs.readFileSync(stmtPath, 'utf8')

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

/* ---------- 抽取 formatDataForLLM 函数源码并实跑 ---------- */
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) return null
  // 从函数体起点找配对的大括号
  let depth = 0
  let i = src.indexOf('{', start)
  const begin = i
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
}

const fnSrc = extractFn(finReport, 'formatDataForLLM')
const formatDataForLLM = fnSrc ? new Function(`${fnSrc}; return formatDataForLLM`)() : null

console.log('\n== 一、失真场景实跑（9月2日 / 收入0 / 支出179 / 固定支出4100 / 含结转） ==')
const userScenario = {
  monthText: '2026年9月',
  today: '2026-09-02',
  income: 0,
  expense: 179,
  balance: -179,
  savingsRate: 0,
  available: 6200,
  carriedOver: 4379,
  prevMonthExpense: 4100,
  recurTotal: 4100,
  categories: [{ name: '餐饮', amount: 179, budget: 0, over: false, topNotes: [] }],
  budgetOver: false,
  budgetNear: false,
  overCategories: []
}
const text = formatDataForLLM ? formatDataForLLM(userScenario) : ''
console.log('---- 数据块输出 ----')
console.log(text)
console.log('--------------------')

check('formatDataForLLM 可被抽取执行', !!text)
check('不再出现 2289% 类失真比率', !/占已支出 ?2\d{3}%/.test(text), text.match(/占 ?\d{3,}%.*固定/))
check('固定支出降级为"全月应付口径,不算占比"', /全月应付口径/.test(text))
check('储蓄率在收入为 0 时不输出', !/储蓄率/.test(text))
check('包含累计可用余额', /可用余额 ¥6200/.test(text))
check('包含历史结转金额', /含历史结转 ¥4379/.test(text))
check('包含今天日期(月初语境)', /今天：2026-09-02（本月第 2 天/.test(text))
check('月初标注"当月数据还不完整"', /月初，当月数据还不完整/.test(text))
check('月初环比标注参考价值低', /月初环比参考价值低/.test(text))

console.log('\n== 二、正常月中场景实跑（15号发薪后,大支出,占比应保留） ==')
const midMonth = {
  monthText: '2026年8月',
  today: '2026-08-20',
  income: 12500,
  expense: 3850,
  balance: 8650,
  savingsRate: 69,
  available: 24000,
  carriedOver: 15350,
  prevMonthExpense: 3420,
  recurTotal: 2000,
  categories: [{ name: '餐饮', amount: 1200, budget: 1500, over: false, topNotes: [] }],
  budgetOver: false,
  budgetNear: false,
  overCategories: []
}
const text2 = formatDataForLLM ? formatDataForLLM(midMonth) : ''
console.log('---- 数据块输出 ----')
console.log(text2)
console.log('--------------------')

check('月中(20日)不标月初', !/月初/.test(text2))
check('月中储蓄率正常输出', /储蓄率 69%/.test(text2))
check('正常占比保留（固定支出占已支出 52%）', /占已支出 52%/.test(text2))
check('累计可用 + 结转均输出', /可用余额 ¥24000/.test(text2) && /含历史结转 ¥15350/.test(text2))
check('月中环比无降级标注', !/参考价值低/.test(text2))

console.log('\n== 三、历史月（不传 today）不应输出日期行 ==')
const histMonth = { monthText: '2026年8月', income: 12500, expense: 3850, balance: 8650, savingsRate: 69, recurTotal: 2000 }
const text3 = formatDataForLLM ? formatDataForLLM(histMonth) : ''
check('历史月不输出「今天」行', !/今天/.test(text3))
check('历史月不误标月初', !/月初/.test(text3))

console.log('\n== 四、statement.js 传参断言 ==')
check('_buildStatement 返回原始 available/carriedOver 数字', /available,\s*\n\s*carriedOver,/.test(stmt))
check('_callFinReport 传 available', /available:\s*stmt\.available/.test(stmt))
check('_callFinReport 传 carriedOver', /carriedOver:\s*stmt\.carriedOver/.test(stmt))
check('_callFinReport 仅当前月传 today', /stmt\.month === nowMonth/.test(stmt) && /today,/.test(stmt))

console.log('\n== 五、finReport 云函数断言 ==')
check('SYSTEM_PROMPT 含月初场景规则', /# 月初场景/.test(finReport))
check('SYSTEM_PROMPT 禁止跨口径算占比', /禁止对不同口径的数字/.test(finReport))
check('SYSTEM_PROMPT 指引月初参考累计可用', /累计可用余额」评价余粮/.test(finReport))
check('savingsRate 有 income > 0 护栏', /savingsRate === 'number' && d\.income > 0/.test(finReport))
check('固定支出占比有 expense >= 500 护栏', /d\.expense >= 500 && pct <= 200/.test(finReport))
check('缓存版本常量存在', /CACHE_VER = 2/.test(finReport))
check('缓存写入带版本号', /ver: CACHE_VER/.test(finReport))
check('旧版本缓存视为未命中', /doc\.ver !== CACHE_VER/.test(finReport))

/* ---------- 语法检查 ---------- */
console.log('\n== 六、语法检查 ==')
const { execFileSync } = require('child_process')
try {
  execFileSync('node', ['--check', finReportPath], { stdio: 'pipe' })
  check('finReport/index.js 语法合法', true)
} catch (e) {
  check('finReport/index.js 语法合法', false, String(e.stderr || e))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
