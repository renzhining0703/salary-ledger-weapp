const config = require('../../utils/config')
const util = require('../../utils/util')
const dbApi = require('../../utils/db')
const finTemplate = require('../../utils/finTemplate')
const chatController = require('../../utils/chatController')
const themeUtil = require('../../utils/theme')


Page({
  behaviors: [chatController],

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
    // 固定支出（数据供账单弹框用，管理入口已移到「我的」页）
    recurList: [],
    recurTotal: '0.00',
    recurCount: 0,
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
    stmtScrollTop: 0,          // sheet 内主 scroll-view 滚到 sheet 底(超大值即可,自动 clamp)
    // 分类预算设置 sheet（从账单 sheet 分类行点 +预算 / 预算金额 弹出）
    showCatBudget: false,
    showCatBudgetClosing: false,
    catBudgetEditing: null,           // { name, spent, spentText, budget, remainingText }
    catBudgetInput: '',               // 输入框当前文本
    catBudgetFocus: true              // 打开 sheet 时自动 focus 输入框
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
   * 刷根节点 class；账单 sheet 打开中时重算（饼图配色取自生效主题）。
   */
  applyTheme() {
    themeUtil.applyToPage(this)
    if (this.data.showStatement) {
      const stmt = this._buildStatementData()
      this.setData({ statement: { ...stmt, insightText: this.data.statement.insightText, insightSource: this.data.statement.insightSource } })
    }
  },

  onUnload() {
    if (this._undoTimer) {
      clearInterval(this._undoTimer)
      this._undoTimer = null
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

      // 收入：仅本月（按 payDate 归月，与首页一致口径）
      const income = salaryList
        .filter((s) => (s.payDate || '').startsWith(month))
        .reduce((s, x) => s + (x.amount || 0), 0)
      // 还款流水已经包含在 monthTotal(标记已还会自动写一条 category=还款 的流水),
      // 还款并入支出，结余 = 收入 - 支出（含还款），不再单独扣减
      const balance = income - monthTotal
      const savingsRate = income > 0 ? (balance / income) * 100 : 0

      // 【累计口径】账单弹框顶部用滚动结转，和首页看板一致
      const cumIncome = salaryList
        .filter((s) => (s.payDate || '').slice(0, 7) <= month)
        .reduce((s, x) => s + (x.amount || 0), 0)
      let cumExpense = 0
      const expAgg = user && user.expAgg
      if (expAgg && typeof expAgg === 'object') {
        cumExpense = Object.entries(expAgg)
          .filter(([k]) => k <= month)
          .reduce((s, [, v]) => s + (v || 0), 0)
      } else {
        // 快照缺失时先用本月近似（首页 loadData 通常已触发对账，极少走到这里）
        cumExpense = monthTotal
        console.warn('[expenses] 月度支出快照缺失，累计支出用本月近似')
      }
      const available = cumIncome - cumExpense
      const cumSavingsRate = cumIncome > 0 ? (available / cumIncome) * 100 : 0

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
        _monthIncomeNum: income,      // 本月收入（自然月口径，给 statement 算结转用）
        // 本月账单 sheet 用（不 setData,留给 statement 拼数据）
        // income/balance/savingsRate 保持自然月口径（AI 解读/兜底模板依赖）
        _stmtIncome: income,
        _stmtBalance: balance,
        _stmtSavingsRate: savingsRate,
        // 累计口径：账单弹框顶部展示用，与首页看板一致
        _stmtCumIncome: cumIncome,
        _stmtCumExpense: cumExpense,
        _stmtAvailable: available,
        _stmtCumSavingsRate: cumSavingsRate,
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


  /* ---------- 分类预算(账单 sheet 内分类行右侧入口)---------- */
  onCatBudgetTap(e) {
    const cat = e.currentTarget.dataset.cat
    const stmt = this.data.statement
    const c = (stmt && stmt.categories || []).find((x) => x.name === cat)
    if (!c) return
    const budget = c.budget || 0
    const remaining = budget > 0 ? Math.max(0, budget - c.amount) : 0
    this.setData({
      showCatBudget: true,
      showCatBudgetClosing: false,
      catBudgetEditing: {
        name: c.name,
        spent: c.amount,
        spentText: c.amountText,
        budget,
        remainingText: remaining > 0 ? util.moneyThousand(remaining) : '0'
      },
      catBudgetInput: budget > 0 ? String(budget) : '',
      catBudgetFocus: true
    })
  },

  onCatBudgetInput(e) {
    // 只允许数字 + 小数点;粘贴含其他字符时清洗
    const raw = (e.detail.value || '').replace(/[^\d.]/g, '')
    this.setData({ catBudgetInput: raw })
  },

  closeCatBudget() {
    util.closeSheet(this, 'showCatBudget')
  },

  async saveCatBudget() {
    const v = Number(this.data.catBudgetInput)
    if (!v || v <= 0) {
      wx.showToast({ title: '请输入有效金额', icon: 'none' })
      return
    }
    await this._updateCatBudget(this.data.catBudgetEditing.name, v)
  },

  async clearCatBudget() {
    await this._updateCatBudget(this.data.catBudgetEditing.name, 0)
  },

  async _updateCatBudget(cat, value) {
    const app = getApp()
    const user = (this.data.user) || (app.globalData.user) || {}
    const next = Object.assign({}, user.budgets || {})
    if (value > 0) {
      next[cat] = value
    } else {
      delete next[cat]
    }
    try {
      await dbApi.updateMyUser({ budgets: next })
      // 同步本地 + globalData,下次 loadData 不被旧值覆盖
      user.budgets = next
      if (app && app.globalData) app.globalData.user = user
      this.closeCatBudget()
      // 重建 statement + 顶部预算条,让已设分类立刻显示金额
      await this.loadData(true)
      wx.showToast({ title: '已保存', icon: 'success' })
    } catch (err) {
      console.error('保存分类预算失败', err)
      wx.showToast({ title: '保存失败', icon: 'none' })
    }
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
    // chat 与首页共享同一会话(globalData.chatMessages,冷启动已从 storage 恢复):
    // 两处账本君不再人格分裂——首页聊过的,这里接着聊
    this.setData({
      statement: stmt,
      statementLoading: true,
      chatOpen: false,
      chatInput: '',
      chatSending: false,
      chatMessages: (getApp().globalData.chatMessages || []).slice(),
      chatRateError: '',
      pageLocked: true   // 锁 page 自身滚动,防止 sheet 内 scroll-view 边界手势穿透
    })
    this.loadStatement(false)
  },

  closeStatement() {
    this._stmtCloseTimer = util.closeSheet(this, 'showStatement')
    // 关 sheet 只收起输入区,不清会话(与首页共享 globalData,清了首页也丢)
    this.setData({
      chatOpen: false,
      chatInput: '',
      chatSending: false,
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


  /* ---------- 账本君对话问答 ---------- */
  openChat() {
    this.setData({
      chatOpen: true,
      // 展开对话区:滚到 sheet 底部,让输入框进入可视区
      stmtScrollTop: this._bumpScrollTop(99999)
    })
  },

  closeChat() {
    // 关闭输入区,但保留对话历史,再开能继续看
    this.setData({
      chatOpen: false,
      chatInput: '',
      chatRateError: '',
      // 收起时滚回账本君卡片,看到 AI 解读 + 问问入口
      stmtScrollTop: this._bumpScrollTop(99999)
    })
  },

  onChatInput(e) {
    this.setData({ chatInput: e.detail.value || '' })
  },

  /**
   * 输入框聚焦:键盘弹起时强制 sheet 滚到底,避免输入框被键盘遮挡。
   * input 在 scroll-view 内部,系统 adjust-position 不一定可靠,自己滚最稳。
   * 延迟 80ms 是等键盘弹起动画到位,scrollTop 值用递增触发新滚动。
   */
  onChatFocus() {
    setTimeout(() => {
      this.setData({ stmtScrollTop: this._bumpScrollTop(99999) })
    }, 80)
  },

  /* ---------- 账本君对话钩子（发送 / 撤销 / 滚动逻辑由 chatController 提供） ---------- */

  /** statement：本月账单 sheet 已拼好的数据（未打开账单则中止发问） */
  _chatStmt() {
    return this.data.statement || null
  },

  /** 最近流水：本月流水列表（时间倒序） */
  _chatRecentList() {
    return this.data.list || []
  },

  /** 滚到底：chat 历史滚到哨兵 + 外层 sheet 滚到底看到输入框 */
  _chatScrollToBottom() {
    this.setData({
      chatScrollIntoView: 'chat-bottom',
      stmtScrollTop: this._bumpScrollTop(99999)
    })
  },

  /** 把 loadData 算出的字段组装成 sheet 要渲染的对象（包含原始数字 + 展示字符串 + 分类备注） */
  _buildStatementData() {
    const month = this.data.viewMonth
    const monthTotal = this.data._monthTotalNum || 0
    const income = this.data._stmtIncome || 0
    const expense = this.data._monthTotalNum || 0
    const balance = this.data._stmtBalance || 0
    const savingsRate = this.data._stmtSavingsRate || 0
    const prevMonthExpense = this.data._lastMonthTotalNum || 0
    const prevYearExpense = this.data._stmtPrevYearTotal || 0
    const hasPrevYear = !!this.data._stmtHasPrevYear
    const recurTotal = (this.data.recurList || [])
      .filter((r) => r.active !== false)
      .reduce((s, r) => s + (r.amount || 0), 0)

    // 累计口径：账单弹框顶部展示用（与首页看板一致）
    const cumIncome = this.data._stmtCumIncome || 0
    const cumExpense = this.data._stmtCumExpense || 0
    const available = this.data._stmtAvailable || 0
    const cumSavingsRate = this.data._stmtCumSavingsRate || 0
    // 结转金额 = 可用余额 − 本月结余（自然月）
    const monthBalance = income - expense
    const carriedOver = available - monthBalance

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
    const palette = ['#2B2620', '#C8A04D', '#BE4A3A', '#C98A2D', '#2F9B6B', '#A3823A']
    const paletteDark = ['#8AA4C2', '#E5C26B', '#E55858', '#E0A055', '#4FB78A', '#8AA4C2']
    const app = getApp()
    const isDark = app.resolvedTheme() === 'dark'
    const colors = isDark ? paletteDark : palette
    const budgetMap = (this.data.user && this.data.user.budgets) || {}
    // 账单 sheet 只展示本月有消费的分类（占比>0）——零消费分类显示一排空行没有信息量；
    // 给任意分类设预算的正式入口已前移到「我的 → 分类预算」（不依赖当月是否消费）
    const statsMap = new Map((this.data.catStats || []).map((c) => [c.name, c]))
    const categories = (config.CATEGORIES || []).map((name, idx) => {
      const s = statsMap.get(name)
      const amount = s ? s.amount : 0
      const percent = s ? s.percent : 0
      const b = budgetMap[name]
      const over = typeof b === 'number' && b > 0 && amount > b
      const topNotes = (s && noteByCat[name])
        ? [...noteByCat[name].entries()]
            .sort((a, b2) => b2[1] - a[1])
            .slice(0, 3)
            .map(([n]) => n)
        : []
      return {
        name,
        amount,
        amountText: util.moneyThousand(amount),
        percent,
        budget: typeof b === 'number' ? b : 0,
        budgetText: typeof b === 'number' && b > 0 ? util.moneyThousand(b) : '',
        over,
        topNotes,
        color: colors[idx % colors.length],
        isEmpty: amount <= 0  // 本月没消费,UI 上灰化
      }
    }).filter((c) => c.amount > 0)  // 只展示本月有消费的分类（按金额而非四舍五入后的百分比，极小额不漏）
    const overCategories = categories.filter((c) => c.over).map((c) => c.name)

    // 环比 — 预格式化方向 + 百分比字符串(WXML 不能用 Math.abs)
    // 注:去年同月(yoy)已从 UI 移除,prevYear 数据保留供 AI 解读使用
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

    return {
      month,
      monthText: `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`,
      // 原始数字 — 模板 / 云函数都靠这些,必须存在（自然月口径）
      income,
      expense,
      balance,
      savingsRate,
      prevMonthExpense,
      prevYearExpense: hasPrevYear ? prevYearExpense : null,
      hasPrevYear,
      recurTotal,
      // 展示用字符串 — WXML 渲染用（累计口径，与首页看板一致）
      incomeText: util.moneyThousand(cumIncome),
      expenseText: util.moneyThousand(cumExpense),
      balanceText: util.moneyThousand(Math.abs(available)),
      balanceSign: available >= 0 ? '+' : '-',
      savingsRateText: cumSavingsRate.toFixed(0) + '%',
      savingsLevel: cumSavingsRate >= 20 ? 'good' : cumSavingsRate >= 0 ? 'mid' : 'bad',
      // 结转小字：可用余额 ≠ 本月结余时展示
      carriedOverText: carriedOver > 0 ? '含历史结转 ¥' + util.moneyThousand(carriedOver) : '',
      momText: util.moneyThousand(prevMonthExpense),
      momDelta: mom,
      categories,
      recurTotalText: util.moneyThousand(recurTotal),
      overCategories,
      budget: this.data.budget || 0,  // 总预算,让 AI 算出"剩多少能花"给规划
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
      statement: { ...stmt, insightText: text, insightSource: source },
      // AI 解读渲染完成:滚到 sheet 底部,看到 AI 文本 + 问问入口
      stmtScrollTop: this._bumpScrollTop(99999)
    })
  },

  /** 强制重新生成（清缓存 + 调 AI） */
  async forceRegen() {
    if (!this.data.statement || this.data.statementLoading) return
    this.loadStatement(true)
  },

})
