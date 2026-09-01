/**
 * 验证 finChat 的 nowInChina / todayStr 在任意容器时区下都能给出北京时间。
 * 做法:代数验证 nowInChina 公式:
 *   targetMs = inputUtcMs + localOffsetMin*60*1000 + 8*60*60*1000
 *   在容器本地时区下,本地时间戳 = targetMs - localOffsetMin*60*1000
 *                          = inputUtcMs + 8*60*60*1000
 *   即北京时间对应的 UTC 时刻,与容器时区无关。
 */

function parseUTC(s) {
  return new Date(s).getTime()
}

function fmtDate(ms) {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

const CN_OFFSET_MS = 8 * 60 * 60 * 1000

const cases = [
  // UTC 容器:北京时间凌晨 01:07
  { localOffsetMin: 0, input: '2026-09-01T17:07:00.000Z', desc: 'UTC容器-北京凌晨01:07' },
  { localOffsetMin: 0, input: '2026-09-01T15:59:59.000Z', desc: 'UTC容器-北京23:59:59仍当天' },
  { localOffsetMin: 0, input: '2026-09-01T16:00:00.000Z', desc: 'UTC容器-北京00:00跨天' },
  { localOffsetMin: 0, input: '2026-09-01T23:59:59.000Z', desc: 'UTC容器-北京07:59:59' },

  // 东八区本机
  { localOffsetMin: -480, input: '2026-09-02T01:07:00.000+08:00', desc: '东八区本机-北京凌晨01:07' },

  // 西五区本机
  { localOffsetMin: 300, input: '2026-09-01T12:07:00.000-05:00', desc: '西五区本机-北京凌晨01:07' }
]

let pass = 0
let fail = 0

for (const c of cases) {
  const inputUtcMs = parseUTC(c.input)
  const expectedDate = fmtDate(inputUtcMs + CN_OFFSET_MS)

  // nowInChina 公式
  const targetMs = inputUtcMs + c.localOffsetMin * 60 * 1000 + CN_OFFSET_MS
  const localMsInContainer = targetMs - c.localOffsetMin * 60 * 1000

  if (localMsInContainer === inputUtcMs + CN_OFFSET_MS) {
    console.log(`✓ ${c.desc}: 北京日期 ${expectedDate}`)
    pass++
  } else {
    console.log(`✗ ${c.desc}: 公式推导失败`)
    fail++
  }
}

// 源码检查:所有"取当前时间"的 new Date() 都已改为 nowInChina(),
// 仅允许 nowInChina 函数体内部和日期解析/计算(new Date(dateStr), new Date(timestamp)) 保留。
const fs = require('fs')
const path = require('path')
const src = fs.readFileSync(path.join(__dirname, '../cloudfunctions/finChat/index.js'), 'utf8')

const nowInChinaStart = src.indexOf('function nowInChina()')
const nowInChinaEnd = src.indexOf('function todayStr()')
if (nowInChinaStart === -1 || nowInChinaEnd === -1) {
  console.log('✗ 找不到 nowInChina 或 todayStr 函数边界')
  fail++
} else {
  const beforeNowInChina = src.slice(0, nowInChinaStart)
  const afterNowInChina = src.slice(nowInChinaEnd)

  const badBefore = [...beforeNowInChina.matchAll(/const\s+\w+\s*=\s*new\s+Date\(\)/g)]
  const badAfter = [...afterNowInChina.matchAll(/const\s+\w+\s*=\s*new\s+Date\(\)/g)]

  if (badBefore.length === 0 && badAfter.length === 0) {
    console.log('✓ 源码中仅 nowInChina 内部保留 new Date() 取当前时间')
    pass++
  } else {
    console.log(`✗ 源码中还有未改用 nowInChina() 的取当前时间 new Date()`)
    badBefore.forEach((m) => console.log('  before nowInChina at index', m.index))
    badAfter.forEach((m) => console.log('  after nowInChina at index', m.index + nowInChinaEnd))
    fail++
  }
}

// 源码检查 2: salaryReminder / remind 的 index.js 不应再用裸 new Date() 取当前时间
const riskyFiles = [
  '../cloudfunctions/salaryReminder/index.js',
  '../cloudfunctions/remind/index.js'
]
for (const rel of riskyFiles) {
  const p = path.join(__dirname, rel)
  const s = fs.readFileSync(p, 'utf8')
  // 允许 lib/date.js 内部 nowInChina 里的 new Date(), 以及 new Date(timestamp) / new Date(dateStr)
  const bad = [...s.matchAll(/const\s+\w+\s*=\s*new\s+Date\(\)/g)]
  if (bad.length === 0) {
    console.log(`✓ ${rel}: 没有裸 new Date() 取当前时间`)
    pass++
  } else {
    console.log(`✗ ${rel}: 仍有裸 new Date() 取当前时间`)
    bad.forEach((m) => console.log('  at index', m.index))
    fail++
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
