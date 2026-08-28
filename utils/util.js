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

/** 某年某月最后一天 */
function lastDayOfMonth(y, m) {
  return new Date(y, m + 1, 0).getDate()
}

/** 把「每月几号」clamp 到当月有效日期（如 31 号在 2 月 -> 2 月最后一天） */
function dayInMonth(y, m, day) {
  return Math.min(day, lastDayOfMonth(y, m))
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
  lastDayOfMonth,
  dayInMonth,
  calcDueDate,
  interestFreeDays,
  nextPayday,
  lastPayday,
  money,
  moneyThousand,
  thisMonthStr,
  openSheet,
  closeSheet,
  animateNumber,
  tryDailySubscribe,
  errTip,
  checkLock
}
