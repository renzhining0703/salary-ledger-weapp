/**
 * 账本君对话核心(纯函数 + 一个云函数副作用)
 *
 * 设计原则:
 * - 不直接读写 page.data / globalData
 * - caller 负责管理 messages / scroll / 节流标志位
 * - aiChat.send 只负责「问一次,拿到一次回答」
 *
 * 复用入口:
 * - 首页 chat sheet(pages/index/index.js sendAiChat)
 * - 记账页账单 sheet 内的 chat(pages/expenses/expenses.js sendChat)
 *
 * 行为:
 * 1. 调云函数 finChat,8s 超时
 * 2. 拿到 result.text → 返回 { source: 'llm', text }
 * 3. result.code === 'RATE_LIMIT' → 返回限流文案
 * 4. 超时 / NO_KEY → 用 finTemplate 兜底
 * 5. 其他失败 → 返回通用兜底文案
 */

const finTemplate = require('./finTemplate')

/**
 * @param {object} opts
 * @param {string} opts.month     'YYYY-MM'
 * @param {object} opts.stmt      statement blob(income/expense/balance/savingsRate/categories/...)
 * @param {Array}  opts.recentList 最近 30 条明细(给 LLM 看到具体买了啥)
 * @param {string} opts.question  用户问题
 * @param {string} [opts.mode='chat']  'chat' 纯问答;'record' 启用 addExpense 工具(账本君记账)
 * @param {Array}  [opts.history] 多轮上下文(buildHistory 产物,最近 12 条 user/assistant)
 * @returns {Promise<{ text: string, source: 'llm'|'local'|'tool', code?: string, toolResult?: object }>}
 */
async function send({ month, stmt, recentList, question, mode = 'chat', history }) {
  let result = null
  let timedOut = false
  let transportError = null  // 捕获 wx.cloud.callFunction fail 回调里的 error(没部署/网络/鉴权时无 result.msg)
  try {
    result = await new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        timedOut = true
        reject(new Error('云函数超时'))
      }, 8000)
      wx.cloud.callFunction({
        name: 'finChat',
        data: {
          month,
          question,
          mode,                                  // 'chat' | 'record',账本君记账用 'record'
          data: serialize(stmt, recentList),
          history: Array.isArray(history) ? history : []  // 多轮上下文,云端二次清洗
        },
        success: (r) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve((r && r.result) || null)
        },
        fail: (e) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(e)
        }
      })
    })
  } catch (e) {
    transportError = e
    console.warn('finChat 调用失败', e)
  }

  const code = result && result.code
  if (result && result.text) {
    // 云函数在工具调用成功时会返回 { source: 'tool', text, toolResult }
    // 透传 source + toolResult,前端据此决定是否展示撤销气泡、刷新数据
    return {
      text: result.text,
      source: result.source || 'llm',
      toolResult: result.toolResult || null
    }
  }
  if (code === 'RATE_LIMIT') {
    return { text: result.msg || '问得有点急,稍等再问', source: 'local' }
  }
  if (code === 'NO_DATA') {
    return { text: result.msg || '本月还没有任何数据,先记几笔吧', source: 'local' }
  }
  if (code === 'NO_KEY' || timedOut) {
    // 本地模板兜底
    const tpl = finTemplate.build({
      monthText: stmt.monthText,
      income: stmt.income,
      expense: stmt.expense,
      balance: stmt.balance,
      savingsRate: stmt.savingsRate,
      prevMonthExpense: stmt.prevMonthExpense,
      prevYearExpense: stmt.hasPrevYear ? stmt.prevYearExpense : undefined,
      hasPrevYear: stmt.hasPrevYear,
      recurTotal: stmt.recurTotal,
      categories: stmt.categories,
      budgetOver: stmt.budgetOver,
      budgetNear: stmt.budgetNear,
      overCategories: stmt.overCategories
    })
    const prefix = timedOut ? '账本君想了太久,先回你本地版:' : '账本君还没拿到口粮,先用本地话答你:'
    return { text: `${prefix}\n${tpl}`, source: 'local' }
  }
  // 其他失败(LLM_FAIL / LLM_EMPTY / result 为空 / 未知 code 等):
  // 把云函数返回的 msg 或 transport 层 error 透传给用户,避免"黑盒"——
  // HTTP 401/500、超时、限流、没部署、网络问题,用户和开发者都能立刻看到原因。
  // 截断到 60 字防气泡被错误信息撑爆;带 code 前缀便于一眼看出是云函数报错而非 LLM 内容。
  console.warn('finChat 返回异常 result=', result, 'timedOut=', timedOut, 'transportError=', transportError) // vConsole 看完整堆栈
  const cloudMsg = (result && result.msg) ? result.msg.slice(0, 60) : ''
  const cloudCode = (result && result.code) ? `${result.code}: ` : ''
  const transportCode = (transportError && transportError.errCode != null) ? `${transportError.errCode} ` : ''
  const transportMsg = transportError ? String(transportError.errMsg || transportError.message || transportError).slice(0, 60) : ''
  const detail = cloudMsg
    ? `${cloudCode}${cloudMsg}`
    : transportMsg
      ? `调用失败: ${transportCode}${transportMsg}`.replace(/\s+/g, ' ').trim()
      : ''
  return {
    text: detail
      ? `账本君这次没接通(${detail}),稍后再问`
      : '账本君暂时没想明白,稍后再问',
    source: 'local'
  }
}

/**
 * 序列化 statement 给云函数,只传 LLM 需要的字段
 * + 最近 30 条明细(按金额倒序)— 解决"买烟哪天"这类问题
 */
function serialize(stmt, recentList) {
  if (!stmt) return null
  const list = (recentList || [])
    .slice()
    .sort((a, b) => (b.amount || 0) - (a.amount || 0))
    .slice(0, 30)
    .map((x) => ({
      date: x.date || '',
      category: x.category || '其他',
      amount: x.amount || 0,
      note: (x.note || '').trim()
    }))
  return {
    month: stmt.month,
    monthText: stmt.monthText,
    income: stmt.income,
    expense: stmt.expense,
    balance: stmt.balance,
    savingsRate: stmt.savingsRate,
    // 近 6 个月趋势(首页 loadData 现成数据):AI 免工具即可答"走势/上个月"类问题
    trend: Array.isArray(stmt.trend) ? stmt.trend : [],
    prevMonthExpense: stmt.prevMonthExpense,
    prevYearExpense: stmt.hasPrevYear ? stmt.prevYearExpense : undefined,
    hasPrevYear: stmt.hasPrevYear,
    recurTotal: stmt.recurTotal,
    categories: stmt.categories,
    budget: stmt.budget || 0,        // 用户总预算(¥),让 AI 知道"还剩多少能花"
    budgetOver: stmt.budgetOver,
    budgetNear: stmt.budgetNear,
    overCategories: stmt.overCategories,
    recentList: list
  }
}

/**
 * 从会话消息里提取多轮上下文,让"那上个月呢""再具体点"类追问可被理解。
 * - 只留 user/assistant + 非空字符串 content,单条截 400 字
 * - 取最近 12 条(约 6 轮);输出只含 role/content,剥离 ts/undoable/toolResult 等页面字段
 * - 云端 sanitizeHistory 会再做一遍同规格清洗(双保险,防伪造入参)
 * @param {Array} messages 完整会话消息(不含即将发送的本条问题)
 * @returns {Array<{role: 'user'|'assistant', content: string}>}
 */
function buildHistory(messages) {
  if (!Array.isArray(messages)) return []
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant')
      && typeof m.content === 'string' && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 400) }))
}

module.exports = { send, buildHistory }