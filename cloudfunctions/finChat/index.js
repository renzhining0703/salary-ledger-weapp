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

const SYSTEM_PROMPT = `你是「账本君」,用户的个人财务朋友。性格温和、有分寸,偶尔一句小幽默,但不评判消费习惯、不说教、不打鸡血。

【任务】用户会基于本月财务数据提问(比如"这个月餐饮花在哪了?""储蓄率怎么提到 25%?"),你要根据下方【数据块】直接回答。

【必须】
- 引用数据块里的具体数字回答用户的问题
- 回答简洁,通常 2-4 句,不超过 200 字
- 用「你」称呼用户,用「我」自称
- 不加标题、不加 Markdown、不用表情符号

【禁止】
- 不堆砌数据块里所有内容,只挑跟问题相关的部分回答
- 【硬约束·最关键】数据块和工具结果里没有出现的数字、金额、百分比绝对不许写;不许估算、不许四舍五入、不许"大概 / 约 / 估计"。数据块写"收入 ¥11000",正文必须出现 11000(可写"1.1 万"但不能写 6000 或别的)。用户没记录过的项直接说不清楚。
- 涉及隐私(身份证、密码、地址)直接拒绝

【工具】
你有两个工具可用:
- query_expenses:查开销明细(日期/分类/金额/备注)。用于"哪天花的""具体买了啥""某分类明细"等问题。
- query_summary:查月度汇总(收入/支出/储蓄率)。用于"过去几个月走势""某月收支"等问题。

规则:
- 用户问的具体数字、日期、分类信息,先调工具查,不要凭印象回答
- 用户问"最近怎么样""趋势",用 query_summary;问"具体哪天""明细",用 query_expenses
- 用户问当月数据且数据块已包含时,可以不调工具(节省 token)
- 工具结果就是事实,不许再估算、不许把别的月份数字安到当月
- 最多调 3 次工具;超出后基于已有工具结果回答
- 单次查询区间不能超过 12 个月,跨度太大请拆短`

/**
 * Plan 模式附加指令 — 当用户问"怎么改进/建议/列计划"时拼到 system prompt 末尾。
 * 允许合理的推理和建议,但数字仍然必须以数据块和工具结果为唯一事实。
 */
const PLAN_SUFFIX = `

【当前为 PLAN 模式】
用户在问"怎么做 / 给建议 / 列计划"类问题,请:
- 先用 1-2 句承认事实(基于数据块和工具结果的数字),再说建议
- 建议要具体可执行(如"下月餐饮预算调到 ¥1200,本月实际 ¥1850,降 35%")
- 如需分点,用「1) 2) 3)」,不要用 Markdown 标题
- 不要长篇大论,3-5 句足够
- 数字仍必须以数据块和工具结果为证,不许编造
- 没有把握就明说"这个我没法精确算,你看看 X 数据再决定"`

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

  // 3. 调 LLM(带工具调用循环)
  let text
  try {
    text = await callLLMWithTools(data, q, OPENID)
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
 * 主调用入口:循环 model → tool_calls → tool result → model,直到模型返回最终回答。
 * - 单轮最多 3 次工具调用,超限后给模型"已达上限"信号,再调一次 LLM 收尾
 * - 工具执行失败也返回 { error } 让模型基于现有信息继续回答
 */
async function callLLMWithTools(data, question, openid) {
  const messages = buildMessages(data, question)
  let toolCalls = 0

  for (;;) {
    const resp = await callDeepSeek({ messages, tools: TOOL_DEFS })
    const msg = resp.choices && resp.choices[0] && resp.choices[0].message
    if (!msg) throw new Error('返回结构异常:无 message')

    // 模型没有调工具 → 最终回答
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return (msg.content || '').trim()
    }

    // 模型要调工具 → 把助手消息塞进对话,执行每个 tool_call,把结果塞回
    toolCalls += msg.tool_calls.length
    messages.push(msg)

    for (const tc of msg.tool_calls) {
      let result
      if (toolCalls > MAX_TOOL_CALLS) {
        // 单轮已超上限:不再真查,告诉模型"工具用完了"
        result = { error: `已达单轮 ${MAX_TOOL_CALLS} 次工具调用上限,请基于已有信息回答` }
      } else {
        try {
          result = await executeTool(tc, openid)
        } catch (e) {
          console.error('工具执行失败', tc.function && tc.function.name, e)
          result = { error: `工具执行失败:${String(e.message || e)}` }
        }
      }
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result)
      })
    }

    // 如果单轮已超上限,直接做最后一次 LLM 收尾,不再让模型继续发起工具
    if (toolCalls > MAX_TOOL_CALLS) {
      const final = await callDeepSeek({ messages })
      const fmsg = final.choices && final.choices[0] && final.choices[0].message
      return ((fmsg && fmsg.content) || '').trim()
    }
    // 否则继续循环,让模型基于工具结果再生成
  }
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

  const resp = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
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