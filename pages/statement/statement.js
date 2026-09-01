const config = require('../../utils/config')
const util = require('../../utils/util')
const dbApi = require('../../utils/db')
const finTemplate = require('../../utils/finTemplate')
const themeUtil = require('../../utils/theme')

/** 数字月 → 中文月:9 → 九月,11 → 十一月(页面标题「九月账单」) */
const CN_MONTHS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']

Page({
  data: {
    themeClass: '',
    month: '',            // 查看月 'YYYY-MM'
    loading: true,
    statement: null,      // 账单数据(数字 + 展示字符串 + 分类)
    recentList: [],       // 本月流水(时间倒序,账本君聊天数据源)
    // 分类预算设置 sheet
    showCatBudget: false,
    showCatBudgetClosing: false,
    catBudgetEditing: null,           // { name, spent, spentText, budget, remainingText }
    catBudgetInput: '',
    catBudgetFocus: true,
    // 账本君聊天 sheet(公共组件)
    showChat: false,
    chatSub: ''           // 组件副标题:「你的 AI 财务助理」
  },

  onLoad(options) {
    const m = options && options.month
    this._month = (m && /^\d{4}-\d{2}$/.test(m)) ? m : util.thisMonthStr()
    const cn = CN_MONTHS[Number(this._month.slice(5, 7)) - 1] || this._month.slice(5, 7)
    this.setData({ month: this._month, chatSub: '你的 AI 财务助理' })
    // 页面标题:「九月账单」
    wx.setNavigationBarTitle({ title: `${cn}月账单` })
  },

  async onShow() {
    themeUtil.applyToPage(this)
    // force=true:从记账页/聊天记账返回时强制重查,确保数字最新
    await this.loadData(true)
    // 数据就绪后再拉 AI 解读(loadData 前调会因 statement 为空被中止)
    this.loadStatement(false)
  },

  /**
   * 外观偏好 / 系统主题变化时由 app 统一回调:
   * 刷根节点 class;分类配色取自生效主题,需重算 statement。
   */
  applyTheme() {
    themeUtil.applyToPage(this)
    if (this._rawData) {
      const stmt = this._buildStatement(this._rawData, this.data._budgetOver, this.data._budgetNear)
      this.setData({ statement: { ...stmt, insightText: (this.data.statement || {}).insightText, insightSource: (this.data.statement || {}).insightSource } })
    }
  },

  /* ---------------- 数据加载 ---------------- */

  async loadData(force) {
    const app = getApp()
    await app.ready()
    const month = this._month
    const prev = this.shiftMonth(month, -1)
    const prevYear = this.shiftMonth(month, -12)
    try {
      const [user, list, lastList, recurList, salaryList, prevYearList] = await Promise.all([
        dbApi.getMyUser(force),
        dbApi.listExpenses(month, force),
        dbApi.listExpenses(prev, force),
        dbApi.listRecurring(force),
        dbApi.listSalary(force),
        dbApi.listExpenses(prevYear, force)
      ])

      const monthTotal = list.reduce((s, x) => s + (x.amount || 0), 0)
      const lastMonthTotal = lastList.reduce((s, x) => s + (x.amount || 0), 0)
      const prevYearTotal = prevYearList.reduce((s, x) => s + (x.amount || 0), 0)

      // 收入：仅本月（按 payDate 归月，与首页一致口径）
      const income = salaryList
        .filter((s) => (s.payDate || '').startsWith(month))
        .reduce((s, x) => s + (x.amount || 0), 0)
      // 还款流水已包含在 monthTotal(标记已还会自动写一条 category=还款 的流水)
      const balance = income - monthTotal
      const savingsRate = income > 0 ? (balance / income) * 100 : 0

      // 【累计口径】顶部用滚动结转，和首页看板一致
      const cumIncome = salaryList
        .filter((s) => (s.payDate || '').slice(0, 7) <= month)
        .reduce((s, x) => s + (x.amount || 0), 0)
      let cumExpense = 0
      const expAgg = user && user.expAgg
      if (expAgg && typeof expAgg === 'object') {
        // 历史月份用快照，本月用实际值（避免快照漂移导致本月累计不准）
        cumExpense = Object.entries(expAgg)
          .filter(([k]) => k < month)
          .reduce((s, [, v]) => s + (v || 0), 0)
        cumExpense += monthTotal
      } else {
        cumExpense = monthTotal
        console.warn('[statement] 月度支出快照缺失，累计支出用本月近似')
      }
      const available = cumIncome - cumExpense
      const cumSavingsRate = cumIncome > 0 ? (available / cumIncome) * 100 : 0

      // 留一份原始数据:主题变化时免查库重建 statement(_buildStatement 纯函数)
      this._rawData = {
        user,
        list,
        month,
        monthTotal,
        lastMonthTotal,
        prevYearTotal,
        income,
        balance,
        savingsRate,
        cumIncome,
        cumExpense,
        available,
        cumSavingsRate,
        hasPrevYear: prevYearList.length > 0,
        recurTotal: recurList
          .filter((r) => r.active !== false)
          .reduce((s, r) => s + (r.amount || 0), 0)
      }

      const budget = (user && user.budget) || 0
      const percent = budget > 0 ? Math.round((monthTotal / budget) * 100) : 0
      const budgetOver = percent > 100
      const budgetNear = !!(budget > 0 && percent >= 80 && percent <= 100)
      this.setData({
        _budgetOver: budgetOver,
        _budgetNear: budgetNear
      })
      const stmt = this._buildStatement(this._rawData, budgetOver, budgetNear)
      this.setData({
        loading: false,
        // 最近流水(时间倒序,账本君聊天数据源)
        recentList: list,
        statement: { ...stmt, insightText: '', insightSource: 'loading' }
      })
    } catch (e) {
      this.setData({ loading: false })
      console.error('加载账单失败', e)
      wx.showToast({ title: util.errTip(e, '加载失败，请重试'), icon: 'none' })
    }
  },

  /** 通用月份位移：delta 可正可负（-1 上月 / -12 去年同月） */
  shiftMonth(monthStr, delta) {
    const [y, m] = monthStr.split('-').map(Number)
    const d = new Date(y, m - 1 + delta, 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  },

  /** 从原始数据构建 statement(纯函数,主题变化时可免查库重建) */
  _buildStatement(raw, budgetOver, budgetNear) {
    const { user, list, month, monthTotal, lastMonthTotal, prevYearTotal,
      income, balance, savingsRate, cumIncome, cumExpense, available,
      cumSavingsRate, hasPrevYear, recurTotal } = raw
    // 结转金额 = 可用余额 − 本月结余（自然月）
    const monthBalance = income - monthTotal
    const carriedOver = available - monthBalance

    // 分类备注 top-3:按"出现金额"权重排序,让 LLM 看到"抚养费/补习班"而不是泛称
    const noteByCat = {}
    list.forEach((x) => {
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
    const budgetMap = (user && user.budgets) || {}

    // 本月分类合计
    const catMap = {}
    list.forEach((x) => {
      const c = x.category || '其他'
      catMap[c] = (catMap[c] || 0) + (x.amount || 0)
    })

    // 只展示本月有消费的分类（按金额,极小额不漏）
    const categories = (config.CATEGORIES || []).map((name, idx) => {
      const amount = catMap[name] || 0
      const percent = monthTotal > 0 ? Math.round((amount / monthTotal) * 100) : 0
      const b = budgetMap[name]
      const over = typeof b === 'number' && b > 0 && amount > b
      const topNotes = noteByCat[name]
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
        isEmpty: amount <= 0
      }
    }).filter((c) => c.amount > 0)
    const overCategories = categories.filter((c) => c.over).map((c) => c.name)

    // 环比 — 预格式化方向 + 百分比字符串(WXML 不能用 Math.abs)
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
    const mom = buildDelta(monthTotal, lastMonthTotal)

    return {
      month,
      monthText: `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`,
      // 原始数字 — 模板 / 云函数都靠这些,必须存在（自然月口径）
      income,
      expense: monthTotal,
      balance,
      savingsRate,
      prevMonthExpense: lastMonthTotal,
      prevYearExpense: hasPrevYear ? prevYearTotal : null,
      hasPrevYear,
      recurTotal,
      // 累计口径原始数字 — 供 AI 数据块使用（与首页看板同源）
      available,
      carriedOver,
      // 展示用字符串 — WXML 渲染用（累计口径，与首页看板一致）
      incomeText: util.moneyThousand(cumIncome),
      expenseText: util.moneyThousand(cumExpense),
      balanceText: util.moneyThousand(Math.abs(available)),
      balanceSign: available >= 0 ? '' : '-',
      savingsRateText: cumSavingsRate.toFixed(0) + '%',
      savingsLevel: cumSavingsRate >= 20 ? 'good' : cumSavingsRate >= 0 ? 'mid' : 'bad',
      // 结转小字：可用余额 ≠ 本月结余时展示
      carriedOverText: carriedOver > 0 ? '含历史结转 ¥' + util.moneyThousand(carriedOver) : '',
      momText: util.moneyThousand(lastMonthTotal),
      momDelta: mom,
      categories,
      recurTotalText: util.moneyThousand(recurTotal),
      overCategories,
      budget: (user && user.budget) || 0,
      budgetOver: !!budgetOver,
      budgetNear: !!budgetNear
    }
  },

  /* ---------------- AI 解读 ---------------- */

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
    }
  },

  /** 调云函数带超时 */
  _callFinReport(stmt, force) {
    // 月初语境：仅在查看「当前月」账单时传今天日期，历史月不传（避免误导 AI）
    const now = new Date()
    const nowMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const today = stmt.month === nowMonth
      ? `${nowMonth}-${String(now.getDate()).padStart(2, '0')}`
      : undefined
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
            // 累计口径 — 让 AI 知道"有历史结余可花"，月初收入未记时不误判
            available: stmt.available,
            carriedOver: stmt.carriedOver,
            today,
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
  forceRegen() {
    if (!this.data.statement) return
    this.loadStatement(true)
  },

  /* ---------------- 账本君聊天(公共组件) ---------------- */

  /** 「有问题问账本君」→ 打开公共聊天组件 */
  openChat() {
    this.setData({ showChat: true })
  },

  /** 组件播完关闭动画后回调 */
  onChatClose() {
    this.setData({ showChat: false })
  },

  /** 记账/撤销后刷新页面数据(云函数写库不触发 dbApi 缓存失效,必须 force) */
  onChatRefresh() {
    this.loadData(true)
  },

  /* ---------------- 分类预算(分类行右侧入口) ---------------- */

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
    const user = this._rawData && this._rawData.user || app.globalData.user || {}
    const next = Object.assign({}, user.budgets || {})
    if (value > 0) {
      next[cat] = value
    } else {
      delete next[cat]
    }
    try {
      await dbApi.updateMyUser({ budgets: next })
      // 同步本地原始数据,下次 loadData 不被旧值覆盖
      if (this._rawData && this._rawData.user) this._rawData.user.budgets = next
      if (app && app.globalData) app.globalData.user = { ...user, budgets: next }
      this.closeCatBudget()
      // 重建 statement,让已设分类立刻显示金额
      await this.loadData(true)
      wx.showToast({ title: '已保存', icon: 'success' })
    } catch (err) {
      console.error('保存分类预算失败', err)
      wx.showToast({ title: '保存失败', icon: 'none' })
    }
  }
})
