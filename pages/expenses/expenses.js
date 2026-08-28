const config = require('../../utils/config')
const util = require('../../utils/util')
const dbApi = require('../../utils/db')
const finTemplate = require('../../utils/finTemplate')

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

Page({
  data: {
    categories: config.CATEGORIES,
    viewMonth: '',
    monthText: '',
    isThisMonth: true,
    monthTotal: '0.00',
    lastMonthTotal: '0.00',
    budget: 4000,
    budgetPercent: 0,
    budgetOver: false,
    overAmount: '0.00',
    catStats: [],
    list: [],
    loading: true,
    showForm: false,
    saving: false,
    formAmount: '',
    formCategory: '餐饮',
    formDate: '',
    formNote: '',
    // 固定支出
    recurList: [],
    recurTotal: '0.00',
    recurCount: 0,
    showRecur: false,
    showRecurClosing: false,
    showRecurForm: false,
    showRecurFormClosing: false,
    recurSaving: false,
    rName: '',
    rAmount: '',
    rCategory: '居住',
    // 本月账单 sheet
    showStatement: false,
    showStatementClosing: false,
    pageLocked: false,      // 本月账单 sheet 打开期间锁住 page 自身滚动,防止内部手势穿透
    statementLoading: false,
    statement: null,     // { month, monthText, income, expense, balance, savingsRate,
                         //   prevMonthExpense, prevYearExpense, hasPrevYear,
                         //   categories:[{name,amount,budget,over,pct}], recurTotal,
                         //   overCategories, budgetOver, budgetNear,
                         //   insightText, insightSource: 'cache'|'llm'|'template' }
    // 账本君对话问答
    chatOpen: false,           // 是否展开 chat 区
    chatInput: '',             // 当前输入框文本
    chatSending: false,        // 请求中
    chatMessages: [],          // [{ role:'user'|'assistant', content, ts, source? }]
    chatRateError: '',         // 限流错误文案(2 秒后自动消)
    // 消费日历热力图
    heatmapSubText: '加载中…',         // 入口卡副标题(动态统计)
    heatmapPreview: [],               // [{date, level}] 最近 91 天格子
    heatmapRange: 'q',                // 'q' 近3月 / 'h' 半年 / 'y' 全年
    heatCellSize: 40,                 // 动态算:13 列撑满 sheet 内宽的 cell 边长(rpx)
    showHeatmap: false,
    showHeatmapClosing: false,
    heatmapGrid: null,                // [[{date, amount, level, today?}, ...]] 7 行 N 列
    heatmapMonthLabels: [],           // [{weekIndex, left, label}] 月份标记位置
    heatmapStats: null,               // {totalDays, totalAmountText, avgAmountText, maxDay}
    showHeatmapDay: false,
    showHeatmapDayClosing: false,
    heatmapDay: null                  // {date, items, totalText, count}
  },

  onShow() {
    util.checkLock()
    this._computeHeatCellSize()
    this.loadData()
    // 记一笔快捷入口：其他页点「＋」跳转过来时，自动弹开记账表单
    const app = getApp()
    if (app.globalData.quickExpense) {
      app.globalData.quickExpense = false
      setTimeout(() => this.openForm(), 120)
    }
    // 主题切换重绘本月账单饼图（颜色取自主题）
    if (this._stmtThemeHandler) wx.offThemeChange(this._stmtThemeHandler)
    this._stmtThemeHandler = () => {
      const a = getApp()
      a.syncTheme()
      a.applyNavBarColor()
      if (this.data.showStatement) {
        const stmt = this._buildStatementData()
        this.setData({ statement: { ...stmt, insightText: this.data.statement.insightText, insightSource: this.data.statement.insightSource } })
      }
    }
    wx.onThemeChange(this._stmtThemeHandler)
  },

  onUnload() {
    if (this._stmtThemeHandler) {
      wx.offThemeChange(this._stmtThemeHandler)
      this._stmtThemeHandler = null
    }
  },

  onHide() {
    // 切走页面时停掉数字滚动动画，避免后台空转
    if (this._cancelAnim) {
      this._cancelAnim.forEach((fn) => fn())
      this._cancelAnim = null
    }
  },

  async onPullDownRefresh() {
    try {
      await this.loadData(true)
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  async loadData(force) {
    const app = getApp()
    await app.ready()
    const month = this.data.viewMonth || util.thisMonthStr()
    const thisMonth = util.thisMonthStr()
    const prev = this.prevMonth(month)
    const prevYear = this.shiftMonth(month, -12)
    if (!this._loaded) this.setData({ loading: true })
    try {
      const [user, list, lastList, recurList, salaryList, prevYearList, cards] = await Promise.all([
        dbApi.getMyUser(force),
        dbApi.listExpenses(month, force),
        dbApi.listExpenses(prev, force),
        dbApi.listRecurring(force),
        dbApi.listSalary(force),
        dbApi.listExpenses(prevYear, force),
        dbApi.listCards(force)
      ])

      const recurTotal = recurList
        .filter((r) => r.active !== false)
        .reduce((s, r) => s + (r.amount || 0), 0)

      const budget = (user && user.budget) || 0
      const monthTotal = list.reduce((s, x) => s + (x.amount || 0), 0)
      const lastMonthTotal = lastList.reduce((s, x) => s + (x.amount || 0), 0)
      const prevYearTotal = prevYearList.reduce((s, x) => s + (x.amount || 0), 0)
      const percent = budget > 0 ? Math.round((monthTotal / budget) * 100) : 0
      const overAmount = budget > 0 && monthTotal > budget ? monthTotal - budget : 0

      // 收入 / 还款：仅本月（按 payDate 归月，与首页一致口径）
      const income = salaryList
        .filter((s) => (s.payDate || '').startsWith(month))
        .reduce((s, x) => s + (x.amount || 0), 0)
      const repayByMonth = {}
      cards.forEach((c) => {
        const hist = c.history || []
        if (hist.length) {
          hist.forEach((h) => {
            const m = (h.date || '').slice(0, 7)
            if (m) repayByMonth[m] = (repayByMonth[m] || 0) + (h.amount || 0)
          })
        } else if (c.status === 'paid' && c.repayDate) {
          const m = c.repayDate.slice(0, 7)
          repayByMonth[m] = (repayByMonth[m] || 0) + (c.amount || 0)
        }
      })
      const repay = repayByMonth[month] || 0
      // 还款流水已经包含在 monthTotal(标记已还会自动写一条 category=还款 的流水),
      // 这里不能再减一次,否则还款金额被算两遍(支出减一次 + 还款再减一次)
      const balance = income - monthTotal
      const savingsRate = income > 0 ? (balance / income) * 100 : 0

      // 分类统计
      const catMap = {}
      list.forEach((x) => {
        const c = x.category || '其他'
        catMap[c] = (catMap[c] || 0) + (x.amount || 0)
      })
      const catStats = this.data.categories
        .map((name) => ({
          name,
          amount: catMap[name] || 0,
          amountText: util.moneyThousand(catMap[name] || 0)
        }))
        .map((c) => ({
          ...c,
          percent: monthTotal > 0 ? Math.round((c.amount / monthTotal) * 100) : 0
        }))
        .sort((a, b) => b.amount - a.amount)

      const fmtList = list.map((x) => ({
        ...x,
        amountText: util.moneyThousand(x.amount)
      }))

      // 留一份原始流水(带 note),给「本月账单」sheet 聚合分类 top-3 备注用
      this._stmtRawList = list

      this._loaded = true
      this.setData({
        user,
        viewMonth: month,
        monthText: month,
        isThisMonth: month === thisMonth,
        list: fmtList,
        catStats,
        loading: false,
        monthTotal: util.moneyThousand(monthTotal),
        lastMonthTotal: util.moneyThousand(lastMonthTotal),
        budget,
        budgetPercent: Math.min(percent, 100),
        budgetOver: percent > 100,
        budgetNear: !!(budget > 0 && percent >= 80 && percent <= 100),
        overAmount: util.moneyThousand(overAmount),
        recurList: recurList.map((r) => ({
          ...r,
          amountText: util.moneyThousand(r.amount),
          // 本月是否已手动确认记账（防重复）
          recordedThisMonth: r.lastRecorded === thisMonth
        })),
        recurTotal: util.moneyThousand(recurTotal),
        recurCount: recurList.filter((r) => r.active !== false).length,
        // 动画用原始数值
        _monthTotalNum: monthTotal,
        _lastMonthTotalNum: lastMonthTotal,
        _overAmountNum: overAmount,
        // 本月账单 sheet 用（不 setData,留给 statement 拼数据）
        _stmtIncome: income,
        _stmtRepay: repay,
        _stmtBalance: balance,
        _stmtSavingsRate: savingsRate,
        _stmtPrevYearTotal: prevYearTotal,
        _stmtHasPrevYear: prevYearList.length > 0
      })

      // 数字滚动动画
      this._cancelAnim && this._cancelAnim.forEach((fn) => fn())
      this._cancelAnim = [
        util.animateNumber(this, 'monthTotal', monthTotal, { duration: 700, decimals: 2, thousand: true, prefix: '¥' }),
        util.animateNumber(this, 'lastMonthTotal', lastMonthTotal, { duration: 600, decimals: 2, thousand: true, prefix: '¥' }),
        util.animateNumber(this, 'overAmount', overAmount, { duration: 500, decimals: 2, thousand: true, prefix: '¥' })
      ]

      // 热力图入口卡预览(异步,不阻塞主流程)
      this._loadHeatmapPreview(force).catch((err) => console.warn('热力图预览失败', err))
    } catch (e) {
      this._loaded = true
      this.setData({ loading: false })
      console.error('加载记账失败', e)
      wx.showToast({ title: util.errTip(e, '加载失败，请下拉重试'), icon: 'none' })
    }
  },

  prevMonth(monthStr) {
    const [y, m] = monthStr.split('-').map(Number)
    const d = new Date(y, m - 2, 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  },

  nextMonth(monthStr) {
    const [y, m] = monthStr.split('-').map(Number)
    const d = new Date(y, m, 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  },

  /** 通用月份位移：delta 可正可负,绝对值不限（用于去年同月 delta=-12） */
  shiftMonth(monthStr, delta) {
    const [y, m] = monthStr.split('-').map(Number)
    const d = new Date(y, m - 1 + delta, 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  },

  /* ---------- 月份切换 ---------- */
  goPrevMonth() {
    const cur = this.data.viewMonth || util.thisMonthStr()
    const target = this.prevMonth(cur)
    this._loaded = true // 已加载过骨架屏，翻月静默刷新
    this.setData({ viewMonth: target })
    this.loadData()
  },

  goNextMonth() {
    const cur = this.data.viewMonth || util.thisMonthStr()
    const target = this.nextMonth(cur)
    if (target > util.thisMonthStr()) {
      wx.showToast({ title: '不能查看未来月份', icon: 'none' })
      return
    }
    this._loaded = true
    this.setData({ viewMonth: target })
    this.loadData()
  },

  /* ---------- 新增 ---------- */
  openForm() {
    if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null }
    util.openSheet(this, 'showForm', {
      formAmount: '',
      formCategory: '餐饮',
      formDate: util.todayStr(),
      formNote: ''
    })
  },

  closeForm() {
    this._closeTimer = util.closeSheet(this, 'showForm')
  },

  onAmountInput(e) {
    this.setData({ formAmount: e.detail.value })
  },

  onCategoryTap(e) {
    this.setData({ formCategory: e.currentTarget.dataset.cat })
  },

  onDateChange(e) {
    this.setData({ formDate: e.detail.value })
  },

  onNoteInput(e) {
    this.setData({ formNote: e.detail.value })
  },

  async saveExpense() {
    const { formAmount, formCategory, formDate, formNote } = this.data
    const amount = Number(formAmount)
    if (!amount || amount <= 0) {
      wx.showToast({ title: '请输入正确金额', icon: 'none' })
      return
    }
    if (this.data.saving) return
    this.setData({ saving: true })
    try {
      await dbApi.addExpense({ date: formDate, category: formCategory, amount, note: formNote.trim() })
      wx.showToast({ title: '已记账', icon: 'success' })
      util.closeSheet(this, 'showForm')
      // 切到新纪录所在月份，保存后立即可见
      this.setData({ viewMonth: formDate.slice(0, 7) })
      // 失效当月 AI 解读缓存(用户改了数据 → 上次的解读过期)
      dbApi.invalidateFinCache(formDate.slice(0, 7))
      this.loadData()
    } catch (e) {
      wx.showToast({ title: '保存失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  /* ---------- 删除 ---------- */
  removeExpense(e) {
    const { id, date, amount } = e.currentTarget.dataset
    wx.showModal({
      title: '删除记录',
      content: `确定删除 ${date} 的 ¥${amount} 吗？删除后可在回收站恢复（保留 ${config.RECYCLE_DAYS} 天）。`,
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await dbApi.removeExpense(id)
          wx.showToast({ title: '已移入回收站', icon: 'success' })
          // 失效当月 AI 解读缓存
          dbApi.invalidateFinCache((date || '').slice(0, 7))
          this.loadData()
        } catch (err) {
          wx.showToast({ title: '删除失败', icon: 'none' })
        }
      }
    })
  },

  /* ---------- 固定支出管理 ---------- */
  openRecur() {
    if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null }
    util.openSheet(this, 'showRecur')
  },

  closeRecur() {
    this._closeTimer = util.closeSheet(this, 'showRecur')
  },

  openRecurForm() {
    if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null }
    util.openSheet(this, 'showRecurForm', {
      rName: '',
      rAmount: '',
      rCategory: '居住'
    })
  },

  closeRecurForm() {
    this._closeTimer = util.closeSheet(this, 'showRecurForm')
  },

  onRNameInput(e) {
    this.setData({ rName: e.detail.value })
  },

  onRAmountInput(e) {
    this.setData({ rAmount: e.detail.value })
  },

  onRCategoryTap(e) {
    this.setData({ rCategory: e.currentTarget.dataset.cat })
  },

  async saveRecurring() {
    const { rName, rAmount, rCategory } = this.data
    const amount = Number(rAmount)
    if (!rName.trim()) {
      wx.showToast({ title: '请填写名称', icon: 'none' })
      return
    }
    if (!amount || amount <= 0) {
      wx.showToast({ title: '请输入正确金额', icon: 'none' })
      return
    }
    if (this.data.recurSaving) return
    this.setData({ recurSaving: true })
    try {
      await dbApi.addRecurring({
        name: rName.trim(),
        amount,
        category: rCategory
      })
      wx.showToast({ title: '已添加模板', icon: 'success' })
      util.closeSheet(this, 'showRecurForm')
      this.loadData()
    } catch (e) {
      console.error('添加固定支出失败', e)
      const msg = e && e.isCollectionMissing ? e.message : '保存失败'
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      this.setData({ recurSaving: false })
    }
  },

  /* 手动确认记账：点了「记入本月」才生成一条真实开销（不自动扣） */
  recordRecurringItem(e) {
    const { id, name, amount, recorded } = e.currentTarget.dataset
    if (recorded) {
      wx.showToast({ title: '本月已记过这笔了', icon: 'none' })
      return
    }
    wx.showModal({
      title: '记入本月',
      content: `确认已支付「${name}」¥${amount}？确认后按今天日期记一笔开销。`,
      success: async (res) => {
        if (!res.confirm) return
        try {
          const r = await dbApi.recordRecurring(id)
          if (r && r.dup) {
            wx.showToast({ title: '本月已记过这笔了', icon: 'none' })
          } else {
            wx.showToast({ title: '已记账', icon: 'success' })
          }
          // 失效本月 AI 解读缓存
          dbApi.invalidateFinCache(util.thisMonthStr())
          this.loadData()
        } catch (err) {
          console.error('固定支出记账失败', err)
          wx.showToast({ title: '记账失败', icon: 'none' })
        }
      }
    })
  },

  /* 切换「每月自动落账」开关（乐观更新,失败回滚） */
  async toggleAutoRecord(e) {
    const id = e.currentTarget.dataset.id
    const newVal = e.detail.value === true
    const before = (this.data.recurList || []).find((r) => r._id === id)
    if (!before || before.autoRecord === newVal) return
    // 乐观更新 UI,立即反馈
    const list = (this.data.recurList || []).map((r) =>
      r._id === id ? { ...r, autoRecord: newVal } : r
    )
    this.setData({ recurList: list })
    try {
      await dbApi.updateRecurring(id, { autoRecord: newVal })
      wx.showToast({
        title: newVal ? '已开启自动落账' : '已关闭自动落账',
        icon: 'none',
        duration: 1500
      })
    } catch (err) {
      // 写库失败 → 回滚 UI
      const rollback = (this.data.recurList || []).map((r) =>
        r._id === id ? { ...r, autoRecord: !newVal } : r
      )
      this.setData({ recurList: rollback })
      wx.showToast({ title: '切换失败', icon: 'none' })
    }
  },

  removeRecurringItem(e) {
    const { id, name } = e.currentTarget.dataset
    wx.showModal({
      title: '删除固定支出',
      content: `删除「${name}」仅移除模板，已记入流水的记录保留。删除后可在回收站恢复。确定删除吗？`,
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await dbApi.removeRecurring(id)
          wx.showToast({ title: '已移入回收站', icon: 'success' })
          this.loadData()
        } catch (err) {
          wx.showToast({ title: '删除失败', icon: 'none' })
        }
      }
    })
  },

  /* ---------- 本月账单 sheet ---------- */
  openStatement() {
    if (!this.data.catStats.length) {
      wx.showToast({ title: '本月还没有数据', icon: 'none' })
      return
    }
    if (this._stmtCloseTimer) { clearTimeout(this._stmtCloseTimer); this._stmtCloseTimer = null }
    util.openSheet(this, 'showStatement')
    // 拼好基础数据(数字 / 分类 / 同比环比),AI 解读异步填
    const stmt = this._buildStatementData()
    // 每次开 sheet 重置 chat(关闭后再次进入,从零开始)
    this.setData({
      statement: stmt,
      statementLoading: true,
      chatOpen: false,
      chatInput: '',
      chatSending: false,
      chatMessages: [],
      chatRateError: '',
      pageLocked: true   // 锁 page 自身滚动,防止 sheet 内 scroll-view 边界手势穿透
    })
    this.loadStatement(false)
  },

  closeStatement() {
    this._stmtCloseTimer = util.closeSheet(this, 'showStatement')
    // 关 sheet 时重置 chat,下次打开是干净状态
    this.setData({
      chatOpen: false,
      chatInput: '',
      chatSending: false,
      chatMessages: [],
      chatRateError: '',
      pageLocked: true   // 保持锁定直到滑出动画结束,避免动画期间 page 闪动
    })
    // 动画结束后(240ms)再解锁 page 滚动
    if (this._stmtUnlockTimer) clearTimeout(this._stmtUnlockTimer)
    this._stmtUnlockTimer = setTimeout(() => {
      this.setData({ pageLocked: false })
      this._stmtUnlockTimer = null
    }, 240)
  },

  /* ---------- 消费日历热力图 ---------- */

  openHeatmap() {
    if (this._heatmapCloseTimer) { clearTimeout(this._heatmapCloseTimer); this._heatmapCloseTimer = null }
    util.openSheet(this, 'showHeatmap')
    this._loadHeatmapFull()
  },

  closeHeatmap() {
    this._heatmapCloseTimer = util.closeSheet(this, 'showHeatmap')
  },

  switchHeatmapRange(e) {
    const r = e.currentTarget.dataset.range
    if (!r || r === this.data.heatmapRange) return
    // 先重置 grid,避免切换瞬间的错位闪烁
    this.setData({ heatmapRange: r, heatmapGrid: null, heatmapMonthLabels: [], heatmapStats: null })
    // cellSize 保持 13 列基准不变 — 切到 26/52 列时 cell 不缩,grid 自然超 viewport → 横滚查看
    this._loadHeatmapFull()
  },

  tapHeatmapCell(e) {
    const { date, amount } = e.currentTarget.dataset
    if (!date || !amount || Number(amount) <= 0) {
      wx.showToast({ title: '这天没开销', icon: 'none', duration: 1000 })
      return
    }
    const items = (this._heatmapItemsByDate && this._heatmapItemsByDate[date]) || []
    const fmtItems = items.map((x) => ({
      ...x,
      amountText: util.moneyThousand(x.amount)
    }))
    const total = fmtItems.reduce((s, x) => s + (x.amount || 0), 0)
    this.setData({
      showHeatmapDay: true,
      showHeatmapDayClosing: false,
      heatmapDay: {
        date,
        items: fmtItems,
        totalText: util.moneyThousand(total),
        count: fmtItems.length
      }
    })
  },

  closeHeatmapDay() {
    util.closeSheet(this, 'showHeatmapDay')
  },

  /**
   * 入口卡预览：拉最近 4 个月开销(覆盖 13 周 + 余量),聚合 13 列 × 7 行 = 91 格。
   * 失败静默(主流程 catch 已处理过,这里再兜一道,不让预览报错打断主流程)。
   */
  async _loadHeatmapPreview(force) {
    const { byDay, items } = await dbApi.listExpensesForHeatmap(4, force)
    const cells = buildHeatmapCells(byDay, 91)
    // 压平成时间序列,截取最近 91 格给入口卡预览
    const flat = []
    for (const col of cells) for (const c of col) flat.push(c)
    const preview = flat.slice(-91)
    const stats = computeHeatmapStats(byDay)
    this.setData({
      heatmapPreview: preview,
      heatmapSubText: `近 3 月共 ¥${stats.totalAmountText} · ${stats.totalDays} 天有开销`
    })
    // 顺便把 items 也分组缓存,主 sheet 复用
    this._heatmapItemsByDate = groupItemsByDate(items)
  },

  /**
   * 主 sheet 数据:按当前 heatmapRange 拉对应范围,构造完整 grid + 月份 label + 统计
   */
  async _loadHeatmapFull() {
    const map = { q: [4, 91], h: [7, 182], y: [13, 365] }
    const conf = map[this.data.heatmapRange] || map.q
    const [monthsBack, days] = conf
    const { byDay, items } = await dbApi.listExpensesForHeatmap(monthsBack)
    const grid = buildHeatmapCells(byDay, days, this.data.heatCellSize)
    const today = util.todayStr()
    grid.forEach((col) => col.forEach((c) => { if (c.date === today) c.today = true }))
    const monthLabels = buildHeatmapMonthLabels(grid, this.data.heatCellSize)
    this._heatmapItemsByDate = groupItemsByDate(items)
    this.setData({
      heatmapGrid: grid,
      heatmapMonthLabels: monthLabels,
      heatmapStats: computeHeatmapStats(byDay)
    })
  },

  /**
   * 按 13 列撑满弹框算 cell 边长,作为基准。
   * 切到近半年(26 列)/近一年(52 列)时 cell 不变,grid 总宽 > viewport → 横滚查看。
   * 这样三种窗口 cell 视觉一致,信息密度通过列数表达。
   *
   * 公式: cell = (container - 8 - 12*4) / 13
   * 仅设下限 32rpx(小屏也别太小,大屏 cell 自然放大,真正撑满)。
   */
  _computeHeatCellSize() {
    let screenWidth = 750
    try {
      const info = (wx.getWindowInfo && wx.getWindowInfo()) || wx.getSystemInfoSync()
      screenWidth = (info && info.windowWidth) || screenWidth
    } catch (e) {}
    const container = screenWidth - 64  // sheet 左右 padding 32*2
    const size = Math.max(32, Math.floor((container - 8 - 12 * 4) / 13))
    if (size !== this.data.heatCellSize) {
      this.setData({ heatCellSize: size })
    }
  },

  /* ---------- 账本君对话问答 ---------- */
  openChat() {
    this.setData({ chatOpen: true })
  },

  closeChat() {
    // 关闭输入区,但保留对话历史,再开能继续看
    this.setData({ chatOpen: false, chatInput: '', chatRateError: '' })
  },

  onChatInput(e) {
    this.setData({ chatInput: e.detail.value || '' })
  },

  async sendChat() {
    const stmt = this.data.statement
    if (!stmt) return
    const q = (this.data.chatInput || '').trim()
    if (!q || this.data.chatSending) return

    // 1. 前端 throttle：每分钟 ≤6 次
    const now = Date.now()
    this._chatTs = (this._chatTs || []).filter((t) => now - t < 60000)
    if (this._chatTs.length >= 6) {
      this.setData({ chatRateError: '一分钟最多问 6 次,稍等再问' })
      setTimeout(() => this.setData({ chatRateError: '' }), 2000)
      return
    }
    this._chatTs.push(now)

    // 2. 推 user 气泡,清空输入框,置 sending
    const userMsg = { role: 'user', content: q, ts: now }
    this.setData({
      chatSending: true,
      chatInput: '',
      chatMessages: [...this.data.chatMessages, userMsg]
    })

    // 3. 调云函数 + 8s 超时
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
          data: { month: stmt.month, question: q, data: this._stmtForChat() },
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

    // 4. 拼 assistant 气泡
    let assistant
    const code = result && result.code
    if (result && result.text) {
      assistant = { role: 'assistant', content: result.text, ts: Date.now(), source: 'llm' }
    } else if (code === 'RATE_LIMIT') {
      assistant = { role: 'assistant', content: result.msg || '问得有点急,稍等再问', ts: Date.now(), source: 'local' }
    } else if (code === 'NO_KEY' || timedOut) {
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
      assistant = { role: 'assistant', content: `${prefix}\n${tpl}`, ts: Date.now(), source: 'local' }
    } else {
      assistant = { role: 'assistant', content: '账本君暂时没想明白,稍后再问', ts: Date.now(), source: 'local' }
    }

    this.setData({
      chatSending: false,
      chatMessages: [...this.data.chatMessages, assistant]
    })

    // 5. 滚到底部(scroll-view 的 scroll-into-view 模式)
    const lastTs = (this.data.chatMessages[this.data.chatMessages.length - 1] || {}).ts
    if (lastTs) {
      this.setData({ chatScrollIntoView: 'msg-' + lastTs })
    }
  },

  /** 序列化 statement 给云函数,只传 LLM 需要的字段 */
  _stmtForChat() {
    const s = this.data.statement
    if (!s) return null

    // 对话数据增强:在 _stmtForChat 里现算,不污染 _buildStatementData / loadData
    // 1) 最近 30 条明细(按金额倒序)— 解决"买烟哪天"这类问题
    const recentList = (this.data.list || [])
      .slice()
      .sort((a, b) => (b.amount || 0) - (a.amount || 0))
      .slice(0, 30)
      .map((x) => ({
        date: x.date || '',
        category: x.category || '其他',
        amount: x.amount || 0,
        note: (x.note || '').trim()
      }))

    // 2) 近 3 个月趋势 — 阶段 2 再补 income/savingsRate,这里先只算 expense(只塞当月数据)
    //    阶段 2 改造:在 loadData 里加 trendMonths 字段,这里直接读
    const recentMonths = [{ month: s.month, expense: s.expense }]

    return {
      month: s.month,
      monthText: s.monthText,
      income: s.income,
      expense: s.expense,
      balance: s.balance,
      savingsRate: s.savingsRate,
      prevMonthExpense: s.prevMonthExpense,
      prevYearExpense: s.hasPrevYear ? s.prevYearExpense : undefined,
      hasPrevYear: s.hasPrevYear,
      recurTotal: s.recurTotal,
      categories: (s.categories || []).map((c) => ({
        name: c.name,
        amount: c.amount,
        budget: c.budget || 0,
        over: !!c.over,
        topNotes: c.topNotes || []
      })),
      budgetOver: s.budgetOver,
      budgetNear: s.budgetNear,
      overCategories: s.overCategories,
      recentList,
      recentMonths
    }
  },

  /** 把 loadData 算出的字段组装成 sheet 要渲染的对象（包含原始数字 + 展示字符串 + 分类备注） */
  _buildStatementData() {
    const month = this.data.viewMonth
    const monthTotal = this.data._monthTotalNum || 0
    const income = this.data._stmtIncome || 0
    const repay = this.data._stmtRepay || 0
    const balance = this.data._stmtBalance || 0
    const savingsRate = this.data._stmtSavingsRate || 0
    const prevMonthExpense = this.data._lastMonthTotalNum || 0
    const prevYearExpense = this.data._stmtPrevYearTotal || 0
    const hasPrevYear = !!this.data._stmtHasPrevYear
    const recurTotal = (this.data.recurList || [])
      .filter((r) => r.active !== false)
      .reduce((s, r) => s + (r.amount || 0), 0)

    // 分类备注 top-3:按"出现金额"权重排序,让 LLM 看到"抚养费/补习班"而不是泛称
    const noteByCat = {}
    ;(this._stmtRawList || []).forEach((x) => {
      const n = (x.note || '').trim()
      if (!n) return
      const k = x.category || '其他'
      if (!noteByCat[k]) noteByCat[k] = new Map()
      const m = noteByCat[k]
      m.set(n, (m.get(n) || 0) + (x.amount || 0))
    })

    // 分类,带上预算对照 + 颜色 + 格式化字符串 + top-3 备注
    const palette = ['#14304F', '#C8A04D', '#C94040', '#C98A2D', '#2F9B6B', '#4A6B8A']
    const paletteDark = ['#8AA4C2', '#E5C26B', '#E55858', '#E0A055', '#4FB78A', '#8AA4C2']
    const app = getApp()
    const isDark = app && app.globalData && app.globalData.theme === 'dark'
    const colors = isDark ? paletteDark : palette
    const budgetMap = (this.data.user && this.data.user.budgets) || {}
    const categories = (this.data.catStats || [])
      .filter((c) => c.amount > 0)
      .map((c, idx) => {
        const b = budgetMap[c.name]
        const over = typeof b === 'number' && b > 0 && c.amount > b
        const topNotes = noteByCat[c.name]
          ? [...noteByCat[c.name].entries()]
              .sort((a, b2) => b2[1] - a[1])
              .slice(0, 3)
              .map(([n]) => n)
          : []
        return {
          name: c.name,
          amount: c.amount,
          amountText: util.moneyThousand(c.amount),
          percent: c.percent,
          budget: typeof b === 'number' ? b : 0,
          over,
          topNotes,
          color: colors[idx % colors.length]
        }
      })
    const overCategories = categories.filter((c) => c.over).map((c) => c.name)

    // 同比环比 — 预格式化方向 + 百分比字符串(WXML 不能用 Math.abs)
    const buildDelta = (cur, prev) => {
      if (!prev || !cur) return null
      const diff = cur - prev
      const pct = (diff / prev) * 100
      return {
        dir: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
        pctText: Math.abs(pct).toFixed(1) + '%',
        arrow: diff > 0 ? '↑' : diff < 0 ? '↓' : '·'
      }
    }
    const mom = buildDelta(monthTotal, prevMonthExpense)
    const yoy = hasPrevYear ? buildDelta(monthTotal, prevYearExpense) : null

    return {
      month,
      monthText: `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`,
      // 原始数字 — 模板 / 云函数都靠这些,必须存在
      income,
      expense: monthTotal,
      balance,
      savingsRate,
      prevMonthExpense,
      prevYearExpense: hasPrevYear ? prevYearExpense : null,
      hasPrevYear,
      recurTotal,
      // 展示用字符串 — WXML 渲染用
      incomeText: util.moneyThousand(income),
      expenseText: util.moneyThousand(monthTotal),
      balanceText: util.moneyThousand(Math.abs(balance)),
      balanceSign: balance >= 0 ? '+' : '-',
      savingsRateText: savingsRate.toFixed(0) + '%',
      savingsLevel: savingsRate >= 20 ? 'good' : savingsRate >= 0 ? 'mid' : 'bad',
      momText: util.moneyThousand(prevMonthExpense),
      momDelta: mom,
      yoyText: hasPrevYear ? util.moneyThousand(prevYearExpense) : '—',
      yoyDelta: yoy,
      categories,
      recurTotalText: util.moneyThousand(recurTotal),
      overCategories,
      budgetOver: this.data.budgetOver,
      budgetNear: this.data.budgetNear,
      insightText: '',
      insightSource: ''
    }
  },

  /**
   * 拉 AI 解读
   *  - 流程: 进入先 loading,等云函数结果;AI 拿到就显示 AI;失败/超时/未配 key 才回退到本地模板
   *  - force=true: 跳过缓存,云函数强制重生成
   */
  async loadStatement(force) {
    const stmt = this.data.statement
    if (!stmt) return

    // 1. 先清空 + 切到 loading,避免残留旧文本闪现
    this.setData({
      statementLoading: true,
      statement: { ...stmt, insightText: '', insightSource: 'loading' }
    })

    // 2. 调云函数(8s 超时自动放弃 → 走模板兜底)
    try {
      const res = await this._callFinReport(stmt, force)
      if (res && res.text) {
        this._renderInsight(res.text, res.source || 'llm')
        return
      }
      throw new Error('云函数返回空')
    } catch (e) {
      console.warn('AI 解读失败,回退本地模板', e)
      // 3. 兜底:用同一 stmt 对象(含原始数字)喂模板,不会再走"没数据"分支
      const tplText = finTemplate.build({
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
      this._renderInsight(tplText, 'template')
    } finally {
      this.setData({ statementLoading: false })
    }
  },

  /** 调云函数带超时 */
  _callFinReport(stmt, force) {
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('云函数超时'))
      }, 8000)
      wx.cloud.callFunction({
        name: 'finReport',
        data: {
          month: stmt.month,
          force: !!force,
          data: {
            monthText: stmt.monthText,
            income: stmt.income,
            expense: stmt.expense,
            balance: stmt.balance,
            savingsRate: stmt.savingsRate,
            prevMonthExpense: stmt.prevMonthExpense,
            prevYearExpense: stmt.hasPrevYear ? stmt.prevYearExpense : undefined,
            hasPrevYear: stmt.hasPrevYear,
            recurTotal: stmt.recurTotal,
            categories: stmt.categories.map((c) => ({
              name: c.name,
              amount: c.amount,
              budget: c.budget || 0,
              over: !!c.over,
              topNotes: c.topNotes || []
            })),
            budgetOver: stmt.budgetOver,
            budgetNear: stmt.budgetNear,
            overCategories: stmt.overCategories
          }
        },
        success: (r) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          const result = r && r.result
          if (!result) return reject(new Error('云函数返回空'))
          if (result.code) return reject(new Error(result.msg || result.code))
          resolve({ text: result.text, source: result.source })
        },
        fail: (e) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(e)
        }
      })
    })
  },

  _renderInsight(text, source) {
    const stmt = this.data.statement || {}
    this.setData({
      statement: { ...stmt, insightText: text, insightSource: source }
    })
  },

  /** 强制重新生成（清缓存 + 调 AI） */
  async forceRegen() {
    if (!this.data.statement || this.data.statementLoading) return
    this.loadStatement(true)
  },

})
