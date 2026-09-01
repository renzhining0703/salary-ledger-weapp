const config = require('../../utils/config')
const util = require('../../utils/util')
const dbApi = require('../../utils/db')
const chatStorage = require('../../utils/chatStorage')
const themeUtil = require('../../utils/theme')

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
 * 「我的」页：设置中心 + 数据洞察（消费日历、固定支出）。
 */
Page({
  data: {
    user: {},
    categories: config.CATEGORIES,
    saving: false,
    recycleDays: config.RECYCLE_DAYS,
    privacyOptions: ['关闭', '手势图案', '指纹解锁'],
    privacyIndex: 0,
    // 外观主题（浅色/深色/跟随系统，默认跟随系统）
    themeOptions: ['跟随系统', '浅色', '深色'],
    themeIndex: 0,
    formAvatar: '',
    formNickname: '',
    formPayday: 15,
    formBudget: '4000',
    paydayRange: Array.from({ length: 31 }, (_, i) => i + 1),
    // 编辑资料半屏弹层：点头像/昵称区域触发，头像与昵称一次性保存
    showEditProfile: false,
    showEditProfileClosing: false,
    editAvatar: '',
    editNickname: '',
    editSaving: false,
    // 总预算编辑弹框
    showBudgetEdit: false,
    showBudgetEditClosing: false,
    budgetEditInput: '',
    budgetEditFocus: false,
    // 签名
    defaultMotto: '记录烟火收支，积攒人间安稳',
    formMotto: '',
    showMottoEdit: false,
    showMottoEditClosing: false,
    mottoEditInput: '',
    mottoEditFocus: false,
    // 分类预算（正式设置入口；此前藏在记账页账单 sheet 的分类行里，太深）
    catBudgetSetCount: 0,             // 已设预算的分类数（入口行右侧展示）
    showCatBudgets: false,            // 分类预算列表 sheet
    showCatBudgetsClosing: false,
    catBudgetRows: [],                // [{name, spent, spentText, budget, budgetText, over}]
    showCatBudget: false,             // 单分类预算编辑 sheet
    showCatBudgetClosing: false,
    catBudgetEditing: null,           // {name, spentText, budget, remainingText}
    catBudgetInput: '',
    catBudgetFocus: false,
    // 每月固定支出（从记账页移入）
    recurList: [],
    recurTotal: '0.00',
    recurCount: 0,
    showRecur: false,
    showRecurClosing: false,
    // 固定支出列表 scroll-view 动态高度：默认 56vh（与全局 .sheet-scroll 一致，保留滚动）；
    // openRecur 弹框入场后由 _fitRecurScrollHeight 测量并按需收敛成内容真实像素高度，
    // 避免只有 2-3 项时 sheet 被撑到 ~70% 屏高、底部留大片空白。
    recurScrollHeight: '56vh',
    showRecurForm: false,
    showRecurFormClosing: false,
    recurSaving: false,
    rName: '',
    rAmount: '',
    rCategory: '居住',
    // 消费日历（一行入口：副标题汇总文案；完整月历/热力/单日明细在独立页 pages/calendar）
    heatmapSubText: '加载中…'
  },

  onShow() {
    util.checkLock()
    // 外观偏好 / 系统主题刷新根节点 class + 窗口背景；picker 选中值同步当前模式
    themeUtil.applyToPage(this)
    this.setData({ themeIndex: this.themeIndexOf(themeUtil.getMode()) })
    this.loadUser()
    this.loadRecurring()
    this._loadHeatmapPreview()
  },

  /** 外观偏好 / 系统主题变化时由 app 统一回调 */
  applyTheme() {
    themeUtil.applyToPage(this)
  },

  /** 加载固定支出列表（供入口卡片和管理弹层用） */
  async loadRecurring() {
    try {
      const recurList = await dbApi.listRecurring(true)
      const recurTotal = recurList
        .filter((r) => r.active !== false)
        .reduce((s, r) => s + (r.amount || 0), 0)
      this.setData({
        recurList: recurList.map((r) => ({
          ...r,
          amountText: util.moneyThousand(r.amount)
        })),
        recurTotal: util.moneyThousand(recurTotal),
        recurCount: recurList.filter((r) => r.active !== false).length
      })
      // 弹层打开时,增删行会让内容高度变化,需重新收敛 scroll-view 高度
      if (this.data.showRecur) {
        setTimeout(() => this._fitRecurScrollHeight(), 50)
      }
    } catch (err) {
      console.error('加载固定支出失败', err)
    }
  },

  onLoad() {
    // 自定义导航栏（navigationStyle: custom）：状态栏高度需 JS 注入
    this.setData({ statusBarHeight: wx.getWindowInfo().statusBarHeight || 44 })
  },

  onHide() {
    // 编辑资料改半屏弹层，离开页面不再兜底保存（未保存改动视为用户主动放弃）
  },

  /* ---------- 信用卡管理（从 tabBar 移入本页的入口） ---------- */
  goCards() {
    wx.navigateTo({ url: '/pages/cards/cards' })
  },

  /** 拉取最新用户配置（force=true：手势锁在 lock 页保存后回来要立刻生效） */
  async loadUser() {
    const app = getApp()
    await app.ready()
    try {
      const user = await dbApi.getMyUser(true)
      this.applyUser(user)
    } catch (err) {
      this.applyUser(app.globalData.user || {})
    }
  },

  applyUser(u) {
    this.setData({
      user: u || {},
      formAvatar: (u && u.avatarUrl) || '',
      formNickname: (u && u.nickname) || '',
      formPayday: (u && u.payday) || 15,
      formBudget: String((u && u.budget) || 4000),
      formMotto: (u && u.motto) || '',
      privacyIndex: this.privacyIndexOf(u && u.privacyLock),
      catBudgetSetCount: Object.keys((u && u.budgets) || {}).length
    })
  },

  privacyIndexOf(mode) {
    return mode === 'gesture' ? 1 : mode === 'finger' ? 2 : 0
  },

  /* ---------- 外观主题 ---------- */
  themeIndexOf(mode) {
    return mode === 'light' ? 1 : mode === 'dark' ? 2 : 0
  },

  /**
   * 切换外观主题：本地立即生效（storage + 根节点 class + 导航栏/tabBar +
   * 页面栈内所有页面刷新），云端写 users.themeMode 持久化（跨设备同步）。
   * 云端写失败不影响本机使用，只提示一下。
   */
  onThemeModeChange(e) {
    const idx = Number(e.detail.value)
    const mode = ['system', 'light', 'dark'][idx]
    if (!mode || mode === themeUtil.getMode()) return
    getApp().setThemeMode(mode)
    this.setData({ themeIndex: idx })
    dbApi.updateMyUser({ themeMode: mode })
      .then(() => this.syncUser({ themeMode: mode }))
      .catch((err) => {
        console.error('保存外观偏好失败', err)
        wx.showToast({ title: '已在本机生效，云端同步失败', icon: 'none' })
      })
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
    if (!app.globalData.user) {
      app.globalData.user = {}
    }
    app.globalData.user = { ...app.globalData.user, ...patch }
    this.setData({ user: app.globalData.user })
  },

  /* ---------- 分类预算：列表 sheet + 单分类编辑 sheet ---------- */
  /** 打开分类预算列表：拉本月支出按分类聚合（60s 缓存，通常零额外云调用） */
  async openCatBudgets() {
    if (this._catBudgetsCloseTimer) { clearTimeout(this._catBudgetsCloseTimer); this._catBudgetsCloseTimer = null }
    util.openSheet(this, 'showCatBudgets')
    await this._buildCatBudgetRows()
  },

  async _buildCatBudgetRows() {
    try {
      const month = util.thisMonthStr()
      const list = await dbApi.listExpenses(month)
      const spentByCat = {}
      list.forEach((x) => {
        const k = x.category || '其他'
        spentByCat[k] = (spentByCat[k] || 0) + (x.amount || 0)
      })
      const budgetMap = (this.data.user && this.data.user.budgets) || {}
      const rows = (config.CATEGORIES || []).map((name) => {
        const spent = spentByCat[name] || 0
        const b = budgetMap[name]
        const budget = typeof b === 'number' && b > 0 ? b : 0
        return {
          name,
          spent,
          spentText: util.moneyThousand(spent),
          budget,
          budgetText: budget > 0 ? util.moneyThousand(budget) : '',
          over: budget > 0 && spent > budget
        }
      })
      this.setData({ catBudgetRows: rows })
    } catch (err) {
      console.error('加载分类预算失败', err)
      wx.showToast({ title: '加载失败，请重试', icon: 'none' })
    }
  },

  closeCatBudgets() {
    if (this._catBudgetsCloseTimer) { clearTimeout(this._catBudgetsCloseTimer); this._catBudgetsCloseTimer = null }
    this._catBudgetsCloseTimer = util.closeSheet(this, 'showCatBudgets')
  },

  /** 点某个分类 → 弹编辑 sheet（本月已花 + 预算输入） */
  onCatRowTap(e) {
    const name = e.currentTarget.dataset.cat
    const row = (this.data.catBudgetRows || []).find((r) => r.name === name)
    if (!row) return
    const remaining = row.budget > 0 ? Math.max(0, row.budget - row.spent) : 0
    this.setData({
      showCatBudget: true,
      showCatBudgetClosing: false,
      catBudgetEditing: {
        name: row.name,
        spentText: row.spentText,
        budget: row.budget,
        remainingText: remaining > 0 ? util.moneyThousand(remaining) : '0'
      },
      catBudgetInput: row.budget > 0 ? String(row.budget) : '',
      catBudgetFocus: true
    })
  },

  onCatBudgetInput(e) {
    // 只允许数字 + 小数点;粘贴含其他字符时清洗
    const raw = (e.detail.value || '').replace(/[^\d.]/g, '')
    this.setData({ catBudgetInput: raw })
  },

  closeCatBudget() {
    if (this._catBudgetCloseTimer) { clearTimeout(this._catBudgetCloseTimer); this._catBudgetCloseTimer = null }
    this._catBudgetCloseTimer = util.closeSheet(this, 'showCatBudget')
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

  /** 保存到 users.budgets；本地同步 user/globalData + 刷新列表行，不重查云 */
  async _updateCatBudget(cat, value) {
    const user = this.data.user || {}
    const next = Object.assign({}, user.budgets || {})
    if (value > 0) {
      next[cat] = value
    } else {
      delete next[cat]
    }
    try {
      await dbApi.updateMyUser({ budgets: next })
      // 同步本地 + globalData，其他页面(首页预算预警/账单 sheet)下次 loadData 读到新值
      this.syncUser({ budgets: next })
      this.setData({ catBudgetSetCount: Object.keys(next).length })
      this.closeCatBudget()
      // 本地刷新对应行（本月已花已在前台，无需再查）
      const rows = (this.data.catBudgetRows || []).map((r) => r.name === cat
        ? {
            ...r,
            budget: value > 0 ? value : 0,
            budgetText: value > 0 ? util.moneyThousand(value) : '',
            over: value > 0 && r.spent > value
          }
        : r)
      this.setData({ catBudgetRows: rows })
      wx.showToast({ title: '已保存', icon: 'success' })
    } catch (err) {
      console.error('保存分类预算失败', err)
      wx.showToast({ title: '保存失败', icon: 'none' })
    }
  },

  /* ---------- 回收站 ---------- */
  openRecycle() {
    wx.navigateTo({ url: '/pages/recycle/recycle' })
  },

  /* ---------- 编辑资料半屏弹层：头像 + 昵称，一次性保存 ---------- */
  /**
   * 打开编辑资料弹层：用当前顶部展示的 formAvatar / formNickname 初始化。
   * 注意：选头像（onChooseEditAvatar）只更新 editAvatar 预览，不立即上传；
   * 点保存按钮（saveEditProfile）时才统一上传头像 + 一次性 updateMyUser。
   *
   * 隐私授权前置检查：chooseAvatar / type=nickname 均为隐私接口，
   * 用户未同意隐私协议时 iOS 真机上静默失效（点击无反应、无昵称快捷栏、无报错），
   * 这里在打开弹层前主动唤起授权弹窗，拒绝时明确提示而非静默失败。
   */
  openEditProfile() {
    if (wx.getPrivacySetting) {
      wx.getPrivacySetting({
        success: (res) => {
          if (res.needAuthorization) {
            wx.requirePrivacyAuthorize({
              success: () => this._doOpenEditProfile(),
              fail: () => {
                wx.showToast({ title: '需同意隐私协议后才能设置头像昵称', icon: 'none', duration: 2500 })
              }
            })
          } else {
            this._doOpenEditProfile()
          }
        },
        fail: () => this._doOpenEditProfile()
      })
    } else {
      // 低版本基础库无隐私接口，直接打开（由后台隐私指引兜底）
      this._doOpenEditProfile()
    }
  },

  _doOpenEditProfile() {
    util.openSheet(this, 'showEditProfile', {
      editAvatar: this.data.formAvatar || '',
      editNickname: this.data.formNickname || '',
      editSaving: false
    })
  },

  closeEditProfile() {
    if (this._editCloseTimer) { clearTimeout(this._editCloseTimer); this._editCloseTimer = null }
    this._editCloseTimer = util.closeSheet(this, 'showEditProfile')
  },

  /** 弹层内选头像：只更新 editAvatar 预览，不写库 */
  onChooseEditAvatar(e) {
    this.setData({ editAvatar: e.detail.avatarUrl })
  },

  onEditNickInput(e) {
    this.setData({ editNickname: e.detail.value })
  },

  /**
   * 保存编辑资料：
   * - 头像若仍是本地临时路径（http://tmp/...，微信 chooseAvatar 返回）则上传到 cloud://；
   *   若已是 cloud:// fileID 则透传（不重复上传，节省读请求额度）。
   * - 昵称/头像一次性 dbApi.updateMyUser，幂等。
   * - 顶部资料卡 formAvatar / formNickname 同步刷新，下次打开弹层显示新值。
   */
  async saveEditProfile() {
    if (this.data.editSaving) return
    this.setData({ editSaving: true })
    const { editAvatar, editNickname } = this.data
    const nickname = (editNickname || '').trim()
    const data = { nickname }
    if (editAvatar && editAvatar.indexOf('cloud://') !== 0) {
      // 本地临时路径 → 上传到云端
      try {
        const openid = getApp().globalData.openid || 'user'
        const extMatch = (editAvatar.split('?')[0].match(/\.(\w+)$/) || [])[1]
        const ext = ['jpg', 'jpeg', 'png'].indexOf(extMatch) >= 0 ? extMatch : 'png'
        const up = await wx.cloud.uploadFile({
          cloudPath: `avatars/${openid}_${Date.now()}.${ext}`,
          filePath: editAvatar
        })
        data.avatarUrl = up.fileID
      } catch (err) {
        console.error('头像上传失败', err)
        wx.showToast({ title: '头像上传失败，请重试', icon: 'none' })
        this.setData({ editSaving: false })
        return
      }
    } else if (editAvatar) {
      data.avatarUrl = editAvatar
    }
    try {
      await dbApi.updateMyUser(data)
      this.syncUser(data)
      // 同步顶部资料卡展示：上传后的 fileID 写回 formAvatar，下次开弹层看到的就是新头像
      this.setData({
        formNickname: nickname,
        formAvatar: data.avatarUrl || this.data.formAvatar
      })
      wx.showToast({ title: '已保存', icon: 'success' })
      this.closeEditProfile()
    } catch (err) {
      console.error('保存编辑资料失败', err)
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    } finally {
      this.setData({ editSaving: false })
    }
  },

  onPaydayChange(e) {
    this.setData({ formPayday: Number(e.detail.value) + 1 })
  },

  /* ---------- 总预算编辑弹框 ---------- */
  openBudgetEdit() {
    util.openSheet(this, 'showBudgetEdit', {
      budgetEditInput: String(this.data.formBudget || ''),
      budgetEditFocus: true
    })
  },
  closeBudgetEdit() {
    if (this._budgetEditCloseTimer) { clearTimeout(this._budgetEditCloseTimer); this._budgetEditCloseTimer = null }
    this._budgetEditCloseTimer = util.closeSheet(this, 'showBudgetEdit')
  },
  onBudgetEditInput(e) {
    const raw = (e.detail.value || '').replace(/[^\d.]/g, '')
    this.setData({ budgetEditInput: raw })
  },
  async saveBudgetEdit() {
    const v = Number(this.data.budgetEditInput)
    if (!v || v <= 0) {
      wx.showToast({ title: '请输入有效金额', icon: 'none' })
      return
    }
    try {
      await dbApi.updateMyUser({ budget: v })
      this.syncUser({ budget: v })
      this.setData({ formBudget: String(v) })
      this.closeBudgetEdit()
      wx.showToast({ title: '已保存', icon: 'success' })
    } catch (err) {
      console.error('保存预算失败', err)
      wx.showToast({ title: '保存失败', icon: 'none' })
    }
  },

  /* ---------- 签名编辑 ---------- */
  openMottoEdit() {
    util.openSheet(this, 'showMottoEdit', {
      mottoEditInput: this.data.formMotto || this.data.defaultMotto,
      mottoEditFocus: true
    })
  },
  closeMottoEdit() {
    if (this._mottoEditCloseTimer) { clearTimeout(this._mottoEditCloseTimer); this._mottoEditCloseTimer = null }
    this._mottoEditCloseTimer = util.closeSheet(this, 'showMottoEdit')
  },
  onMottoEditInput(e) {
    this.setData({ mottoEditInput: e.detail.value })
  },
  async saveMottoEdit() {
    const v = (this.data.mottoEditInput || '').trim()
    if (!v) {
      wx.showToast({ title: '签名不能为空', icon: 'none' })
      return
    }
    if (v === this.data.formMotto) {
      this.closeMottoEdit()
      return
    }
    try {
      await dbApi.updateMyUser({ motto: v })
      this.syncUser({ motto: v })
      this.setData({ formMotto: v })
      this.closeMottoEdit()
      wx.showToast({ title: '已保存', icon: 'success' })
    } catch (err) {
      console.error('保存签名失败', err)
      wx.showToast({ title: '保存失败', icon: 'none' })
    }
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
    // 头像/昵称已在编辑资料弹层（saveEditProfile）保存为 cloud fileID；仅当仍是本地临时路径时兜底上传
    if (formAvatar && formAvatar.indexOf('cloud://') !== 0) {
      try {
        const openid = getApp().globalData.openid || 'user'
        const extMatch = (formAvatar.split('?')[0].match(/\.(\w+)$/) || [])[1]
        const ext = ['jpg', 'jpeg', 'png'].indexOf(extMatch) >= 0 ? extMatch : 'png'
        const up = await wx.cloud.uploadFile({
          cloudPath: `avatars/${openid}_${Date.now()}.${ext}`,
          filePath: formAvatar
        })
        data.avatarUrl = up.fileID
      } catch (err) {
        console.error('头像上传失败，将仅本地显示', err)
      }
    } else if (formAvatar) {
      data.avatarUrl = formAvatar
    }
    try {
      await dbApi.updateMyUser(data)
      this.syncUser(data)
      wx.showToast({ title: '已保存', icon: 'success' })
      this.loadUser()
    } catch (err) {
      wx.showToast({ title: '保存失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  /**
   * 「账本君主动询问」开关:
   * - 开启 → 走订阅授权;关闭 → 直接清云端字段,云函数不再推送
   */
  async onSalaryRemindToggle(e) {
    const newVal = e.detail.value === true
    const u = this.data.user || {}
    if (u.salaryRemindSubscribed === newVal) return
    if (newVal) {
      this.subscribeAiAsk()  // 内部 success 后会 syncUser + setData
      return
    }
    // 关闭
    try {
      await dbApi.updateMyUser({ salaryRemindSubscribed: false })
      this.syncUser({ salaryRemindSubscribed: false })
      // 顺手清未读 — 用户主动关了,提示也没意义
      chatStorage.clearPendingQuestion()
      dbApi.updateMyUser({ unreadQuestion: null, unreadQuestionCount: 0 }).catch(() => {})
      wx.showToast({ title: '已关闭账本君主动询问', icon: 'none' })
    } catch (err) {
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  /**
   * 账本君主动询问订阅授权(发薪日推送)。
   * 复用 subscribeRemind 的 error-code 映射,只是模板 ID 不同。
   */
  subscribeAiAsk() {
    const tid = config.SALARY_REMIND_TEMPLATE_ID
    if (tid.indexOf('请填入') === 0) {
      wx.showModal({
        title: '提醒未开启',
        content: '需要先在 utils/config.js 填入订阅消息模板 ID,才能收到工资到账询问。',
        showCancel: false
      })
      return
    }
    // 标记今天已请求过,避免同一天重复弹授权
    wx.setStorageSync('xz_subscribe_ask_date', util.todayStr())
    wx.requestSubscribeMessage({
      tmplIds: [tid],
      success: async (res) => {
        if (res[tid] === 'accept') {
          try {
            await dbApi.updateMyUser({ salaryRemindSubscribed: true })
            this.syncUser({ salaryRemindSubscribed: true })
            wx.showToast({ title: '账本君会主动关心你', icon: 'success' })
          } catch (e) {
            wx.showToast({ title: '保存失败,请重试', icon: 'none' })
          }
        } else {
          wx.showToast({ title: '未授权,收不到推送', icon: 'none' })
        }
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || ''
        let tip = '授权失败,请重试'
        if (msg.indexOf('20001') >= 0) tip = '订阅消息主开关已关闭,请到设置中开启'
        else if (msg.indexOf('20004') >= 0) tip = '模板 ID 无效,请核对小程序后台'
        wx.showToast({ title: tip, icon: 'none' })
      }
    })
  },

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
      content: '将删除当前账号下所有工资、信用卡、开销记录，并清空账本君的聊天记录，此操作不可恢复。确定继续吗？',
      confirmText: '确定重置',
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await dbApi.clearAllData()
          // 同步清空账本君聊天记录：本地 storage + 内存态 + 欢迎标记 + 待回应询问气泡
          getApp().globalData.chatMessages = []
          getApp().globalData.chatInput = ''
          chatStorage.clear()
          chatStorage.clearPendingQuestion()
          chatStorage.clearWelcomed()
          chatStorage.clearHints()
          chatStorage.clearReminderRead()
          chatStorage.clearBriefRead()
          wx.showToast({ title: '已重置', icon: 'success' })
          this.loadUser()
        } catch (e) {
          wx.showToast({ title: '重置失败', icon: 'none' })
        }
      }
    })
  },

  /* ---------- 固定支出管理（从记账页移入） ---------- */
  openRecur() {
    if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null }
    util.openSheet(this, 'showRecur')
    // 弹框入场动画 0.28s 结束后再测量（此时 scroll-view 已渲染出真实内容高度）
    setTimeout(() => this._fitRecurScrollHeight(), 320)
  },

  closeRecur() {
    this._closeTimer = util.closeSheet(this, 'showRecur')
    // 关闭后重置：下次再打开默认仍走 56vh（避免开-关-开残留低高度）
    this.setData({ recurScrollHeight: '56vh' })
  },

  /**
   * 测量固定支出列表真实内容高度，按需收敛 scroll-view height：
   * - 内容 ≤ 56vh → scroll-view height = 内容真实像素高度 + 8rpx 缓冲（自适应，无空白）
   * - 内容 > 56vh → scroll-view height = 56vh（保留 WX scroll-view 内部滚动能力）
   * WX scroll-view 内部滚动容器必须拿到确定 height 才能滚动，所以保留 fixed 兜底；
   * 只在内容少时"放权"给内容自然撑开——这是 scroll-view 既能适应内容又能滚动的唯一折中。
   */
  _fitRecurScrollHeight() {
    if (!this.data.showRecur) return
    try {
      const query = wx.createSelectorQuery().in(this)
      query.select('.recur-tip').boundingClientRect()
      query.selectAll('.recur-row').boundingClientRect()
      query.exec((res) => {
        if (!this.data.showRecur) return  // 测量期间用户可能已关闭
        const tip = res[0]
        const rows = res[1] || []
        if (!tip) return
        const win = wx.getWindowInfo()
        const rpx = win.windowWidth / 750
        // 内容真实底部 = max(最后一个 row 底部, tip 底部)
        let contentBottom = tip.top + tip.height
        if (rows.length) {
          const lastRowBottom = Math.max(...rows.map((r) => r.top + r.height))
          if (lastRowBottom > contentBottom) contentBottom = lastRowBottom
        }
        // 内容像素高度 + 8rpx 缓冲(避免最后一行贴底被裁);rpx 用窗口宽 / 750 换算
        const contentPx = Math.round((contentBottom - tip.top) + 8 * rpx)
        const maxPx = 0.56 * win.windowHeight  // 56vh
        const target = contentPx <= maxPx ? Math.ceil(contentPx) : Math.floor(maxPx)
        this.setData({ recurScrollHeight: `${target}px` })
      })
    } catch (err) {
      console.warn('fitRecurScrollHeight fail', err)
      // 兜底保持 56vh（保留滚动能力，不破坏既有行为）
      this.setData({ recurScrollHeight: '56vh' })
    }
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
    // cat-grid 组件 change 事件：detail.value 为选中分类
    this.setData({ rCategory: e.detail.value })
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
      this.loadRecurring()
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
          dbApi.invalidateFinCache(util.thisMonthStr())
          this.loadRecurring()
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
          this.loadRecurring()
        } catch (err) {
          wx.showToast({ title: '删除失败', icon: 'none' })
        }
      }
    })
  },

  /* ---------- 消费日历（入口卡片：点击跳转独立页 pages/calendar） ---------- */
  goCalendar() {
    wx.navigateTo({ url: '/pages/calendar/calendar' })
  },

  /** 入口行副标题：近 3 月支出汇总（完整热力图在独立页） */
  async _loadHeatmapPreview(force) {
    try {
      const { byDay } = await dbApi.listExpensesForHeatmap(4, force)
      const stats = computeHeatmapStats(byDay)
      this.setData({
        heatmapSubText: `近 3 月支出 ¥${stats.totalAmountText}・${stats.totalDays} 天有开销`
      })
    } catch (err) {
      console.warn('消费日历统计失败', err)
    }
  }
})
