/**
 * 云函数 finChat：账本君对话问答
 *
 * 用户在「本月账单」sheet 里点 ✏️ 问他点什么,发问到这里。
 * 每次问题都重新注入当月数据块,模型可按需调工具查历史/明细(DeepSeek function calling)。
 *
 * 部署步骤：
 *  1. 上传本目录到云函数,环境变量与 finReport 一致（LLM_API_KEY / LLM_BASE_URL / LLM_MODEL）
 *  2. 创建数据库集合 finChatRate,权限「仅创建者可读写」（用于限流计数）
 *
 * 限流：每用户每分钟 ≤10 次、每天 ≤100 次。
 * 前端另外有 UI 层 throttle（每分钟 6 次）做软兜底。
 *
 * 工具能力（让模型按需查数据,而不是提前塞）：
 *  - query_expenses：查开销明细（日期/分类/金额/备注）
 *  - query_summary：查月度汇总（收入/支出/储蓄率）
 * 单轮最多 3 次工具调用;查询区间不超过 12 个月。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// Node 16 没有全局 fetch,用 undici 兜底;Node 18+ 走原生
const fetchFn = typeof fetch === 'function' ? fetch : require('undici').fetch

const API_KEY = process.env.LLM_API_KEY
const BASE_URL = process.env.LLM_BASE_URL || 'https://api.deepseek.com'
const MODEL = process.env.LLM_MODEL || 'deepseek-chat'

// 限流阈值
const RATE_PER_MIN = 10
const RATE_PER_DAY = 100

// 单轮最多工具调用次数(防死循环 + 防 token 爆)
const MAX_TOOL_CALLS = 3
// 工具查询区间上限(月份数)
const MAX_MONTH_SPAN = 12

const SYSTEM_PROMPT = `你是「账本君」,用户的私人财务助手。语气像一个懂行的朋友:平和、克制、偶尔轻松一句,但绝不评判消费、不说教、不打鸡血。

# 输入
每轮对话你都会收到:
- 【本月数据】:用户当月收支快照(收支、对比、分类占比、预算状态),是事实基准
- 【用户问题】:用户的提问

# 工具与选择策略
- query_expenses(startMonth, endMonth, category?, limit?):开销明细,含日期/分类/金额/备注
- query_summary(startMonth, endMonth):各月汇总,含收入/支出/结余/储蓄率

按问题类型选:
- 当月数字、分类占比,【本月数据】已有 → 直接答,不调工具
- "哪天花的 / 买了啥 / 某分类明细" → query_expenses
- "最近几个月 / 走势 / 去年" → query_summary
- 组合问题(如"哪个月花得最多、都花在哪") → 先 query_summary 定位异常月,再 query_expenses 查该月明细
- 用户说"这个月 / 上个月 / 最近半年",以【本月数据】里的月份为基准推算区间
- 工具没查到记录就直说没查到,不要编
- 单轮最多 3 次工具调用

# 回答方式
- 先给结论,再给依据,引用具体数字和日期
- 2-4 句、200 字以内,口语化;用「你」称呼用户、用「我」自称
- 只挑与问题相关的数字,不罗列整个数据块
- 问题含糊时,按最可能的含义直接回答并顺带说明你的理解,不要反问一堆
- 不加标题、不用 Markdown、不用表情符号

# 硬约束(最高优先级,优先于以上所有规则)
- 回答中的每一个数字,必须能在【本月数据】或工具结果里找到,或由它们精确算出(如差额、占比)
- 不许估算、不许"大概 / 约 / 估计 / 可能几千";算不准就明说"这个我算不准"
- 用户没记录的项,直接说没有记录
- 涉及身份证、密码、住址等隐私,直接拒绝`

/**
 * Plan 模式附加指令 — 当用户问"怎么改进/建议/列计划"时拼到 system prompt 末尾。
 * 允许合理的推理和建议,但数字仍然必须以数据块和工具结果为唯一事实。
 */
const PLAN_SUFFIX = `

【当前为 PLAN 模式】用户在问"怎么做 / 给建议 / 列计划"。按此结构回答:
1. 第一句:一句话结论,基于数据的现状(如"餐饮超了 ¥350,是本月支出的主因")
2. 中间:2-3 条建议,每条具体可执行——动哪个分类、参考值多少、怎么落地;数字必须来自数据块或工具结果
3. 结尾:如果建议依赖推算(如"降到 ¥1200 会怎样"),必须现场精确算;算不出就明说不确定

分点用「1) 2) 3)」,不用 Markdown 标题,总长 3-6 句。数字纪律不变:只准引用数据块与工具结果里的数字及其精确换算。`

/* ---------------- 工具定义(OpenAI tools schema) ---------------- */
const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'query_expenses',
      description: '查询用户开销明细。可指定月份区间和分类。返回按金额降序的列表(最多 limit 条)。用于回答"哪天花了什么""某分类具体开销"等问题。',
      parameters: {
        type: 'object',
        properties: {
          startMonth: { type: 'string', description: '起始月份 YYYY-MM,含', pattern: '^\\d{4}-\\d{2}$' },
          endMonth:   { type: 'string', description: '结束月份 YYYY-MM,含', pattern: '^\\d{4}-\\d{2}$' },
          category:   { type: 'string', description: '可选:分类名(如「餐饮」「孩子」),不传则查全部分类' },
          limit:      { type: 'number', description: '最多返回条数,默认 30,最大 100', minimum: 1, maximum: 100 }
        },
        required: ['startMonth', 'endMonth']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'query_summary',
      description: '查询用户月度汇总(收入/支出/储蓄率)。可指定月份区间。用于回答"过去几个月走势""某月收支"等问题。',
      parameters: {
        type: 'object',
        properties: {
          startMonth: { type: 'string', description: '起始月份 YYYY-MM,含', pattern: '^\\d{4}-\\d{2}$' },
          endMonth:   { type: 'string', description: '结束月份 YYYY-MM,含', pattern: '^\\d{4}-\\d{2}$' }
        },
        required: ['startMonth', 'endMonth']
      }
    }
  }
]

/* ---------------- 入口 ---------------- */
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { month, question, data } = event || {}

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return { code: 'BAD_ARG', msg: 'month 必须是 YYYY-MM' }
  }
  if (!question || typeof question !== 'string') {
    return { code: 'BAD_ARG', msg: '缺少 question' }
  }
  const q = question.trim().slice(0, 80)
  if (!q) return { code: 'BAD_ARG', msg: '问题不能为空' }
  if (!data || typeof data !== 'object') {
    return { code: 'BAD_ARG', msg: '缺少 data' }
  }

  // 1. 频次限流
  try {
    const rate = await checkRate(OPENID)
    if (!rate.ok) {
      return { code: 'RATE_LIMIT', msg: rate.msg }
    }
  } catch (e) {
    // 限流集合未创建时静默放行(避免阻塞用户)
    if (!(e && (e.errCode === -502005 || /not exist/i.test(e.errMsg || '')))) {
      console.warn('finChat 限流检查失败', e)
    }
  }

  // 2. 未配 key:返回 error,前端走本地模板
  if (!API_KEY) {
    return { code: 'NO_KEY', msg: 'LLM_API_KEY 未配置' }
  }

  // 3. 调 LLM(单次调用,不带工具)
  // data 里 categories(分类+备注) + recentList(近 30 条明细)已经足够回答大部分问题
  // 工具调用循环在 data 较空时会反复调 → 拖到云函数 30s 超时 → 504003
  let text
  try {
    text = await callLLM(data, q)
  } catch (e) {
    console.error('finChat LLM 失败', e)
    return { code: 'LLM_FAIL', msg: String(e.message || e) }
  }

  if (!text || text.length < 4) {
    return { code: 'LLM_EMPTY', msg: '模型返回为空' }
  }

  return { source: 'llm', text: text.trim() }
}

/* ---------------- helpers ---------------- */

/**
 * 频次限流：finChatRate 集合里每个 _openid 一条文档,ts 数组存最近调用时间戳。
 * 返回 { ok: true } 或 { ok: false, msg: '...' }
 */
async function checkRate(openid) {
  // 缺 openid(测试模式 / 上下文异常)直接放行,避免阻塞
  if (!openid || typeof openid !== 'string') {
    return { ok: true }
  }
  const now = Date.now()
  const col = db.collection('finChatRate')
  const r = await col.where({ _openid: openid }).limit(1).get()
  const doc = r.data[0]
  let ts = (doc && Array.isArray(doc.ts)) ? doc.ts : []
  // 剔 24h 前 + 60s 前的(留着只是为了统计,不再二次过滤)
  ts = ts.filter((t) => now - t < 86400000)
  const lastMin = ts.filter((t) => now - t < 60000)

  if (lastMin.length >= RATE_PER_MIN) {
    return { ok: false, msg: '问得有点急,稍等再问' }
  }
  if (ts.length >= RATE_PER_DAY) {
    return { ok: false, msg: '今天问得够多了,明天再来' }
  }

  ts.push(now)
  if (doc) {
    await col.doc(doc._id).update({ data: { ts, updatedAt: db.serverDate() } })
  } else {
    await col.add({ data: { ts, createdAt: db.serverDate() } })
  }
  return { ok: true }
}

/**
 * 主调用入口:单次 LLM 调用,基于 data 直接回答。
 * 之前是 model → tool_calls → tool result → model 的循环,空 data 时模型会反复调工具,
 * 拖到云函数 30s 超时 → 504003。现在直接单次调用,data 已含分类 + 近 30 条明细,够用。
 */
async function callLLM(data, question) {
  const messages = buildMessages(data, question)
  const resp = await callDeepSeek({ messages })
  const msg = resp.choices && resp.choices[0] && resp.choices[0].message
  if (!msg) throw new Error('返回结构异常:无 message')
  return (msg.content || '').trim()
}

function buildMessages(data, question) {
  const dataBlock = formatDataForLLM(data)
  const isPlan = /怎么|建议|计划|如何|能不能|应该|可以|帮我|想|要不要/.test(question)
  const systemContent = isPlan ? SYSTEM_PROMPT + PLAN_SUFFIX : SYSTEM_PROMPT
  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: `【本月数据】\n${dataBlock}` },
    { role: 'user', content: `【用户问题】\n${question}` }
  ]
}

async function callDeepSeek({ messages, tools }) {
  const url = `${BASE_URL}/v1/chat/completions`
  const body = {
    model: MODEL,
    temperature: 0.7,
    max_tokens: 700,
    messages
  }
  if (tools) body.tools = tools

  // 主动 20s 超时(云函数默认 30s,留 10s 余量给后续处理)
  // 单次 LLM 调用正常 1~3s,20s 兜底够用,避免拖到云函数层 504003
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)

  let resp
  try {
    resp = await fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
  }

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`)
  }
  const json = await resp.json()
  if (!json.choices || !json.choices[0]) throw new Error('返回结构异常:无 choices')
  return json
}

/* ---------------- 工具执行 ---------------- */

async function executeTool(tc, openid) {
  const name = tc.function && tc.function.name
  let args = {}
  try {
    args = JSON.parse(tc.function.arguments || '{}')
  } catch (e) {
    return { error: '参数解析失败' }
  }

  // 安全校验
  const err = validateToolArgs(name, args)
  if (err) return err

  if (name === 'query_expenses') {
    return queryExpenses(args, openid)
  }
  if (name === 'query_summary') {
    return querySummary(args, openid)
  }
  return { error: `未知工具:${name}` }
}

async function queryExpenses({ startMonth, endMonth, category, limit = 30 }, openid) {
  const start = startMonth + '-01'
  const end = monthNext(endMonth) + '-01'
  const cap = Math.min(limit || 30, 100)
  const where = {
    _openid: openid,
    date: _.gte(start).and(_.lt(end)),
    deleted: _.neq(true)
  }
  if (category) where.category = category

  const r = await db.collection('expenses').where(where).limit(cap).get()
  // 按金额降序(数据库 orderBy 复合索引麻烦,JS 内排序)
  r.data.sort((a, b) => (b.amount || 0) - (a.amount || 0))
  const items = r.data.slice(0, cap).map((x) => ({
    date: x.date,
    category: x.category,
    amount: x.amount,
    note: (x.note || '').trim()
  }))
  return { count: r.data.length, items }
}

async function querySummary({ startMonth, endMonth }, openid) {
  const start = startMonth + '-01'
  const end = monthNext(endMonth) + '-01'
  const [expR, salR] = await Promise.all([
    db.collection('expenses')
      .where({ _openid: openid, date: _.gte(start).and(_.lt(end)), deleted: _.neq(true) })
      .limit(2000).get(),
    db.collection('salary')
      .where({ _openid: openid, payDate: _.gte(start).and(_.lt(end)), deleted: _.neq(true) })
      .limit(200).get()
  ])
  const months = []
  let cur = startMonth
  while (cur <= endMonth) {
    const exp = expR.data.filter((x) => (x.date || '').startsWith(cur)).reduce((s, x) => s + x.amount, 0)
    const inc = salR.data.filter((x) => (x.payDate || '').startsWith(cur)).reduce((s, x) => s + x.amount, 0)
    const bal = inc - exp
    months.push({
      month: cur,
      income: inc,
      expense: exp,
      balance: bal,
      savingsRate: inc > 0 ? Math.round((bal / inc) * 100) : 0
    })
    cur = monthNext(cur)
  }
  return { months }
}

/* ---------------- 日期/校验 ---------------- */

/**
 * 月份字符串的下一月。'2026-08' → '2026-09','2026-12' → '2027-01'。
 * Date 第 13 月会自动跨年,正好用上。
 */
function monthNext(monthStr) {
  const [y, m] = monthStr.split('-').map(Number)
  const d = new Date(y, m, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 计算包含端点的月份跨度。'2026-01' 到 '2026-12' = 12,'2025-08' 到 '2026-08' = 13。
 */
function monthSpan(start, end) {
  const [y1, m1] = start.split('-').map(Number)
  const [y2, m2] = end.split('-').map(Number)
  return (y2 - y1) * 12 + (m2 - m1) + 1
}

function validateToolArgs(toolName, args) {
  if (toolName === 'query_expenses' || toolName === 'query_summary') {
    if (!/^\d{4}-\d{2}$/.test(args.startMonth) || !/^\d{4}-\d{2}$/.test(args.endMonth)) {
      return { error: '月份格式必须是 YYYY-MM' }
    }
    if (args.startMonth > args.endMonth) {
      return { error: '起始月份不能晚于结束月份' }
    }
    const span = monthSpan(args.startMonth, args.endMonth)
    if (span > MAX_MONTH_SPAN) {
      return { error: `查询区间不能超过 ${MAX_MONTH_SPAN} 个月` }
    }
  }
  return null
}

/**
 * 把结构化数据压成自然语言,让 LLM 看到完整事实。
 * 注：与 cloudfunctions/finReport/index.js 中同名函数复制而来,
 * 改动格式时两处同步修改。
 *
 * 当月全景精简：近月趋势 + 明细查询交给 query_summary / query_expenses 工具按需查,
 * 这里只保留回答"本月问题"必需的事实(收支/对比/分类/固定支出/状态)。
 */
function formatDataForLLM(d) {
  const lines = []
  lines.push(`本月：${d.monthText || d.month}`)

  const fin = []
  if (typeof d.income === 'number') fin.push(`收入 ¥${d.income.toFixed(0)}`)
  if (typeof d.expense === 'number') fin.push(`支出 ¥${d.expense.toFixed(0)}`)
  if (typeof d.balance === 'number') {
    const sign = d.balance >= 0 ? '+' : '-'
    fin.push(`结余 ${sign}¥${Math.abs(d.balance).toFixed(0)}`)
  }
  if (typeof d.savingsRate === 'number') fin.push(`储蓄率 ${d.savingsRate.toFixed(0)}%`)
  if (fin.length) lines.push(`收支：${fin.join('，')}`)

  const cmp = []
  if (typeof d.prevMonthExpense === 'number' && d.expense) {
    const diff = d.expense - d.prevMonthExpense
    const pct = d.prevMonthExpense > 0 ? (diff / d.prevMonthExpense) * 100 : 0
    const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '·'
    cmp.push(`上月支出 ¥${d.prevMonthExpense.toFixed(0)}（环比 ${arrow}${Math.abs(pct).toFixed(1)}%）`)
  }
  if (typeof d.prevYearExpense === 'number' && d.expense && d.hasPrevYear) {
    const diff = d.expense - d.prevYearExpense
    const pct = d.prevYearExpense > 0 ? (diff / d.prevYearExpense) * 100 : 0
    const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '·'
    cmp.push(`去年同月 ¥${d.prevYearExpense.toFixed(0)}（同比 ${arrow}${Math.abs(pct).toFixed(1)}%）`)
  }
  if (cmp.length) lines.push(`对比：${cmp.join('，')}`)

  if (Array.isArray(d.categories) && d.categories.length) {
    const items = d.categories
      .filter((c) => c.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 6)
      .map((c) => {
        const pct = d.expense > 0 ? Math.round((c.amount / d.expense) * 100) : 0
        const budgetTxt = typeof c.budget === 'number' && c.budget > 0
          ? (c.over ? `超 ¥${(c.amount - c.budget).toFixed(0)}` : `剩 ¥${(c.budget - c.amount).toFixed(0)}`)
          : '未设预算'
        const noteTxt = Array.isArray(c.topNotes) && c.topNotes.length
          ? `备注：${c.topNotes.join('、')}`
          : ''
        // 问答场景给更全的明细(top-6 而非 top-4),并把备注抬到前面方便 LLM 引用
        if (noteTxt) {
          return `${c.name} ¥${c.amount.toFixed(0)}(${pct}%,${budgetTxt});${noteTxt}`
        }
        return `${c.name} ¥${c.amount.toFixed(0)}(${pct}%,${budgetTxt})`
      })
    if (items.length) lines.push(`分类（降序）：${items.join('，')}`)
  }

  if (typeof d.recurTotal === 'number' && d.recurTotal > 0 && d.expense) {
    const pct = Math.round((d.recurTotal / d.expense) * 100)
    lines.push(`固定支出 ¥${d.recurTotal.toFixed(0)}（占 ${pct}%）`)
  }

  const tags = []
  if (d.budgetOver) tags.push('总预算已超')
  else if (d.budgetNear) tags.push('总预算接近上限')
  if (d.overCategories && d.overCategories.length) {
    tags.push(`超预算分类：${d.overCategories.join('、')}`)
  }
  if (tags.length) lines.push(`状态：${tags.join('；')}`)

  return lines.join('\n')
}