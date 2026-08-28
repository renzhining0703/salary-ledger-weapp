const config = require('../../utils/config')
const util = require('../../utils/util')
const dbApi = require('../../utils/db')
const finTemplate = require('../../utils/finTemplate')

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
    statementLoading: false,
    statement: null      // { month, monthText, income, expense, balance, savingsRate,
                         //   prevMonthExpense, prevYearExpense, hasPrevYear,
                         //   categories:[{name,amount,budget,over,pct}], recurTotal,
                         //   overCategories, budgetOver, budgetNear,
                         //   insightText, insightSource: 'cache'|'llm'|'template' }
  },

  onShow() {
    util.checkLock()
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
        setTimeout(() => this.drawStatementPie(), 80)
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
      const balance = income - monthTotal - repay
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
    this.setData({ statement: stmt, statementLoading: true })
    this.loadStatement(false)
    // 等 sheet 动画 + canvas 挂载后再画饼图
    setTimeout(() => this.drawStatementPie(), 280)
  },

  closeStatement() {
    this._stmtCloseTimer = util.closeSheet(this, 'showStatement')
  },

  /** 把 loadData 算出的字段组装成 sheet 要渲染的对象（包含所有展示用的预格式化字符串） */
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

    // 分类,带上预算对照 + 颜色 + 格式化字符串
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
        return {
          name: c.name,
          amount: c.amount,
          amountText: util.moneyThousand(c.amount),
          percent: c.percent,
          budget: typeof b === 'number' ? b : 0,
          over,
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
      hasPrevYear,
      categories,
      recurTotal,
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
   *  - 缓存命中: 直接显示
   *  - 否则: 云函数 finReport,8s 超时降级到模板
   *  - force=true: 跳过缓存,云函数强制重生成
   */
  async loadStatement(force) {
    const stmt = this.data.statement
    if (!stmt) return
    this.setData({ statementLoading: true })

    // 1. 先本地模板兜底,任何时候都能立刻出字
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
    this._renderInsight(tplText, force ? '' : 'template-pending')

    // 2. 调云函数(超时 8s 自动放弃,保留模板)
    try {
      const res = await this._callFinReport(stmt, force)
      if (res && res.text) {
        this._renderInsight(res.text, res.source || 'llm')
      }
    } catch (e) {
      console.warn('AI 解读失败,保留模板', e)
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
              over: !!c.over
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

  /** 画分类饼图（弹层 wx:if 挂载完成后再调） */
  drawStatementPie() {
    if (!this.data.showStatement || !this.data.statement) return
    const query = this.createSelectorQuery()
    query.select('#statementPie')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return
        const canvas = res[0].node
        const W = res[0].width
        const H = res[0].height
        const dpr = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).pixelRatio || 2
        canvas.width = W * dpr
        canvas.height = H * dpr
        const ctx = canvas.getContext('2d')
        ctx.scale(dpr, dpr)
        ctx.clearRect(0, 0, W, H)

        const cats = (this.data.statement.categories || []).filter((c) => c.amount > 0)
        if (!cats.length) return

        const total = cats.reduce((s, c) => s + c.amount, 0)
        const cx = W / 2
        const cy = H / 2
        const r = Math.min(W, H) / 2 - 6
        const innerR = r * 0.58

        const app = getApp()
        const isDark = app && app.globalData && app.globalData.theme === 'dark'
        // 6 个分类按 config.CATEGORIES 顺序固定取色
        const paletteLight = ['#14304F', '#C8A04D', '#C94040', '#C98A2D', '#2F9B6B', '#4A6B8A']
        const paletteDark = ['#8AA4C2', '#E5C26B', '#E55858', '#E0A055', '#4FB78A', '#8AA4C2']
        const colors = isDark ? paletteDark : paletteLight

        let start = -Math.PI / 2
        cats.forEach((c, i) => {
          const angle = (c.amount / total) * Math.PI * 2
          ctx.beginPath()
          ctx.moveTo(cx, cy)
          ctx.arc(cx, cy, r, start, start + angle)
          ctx.closePath()
          ctx.fillStyle = colors[i % colors.length]
          ctx.fill()
          start += angle
        })
        // 中心挖空（甜甜圈样式）
        ctx.beginPath()
        ctx.arc(cx, cy, innerR, 0, Math.PI * 2)
        ctx.fillStyle = isDark ? '#1A2532' : '#FFFFFF'
        ctx.fill()
        // 中心文字
        ctx.fillStyle = isDark ? '#A8B4C5' : '#657183'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.font = '500 20px sans-serif'
        ctx.fillText('总支出', cx, cy - 16)
        ctx.fillStyle = isDark ? '#E8EDF3' : '#151E2B'
        ctx.font = 'bold 28px "DIN Alternate", sans-serif'
        ctx.fillText('¥' + total.toFixed(0), cx, cy + 14)
      })
  }
})
