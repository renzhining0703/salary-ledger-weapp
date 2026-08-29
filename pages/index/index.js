const config = require('../../utils/config')
const util = require('../../utils/util')
const dbApi = require('../../utils/db')

Page({
  data: {
    user: null,
    recycleDays: config.RECYCLE_DAYS,
    todoList: [],
    boardMonth: '',          // 当前查看的月份，如 2026-08
    board: null,             // 月度结余看板
    budgetAlert: null,       // 预算预警 { type: 'over'|'warn', text }
    showProfile: false,
    saving: false,
    privacyOptions: ['关闭', '手势图案', '指纹解锁'],
    privacyIndex: 0,
    formAvatar: '',
    formNickname: '',
    formPayday: 15,
    formBudget: '4000',
    paydayRange: Array.from({ length: 31 }, (_, i) => i + 1),
    // 账单分享卡片
    showShare: false,
    showShareClosing: false,
    shareImagePath: '',
    shareBusy: false,
    // 最优还款顺序（≥3 张未还卡时显示入口卡）
    optimalPreview: null,    // { pendingCount, subText, first: { bank, amountText, dueText } }
    optimalFull: null,       // { pendingCount, order: [], savedInterestText }
    showOptimalSheet: false,
    showOptimalSheetClosing: false
  },

  onShow() {
    util.checkLock()
    this.loadData()
    // 监听系统主题变化：canvas 颜色不跟随 CSS 变量，需手动重绘
    if (this._themeChangeHandler) {
      wx.offThemeChange(this._themeChangeHandler)
    }
    this._themeChangeHandler = () => {
      const app = getApp()
      app.syncTheme()
      app.applyNavBarColor()
      this.drawTrend()
    }
    wx.onThemeChange(this._themeChangeHandler)
  },

  onHide() {
    // 切走页面时停掉趋势图动画，避免后台空转
    if (this._trendAnimId && this._trendCanvas && this._trendCanvas.cancelAnimationFrame) {
      this._trendCanvas.cancelAnimationFrame(this._trendAnimId)
      this._trendAnimId = null
    }
  },

  onUnload() {
    if (this._themeChangeHandler) {
      wx.offThemeChange(this._themeChangeHandler)
      this._themeChangeHandler = null
    }
  },

  /**
   * 页面任意点击（冒泡到根节点）：每天第一次点击时静默请求订阅授权。
   * 微信要求 requestSubscribeMessage 必须由点击行为触发，
   * 所以不能在 onShow 里直接调，借用户打开后的第一次点击来触发。
   */
  onPageTap() {
    util.tryDailySubscribe(config.SUBSCRIBE_TEMPLATE_ID)
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
    try {
      const month = this.data.boardMonth || util.thisMonthStr()
      const trendStart = this.shiftMonth(month, -5)
      const [user, cards, salaryList, expenses, trendExpenses] = await Promise.all([
        dbApi.getMyUser(force),
        dbApi.listCards(force),
        dbApi.listSalary(force),
        dbApi.listExpenses(month, force),
        dbApi.listExpensesRange(trendStart, month, force)
      ])

      const today = util.todayStr()
      const thisMonth = util.thisMonthStr()

      // 今天要处理：逾期/今天/明天 的待还卡
      const todoList = []
      cards.forEach((c) => {
        if (c.status === 'paid') return
        const dueDate = util.calcDueDate(c.repayDay, 'pending')
        const days = util.daysBetween(today, dueDate)
        let level = ''
        let dueText = ''
        if (days < 0) {
          level = 'overdue'
          dueText = `已逾期 ${-days} 天`
        } else if (days === 0) {
          level = 'today'
          dueText = '今天还款'
        } else if (days === 1) {
          level = 'tomorrow'
          dueText = '明天还款'
        } else {
          return
        }
        todoList.push({
          id: c._id,
          bank: c.bank,
          amount: util.moneyThousand(c.amount),
          days,
          dueText,
          level,
          canPay: true
        })
      })
      // 按到期天数升序:逾期 N 天 → 今天 → 明天(更靠前越紧急)
      todoList.sort((a, b) => a.days - b.days)

      // 保留原始 cards，供 markPaid 组装还款历史用
      this._cards = cards

      // 多卡最优还款顺序(纯函数,无副作用)。<3 张未还时给 null,入口卡不显示
      this._computeOptimal(cards, today)

      // 各月还款金额（现金流口径）：
      // 新数据用 history（每次还款一条，跨月准确）；旧数据回退 repayDate + 当前金额
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

      // 月度结余看板：收入/支出/还款/结余（按查看月份）
      const income = salaryList
        .filter((s) => (s.payDate || '').startsWith(month))
        .reduce((s, x) => s + (x.amount || 0), 0)
      const expense = expenses.reduce((s, x) => s + (x.amount || 0), 0)
      // 还款只统计「实际已还」：待还（pending）的钱还没出账，不影响结余
      const repay = repayByMonth[month] || 0
      const balance = income - expense - repay
      const board = {
        month,
        monthText: `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`,
        isThisMonth: month === thisMonth,
        income: util.moneyThousand(income),
        expense: util.moneyThousand(expense),
        repay: util.moneyThousand(repay),
        balance: util.moneyThousand(Math.abs(balance)),
        balancePositive: balance >= 0,
        // 动画用原始数值
        _incomeNum: income,
        _expenseNum: expense,
        _repayNum: repay,
        _balanceNum: Math.abs(balance)
      }

      // 预算超支预警（只看当月）
      const budget = (user && user.budget) || 0
      const curExpense = expenses.reduce((s, x) => s + (x.amount || 0), 0)
      let budgetAlert = null
      if (budget > 0 && month === thisMonth) {
        const pct = Math.round((curExpense / budget) * 100)
        if (curExpense > budget) {
          budgetAlert = {
            type: 'over',
            text: `本月开销 ¥${util.moneyThousand(curExpense)}，已超预算 ¥${util.moneyThousand(curExpense - budget)}`
          }
        } else if (pct >= 80) {
          budgetAlert = {
            type: 'warn',
            text: `本月开销 ¥${util.moneyThousand(curExpense)}，已达预算 ${pct}%，注意控制`
          }
        }
      }

      // 近 6 个月收支趋势（随看板查看月份滚动）
      const trendMonths = []
      for (let i = 5; i >= 0; i--) trendMonths.push(this.shiftMonth(month, -i))
      const trend = trendMonths.map((m) => {
        const inc = salaryList
          .filter((s) => (s.payDate || '').startsWith(m))
          .reduce((s, x) => s + (x.amount || 0), 0)
        const exp = trendExpenses
          .filter((x) => (x.date || '').startsWith(m))
          .reduce((s, x) => s + (x.amount || 0), 0)
        const rep = repayByMonth[m] || 0
        return { month: m, label: `${Number(m.slice(5, 7))}月`, income: inc, expense: exp, balance: inc - exp - rep }
      })
      const trendEmpty = trend.every((t) => !t.income && !t.expense && !t.balance)

      this.setData({
        user,
        todoList,
        boardMonth: month,
        board,
        budgetAlert,
        trend,
        trendEmpty
      })

      if (!trendEmpty) {
        setTimeout(() => this.drawTrend(), 80)
      }

      // 数字滚动动画
      this._cancelAnim && this._cancelAnim.forEach((fn) => fn())
      this._cancelAnim = [
        util.animateNumber(this, 'board.income', income, { duration: 700, decimals: 2, thousand: true, prefix: '¥' }),
        util.animateNumber(this, 'board.expense', expense, { duration: 700, decimals: 2, thousand: true, prefix: '¥' }),
        util.animateNumber(this, 'board.repay', repay, { duration: 700, decimals: 2, thousand: true, prefix: '¥' }),
        util.animateNumber(this, 'board.balance', Math.abs(balance), { duration: 800, decimals: 2, thousand: true, prefix: '¥' })
      ]
    } catch (e) {
      console.error('加载首页数据失败', e)
      wx.showToast({ title: util.errTip(e, '加载失败，请下拉重试'), icon: 'none' })
    }
  },

  /* ---------- 看板月份切换 ---------- */
  prevMonth() {
    const m = this.shiftMonth(this.data.boardMonth || util.thisMonthStr(), -1)
    this.setData({ boardMonth: m })
    this.loadData()
  },

  nextMonth() {
    const m = this.shiftMonth(this.data.boardMonth || util.thisMonthStr(), 1)
    this.setData({ boardMonth: m })
    this.loadData()
  },

  shiftMonth(monthStr, delta) {
    const [y, m] = monthStr.split('-').map(Number)
    const d = new Date(y, m - 1 + delta, 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  },

  /** 一键标记已还（同步累积还款历史，供趋势图按月聚合与卡片展示） */
  async markPaid(e) {
    const id = e.currentTarget.dataset.id
    const card = (this._cards || []).find((c) => c._id === id) || {}
    try {
      // 一并写一条分类=还款的流水,让记账 Tab 自然看到这笔还款
      const r = await dbApi.recordCardRepayment(id)
      if (r && !r.dup) {
        // 产生了新流水 → 失效当月 AI 解读缓存,避免账本君基于旧数据说话
        dbApi.invalidateFinCache(util.thisMonthStr())
        wx.showToast({ title: '已记账', icon: 'success' })
      } else {
        wx.showToast({ title: '已标记还款', icon: 'success' })
      }
      // 同步追加 history(趋势图按月聚合需要)
      if (!(card.history || []).some((h) => h.date === util.todayStr())) {
        const history = [...(card.history || []), { date: util.todayStr(), amount: card.amount || 0 }]
        await dbApi.updateCard(id, { history })
      }
      this.loadData()
    } catch (err) {
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  /* ---------- 记一笔快捷入口 ---------- */
  quickExpense() {
    getApp().globalData.quickExpense = true
    wx.switchTab({ url: '/pages/expenses/expenses' })
  },

  /* ---------- 最优还款顺序 ---------- */
  /**
   * 派生 optimalPreview / optimalFull 写入 data。
   * 触发条件：≥3 张未还卡才显示入口卡。<3 时给 null，UI 自动隐藏。
   */
  _computeOptimal(cards, today) {
    const result = util.calcOptimalRepayOrder(cards, today)
    if (!result.pendingCount) {
      this.setData({ optimalPreview: null, optimalFull: null })
      return
    }
    const first = result.order[0]
    this.setData({
      optimalPreview: {
        pendingCount: result.pendingCount,
        subText: `当前 ${result.pendingCount} 张卡未还，建议先还「${first.bank}」`,
        first: {
          bank: first.bank,
          amountText: first.amountText,
          dueText: first.dueText
        }
      },
      optimalFull: result
    })
  },

  openOptimalSheet() {
    if (this._optCloseTimer) { clearTimeout(this._optCloseTimer); this._optCloseTimer = null }
    util.openSheet(this, 'showOptimalSheet')
  },

  closeOptimalSheet() {
    this._optCloseTimer = util.closeSheet(this, 'showOptimalSheet')
  },

  /* ---------- 设置弹层 ---------- */
  openProfile() {
    if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null }
    const u = this.data.user || {}
    util.openSheet(this, 'showProfile', {
      formAvatar: u.avatarUrl || '',
      formNickname: u.nickname || '',
      formPayday: u.payday || 15,
      formBudget: String(u.budget || 4000),
      privacyIndex: this.privacyIndexOf(u.privacyLock)
    })
  },

  privacyIndexOf(mode) {
    return mode === 'gesture' ? 1 : mode === 'finger' ? 2 : 0
  },

  closeProfile() {
    this._closeTimer = util.closeSheet(this, 'showProfile')
    this.redrawTrendAfterPopup()
  },

  /** 弹层关闭后 canvas 随 wx:if 重建，需要重新绘制趋势图 */
  redrawTrendAfterPopup() {
    if (this.data.trendEmpty) return
    // 关闭动画 240ms,等 wx:if 重新挂载 canvas 后再画;中途若用户又打开弹层则放弃
    setTimeout(() => {
      if (this.data.showProfile || this.data.showShare) return
      this.drawTrend()
    }, 280)
  },

  /* ---------- 隐私锁 ---------- */
  onPrivacyChange(e) {
    const idx = Number(e.detail.value)
    const u = this.data.user || {}
    const cur = u.privacyLock || 'off'
    if (idx === this.privacyIndexOf(cur)) return

    if (idx === 0) {
      // 关闭
      wx.showModal({
        title: '关闭隐私锁',
        content: '关闭后打开小程序将不再需要解锁。确定关闭吗？',
        success: async (res) => {
          if (!res.confirm) {
            this.setData({ privacyIndex: this.privacyIndexOf(cur) })
            return
          }
          try {
            await dbApi.updateMyUser({ privacyLock: 'off' })
            this.syncUser({ privacyLock: 'off' })
            this.setData({ privacyIndex: 0 })
            wx.showToast({ title: '已关闭', icon: 'success' })
          } catch (err) {
            this.setData({ privacyIndex: this.privacyIndexOf(cur) })
            wx.showToast({ title: '操作失败', icon: 'none' })
          }
        }
      })
      return
    }

    if (idx === 1) {
      // 手势：去锁页绘制两次（锁页保存成功后回来 onShow 刷新）
      util.closeSheet(this, 'showProfile')
      wx.navigateTo({ url: '/pages/lock/lock?mode=set' })
      return
    }

    // 指纹
    if (!wx.checkIsSoterEnrolledInDevice) {
      this.setData({ privacyIndex: this.privacyIndexOf(cur) })
      wx.showToast({ title: '当前微信版本不支持', icon: 'none' })
      return
    }
    wx.checkIsSoterEnrolledInDevice({
      checkAuthMode: 'fingerPrint',
      success: async (res) => {
        if (!res.isEnrolled) {
          this.setData({ privacyIndex: this.privacyIndexOf(cur) })
          wx.showToast({ title: '本机未录入指纹，请先在系统设置中录入', icon: 'none' })
          return
        }
        try {
          await dbApi.updateMyUser({ privacyLock: 'finger' })
          this.syncUser({ privacyLock: 'finger' })
          this.setData({ privacyIndex: 2 })
          wx.showToast({ title: '指纹锁已开启', icon: 'success' })
        } catch (err) {
          this.setData({ privacyIndex: this.privacyIndexOf(cur) })
          wx.showToast({ title: '操作失败', icon: 'none' })
        }
      },
      fail: (err) => {
        console.error('SOTER enroll check failed', err)
        this.setData({ privacyIndex: this.privacyIndexOf(cur) })
        wx.showToast({ title: '本机不支持指纹验证', icon: 'none' })
      }
    })
  },

  /** 同步更新 globalData.user（隐私锁守卫读它，避免读到旧值） */
  syncUser(patch) {
    const app = getApp()
    if (app.globalData.user) {
      app.globalData.user = { ...app.globalData.user, ...patch }
    }
    this.setData({ user: app.globalData.user })
  },

  /* ---------- 回收站 ---------- */
  openRecycle() {
    util.closeSheet(this, 'showProfile')
    wx.navigateTo({ url: '/pages/recycle/recycle' })
  },

  onChooseAvatar(e) {
    this.setData({ formAvatar: e.detail.avatarUrl })
  },

  onNickInput(e) {
    this.setData({ formNickname: e.detail.value })
  },

  onPaydayChange(e) {
    this.setData({ formPayday: Number(e.detail.value) + 1 })
  },

  onBudgetInput(e) {
    this.setData({ formBudget: e.detail.value })
  },

  async saveProfile() {
    if (this.data.saving) return
    this.setData({ saving: true })
    const { formNickname, formPayday, formBudget, formAvatar } = this.data
    const data = {
      nickname: formNickname.trim(),
      payday: formPayday,
      budget: Number(formBudget) || 0
    }
    if (formAvatar) {
      try {
        const openid = getApp().globalData.openid
        const extMatch = (formAvatar.split('?')[0].match(/\.(\w+)$/) || [])[1]
        const ext = ['jpg', 'jpeg', 'png'].indexOf(extMatch) >= 0 ? extMatch : 'png'
        const up = await wx.cloud.uploadFile({
          cloudPath: `avatars/${openid}.${ext}`,
          filePath: formAvatar
        })
        data.avatarUrl = up.fileID
      } catch (err) {
        console.error('头像上传失败，将仅本地显示', err)
      }
    }
    try {
      await dbApi.updateMyUser(data)
      wx.showToast({ title: '已保存', icon: 'success' })
      util.closeSheet(this, 'showProfile')
      this.loadData()
    } catch (err) {
      wx.showToast({ title: '保存失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  /* ---------- 月度账单分享卡片 ---------- */
  async openShare() {
    if (!this.data.board || this.data.shareBusy) return
    this.setData({ shareBusy: true, showShare: true, showShareClosing: false, shareImagePath: '' })
    wx.showLoading({ title: '生成中…', mask: true })
    try {
      // 等待 canvas 节点随弹层渲染完成
      await new Promise((r) => setTimeout(r, 150))
      await this.drawShareCard()
    } catch (e) {
      console.error('生成分享卡片失败', e)
      wx.showToast({ title: '生成失败，请重试', icon: 'none' })
      this.closeShare()
    } finally {
      wx.hideLoading()
      this.setData({ shareBusy: false })
    }
  },

  closeShare() {
    this._closeTimer = util.closeSheet(this, 'showShare')
    this.redrawTrendAfterPopup()
  },

  /** 用 canvas 2d 绘制深蓝+香槟金风格的月度账单卡片 */
  async drawShareCard() {
    const b = this.data.board
    const user = this.data.user || {}
    const query = this.createSelectorQuery()
    const res = await new Promise((resolve) => query.select('#shareCanvas').fields({ node: true, size: true }).exec(resolve))
    if (!res[0] || !res[0].node) throw new Error('canvas 节点未就绪')
    const canvas = res[0].node
    const ctx = canvas.getContext('2d')
    const dpr = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).pixelRatio || 2
    const W = 750
    const H = 1000
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.scale(dpr, dpr)

    const GOLD = '#C8A04D'
    const NAVY = '#0E2238'
    const NAVY2 = '#14304F'
    const SUB = '#8FA3B8'
    const WHITE = '#FFFFFF'
    const RED = '#E06C5A'
    const center = W / 2
    ctx.textAlign = 'center'

    // 背景 + 顶部渐变
    ctx.fillStyle = NAVY
    ctx.fillRect(0, 0, W, H)
    const grad = ctx.createLinearGradient(0, 0, W, 380)
    grad.addColorStop(0, NAVY2)
    grad.addColorStop(1, NAVY)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, W, 380)

    // 品牌
    ctx.fillStyle = GOLD
    ctx.font = '600 30px "DIN Alternate", sans-serif'
    ctx.fillText('薪 账 本', center, 100)
    ctx.fillRect(center - 40, 128, 80, 3)

    // 月份
    ctx.fillStyle = WHITE
    ctx.font = 'bold 46px sans-serif'
    ctx.fillText(`${b.monthText} 账单`, center, 196)

    // 结余
    ctx.fillStyle = SUB
    ctx.font = '26px sans-serif'
    ctx.fillText('本月结余', center, 292)
    ctx.fillStyle = b.balancePositive ? GOLD : RED
    ctx.font = 'bold 92px "DIN Alternate", sans-serif'
    ctx.fillText(`${b.balancePositive ? '+' : '−'}¥${util.moneyThousand(b._balanceNum)}`, center, 398)

    // 分割线
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(80, 470)
    ctx.lineTo(W - 80, 470)
    ctx.stroke()

    // 收入 / 支出 / 已还 三列
    const cols = [
      { label: '收入', val: b._incomeNum },
      { label: '支出', val: b._expenseNum },
      { label: '已还', val: b._repayNum }
    ]
    cols.forEach((c, i) => {
      const x = 125 + i * 250
      ctx.fillStyle = SUB
      ctx.font = '24px sans-serif'
      ctx.fillText(c.label, x, 542)
      ctx.fillStyle = WHITE
      ctx.font = 'bold 44px "DIN Alternate", sans-serif'
      ctx.fillText(`¥${util.moneyThousand(c.val)}`, x, 608)
    })

    // 预算使用（当月且有预算）
    const budget = user.budget || 0
    if (b.isThisMonth && budget > 0) {
      const pct = Math.min(100, Math.round((b._expenseNum / budget) * 100))
      ctx.fillStyle = SUB
      ctx.font = '24px sans-serif'
      ctx.fillText(`月预算 ¥${util.moneyThousand(budget)} · 已用 ${pct}%`, center, 700)
      const bx = 120
      const bw = W - 240
      const by = 730
      const bh = 14
      ctx.fillStyle = 'rgba(255,255,255,0.10)'
      this.roundRect(ctx, bx, by, bw, bh, bh / 2)
      ctx.fill()
      ctx.fillStyle = pct >= 100 ? RED : GOLD
      this.roundRect(ctx, bx, by, Math.max(bh, (bw * pct) / 100), bh, bh / 2)
      ctx.fill()
    }

    // 底部
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.font = '24px sans-serif'
    ctx.fillText('收入 − 支出 − 已还 = 结余', center, 836)
    const nick = (user.nickname || '').trim()
    ctx.fillStyle = GOLD
    ctx.font = '26px sans-serif'
    ctx.fillText(nick ? `${nick} 的账本` : '记录每一份收支', center, 906)
    ctx.fillStyle = 'rgba(255,255,255,0.25)'
    ctx.font = '22px sans-serif'
    ctx.fillText(util.todayStr(), center, 944)

    // 导出为临时图片（2x 保证清晰度）
    const tmp = await new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas,
        destWidth: W * 2,
        destHeight: H * 2,
        success: resolve,
        fail: reject
      })
    })
    this.setData({ shareImagePath: tmp.tempFilePath })
  },

  /** canvas 圆角矩形路径 */
  roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  },

  /** 保存到相册（含权限被拒后引导开启） */
  async saveShareImage() {
    const p = this.data.shareImagePath
    if (!p) return
    try {
      await new Promise((resolve, reject) => wx.saveImageToPhotosAlbum({ filePath: p, success: resolve, fail: reject }))
      wx.showToast({ title: '已保存到相册', icon: 'success' })
    } catch (e) {
      const msg = (e && e.errMsg) || ''
      if (msg.indexOf('auth') >= 0 || msg.indexOf('deny') >= 0) {
        wx.showModal({
          title: '需要相册权限',
          content: '保存账单卡片需要相册权限，请在设置中开启后重试。',
          confirmText: '去设置',
          success: (r) => {
            if (r.confirm) wx.openSetting()
          }
        })
      } else {
        wx.showToast({ title: '保存失败', icon: 'none' })
      }
    }
  },

  /** 分享给微信好友（低版本基础库回退为保存相册） */
  shareToFriend() {
    const p = this.data.shareImagePath
    if (!p) return
    if (wx.showShareImageMenu) {
      wx.showShareImageMenu({
        path: p,
        fail: () => {
          wx.showToast({ title: '当前微信版本不支持，已尝试保存', icon: 'none' })
          this.saveShareImage()
        }
      })
    } else {
      this.saveShareImage()
    }
  },

  /**
   * 分享给好友：showShareImageMenu 调起的「图片分享菜单」必须配合页面级
   * onShareAppMessage 才能开启「分享给朋友」入口（否则该项置灰）。
   * 这里是纯图片分享，直接返回当前 path，微信会用 showShareImageMenu 的图片。
   * 同时也是右上角菜单「转发」按钮的兜底回调。
   */
  onShareAppMessage() {
    const monthText = (this.data.board && this.data.board.monthText) || ''
    return {
      title: monthText ? `${monthText} 账单` : '我的月度账单',
      path: '/pages/index/index'
    }
  },

  /** 分享到朋友圈（微信要求每个页面单独声明，不能靠 app.js 兜底） */
  onShareTimeline() {
    const monthText = (this.data.board && this.data.board.monthText) || ''
    return {
      title: monthText ? `${monthText} 账单` : '我的月度账单'
    }
  },

  /* ---------- 近 6 个月收支趋势图 ---------- */
  /** canvas 2d 绘制：收入/支出双柱 + 结余折线（金色，可跌破零轴），带生长动画 */
  async drawTrend() {
    const list = this.data.trend || []
    if (!list.length) return
    const query = this.createSelectorQuery()
    const res = await new Promise((resolve) => query.select('#trendCanvas').fields({ node: true, size: true }).exec(resolve))
    if (!res[0] || !res[0].node) return
    const canvas = res[0].node
    const W = res[0].width
    const H = res[0].height
    const dpr = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).pixelRatio || 2
    canvas.width = W * dpr
    canvas.height = H * dpr
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)

    // 取消上一轮未完成的动画（切月快速连点时只保留最新一次）
    if (this._trendAnimId && canvas.cancelAnimationFrame) {
      canvas.cancelAnimationFrame(this._trendAnimId)
      this._trendAnimId = null
    }
    this._trendCanvas = canvas

    // 取主题色（深色模式用浅色系以保证对比度）
    const app = getApp()
    const isDark = app && app.globalData && app.globalData.theme === 'dark'
    const NAVY = isDark ? '#8AA4C2' : '#14304F'
    const RED = isDark ? '#E55858' : '#C94040'
    const GOLD = isDark ? '#E5C26B' : '#C8A04D'
    const SUB = isDark ? '#A8B4C5' : '#97A3B2'
    const GRID = isDark ? '#2D3A4D' : '#E9EDF2'
    const AXIS = isDark ? '#4A5A70' : '#C9D2DC'
    const NODE_FILL = isDark ? '#1A2532' : '#FFFFFF'

    const DURATION = 550
    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)
    const render = (p) => {
      ctx.clearRect(0, 0, W, H)

      const padL = 6
      const padR = 6
      const padT = 14
      const padB = 24
      const plotW = W - padL - padR
      const plotH = H - padT - padB
      const groupW = plotW / list.length

      const maxVal = Math.max(1, ...list.map((t) => Math.max(t.income, t.expense)))
      const minVal = Math.min(0, ...list.map((t) => t.balance))
      const range = maxVal - minVal || 1
      const yOf = (v) => padT + plotH - ((v - minVal) / range) * plotH
      const y0 = yOf(0)

      // 横向网格线（零轴略深）
      ctx.lineWidth = 1
      ;[0.25, 0.5, 0.75].forEach((g) => {
        const y = padT + plotH * (1 - g)
        ctx.strokeStyle = GRID
        ctx.beginPath()
        ctx.moveTo(padL, y)
        ctx.lineTo(W - padR, y)
        ctx.stroke()
      })
      ctx.strokeStyle = AXIS
      ctx.beginPath()
      ctx.moveTo(padL, y0)
      ctx.lineTo(W - padR, y0)
      ctx.stroke()

      // 收入 / 支出双柱：逐月错峰生长 + 月份标签渐显
      const barW = Math.min(14, groupW * 0.22)
      ctx.textAlign = 'center'
      list.forEach((t, i) => {
        const cx = padL + groupW * i + groupW / 2
        // 每根柱子延迟 i*8% 开跑，自身占 60% 时长 → 波浪式生长
        const gp = Math.min(1, Math.max(0, (p - i * 0.08) / 0.6))
        const grow = easeOutCubic(gp)
        if (t.income > 0) this.trendBar(ctx, cx - barW - 3, y0, barW, (y0 - yOf(t.income)) * grow, NAVY)
        if (t.expense > 0) this.trendBar(ctx, cx + 3, y0, barW, (y0 - yOf(t.expense)) * grow, RED)
        ctx.globalAlpha = Math.min(1, p * 1.6)
        ctx.fillStyle = SUB
        ctx.font = '10px sans-serif'
        ctx.fillText(t.label, cx, H - 7)
        ctx.globalAlpha = 1
      })

      // 结余折线（金芯深底圆点）：进度过半后画入，末端点到目标位
      const lp = easeOutCubic(Math.min(1, Math.max(0, (p - 0.35) / 0.65)))
      if (lp > 0) {
        const drawUpTo = (list.length - 1) * lp
        ctx.strokeStyle = GOLD
        ctx.lineWidth = 2
        ctx.beginPath()
        const pts = []
        list.forEach((t, i) => {
          const cx = padL + groupW * i + groupW / 2
          const cy = yOf(t.balance)
          pts.push({ cx, cy })
        })
        // 最后一段做插值截断
        const seg = Math.floor(drawUpTo)
        pts.slice(0, seg + 1).forEach((pt, i) => {
          if (i === 0) ctx.moveTo(pt.cx, pt.cy)
          else ctx.lineTo(pt.cx, pt.cy)
        })
        if (seg < pts.length - 1) {
          const a = pts[seg]
          const b = pts[seg + 1]
          const f = drawUpTo - seg
          ctx.lineTo(a.cx + (b.cx - a.cx) * f, a.cy + (b.cy - a.cy) * f)
        }
        ctx.stroke()
        // 已走过的节点画圆点
        pts.forEach((pt, i) => {
          if (i > drawUpTo) return
          ctx.fillStyle = NODE_FILL
          ctx.beginPath()
          ctx.arc(pt.cx, pt.cy, 3.5, 0, Math.PI * 2)
          ctx.fill()
          ctx.strokeStyle = GOLD
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(pt.cx, pt.cy, 3.5, 0, Math.PI * 2)
          ctx.stroke()
        })
      }
    }

    // 动画驱动
    const startTs = Date.now()
    const step = () => {
      const p = Math.min(1, (Date.now() - startTs) / DURATION)
      render(p)
      if (p < 1) {
        this._trendAnimId = canvas.requestAnimationFrame(step)
      } else {
        this._trendAnimId = null
      }
    }
    step()
  },

  /** 趋势图圆角顶柱子：从 yBottom 向上画 h 高 */
  trendBar(ctx, x, yBottom, w, h, color) {
    if (h <= 0.5) return
    const r = Math.min(3, w / 2)
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(x, yBottom)
    ctx.lineTo(x, yBottom - h + r)
    ctx.arcTo(x, yBottom - h, x + r, yBottom - h, r)
    ctx.arcTo(x + w, yBottom - h, x + w, yBottom - h + r, r)
    ctx.lineTo(x + w, yBottom)
    ctx.closePath()
    ctx.fill()
  },

  /* ---------- 订阅消息 ---------- */
  subscribeRemind() {
    const tid = config.SUBSCRIBE_TEMPLATE_ID
    if (tid.indexOf('请填入') === 0) {
      wx.showModal({
        title: '提醒未开启',
        content: '需要先在 utils/config.js 填入订阅消息模板 ID（申请方式见 README），才能收到还款提醒。',
        showCancel: false
      })
      return
    }
    // 标记今天已请求过，避免冒泡到根节点时再触发一次静默请求（同一点击只弹一个授权框）
    wx.setStorageSync('xz_subscribe_ask_date', util.todayStr())
    wx.requestSubscribeMessage({
      tmplIds: [tid],
      success: (res) => {
        if (res[tid] === 'accept') {
          wx.setStorageSync('xz_subscribe_last_accept', util.todayStr())
          wx.showToast({ title: '还款提醒已开启', icon: 'success' })
        } else {
          wx.showToast({ title: '未授权，收不到推送', icon: 'none' })
        }
      },
      fail: (err) => {
        console.error('requestSubscribeMessage fail', err)
        const msg = (err && err.errMsg) || ''
        let tip = '授权失败，请重试'
        if (msg.indexOf('20001') >= 0 || msg.indexOf('switched off') >= 0) {
          tip = '订阅消息主开关已关闭，请到设置中开启'
        } else if (msg.indexOf('20004') >= 0 || msg.indexOf('templateId') >= 0 || msg.indexOf('invalid') >= 0) {
          tip = '模板 ID 无效，请核对小程序后台'
        }
        wx.showToast({ title: tip, icon: 'none' })
      }
    })
  },

  /* ---------- 重置全部数据 ---------- */
  clearData() {
    wx.showModal({
      title: '重置全部数据',
      content: '将删除当前账号下所有工资、信用卡、开销记录，重新打开小程序会预置一份新的示例数据，之后可再改成真实数据。确定继续吗？',
      confirmText: '确定重置',
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await dbApi.clearAllData()
          wx.showToast({ title: '已重置', icon: 'success' })
          util.closeSheet(this, 'showProfile')
          this.loadData()
        } catch (e) {
          wx.showToast({ title: '重置失败', icon: 'none' })
        }
      }
    })
  }
})
