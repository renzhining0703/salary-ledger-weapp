/**
 * 验证：账本君首页 chat 工资提醒复读与过早提醒修复
 *
 * 背景 bug：
 *   1. 每轮回答都复读"另外提醒一句，这个月好像还没记工资..."
 *   2. 今天 9 月 2 号、发薪日 15 号，提前 13 天就开始提醒。
 *
 * 运行：node scripts/verify-salary-reminder.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const finChatPath = path.join(ROOT, 'cloudfunctions/finChat/index.js')
const finChat = fs.readFileSync(finChatPath, 'utf8')

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

/* ---------- 抽取 formatDataForLLM 实跑 ---------- */
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) return null
  let depth = 0
  let i = src.indexOf('{', start)
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
}

const fnSrc = extractFn(finChat, 'formatDataForLLM')
const formatDataForLLM = fnSrc ? new Function(`${fnSrc}; return formatDataForLLM`)() : null
check('formatDataForLLM 可被抽取', !!formatDataForLLM)

const base = {
  monthText: '2026年9月',
  income: 0,
  expense: 167,
  balance: -167,
  available: 6000,
  savingsRate: 0,
  payday: 15
}

// 1. 用户截图场景：9月2日、发薪日15号 -> 不应提醒
{
  const d = { ...base }
  // formatDataForLLM 内部用 new Date() 取今天，为了稳定测试我们劫持 Date
  const RealDate = Date
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...args.length ? args : [2026, 8, 2, 11, 34, 0])
    }
  }
  Object.setPrototypeOf(global.Date, RealDate)
  global.Date.now = RealDate.now
  const text = formatDataForLLM(d)
  global.Date = RealDate
  console.log('\n---- 场景 A：9月2日，发薪日15号 ----')
  console.log(text)
  check('A-1 过早不提醒：不含"工资提醒"', !/工资提醒/.test(text))
  check('A-2 不含"还没记工资"', !/还没记工资/.test(text))
}

// 2. 发薪日前 2 天（9月13日）且未记工资 -> 应提醒
{
  const RealDate = Date
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...args.length ? args : [2026, 8, 13, 11, 0, 0])
    }
  }
  Object.setPrototypeOf(global.Date, RealDate)
  global.Date.now = RealDate.now
  const text = formatDataForLLM(base)
  global.Date = RealDate
  console.log('\n---- 场景 B：9月13日，发薪日15号 ----')
  console.log(text)
  check('B-1 临近发薪应提醒：含"工资提醒"', /工资提醒/.test(text))
  check('B-2 提醒含"还有2天"', /还有2天/.test(text))
  check('B-3 提醒含"还没记工资"', /还没记工资/.test(text))
}

// 3. 发薪日当天（9月15日）-> 应提醒"今天"
{
  const RealDate = Date
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...args.length ? args : [2026, 8, 15, 11, 0, 0])
    }
  }
  Object.setPrototypeOf(global.Date, RealDate)
  global.Date.now = RealDate.now
  const text = formatDataForLLM(base)
  global.Date = RealDate
  console.log('\n---- 场景 C：9月15日，发薪日当天 ----')
  console.log(text)
  check('C-1 当天应提醒', /工资提醒/.test(text))
  check('C-2 当天提醒含"今天"', /今天/.test(text))
}

// 4. 发薪日后 2 天（9月17日）-> 应提醒"已过期"
{
  const RealDate = Date
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...args.length ? args : [2026, 8, 17, 11, 0, 0])
    }
  }
  Object.setPrototypeOf(global.Date, RealDate)
  global.Date.now = RealDate.now
  const text = formatDataForLLM(base)
  global.Date = RealDate
  console.log('\n---- 场景 D：9月17日，发薪日后2天 ----')
  console.log(text)
  check('D-1 过期应提醒', /工资提醒/.test(text))
  check('D-2 提醒含"已过期2天"', /已过期2天/.test(text))
}

// 5. 发薪日后 8 天 -> 不应再提醒（超出后窗）
{
  const RealDate = Date
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...args.length ? args : [2026, 8, 23, 11, 0, 0])
    }
  }
  Object.setPrototypeOf(global.Date, RealDate)
  global.Date.now = RealDate.now
  const text = formatDataForLLM(base)
  global.Date = RealDate
  check('E 过期8天不提醒', !/工资提醒/.test(text))
}

// 6. 已记工资（income > 0）-> 不应提醒
{
  const RealDate = Date
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...args.length ? args : [2026, 8, 13, 11, 0, 0])
    }
  }
  Object.setPrototypeOf(global.Date, RealDate)
  global.Date.now = RealDate.now
  const text = formatDataForLLM({ ...base, income: 12000 })
  global.Date = RealDate
  check('F 已记工资不提醒', !/工资提醒/.test(text))
}

// 7. 同会话已提醒过 -> 不应再提醒
{
  const RealDate = Date
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...args.length ? args : [2026, 8, 13, 11, 0, 0])
    }
  }
  Object.setPrototypeOf(global.Date, RealDate)
  global.Date.now = RealDate.now
  const text = formatDataForLLM({ ...base, salaryReminded: true })
  global.Date = RealDate
  check('G 同会话已提醒过不再提醒', !/工资提醒/.test(text))
}

/* ---------- prompt 规则断言 ---------- */
console.log('\n== 二、prompt 规则断言 ==')
check('不再有无条件"收入为0但支出>0先提醒"', !/收入为 0 但支出 > 0 → 第一句先提醒/.test(finChat))
check('系统提示改为"只有【本月数据】带工资提醒时才提"', /只有【本月数据】里明确出现「工资提醒/.test(finChat))
check('包含"不要每轮重复"规则', /不要每轮重复|不要再重复/.test(finChat))
check('硬约束含工资提醒触发条件', /工资未记提醒只能由【本月数据】里的「工资提醒」行触发/.test(finChat))

/* ---------- buildMessages 同会话去重断言 ---------- */
check('buildMessages 设置 salaryReminded 标志', /data\.salaryReminded = hist\.some\(\(m\) => m\.role === 'assistant' && \/还没记工资\/\.test\(m\.content\)\)/.test(finChat))

/* ---------- 语法检查 ---------- */
console.log('\n== 三、语法检查 ==')
const { execFileSync } = require('child_process')
try {
  execFileSync('node', ['--check', finChatPath], { stdio: 'pipe' })
  check('finChat/index.js 语法合法', true)
} catch (e) {
  check('finChat/index.js 语法合法', false, String(e.stderr || e))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
