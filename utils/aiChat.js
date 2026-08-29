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
 * @returns {Promise<{ text: string, source: 'llm'|'local', code?: string }>}
 */
async function send({ month, stmt, recentList, question }) {
  let result = null
  let timedOut = false
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
          data: serialize(stmt, recentList)
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
    console.warn('finChat 失败', e)
  }

  const code = result && result.code
  if (result && result.text) {
    return { text: result.text, source: 'llm' }
  }
  if (code === 'RATE_LIMIT') {
    return { text: result.msg || '问得有点急,稍等再问', source: 'local' }
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
  return { text: '账本君暂时没想明白,稍后再问', source: 'local' }
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
    prevMonthExpense: stmt.prevMonthExpense,
    prevYearExpense: stmt.hasPrevYear ? stmt.prevYearExpense : undefined,
    hasPrevYear: stmt.hasPrevYear,
    recurTotal: stmt.recurTotal,
    categories: stmt.categories,
    budgetOver: stmt.budgetOver,
    budgetNear: stmt.budgetNear,
    overCategories: stmt.overCategories,
    recentList: list
  }
}

module.exports = { send }