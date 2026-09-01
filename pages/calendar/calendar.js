const util = require('../../utils/util')
const dbApi = require('../../utils/db')
const themeUtil = require('../../utils/theme')

/* ============================================================
 * 模块级纯函数（迁移自「我的」页热力图实现，无页面依赖，便于单测）
 * ============================================================ */

/**
 * 构造 GitHub 风格 grid：7 行 × N 列,补齐首末日附近的空格,确保每列是完整周（周日→周六）。
 * 返回 [[{date, amount, level}, ...]]
 * level ∈ 0..4,基于非零金额 25/50/75 分位动态分桶（避免极端值把所有格子挤到 1 档）。
 */
function buildHeatmapCells(byDay, totalDays) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const endDate = new Date(today)
  const dow = endDate.getDay()  // 0=Sun
  // 列数 = ceil((totalDays + dow + 1) / 7),+1 是把今天自己算进去
  const cols = Math.ceil((totalDays + dow + 1) / 7)
  // 起始日期 = 向前推 cols*7 天,确保第一列从周日开始,最后一列止于今天
  const startDate = new Date(endDate)
  startDate.setDate(endDate.getDate() - cols * 7 + 1)

  // 分桶阈值(percentile)
  const amts = Object.values(byDay).filter((a) => a > 0).sort((a, b) => a - b)
  const p = (q) => amts.length
    ? (amts[Math.min(amts.length - 1, Math.floor(amts.length * q))] || 0)
    : 0
  const t1 = p(0.25)
  const t2 = p(0.50)
  const t3 = p(0.75)

  // 填格
  const grid = []
  const cur = new Date(startDate)
  for (let wi = 0; wi < cols; wi++) {
    const col = []
    for (let r = 0; r < 7; r++) {
      const dateStr = util.fmtDate(cur)
      const amount = byDay[dateStr] || 0
      let level = 0
      if (amount > 0) {
        level = amount <= t1 ? 1 : amount <= t2 ? 2 : amount <= t3 ? 3 : 4
      }
      col.push({ date: dateStr, amount, level })
      cur.setDate(cur.getDate() + 1)
    }
    grid.push(col)
  }
  return grid
}

/**
 * 在每月第一周上方显示月份 label。
 * 返回 [{weekIndex, left, label}],left 是 rpx(基于 cellSize + gap 4rpx)。
 */
function buildHeatmapMonthLabels(grid, cellSize) {
  const labels = []
  let lastMonth = -1
  const cellWidth = (cellSize || 48) + 4  // cell + gap
  grid.forEach((col, wi) => {
    const c = col[0]
    if (!c) return
    const m = Number(c.date.slice(5, 7))
    if (m !== lastMonth) {
      labels.push({ weekIndex: wi, left: wi * cellWidth, label: `${m}月` })
      lastMonth = m
    }
  })
  return labels
}

/**
 * 统计区间内的总开销 / 有开销天数 / 日均 / 最高单日。
 */
function computeHeatmapStats(byDay) {
  const days = Object.keys(byDay).filter((d) => byDay[d] > 0)
  if (days.length === 0) {
    return {
      totalDays: 0,
      totalAmountText: '0.00',
      avgAmountText: '0.00',
      maxDay: '—'
    }
  }
  const total = days.reduce((s, d) => s + byDay[d], 0)
  const maxKey = days.reduce((a, b) => (byDay[a] > byDay[b] ? a : b))
  return {
    totalDays: days.length,
    totalAmountText: util.moneyThousand(total),
    avgAmountText: util.moneyThousand(Math.round(total / days.length)),
    maxDay: maxKey.slice(5)  // 只显示 MM-DD,简洁
  }
}

/**
 * 按 date 分组明细,供点击单元格时 O(1) 取当天所有流水。
 */
function groupItemsByDate(items) {
  const out = {}
  for (const x of items) {
    const d = x.date
    if (!d) continue
    ;(out[d] = out[d] || []).push(x)
  }
  return out
}

/** 金额缩写：≥1000 显示 1.2k；<1000 显示整数（格子内不显示 ¥ 避免拥挤） */
function fmtAmountShort(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(Math.round(n))
}

/** 'YYYY-MM' -> 'YYYY-MM'（上一个月） */
function prevYm(ym) {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 2, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 「消费日历」独立页面（从「我的」页半屏 sheet 重构而来）。
 * 默认进入月历视图；热力视图保留原 GitHub 风格热力图。
 */
Page({
  data: {
    themeClass: '',
    statusBarHeight: 44,
    view: 'cal',            // 'cal' 月历 | 'heat' 热力
    today: util.todayStr(),
    // 月历视图
    curYm: '',
    monthTitle: '',
    calDays: [],
    selDate: '',
    hero: {
      monthLabel: '',
      chip: '',
      amountText: '0.00',
      avgText: '¥0.0',
      countText: '0 笔',
      deltaText: '—',
      deltaDir: 'flat'
    },
    // 热力视图
    heatmapRange: 'q',
    heatmapGrid: null,
    heatmapMonthLabels: [],
    heatmapStats: null,
    heatCellSize: 40,
    // 当日明细 sheet
    showDay: false,
    showDayClosing: false,
    dayData: null
  },

  onLoad() {
    this.setData({ statusBarHeight: wx.getWindowInfo().statusBarHeight || 44 })
    const today = util.todayStr()
    const curYm = today.slice(0, 7)
    this.setData({
      curYm,
      monthTitle: `${Number(curYm.slice(0, 4))} 年 ${Number(curYm.slice(5, 7))} 月`,
      selDate: today
    })
    this._monthItemsByDate = {}
    this._heatmapItemsByDate = {}
    this._computeHeatCellSize()
  },

  onShow() {
    util.checkLock()
    // 外观偏好 / 系统主题刷新根节点 class + 窗口背景
    themeUtil.applyToPage(this)
    this._loadMonth(this.data.curYm)
    this._loadHeatmapFull()
  },

  /** 外观偏好 / 系统主题变化时由 app 统一回调 */
  applyTheme() {
    themeUtil.applyToPage(this)
  },

  async onPullDownRefresh() {
    try {
      await this._loadMonth(this.data.curYm, true)
      await this._loadHeatmapFull(true)
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  /* ---------- 导航栏 ---------- */
  goBack() {
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/my/my' })
    })
  },

  /** 一键回当前月并高亮今天 */
  goToday() {
    const today = util.todayStr()
    const curYm = today.slice(0, 7)
    this.setData({
      curYm,
      monthTitle: `${Number(curYm.slice(0, 4))} 年 ${Number(curYm.slice(5, 7))} 月`,
      selDate: today
    })
    this._loadMonth(curYm)
  },

  /** 前后翻月（不可翻到未来月份） */
  shiftMonth(e) {
    const dir = Number(e.currentTarget.dataset.dir) || -1
    const [y, m] = this.data.curYm.split('-').map(Number)
    const d = new Date(y, m - 1 + dir, 1)
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const today = util.todayStr()
    if (ym > today.slice(0, 7)) {
      wx.showToast({ title: '不能查看未来月份', icon: 'none' })
      return
    }
    this.setData({
      curYm: ym,
      monthTitle: `${ym.slice(0, 4)} 年 ${Number(ym.slice(5, 7))} 月`
    })
    this._loadMonth(ym)
  },

  /* ---------- 视图切换 ---------- */
  switchView(e) {
    const v = e.currentTarget.dataset.view
    if (!v || v === this.data.view) return
    this.setData({ view: v })
  },

  /* ---------- 热力视图 ---------- */
  switchHeatmapRange(e) {
    const r = e.currentTarget.dataset.range
    if (!r || r === this.data.heatmapRange) return
    this.setData({ heatmapRange: r, heatmapGrid: null, heatmapMonthLabels: [], heatmapStats: null })
    this._loadHeatmapFull()
  },

  tapHeatmapCell(e) {
    const { date, amount } = e.currentTarget.dataset
    if (!date || !amount || Number(amount) <= 0) {
      wx.showToast({ title: '这天没开销', icon: 'none', duration: 1000 })
      return
    }
    this.setData({ selDate: date })
    this._openDaySheet(date, this._heatmapItemsByDate)
  },

  /* ---------- 月历视图 ---------- */
  tapDay(e) {
    const date = e.currentTarget.dataset.date
    if (!date) return
    if (date > this.data.today) return  // 未来日期不可点
    this.setData({ selDate: date })
    // 优先用当月明细；他月尾巴日期回退到热力全量明细
    const map = this._monthItemsByDate || {}
    const items = map[date] ? map : (this._heatmapItemsByDate || {})
    this._openDaySheet(date, items)
  },

  /* ---------- 当日明细 sheet ---------- */
  _openDaySheet(date, itemsByDate) {
    const items = (itemsByDate && itemsByDate[date]) || []
    const fmtItems = items.map((x) => ({
      ...x,
      amountText: util.moneyThousand(x.amount)
    }))
    const total = fmtItems.reduce((s, x) => s + (x.amount || 0), 0)
    const [y, m, d] = date.split('-').map(Number)
    const weekCn = '日一二三四五六'[new Date(y, m - 1, d).getDay()]
    util.openSheet(this, 'showDay', {
      dayData: {
        date,
        dateLabel: `${m} 月 ${d} 日`,
        weekText: `周${weekCn}`,
        totalText: util.moneyThousand(total),
        count: fmtItems.length,
        items: fmtItems
      }
    })
  },

  closeDay() {
    if (this._dayCloseTimer) { clearTimeout(this._dayCloseTimer); this._dayCloseTimer = null }
    this._dayCloseTimer = util.closeSheet(this, 'showDay')
  },

  /** 「记一笔」：预填该日期跳转记账页，方便补记漏账。
   * 注意：expenses 是 tabBar 页，navigateTo 无法跳转，必须用 switchTab + globalData 传参。
   */
  recordOnDay() {
    const date = this.data.dayData && this.data.dayData.date
    if (!date) return
    this.closeDay()
    const app = getApp()
    app.globalData.prefillExpenseDate = date
    wx.switchTab({ url: '/pages/expenses/expenses' })
  },

  /* ---------- 数据加载 ---------- */
  /**
   * 加载某月数据：当月流水（聚合 byDay + 明细缓存）+ 上月流水（环比）+ 用户（发薪日）。
   * 月历格子与 hero 概览都依赖本次结果。
   */
  async _loadMonth(ym, force) {
    try {
      const app = getApp()
      await app.ready()
      const [user, curList, prevList] = await Promise.all([
        dbApi.getMyUser(force),
        dbApi.listExpenses(ym, force),
        dbApi.listExpenses(prevYm(ym), force)
      ])
      const byDay = {}
      for (const x of curList) {
        if (!x.date) continue
        byDay[x.date] = (byDay[x.date] || 0) + (x.amount || 0)
      }
      this._monthItemsByDate = groupItemsByDate(curList)
      this._buildCalDays(ym, byDay)
      this._buildHero(ym, curList, prevList, user)
    } catch (err) {
      console.error('加载月历失败', err)
      wx.showToast({ title: util.errTip(err, '加载失败，请下拉重试'), icon: 'none' })
    }
  },

  /** 构建 7 列月历网格（周一开头；金额分位分桶与热力图同款逻辑，仅渲染形态不同） */
  _buildCalDays(ym, byDay) {
    const [y, m] = ym.split('-').map(Number)
    const today = this.data.today
    const selDate = this.data.selDate || today
    const firstDow = (new Date(y, m - 1, 1).getDay() + 6) % 7  // 周一=0
    const daysInMonth = new Date(y, m, 0).getDate()
    const prevDays = new Date(y, m - 1, 0).getDate()
    const totalCells = Math.ceil((firstDow + daysInMonth) / 7) * 7

    // 当月非零金额 25/50/75 分位分桶（极端值不把格子挤进同一档）
    const amts = Object.values(byDay).filter((a) => a > 0).sort((a, b) => a - b)
    const p = (q) => amts.length
      ? (amts[Math.min(amts.length - 1, Math.floor(amts.length * q))] || 0)
      : 0
    const t1 = p(0.25)
    const t2 = p(0.50)
    const t3 = p(0.75)
    const levelOf = (amount) => {
      if (!amount) return 0
      return amount <= t1 ? 1 : amount <= t2 ? 2 : amount <= t3 ? 3 : 4
    }

    const ymPrefix = ym.slice(0, 4)
    const prevMonth = String(m - 1).padStart(2, '0')
    const nextMonth = String(m + 1).padStart(2, '0')
    const calDays = []
    for (let i = 0; i < totalCells; i++) {
      let d, date, inMonth
      if (i < firstDow) {
        d = prevDays - firstDow + 1 + i
        date = `${ymPrefix}-${prevMonth}-${String(d).padStart(2, '0')}`
        inMonth = false
      } else if (i >= firstDow + daysInMonth) {
        d = i - firstDow - daysInMonth + 1
        date = `${ymPrefix}-${nextMonth}-${String(d).padStart(2, '0')}`
        inMonth = false
      } else {
        d = i - firstDow + 1
        date = `${ym}-${String(d).padStart(2, '0')}`
        inMonth = true
      }
      const amount = inMonth ? (byDay[date] || 0) : 0
      calDays.push({
        date,
        day: d,
        inMonth,
        amount,
        level: inMonth ? levelOf(amount) : 0,
        amtText: inMonth && amount > 0 ? fmtAmountShort(amount) : '',
        today: date === today,
        future: date > today,
        selected: date === selDate
      })
    }
    this.setData({ calDays })
  },

  /** hero 概览：本月支出大数字 + 日均/共记/环比 + 发薪日徽章 */
  _buildHero(ym, curList, prevList, user) {
    const monthTotal = curList.reduce((s, x) => s + (x.amount || 0), 0)
    const prevTotal = prevList.reduce((s, x) => s + (x.amount || 0), 0)
    const count = curList.length

    // 日均分母：当月看已过天数，历史月看整月天数
    const today = this.data.today
    const isCurMonth = ym === today.slice(0, 7)
    const daysElapsed = isCurMonth
      ? Number(today.slice(8, 10))
      : new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate()
    const avg = daysElapsed > 0 ? monthTotal / daysElapsed : 0

    // 环比
    let deltaText = '—'
    let deltaDir = 'flat'
    if (monthTotal > 0 && prevTotal > 0) {
      const diff = monthTotal - prevTotal
      const pct = Math.abs((diff / prevTotal) * 100).toFixed(1) + '%'
      deltaText = (diff > 0 ? '↑ ' : diff < 0 ? '↓ ' : '· ') + pct
      deltaDir = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat'
    } else if (monthTotal > 0 && prevTotal === 0) {
      deltaText = '本月新开始'
    } else if (monthTotal === 0 && prevTotal > 0) {
      deltaText = '↓ 100%'
      deltaDir = 'down'
    }

    const payday = (user && user.payday) || 15
    this.setData({
      hero: {
        monthLabel: `${Number(ym.slice(5, 7))} 月支出`,
        chip: this._paydayChip(ym, payday, today),
        amountText: util.moneyThousand(monthTotal),
        avgText: '¥' + avg.toFixed(1),
        countText: `${count} 笔`,
        deltaText,
        deltaDir
      }
    })
  },

  /** 发薪日徽章：当月按今天算；上月按上次发薪到今天；更早月份只展示每月几号 */
  _paydayChip(ym, payday, today) {
    if (ym === today.slice(0, 7)) {
      const td = Number(today.slice(8, 10))
      if (td >= payday) return `发薪日已过 ${td - payday} 天`
      return `距发薪 ${payday - td} 天`
    }
    if (ym === prevYm(today.slice(0, 7))) {
      const [ty, tm] = today.split('-').map(Number)
      const lastPay = new Date(ty, tm - 2, util.dayInMonth(ty, tm - 2, payday))
      const days = Math.round((util.parseDate(today) - lastPay) / 86400000)
      return days >= 0 ? `发薪日已过 ${days} 天` : `距发薪 ${-days} 天`
    }
    return `每月 ${payday} 号发薪`
  },

  /** 热力图全量加载（迁移自「我的」页；按 range 分档） */
  async _loadHeatmapFull(force) {
    try {
      const map = { q: [4, 91], h: [7, 182], y: [13, 365] }
      const conf = map[this.data.heatmapRange] || map.q
      const [monthsBack, days] = conf
      const { byDay, items } = await dbApi.listExpensesForHeatmap(monthsBack, force)
      const grid = buildHeatmapCells(byDay, days)
      const today = util.todayStr()
      grid.forEach((col) => col.forEach((c) => { if (c.date === today) c.today = true }))
      const monthLabels = buildHeatmapMonthLabels(grid, this.data.heatCellSize)
      this._heatmapItemsByDate = groupItemsByDate(items)
      this.setData({
        heatmapGrid: grid,
        heatmapMonthLabels: monthLabels,
        heatmapStats: computeHeatmapStats(byDay)
      })
    } catch (err) {
      console.error('加载热力图失败', err)
    }
  },

  _computeHeatCellSize() {
    let screenWidth = 750
    try {
      const info = (wx.getWindowInfo && wx.getWindowInfo()) || wx.getSystemInfoSync()
      screenWidth = (info && info.windowWidth) || screenWidth
    } catch (e) {}
    const container = screenWidth - 64
    const size = Math.max(32, Math.floor((container - 8 - 12 * 4) / 13))
    if (size !== this.data.heatCellSize) {
      this.setData({ heatCellSize: size })
    }
  }
})
