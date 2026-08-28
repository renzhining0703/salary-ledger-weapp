/**
 * 本月账单文字解读 — 模板兜底版
 *
 * 用途：真 AI（云函数 finReport）失败 / 超时 / 未配置 key 时，
 *       用纯规则拼一段还算像人话的财务小结。
 *
 * 输入参数（与云函数 finReport 的 data 字段对齐）：
 *   {
 *     monthText: '2026-08',         // 显示用月份
 *     income: 12500, expense: 3850, balance: 8650,  // 数字或 undefined
 *     savingsRate: 69,               // 0-100,可缺省
 *     prevMonthExpense: 3420,        // 可缺省
 *     prevYearExpense: 4100,         // 可缺省（hasPrevYear=true 才参与）
 *     recurTotal: 2000,              // 可缺省
 *     categories: [{name, amount, budget, over}],   // 可空数组
 *     budgetOver: false, budgetNear: false,
 *     overCategories: ['购物']       // 名字数组
 *   }
 *
 * 输出：3-4 行中文（用 \n 分隔），不超 130 字。
 */

function fmt(n) {
  return Number(n || 0).toFixed(0)
}

function pct(n) {
  return Number(n || 0).toFixed(0)
}

function line(...parts) {
  return parts.filter(Boolean).join('')
}

function build(d) {
  const out = []
  const expense = Number(d.expense || 0)
  const income = Number(d.income || 0)
  const balance = Number(d.balance || (income - expense))
  const savingsRate = Number(
    d.savingsRate !== undefined
      ? d.savingsRate
      : income > 0
      ? ((balance / income) * 100)
      : 0
  )

  // ── 句 1：整体定调 ──
  if (savingsRate >= 40) {
    out.push(line('这个月攒钱效率不错,储蓄率 ', pct(savingsRate), '%,结余 ¥', fmt(balance), '。'))
  } else if (savingsRate >= 20) {
    out.push(line('这个月结余 ¥', fmt(balance), ',储蓄率 ', pct(savingsRate), '%,算及格。'))
  } else if (savingsRate >= 0 && income > 0) {
    out.push(line('这个月结余 ¥', fmt(balance), ',储蓄率只有 ', pct(savingsRate), '%,有点紧巴。'))
  } else if (income > 0) {
    out.push(line('这个月支出 ¥', fmt(expense), '已经超过收入 ¥', fmt(income), ',需要看看是哪块花冒了。'))
  } else if (expense > 0) {
    out.push(line('这个月共支出 ¥', fmt(expense), '。'))
  } else {
    return ['这个月还没有开销数据,先记一笔再说。']
  }

  // ── 句 2：同比 / 环比 ──
  if (d.prevMonthExpense && expense) {
    const diff = expense - d.prevMonthExpense
    const change = d.prevMonthExpense > 0 ? (diff / d.prevMonthExpense) * 100 : 0
    if (Math.abs(change) >= 5) {
      const word = diff > 0 ? '比上月多花' : '比上月少花'
      out.push(line(word, ' ¥', fmt(Math.abs(diff)), '（', diff > 0 ? '+' : '-', pct(Math.abs(change)), '%）。'))
    } else {
      out.push('跟上月开销基本持平,波动很小。')
    }
  }
  if (d.hasPrevYear && d.prevYearExpense && expense) {
    const diff = expense - d.prevYearExpense
    const change = d.prevYearExpense > 0 ? (diff / d.prevYearExpense) * 100 : 0
    if (Math.abs(change) >= 10) {
      const word = diff > 0 ? '比去年同期多' : '比去年同期少'
      out.push(line(word, ' ¥', fmt(Math.abs(diff)), '（', diff > 0 ? '+' : '-', pct(Math.abs(change)), '%）。'))
    }
  }

  // ── 句 3：最大分类 + 预算状态 ──
  const cats = (d.categories || []).filter((c) => c.amount > 0).sort((a, b) => b.amount - a.amount)
  if (cats.length) {
    const top = cats[0]
    const topPct = expense > 0 ? Math.round((top.amount / expense) * 100) : 0
    let s = line(top.name, '花了 ¥', fmt(top.amount), '（占 ', topPct, '%）')
    if (typeof top.budget === 'number' && top.budget > 0) {
      if (top.over) {
        s += line(',超预算 ¥', fmt(top.amount - top.budget))
      } else if (top.amount / top.budget >= 0.85) {
        s += line(',离预算只剩 ¥', fmt(top.budget - top.amount))
      }
    }
    s += '。'
    out.push(s)
  }

  // ── 句 4：超预算 / 固定支出提醒（可选） ──
  if (d.overCategories && d.overCategories.length) {
    out.push(line('注意:', d.overCategories.join('、'), '已经超预算,下周注意一下。'))
  } else if (d.budgetNear) {
    out.push('总开销快到上限了,后半周悠着点花。')
  }

  // 总长度封顶 140 字（接近 LLM 上限 130）
  return trim(out, 140)
}

function trim(lines, max) {
  let s = lines.join('\n')
  if (s.length <= max) return s
  // 超出就砍掉最后一行,直到合格
  while (s.length > max && lines.length > 1) {
    lines.pop()
    s = lines.join('\n')
  }
  return s
}

module.exports = { build }
