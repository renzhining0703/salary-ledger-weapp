/**
 * 云函数 finReport：根据本月财务数据生成一段「本月财务小报告」。
 *
 * 部署步骤（一次即可）：
 *  1. 云开发控制台 → 云函数 → 新建 → 上传本目录
 *  2. 在该函数的「配置 → 环境变量」添加：
 *       LLM_API_KEY  = 你的 DeepSeek key
 *       LLM_BASE_URL = https://api.deepseek.com   (可选,有默认值)
 *       LLM_MODEL    = deepseek-chat              (可选)
 *  3. 在「云开发 → 数据库」新建集合 finReports,权限「仅创建者可读写」
 *
 * 缓存策略：同 _openid + month 已存在 finReports 文档时直接返回,不再扣费。
 * 前端在用户改动当月数据时通过 db.js 调 invalidateFinCache(month) 删除该缓存。
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

const SYSTEM_PROMPT = `你是「账本君」,用户的私人财务助手,负责给每月账单写一段解读。语气像懂行的朋友:平和、克制、可以偶尔自嘲一句(比如"算账算到我头秃"),但绝不评判消费、不说教。

# 输入
用户消息是一段数据块,包含:本月收支(收入/支出/结余/储蓄率)、对比(环比/同比)、分类明细(金额/占比/预算状态)、固定支出占比、预算状态。这是唯一事实来源,数据块之外的信息你一概不知。

# 写法
1. 先想清楚信息量最大的 2-3 个点,按此优先级挑选:
   超预算项 > 环比/同比涨跌最明显的分类 > 储蓄率明显偏低(<10%)或为负 > 占比最大的分类
   表现平稳的分类一句带过或不提
2. 结构:第一句总评本月(收入/支出/结余的核心数字),中间讲 1-2 个重点变化,收尾给一条可执行的小建议,建议要落到数字(如"餐饮额度还剩 ¥200,收着点花能守住预算")
3. 长度 80-130 字,2-4 句,每句一行,自然口语段落
4. 用「你」称呼用户、用「我」自称

# 硬约束(最高优先级,违反即废稿)
- 正文出现的每一个数字必须来自数据块,或由数据块数字精确算出(如差额、占比换算)
- 11000 可以写成"1.1 万",但不许出现数据块之外的任何数
- 不许估算、不许"大概 / 约 / 估计"
- 禁止没有信息量的短语:「合理规划」「开源节流」「理性消费」「继续加油」
- 不加标题、不用 Markdown、不用表情符号、不堆砌全部分类`

/* ---------------- 入口 ---------------- */
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { month, data, force } = event || {}

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return { code: 'BAD_ARG', msg: 'month 必须是 YYYY-MM' }
  }
  if (!data || typeof data !== 'object') {
    return { code: 'BAD_ARG', msg: '缺少 data' }
  }

  // 1. 缓存命中
  if (!force) {
    const cached = await safeFind(OPENID, month)
    if (cached) {
      return { source: 'cache', text: cached.text, createdAt: cached.createdAt }
    }
  }

  // 2. 未配置 key：直接返回 error,前端走模板兜底
  if (!API_KEY) {
    return { code: 'NO_KEY', msg: 'LLM_API_KEY 未配置' }
  }

  // 3. 调 LLM
  let text
  try {
    text = await callLLM(data)
  } catch (e) {
    console.error('finReport LLM 失败', e)
    return { code: 'LLM_FAIL', msg: String(e.message || e) }
  }

  if (!text || text.length < 10) {
    return { code: 'LLM_EMPTY', msg: '模型返回为空' }
  }

  // 4. 写缓存（先删旧的 upsert）
  try {
    await db.collection('finReports').where({ _openid: OPENID, month }).remove()
    await db.collection('finReports').add({
      data: {
        // 必须显式写 _openid：云函数端 add 不会自动注入（只有小程序端 SDK 才会）。
        // 缺了它 safeFind 按 _openid+month 永远查不到 → 缓存永不命中、每次都调 LLM 烧钱，
        // 且前端 invalidateFinCache 在「仅创建者可读写」权限下也删不掉这个无主文档。
        _openid: OPENID,
        month,
        text,
        model: MODEL,
        createdAt: db.serverDate()
      }
    })
  } catch (e) {
    console.error('finReport 缓存写入失败', e)
    // 不影响返回,本次解读依然有效
  }

  return { source: 'llm', text }
}

/* ---------------- helpers ---------------- */
async function safeFind(openid, month) {
  try {
    const r = await db.collection('finReports').where({ _openid: openid, month }).limit(1).get()
    return r.data[0] || null
  } catch (e) {
    // 集合未创建时视作无缓存
    if (e && (e.errCode === -502005 || /not exist/i.test(e.errMsg || ''))) return null
    throw e
  }
}

async function callLLM(data) {
  const url = `${BASE_URL}/v1/chat/completions`
  const userMsg = formatDataForLLM(data)
  const body = {
    model: MODEL,
    temperature: 0.5,
    max_tokens: 280,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg }
    ]
  }
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
  const text = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content
  if (!text) throw new Error('返回结构异常')
  return text.trim()
}

/**
 * 把结构化数据压成自然语言,让 LLM 看到完整事实。
 * 字段空缺就跳过,不构造假数据。
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

  // 同比/环比
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

  // 分类
  if (Array.isArray(d.categories) && d.categories.length) {
    const items = d.categories
      .filter((c) => c.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 4)
      .map((c) => {
        const pct = d.expense > 0 ? Math.round((c.amount / d.expense) * 100) : 0
        const budgetTxt = typeof c.budget === 'number' && c.budget > 0
          ? (c.over ? `超 ¥${(c.amount - c.budget).toFixed(0)}` : `剩 ¥${(c.budget - c.amount).toFixed(0)}`)
          : '未设预算'
        const noteTxt = Array.isArray(c.topNotes) && c.topNotes.length
          ? `备注：${c.topNotes.join('、')}`
          : ''
        return noteTxt
          ? `${c.name} ¥${c.amount.toFixed(0)}(${pct}%,${budgetTxt});${noteTxt}`
          : `${c.name} ¥${c.amount.toFixed(0)}(${pct}%,${budgetTxt})`
      })
    if (items.length) lines.push(`分类（降序）：${items.join('，')}`)
  }

  // 固定支出
  if (typeof d.recurTotal === 'number' && d.recurTotal > 0 && d.expense) {
    const pct = Math.round((d.recurTotal / d.expense) * 100)
    lines.push(`固定支出 ¥${d.recurTotal.toFixed(0)}（占 ${pct}%）`)
  }

  // 状态标签
  const tags = []
  if (d.budgetOver) tags.push('总预算已超')
  else if (d.budgetNear) tags.push('总预算接近上限')
  if (d.overCategories && d.overCategories.length) {
    tags.push(`超预算分类：${d.overCategories.join('、')}`)
  }
  if (tags.length) lines.push(`状态：${tags.join('；')}`)

  return lines.join('\n')
}
