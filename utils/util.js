/**
 * 日期与金额工具
 */

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

/** Date -> 'YYYY-MM-DD' */
function fmtDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 'YYYY-MM-DD' -> Date（本地时区零点） */
function parseDate(str) {
  const [y, m, dd] = str.split('-').map(Number)
  return new Date(y, m - 1, dd)
}

function todayStr() {
  return fmtDate(new Date())
}

/** b - a 的天数（b 晚于 a 为正） */
function daysBetween(aStr, bStr) {
  return Math.round((parseDate(bStr) - parseDate(aStr)) / 86400000)
}

/**
 * 起始到结束的每日数组(含两端),返回 ['YYYY-MM-DD', ...]
 * 跨年也安全(直接推进 Date)
 */
function eachDay(startStr, endStr) {
  const out = []
  const d = parseDate(startStr)
  const end = parseDate(endStr)
  while (d <= end) {
    out.push(fmtDate(d))
    d.setDate(d.getDate() + 1)
  }
  return out
}

/** 0=周日, 1=周一 ... 6=周六 */
function getWeekday(dateStr) {
  return parseDate(dateStr).getDay()
}

/** 某年某月最后一天 */
function lastDayOfMonth(y, m) {
  return new Date(y, m + 1, 0).getDate()
}

/** 把「每月几号」clamp 到当月有效日期（如 31 号在 2 月 -> 2 月最后一天） */
function dayInMonth(y, m, day) {
  return Math.min(day, lastDayOfMonth(y, m))
}

/**
 * 从当前 nextCharge 滚动到下一周期的 nextCharge（T1.1 / 4.1 节口径）。
 * - 仅在订阅到期后滚动下一期时用（remind 触发器扣减后 / 用户主动「标记已续费」按钮）
 * - 用户首次录入不走这条路径（nextCharge 是用户照抄进的主字段,不是推算的）
 * - 语义:从 currentNextCharge 出发按 cycle 推进 1 周期;月末 dayInMonth clamp
 *
 * @param {'monthly'|'quarterly'|'yearly'|'weekly'|'custom'} cycle
 * @param {string} currentNextCharge 'YYYY-MM-DD' 当前 nextCharge（数据库已有值）
 * @param {Date} [now]
 * @param {number} [customMonths] 仅 cycle=custom 有效:每个周期月数 1-36（如半年包=6、季包=3、两年包=24）
 * @returns {string} 'YYYY-MM-DD';参数非法返回 ''
 */
function nextChargeOf(cycle, currentNextCharge, now, customMonths) {
  const t = now || new Date()
  const raw = String(currentNextCharge || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return ''
  const parts = raw.split('-').map(Number)
  const cy = parts[0]
  const cm0 = parts[1] - 1
  const cd = parts[2]
  if (!Number.isFinite(cy) || !Number.isFinite(cm0) || !Number.isFinite(cd)) return ''
  if (cycle === 'yearly') {
    return fmtDate(new Date(cy + 1, cm0, dayInMonth(cy + 1, cm0, cd)))
  }
  if (cycle === 'weekly') {
    // 周订阅:固定 +7 天
    const base = new Date(cy, cm0, cd)
    return fmtDate(new Date(base.getTime() + 7 * 86400000))
  }
  if (cycle === 'custom') {
    const cm = Number(customMonths)
    if (!Number.isInteger(cm) || cm < 1 || cm > 36) return ''
    const totalM = cy * 12 + cm0 + cm
    const ny = Math.floor(totalM / 12)
    const nm = totalM % 12
    return fmtDate(new Date(ny, nm, dayInMonth(ny, nm, cd)))
  }
  const step = cycle === 'monthly' ? 1 : cycle === 'quarterly' ? 3 : 0
  if (!step) return ''
  const totalM = cy * 12 + cm0 + step
  const ny = Math.floor(totalM / 12)
  const nm = totalM % 12
  return fmtDate(new Date(ny, nm, dayInMonth(ny, nm, cd)))
}

/**
 * 从 nextCharge 反推 cycleDay（写入文档时自动补齐用,4.1 节）。
 * - monthly/quarterly/weekly → 数字 1-31
 * - yearly → 'MM-DD' 字符串
 * - custom → null（期限包无 cycleDay 概念）
 * - 参数非法返回 null
 */
function deriveCycleDay(cycle, nextCharge) {
  const raw = String(nextCharge || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  const parts = raw.split('-')
  const dd = Number(parts[2])
  if (!Number.isFinite(dd) || dd < 1 || dd > 31) return null
  if (cycle === 'yearly') return `${parts[1]}-${parts[2]}`
  if (cycle === 'custom') return null
  return dd
}

/**
 * 从 nextCharge 估算 firstChargeDate = nextCharge - 1 周期(年度报告算「已订阅几个月」用)
 * - 用户首次录入不传 firstChargeDate 时,系统自动用这条估算(不传也不报错)
 * - custom 周期按 customMonths 整月减
 * - 入参非法返回 ''
 */
function deriveFirstChargeDate(cycle, nextCharge, customMonths) {
  const raw = String(nextCharge || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return ''
  const parts = raw.split('-').map(Number)
  const y = parts[0]
  const m = parts[1] - 1
  const d = parts[2]
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return ''
  if (cycle === 'yearly') {
    return fmtDate(new Date(y - 1, m, dayInMonth(y - 1, m, d)))
  }
  if (cycle === 'weekly') {
    const base = new Date(y, m, d)
    return fmtDate(new Date(base.getTime() - 7 * 86400000))
  }
  if (cycle === 'custom') {
    const cm = Number(customMonths)
    if (!Number.isInteger(cm) || cm < 1 || cm > 36) return ''
    const totalM = y * 12 + m - cm
    const ny = Math.floor(totalM / 12)
    const nm = totalM % 12
    return fmtDate(new Date(ny, nm, dayInMonth(ny, nm, d)))
  }
  const step = cycle === 'monthly' ? 1 : cycle === 'quarterly' ? 3 : 0
  if (!step) return ''
  const totalM = y * 12 + m - step
  const ny = Math.floor(totalM / 12)
  const nm = totalM % 12
  return fmtDate(new Date(ny, nm, dayInMonth(ny, nm, d)))
}

/**
 * 计算一张卡当前指向的还款日
 * @param {number} repayDay 每月几号还款 (1-31)
 * @param {string} status    'pending' | 'paid'
 * @param {Date} [today]
 * @returns {string} 'YYYY-MM-DD'（pending 未还时始终指向本月还款日，已过即逾期）
 */
function calcDueDate(repayDay, status, today) {
  const t = today || new Date()
  const y = t.getFullYear()
  const m = t.getMonth()
  if (status === 'paid') {
    const nm = m + 1
    return fmtDate(new Date(y, nm, dayInMonth(y, nm, repayDay)))
  }
  return fmtDate(new Date(y, m, dayInMonth(y, m, repayDay)))
}

/**
 * 信用卡免息期（账单日 → 还款日的天数）
 * 还款日在账单日之后（同月）为短免息期；还款日早于账单日则跨月，为长免息期
 * @param {number} billDay  每月账单日 (1-31)
 * @param {number} repayDay 每月还款日 (1-31)
 * @returns {number} 天数（任一参数缺失返回 0）
 */
function interestFreeDays(billDay, repayDay) {
  if (!billDay || !repayDay) return 0
  if (repayDay > billDay) return repayDay - billDay
  const t = new Date()
  const last = lastDayOfMonth(t.getFullYear(), t.getMonth())
  return last - billDay + repayDay
}

/**
 * 下一次发薪日
 * @param {number} payday 每月几号发薪
 * @returns {Date}
 */
function nextPayday(payday, today) {
  const t = today || new Date()
  const y = t.getFullYear()
  const m = t.getMonth()
  const thisMonth = new Date(y, m, dayInMonth(y, m, payday))
  const tAt = new Date(y, m, t.getDate())
  if (tAt <= thisMonth) return thisMonth
  const nm = m + 1
  return new Date(y, nm, dayInMonth(y, nm, payday))
}

/**
 * 最近一次发薪日（今天>=payday 取本月，否则取上月）
 * @param {number} payday 每月几号发薪
 * @returns {Date}
 */
function lastPayday(payday, today) {
  const t = today || new Date()
  const y = t.getFullYear()
  const m = t.getMonth()
  if (t.getDate() >= payday) {
    return new Date(y, m, dayInMonth(y, m, payday))
  }
  return new Date(y, m - 1, dayInMonth(y, m - 1, payday))
}

/** 金额：保留两位 */
function money(n) {
  const v = Number(n || 0)
  return v.toFixed(2)
}

/** 金额千分位 */
function moneyThousand(n) {
  const v = Number(n || 0)
  const fixed = v.toFixed(2)
  const [int, dec] = fixed.split('.')
  const withComma = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${withComma}.${dec}`
}

/** 今天所在月份 'YYYY-MM' */
function thisMonthStr() {
  const t = new Date()
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}`
}

/**
 * 日均可花（含月预算约束）——首页「今日指南」卡片用。
 *
 * 两个约束取更紧者（min）：
 *   余额视角：可用余额 ÷ 距下次发薪天数（钱要花到下次发薪日）
 *   预算视角：本月剩余预算 ÷ 本月剩余天数（别超用户设的月预算）
 *
 * 这样历史结转的「大余额」不会撑高日均可花（预算兜底），
 * 反过来余额紧张时也不会让用户按预算上限花（余额兜底）。
 *
 * 边界：
 *   - 今天就是发薪日 → daysToPayday 按 1 计（防除零），sub 显示「今天是发薪日」
 *   - 结果 ≤ 0 → clamp 到 0，zeroTip 区分「可用余额不足」/「本月预算已用完」
 *   - budget ≤ 0 → 不启用预算约束，只按余额视角
 *   - payday=0（未设置）→ paydayUnset=true，daysToPayday 按本月剩余天数（含今天）
 *     估算，绝不按默认值推算「距发薪」（默认 15 是用户从未确认过的值，展示即歧义）
 *
 * @param {object} o
 * @param {number} o.available 可用余额（含历史结转）
 * @param {number} o.expense   本月已支出
 * @param {number} o.budget    月预算（0/未设 = 不启用预算约束）
 * @param {number} o.payday    每月几号发薪（0 = 未设置，走估算口径）
 * @param {string} o.today     'YYYY-MM-DD'
 * @returns {{ amount: number, amountText: string, sub: string, budgetMode: boolean, daysToPayday: number, paydayToday: boolean, paydayUnset: boolean, zeroTip: string }}
 *   amount 原始值（可能为 0）；amountText 千分位两位小数；sub 副标题文案；
 *   budgetMode 是否预算视角更紧；paydayUnset 发薪日未设置（副文案走估算说明）；zeroTip 空串表示无告警
 */
function calcDailyBudget(o) {
  const today = o.today || todayStr()
  const payday = o.payday || 0
  const paydayUnset = !payday
  const budget = o.budget || 0

  let daysToPayday
  let paydayToday = false
  if (paydayUnset) {
    // 未设发薪日：按本月剩余天数（含今天）估算，与预算模式 daysLeftInMonth 口径一致
    const [y, m] = today.split('-').map(Number)
    const lastDay = lastDayOfMonth(y, m - 1)
    daysToPayday = Math.max(1, daysBetween(today, `${today.slice(0, 7)}-${lastDay}`) + 1)
  } else {
    const nextPay = nextPayday(payday, parseDate(today))
    daysToPayday = daysBetween(today, fmtDate(nextPay))
    paydayToday = daysToPayday <= 0
    if (daysToPayday < 1) daysToPayday = 1
  }

  let daily = o.available / daysToPayday
  let budgetMode = false
  let budgetLeft = 0
  if (budget > 0) {
    budgetLeft = budget - o.expense
    const [y, m] = today.split('-').map(Number)
    const lastDay = lastDayOfMonth(y, m - 1)
    const daysLeftInMonth = daysBetween(today, `${today.slice(0, 7)}-${lastDay}`) + 1
    const dailyByBudget = budgetLeft / daysLeftInMonth
    if (dailyByBudget < daily) {
      daily = dailyByBudget
      budgetMode = true
    }
  }

  let zeroTip = ''
  if (daily <= 0.005) {
    if (o.available < 0) zeroTip = '可用余额不足'
    else if (budget > 0 && budgetLeft < 0) zeroTip = '本月预算已用完'
  }
  daily = Math.max(0, daily)

  let sub
  if (paydayUnset) {
    sub = `按本月剩余 ${daysToPayday} 天估算`
    sub += budgetMode ? ` · 预算剩 ¥${moneyThousand(budgetLeft)}` : ''
  } else if (paydayToday) sub = '今天是发薪日'
  else if (zeroTip) sub = zeroTip
  else {
    sub = `距发薪 ${daysToPayday} 天`
    sub += budgetMode ? ` · 预算剩 ¥${moneyThousand(budgetLeft)}` : ' · 按可用余额'
  }

  return {
    amount: daily,
    amountText: moneyThousand(daily),
    sub,
    budgetMode,
    daysToPayday,
    paydayToday,
    paydayUnset,
    zeroTip
  }
}

/**
 * 连续记账天数（首页「今日指南」卡片用，多邻国式留存钩子）。
 * 今天还没记不打断连续（今天未结束，从昨天起算）；
 * 今天记了则包含今天。断档日即停止。
 *
 * @param {string[]} dates 记账日期数组（'YYYY-MM-DD'，可含重复/空值，内部去重）
 * @param {string} [today] 'YYYY-MM-DD'，默认今天
 * @returns {{ count: number, todayRecorded: boolean, text: string }}
 *   count 连续天数（今天未记时不含今天）；todayRecorded 今天是否已记；
 *   text 展示文案（含引导）
 */
function calcStreak(dates, today) {
  const t = today || todayStr()
  const daySet = new Set((dates || []).filter(Boolean))
  const todayRecorded = daySet.has(t)
  let cursor = todayRecorded ? t : offsetDate(t, -1)
  let count = 0
  while (daySet.has(cursor)) {
    count++
    cursor = offsetDate(cursor, -1)
  }
  let text
  if (count > 0 && todayRecorded) text = `已连续记账 ${count} 天`
  else if (count > 0) text = `连续 ${count} 天 · 今天还没记`
  else text = '今天记一笔，开启连续'
  return { count, todayRecorded, text }
}

/** todayStr + N 天,返回 'YYYY-MM-DD' */
function offsetDate(todayStr, n) {
  const d = parseDate(todayStr)
  d.setDate(d.getDate() + n)
  return fmtDate(d)
}

/**
 * 账本君主动询问是否已过期（发出超 48h 未回应）
 * 工资询问时效性强：发薪日前后才有意义，一直不回应就应让位给新的主动提醒
 * （还款提醒/预算提醒的开场白在 goAskAI 里被询问占位，若无过期机制会永久堵住）
 * @param {{ text: string, ts: number, round?: number } | null} q
 * @param {number} [now] 时间戳，测试注入用
 * @returns {boolean}
 */
function isPendingQExpired(q, now) {
  if (!q || !q.ts) return false
  return (now || Date.now()) - q.ts > 48 * 3600 * 1000
}

/**
 * 多卡最优还款顺序(纯函数,首页「最优还款顺序」用)
 * 算法:
 *   主排序 key = daysLeft 升序(逾期 → 今天 → 越近越前)
 *   次排序 key = freeDays 升序(同日时免息期短的先还,让长的多躺几天)
 *   suggestDate 按到期天数启发式给出(逾期/今天→立即;1-3→前1天;4-13→前2天;≥14→前3天)
 *
 * @param {Array} cards 全部卡(含 paid 也行,内部过滤)
 * @param {string} today 'YYYY-MM-DD'
 * @returns {{ pendingCount: number, order: Array, savedInterestText: string }}
 *   卡片不足时返回 pendingCount=0、order=[]
 */
function calcOptimalRepayOrder(cards, today) {
  const pending = (cards || []).filter((c) => c && c.status !== 'paid' && c.repayDay)
  if (!pending.length) return { pendingCount: 0, order: [], savedInterestText: '' }

  const rows = pending.map((c) => {
    const dueDate = calcDueDate(c.repayDay, 'pending')
    const daysLeft = daysBetween(today, dueDate)
    const freeDays = interestFreeDays(c.billDay, c.repayDay)
    return {
      id: c._id,
      bank: c.bank,
      amount: c.amount || 0,
      dueDate,
      daysLeft,
      freeDays
    }
  })

  // 主排序 + 次排序
  rows.sort((a, b) => {
    if (a.daysLeft !== b.daysLeft) return a.daysLeft - b.daysLeft
    return a.freeDays - b.freeDays
  })

  // 派生文案 + 建议还款日 + level(影响左侧色条)
  rows.forEach((r) => {
    r.amountText = moneyThousand(r.amount)
    if (r.daysLeft < 0) {
      r.dueText = `已逾期 ${-r.daysLeft} 天`
      r.level = 'overdue'
      r.suggestDate = today
      r.suggestText = '今天立即还(已逾期)'
    } else if (r.daysLeft === 0) {
      r.dueText = '今天还款'
      r.level = 'urgent'
      r.suggestDate = today
      r.suggestText = '今天还款日前还'
    } else if (r.daysLeft <= 3) {
      r.dueText = `${r.daysLeft} 天后到期`
      r.level = 'urgent'
      r.suggestDate = offsetDate(today, r.daysLeft - 1) // 到期前 1 天
      r.suggestText = `${r.suggestDate} 还(到期前 1 天)`
    } else if (r.daysLeft <= 13) {
      r.dueText = `${r.daysLeft} 天后到期`
      r.level = 'soon'
      r.suggestDate = offsetDate(today, r.daysLeft - 2)
      r.suggestText = `${r.suggestDate} 还(到期前 2 天)`
    } else {
      r.dueText = `${r.daysLeft} 天后到期`
      r.level = 'normal'
      r.suggestDate = offsetDate(today, r.daysLeft - 3)
      r.suggestText = `${r.suggestDate} 还(到期前 3 天)`
    }
  })

  // 估算节省:日息万五 × 总金额 × 平均延后天数
  let totalAmount = 0
  let totalDelay = 0
  rows.forEach((r) => {
    totalAmount += r.amount
    totalDelay += Math.max(0, daysBetween(today, r.suggestDate))
  })
  const avgDelay = rows.length ? totalDelay / rows.length : 0
  const saved = totalAmount * 0.0005 * avgDelay
  const savedInterestText = avgDelay >= 0.5
    ? `约节省 ¥${moneyThousand(Math.round(saved))} 利息`
    : '本期无明显节省空间'

  return {
    pendingCount: rows.length,
    order: rows,
    savedInterestText
  }
}

/**
 * 打开底部弹层（重置关闭状态，播放滑入动画）
 * @param {Page} page 页面实例（需有 setData）
 * @param {string} key 弹层开关字段名，如 'showForm'
 * @param {object} [extra] 附带写入的数据
 */
function openSheet(page, key, extra) {
  page.setData({ [key]: true, [`${key}Closing`]: false, ...(extra || {}) })
}

/**
 * 关闭底部弹层（先播放滑出动画，动画结束后再真正移除）
 * @param {Page} page 页面实例（需有 setData）
 * @param {string} key 弹层开关字段名，如 'showForm'
 * @param {number} [duration] 动画时长 ms，默认 240
 * @returns {number} setTimeout id，页面可在重新打开时 clearTimeout 防抖动
 */
function closeSheet(page, key, duration) {
  page.setData({ [`${key}Closing`]: true })
  return setTimeout(() => {
    page.setData({ [key]: false, [`${key}Closing`]: false })
  }, duration || 240)
}

/**
 * 数字滚动动画
 * @param {Page} page 页面实例
 * @param {string} key data 字段名
 * @param {number} target 目标数值
 * @param {object} [opts] 配置
 * @param {number} [opts.duration=600] 动画时长 ms
 * @param {number} [opts.decimals=2] 小数位
 * @param {boolean} [opts.thousand=false] 是否加千分位
 * @param {string} [opts.prefix=''] 前缀（如 ¥）
 * @param {string} [opts.suffix=''] 后缀
 * @returns {function} cancel 函数
 */
function animateNumber(page, key, target, opts) {
  opts = opts || {}
  const duration = opts.duration || 600
  const decimals = opts.decimals !== undefined ? opts.decimals : 2
  const start = 0
  const startTime = Date.now()
  let rafId = null

  const step = () => {
    const elapsed = Date.now() - startTime
    const progress = Math.min(elapsed / duration, 1)
    // easeOutQuart
    const eased = 1 - Math.pow(1 - progress, 4)
    const current = start + (target - start) * eased
    let text
    if (decimals > 0) {
      text = current.toFixed(decimals)
    } else {
      text = String(Math.round(current))
    }
    if (opts.thousand) {
      const [int, dec] = text.split('.')
      text = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dec ? '.' + dec : '')
    }
    page.setData({ [key]: (opts.prefix || '') + text + (opts.suffix || '') })
    if (progress < 1) {
      rafId = setTimeout(step, 16)
    }
  }
  step()
  return () => { if (rafId) clearTimeout(rafId) }
}

/**
 * 把云函数/网络异常转成用户能看懂的简短提示
 * @param {Error|object} e 异常对象（wx.cloud 通常挂在 errMsg；wx.request 失败含 request:fail）
 * @param {string} [fallback] 默认文案（按场景传「加载失败」「保存失败」等）
 * @returns {string}
 */
function errTip(e, fallback) {
  if (e && e.isCollectionMissing) return e.message  // 集合未创建等业务自定义提示
  const msg = (e && (e.errMsg || e.message)) || ''
  if (/request:fail|network|timeout/i.test(msg)) return '网络异常，请重试'
  if (/quota|limit|exceed/i.test(msg)) return '云开发额度已用完，请稍后再试'
  return fallback || '操作失败，请重试'
}

/**
 * 隐私锁守卫：开启手势/指纹锁后,每次进入页面都检查;解锁过 60 秒内不打扰,
 * 超过 60 秒 reLaunch 到锁页。需在每个 Tab 页 onShow 调用。
 */
function checkLock() {
  const app = getApp()
  const u = app && app.globalData && app.globalData.user
  if (!u || !u.privacyLock || u.privacyLock === 'off') return
  const lastTs = (app.globalData && app.globalData.lastUnlockTs) || 0
  if (Date.now() - lastTs < 60 * 1000) return  // 60 秒内解锁过的,放行
  // 已在锁页不重复跳(避免 onShow 互相触发 reLaunch 死循环)
  const pages = getCurrentPages()
  const cur = pages[pages.length - 1]
  if (cur && cur.route === 'pages/lock/lock') return
  wx.reLaunch({ url: '/pages/lock/lock' })
}

/**
 * 每天最多一次的静默订阅授权请求（累计「一次授权一次推送」的可用次数）
 * 微信硬限制：requestSubscribeMessage 必须由用户点击行为触发，
 * 因此只能在 tap 事件（或其冒泡回调）里调用，不能在 onShow/onLaunch 直接调。
 * @param {string} tmplId 订阅消息模板 ID
 * @returns {boolean} 是否真正发起了请求
 */
function tryDailySubscribe(tmplId) {
  if (!tmplId || tmplId.indexOf('请填入') === 0) return false
  const today = todayStr()
  if (wx.getStorageSync('xz_subscribe_ask_date') === today) return false
  wx.setStorageSync('xz_subscribe_ask_date', today)
  wx.requestSubscribeMessage({
    tmplIds: [tmplId],
    success: (res) => {
      if (res[tmplId] === 'accept') {
        wx.setStorageSync('xz_subscribe_last_accept', today)
      }
    },
    fail: () => {} // 静默失败不打扰（无手势/主开关关闭等）
  })
  return true
}

module.exports = {
  fmtDate,
  parseDate,
  todayStr,
  daysBetween,
  eachDay,
  getWeekday,
  lastDayOfMonth,
  dayInMonth,
  nextChargeOf,
  deriveCycleDay,
  deriveFirstChargeDate,
  calcDueDate,
  interestFreeDays,
  nextPayday,
  lastPayday,
  money,
  moneyThousand,
  thisMonthStr,
  offsetDate,
  calcDailyBudget,
  calcStreak,
  isPendingQExpired,
  calcOptimalRepayOrder,
  openSheet,
  closeSheet,
  animateNumber,
  tryDailySubscribe,
  errTip,
  checkLock
}
