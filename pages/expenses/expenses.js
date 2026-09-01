const config = require('../../utils/config')
const util = require('../../utils/util')
const dbApi = require('../../utils/db')
const themeUtil = require('../../utils/theme')


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
    // 固定支出联动（记一笔 ↔ 模板）：打开记一笔时拉本月未落账模板，点一下预填并关联
    pendingRecurring: [],   // [{_id, name, amount, amountText, category}]
    linkedRecurring: null,  // 已选中待关联的模板（保存时写入 recurringId 并标记 lastRecorded）
    // 固定支出（数据供快捷条用，管理入口已移到「我的」页）
    recurList: [],
    recurTotal: '0.00',
    recurCount: 0
  },

  onLoad(options) {
    // 自定义导航栏（navigationStyle: custom）：状态栏高度需 JS 注入
    this.setData({ statusBarHeight: wx.getWindowInfo().statusBarHeight || 44 })
    // 消费日历「记一笔」预填日期：仅接受合法 YYYY-MM-DD，openForm 时应用后即焚
    const d = options && options.date
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      this._prefillDate = d
    }
  },

  onShow() {
    util.checkLock()
    // 外观偏好 / 系统主题刷新根节点 class + 窗口背景
    themeUtil.applyToPage(this)
    // force=true:切到记账页时强制重查。云函数写库(账本君记账)不触发 dbApi 缓存失效,
    // 不 force 的话流水列表 / 预算条不显示账本君刚记的那笔
    this.loadData(true)
    // 记一笔快捷入口：其他页点「＋」跳转过来时，自动弹开记账表单
    const app = getApp()
    if (app.globalData.quickExpense) {
      app.globalData.quickExpense = false
      setTimeout(() => this.openForm(), 120)
    }
    // 消费日历「记一笔」跳转：switchTab 不能带参数，靠 globalData 传递预填日期
    if (app.globalData.prefillExpenseDate) {
      const d = app.globalData.prefillExpenseDate
      app.globalData.prefillExpenseDate = null
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        this._prefillDate = d
        setTimeout(() => this.openForm(), 120)
      }
    }
  },

  /**
   * 外观偏好 / 系统主题变化时由 app 统一回调（app.onThemeChange / setThemeMode）：
   * 刷根节点 class。
   */
  applyTheme() {
    themeUtil.applyToPage(this)
  },

  onUnload() {
    if (this._closeTimer) {
      clearTimeout(this._closeTimer)
      this._closeTimer = null
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
    if (!this._loaded) this.setData({ loading: true })
    try {
      const [user, list, lastList, recurList] = await Promise.all([
        dbApi.getMyUser(force),
        dbApi.listExpenses(month, force),
        dbApi.listExpenses(prev, force),
        dbApi.listRecurring(force)
      ])

      const recurTotal = recurList
        .filter((r) => r.active !== false)
        .reduce((s, r) => s + (r.amount || 0), 0)

      const budget = (user && user.budget) || 0
      const monthTotal = list.reduce((s, x) => s + (x.amount || 0), 0)
      const lastMonthTotal = lastList.reduce((s, x) => s + (x.amount || 0), 0)
      const percent = budget > 0 ? Math.round((monthTotal / budget) * 100) : 0
      const overAmount = budget > 0 && monthTotal > budget ? monthTotal - budget : 0

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
        _overAmountNum: overAmount
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
    // 消费日历跳转预填的日期：用一次就清掉，避免下次打开仍停留补记日期
    const prefillDate = this._prefillDate
    if (prefillDate) this._prefillDate = null
    util.openSheet(this, 'showForm', {
      formAmount: '',
      formCategory: '餐饮',
      formDate: prefillDate || util.todayStr(),
      formNote: '',
      linkedRecurring: null
    })
    this._loadPendingRecurring()
  },

  /**
   * 拉取本月未落账的固定支出模板（记一笔快捷条数据源）。
   * listRecurring 带 60s 缓存；关联落账走 updateRecurring 会 invalidate，
   * 所以下次打开 sheet 时不会看到已记过的模板。
   */
  async _loadPendingRecurring() {
    try {
      const month = util.thisMonthStr()
      const list = await dbApi.listRecurring()
      const pending = (list || [])
        .filter((r) => r.active !== false && r.lastRecorded !== month)
        .map((r) => ({
          _id: r._id,
          name: r.name,
          amount: r.amount || 0,
          amountText: util.moneyThousand(r.amount || 0),
          category: r.category || '其他'
        }))
      this.setData({ pendingRecurring: pending })
    } catch (err) {
      console.warn('加载待记固定支出失败', err)
      this.setData({ pendingRecurring: [] })
    }
  },

  /** 点快捷条模板：预填金额/分类/备注并挂上关联（保存时同步标记本月已记） */
  onRecurringChipTap(e) {
    const id = e.currentTarget.dataset.id
    const item = (this.data.pendingRecurring || []).find((r) => r._id === id)
    if (!item) return
    this.setData({
      formAmount: String(item.amount),
      formCategory: item.category,
      formNote: item.name,
      linkedRecurring: item
    })
  },

  /** 取消关联：保留已预填内容，仅解除模板绑定 */
  clearLinkedRecurring() {
    this.setData({ linkedRecurring: null })
  },

  closeForm() {
    this._closeTimer = util.closeSheet(this, 'showForm')
  },

  onAmountInput(e) {
    this.setData({ formAmount: e.detail.value })
  },

  onCategoryTap(e) {
    // cat-grid 组件 change 事件：detail.value 为选中分类
    this.setData({ formCategory: e.detail.value })
  },

  onDateChange(e) {
    this.setData({ formDate: e.detail.value })
  },

  onNoteInput(e) {
    this.setData({ formNote: e.detail.value })
  },

  async saveExpense() {
    const { formAmount, formCategory, formDate, formNote, linkedRecurring } = this.data
    const amount = Number(formAmount)
    if (!amount || amount <= 0) {
      wx.showToast({ title: '请输入正确金额', icon: 'none' })
      return
    }
    if (this.data.saving) return
    this.setData({ saving: true })
    try {
      // 关联了固定支出模板 → 开销带 recurringId（可追溯），并按该笔日期所属月标记模板已记
      const payload = { date: formDate, category: formCategory, amount, note: formNote.trim() }
      if (linkedRecurring) payload.recurringId = linkedRecurring._id
      await dbApi.addExpense(payload)
      if (linkedRecurring) {
        try {
          await dbApi.updateRecurring(linkedRecurring._id, { lastRecorded: formDate.slice(0, 7) })
        } catch (err) {
          // 标记失败不阻断记账：模板保持待记状态，下次仍可确认，不会丢数据
          console.warn('固定支出标记失败', err)
        }
      }
      wx.showToast({ title: linkedRecurring ? '已记 · ' + linkedRecurring.name + '本月已同步' : '已记账', icon: 'success' })
      util.closeSheet(this, 'showForm')
      // 切到新纪录所在月份，保存后立即可见
      this.setData({ viewMonth: formDate.slice(0, 7), linkedRecurring: null })
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


  /* ---------- 本月账单（独立页面） ---------- */
  openStatement() {
    if (!this.data.catStats.length) {
      wx.showToast({ title: '本月还没有数据', icon: 'none' })
      return
    }
    // 账单弹框已整体迁移为独立页面 pages/statement，带当前查看月份跳转
    wx.navigateTo({ url: '/pages/statement/statement?month=' + this.data.viewMonth })
  }

})
