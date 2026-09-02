const util = require('../../utils/util')
const dbApi = require('../../utils/db')
const themeUtil = require('../../utils/theme')

/**
 * 订阅续费管理页（T1.2）
 * 列表展示 + 新增/编辑/删除 + 顶部汇总卡（月均/年化总支出）
 * 排序：按 nextCharge 升序（最近要扣的在前）—— db.listSubscriptions 已默认按 nextCharge asc
 *
 * 4.3 节录入口径（v2）：
 * - nextCharge 是「主录入字段 + 唯一到期判断依据」,用户对着 App 会员中心「会员有效期至」照抄
 * - cycleDay 由 nextCharge 自动反推(monthly/quarterly/weekly 取日号;yearly 取 MM-DD;custom 无 cycleDay)
 * - firstChargeDate 仅年度报告用,由 nextCharge - 1 周期推算
 * - 不再走「不记得了」降级模式:到期日是 App 里直接看到的,理论上不存在记不住的情况
 * - 「今天新开」快捷:把 nextCharge 设为「今天 + 1 周期」(等价于刚订阅的下一期到期日)
 */
Page({
  data: {
    subscriptions: [],
    activeCount: 0,
    totalCount: 0,
    summary: { monthlyText: '0.00', yearlyText: '0.00' },
    nextUpText: '',
    formScrollHeight: '56vh',

    // 表单字段（4.3 节：nextCharge 主录入 + 系统反推 cycleDay / firstChargeDate）
    showForm: false,
    showFormClosing: false,
    editingId: '',
    formName: '',
    formPlatform: '',
    formAmount: '',
    formNote: '',
    formNextCharge: '',          // 主字段:下次扣费 / 首次到期日期
    formSaving: false,
    cycleIndex: 0,
    customMonths: '',            // 自定义周期月数(选「自定义」时显示输入框,占位「如 6 = 半年包,3 = 季包」)
    usageIndex: 2,           // 默认 rare
    statusIndex: 0,          // 默认 active
    cycleOptions: ['每月', '每年', '每季', '每周', '自定义'],
    usageOptions: ['常用', '偶尔', '很少', '从不'],
    statusOptions: ['使用中', '已暂停', '已取消'],
    // 扣费渠道(T1.2 + T2.3 取消指引匹配用):5 选项,默认「不清楚」=unknown,与 AI 工具 unknown 对齐
    payChannelOptions: ['微信自动续费', '支付宝自动扣款', '苹果订阅', 'App 内开通', '不清楚'],
    payChannelIndex: 4,
    formDateEnd: '',          // picker end 上限（今天 + 1 天，避免选明天）
    formPreview: { nextCharge: '', yearlyText: '0.00', cycleDayText: '', derived: false },

    // 删除确认
    showRemoveConfirm: false,
    showRemoveConfirmClosing: false,
    removeTargetId: '',
    removeTargetName: '',

    // 年度订阅浪费报告(T2.2)
    reportYear: '',
    showReport: false,
    showReportClosing: false,
    reportLoading: false,
    reportError: '',
    reportData: null
  },

  onShow() {
    util.checkLock()
    themeUtil.applyToPage(this)
    // picker end 上限今天 + 1 天(避免选到明天导致数据库 nextCharge 推到更远)
    const tomorrow = new Date(Date.now() + 86400000)
    this.setData({
      formDateEnd: `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`,
      reportYear: String(new Date().getFullYear())
    })
    // 首次进入 + 每次从其他页返回都刷新：首页/账本君记账/编辑页都可能改动订阅数据
    this.loadSubscriptions()
  },

  async onPullDownRefresh() {
    try {
      await this.loadSubscriptions(true)
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  /** 加载订阅列表（60s TTL 缓存）；失败/集合未创建 → 空列表 */
  async loadSubscriptions(force) {
    let list = []
    try {
      list = await dbApi.listSubscriptions(force)
    } catch (e) {
      // 集合未创建等：空态展示，不打扰
      console.warn('加载订阅失败', e)
    }
    const enriched = (list || []).map((s) => this._enrich(s))
    const summary = this._summary(enriched)
    const nextUp = enriched.find((s) => s.status === 'active' && s.nextCharge)
    const nextUpText = nextUp ? `${nextUp.name} ${nextUp.nextChargeText}` : ''
    const activeCount = enriched.filter((s) => s.status === 'active').length
    this.setData({
      subscriptions: enriched,
      activeCount,
      totalCount: enriched.length,
      summary,
      nextUpText
    })
  },

  /** 列表项派生展示字段：金额文本/周期文本/下次扣费中文距离/使用频率标签 + T2.3 取消指引 */
  _enrich(s) {
    const amount = Number(s.amount) || 0
    const cycleMap = { monthly: '每月', yearly: '每年', quarterly: '每季', weekly: '每周' }
    let cycleText = cycleMap[s.cycle] || s.cycle || ''
    // custom 周期:显示「每 N 个月」让用户一眼看出是半年包/季包等期限包
    if (s.cycle === 'custom') {
      const cm = Number(s.customMonths)
      cycleText = Number.isInteger(cm) && cm > 0 ? `每 ${cm} 个月` : '自定义'
    }
    const usageMap = {
      frequent: { text: '常用', cls: 'tag-green' },
      occasional: { text: '偶尔', cls: 'tag-gold' },
      rare: { text: '很少', cls: 'tag-gray' },
      never: { text: '从不', cls: 'tag-red' }
    }
    const u = usageMap[s.usage] || usageMap.rare
    const today = util.todayStr()
    const days = s.nextCharge ? util.daysBetween(today, s.nextCharge) : null
    let daysText = ''
    if (days == null) daysText = '—'
    else if (days < 0) daysText = `已过 ${-days} 天`
    else if (days === 0) daysText = '今天'
    else daysText = `${days} 天`
    const yearly = this._yearly(s)

    // T2.3 取消指引:DB 存的是 cancelGuide(双兜底场景是 JSON 字符串数组),
    // 解析 + 派生展示字段。展开状态默认关。
    const cancelGuide = this._parseCancelGuide(s.cancelGuide)
    const cancelGuideSource = s.cancelGuideSource || ''
    let cancelGuideLabel = ''
    let cancelGuideList = null
    if (cancelGuide) {
      if (cancelGuideSource === 'channel') cancelGuideLabel = '取消指引（按扣费渠道）'
      else if (cancelGuideSource === 'platform') cancelGuideLabel = '取消指引（按平台）'
      else if (cancelGuideSource === 'fallback') {
        cancelGuideLabel = '取消指引（双兜底）'
        // 双兜底:JSON 字符串数组
        try {
          cancelGuideList = typeof cancelGuide === 'string' ? JSON.parse(cancelGuide) : cancelGuide
          if (!Array.isArray(cancelGuideList)) cancelGuideList = [String(cancelGuideList)]
        } catch (_) {
          cancelGuideList = [String(cancelGuide)]
        }
      }
    }

    return {
      ...s,
      amountText: util.moneyThousand(amount),
      yearlyText: util.moneyThousand(yearly),
      cycleText,
      usageText: u.text,
      usageTagClass: u.cls,
      nextChargeText: s.nextCharge || '—',
      days,
      daysText,
      inactive: s.status !== 'active',
      // T2.3 取消指引派生字段
      cancelGuide: cancelGuide || '',
      cancelGuideSource,
      cancelGuideLabel,
      cancelGuideList,
      cancelGuideOpen: false
    }
  },

  /**
   * 兼容 DB 里 cancelGuide 字段的两种形态:
   * - channel/platform: 字符串(如 "微信 → 我 → ...")
   * - fallback: JSON 字符串数组(如 '["微信 → ...","支付宝 → ..."]')
   * 任一形态都统一成「非空时为字符串/数组」,空/null/undefined 视为无指引
   */
  _parseCancelGuide(raw) {
    if (raw == null) return ''
    if (typeof raw === 'string' && raw.trim()) return raw
    if (Array.isArray(raw) && raw.length) return raw
    // JSON 字符串兜底解析
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.length) return parsed
      } catch (_) {}
    }
    return ''
  },

  /** 年化金额：monthly×12 + yearly×1 + quarterly×4 + weekly×52
   *  custom: amount × 12 / customMonths(半年包 88 → 176/年;非法 customMonths 兜底按 12 处理)
   */
  _yearly(s) {
    const a = Number(s.amount) || 0
    if (s.cycle === 'monthly') return a * 12
    if (s.cycle === 'yearly') return a
    if (s.cycle === 'quarterly') return a * 4
    if (s.cycle === 'weekly') return a * 52
    if (s.cycle === 'custom') {
      const cm = Number(s.customMonths)
      if (Number.isInteger(cm) && cm >= 1 && cm <= 36) return Math.round(a * 12 / cm * 100) / 100
      return Math.round(a * 12 * 100) / 100
    }
    return 0
  },

  /** 汇总：仅 active 计入汇总卡（暂停/取消不应拉高支出预期） */
  _summary(list) {
    let yearly = 0
    for (const s of list) {
      if (s.status !== 'active') continue
      yearly += this._yearly(s)
    }
    const monthly = yearly / 12
    return {
      monthlyText: util.moneyThousand(monthly),
      yearlyText: util.moneyThousand(yearly)
    }
  },

  /* ---------- 表单打开/关闭 ---------- */
  openForm(e) {
    const id = (e && e.currentTarget && e.currentTarget.dataset.id) || ''
    let editing = null
    if (id) editing = (this.data.subscriptions || []).find((s) => s._id === id)
    // 周期索引:standard 走前 4 个;custom 落在索引 4
    const cycleKeys = ['monthly', 'yearly', 'quarterly', 'weekly']
    const cycleIndex = editing
      ? (cycleKeys.indexOf(editing.cycle) >= 0
        ? cycleKeys.indexOf(editing.cycle)
        : (editing.cycle === 'custom' ? 4 : 0))
      : 0
    const customMonths = editing && editing.cycle === 'custom'
      ? String(editing.customMonths || '')
      : ''
    const usageIndex = editing
      ? (['frequent', 'occasional', 'rare', 'never'].indexOf(editing.usage) >= 0
        ? ['frequent', 'occasional', 'rare', 'never'].indexOf(editing.usage)
        : 2)
      : 2
    const statusIndex = editing
      ? (['active', 'paused', 'cancelled'].indexOf(editing.status) >= 0
        ? ['active', 'paused', 'cancelled'].indexOf(editing.status)
        : 0)
      : 0
    // 扣费渠道索引:老数据无 payChannel 字段时兜底 4(unknown)
    const payChannelIndex = editing
      ? (['wechat', 'alipay', 'apple', 'inapp', 'unknown'].indexOf(editing.payChannel) >= 0
        ? ['wechat', 'alipay', 'apple', 'inapp', 'unknown'].indexOf(editing.payChannel)
        : 4)
      : 4
    // 4.3 节:nextCharge 主录入,直接装载;老数据无 nextCharge 时兜底取 today(几乎不可能,旧逻辑会写)
    const nextCharge = editing ? (editing.nextCharge || '') : ''
    const derivedCycle = cycleIndex === 4 ? 'custom' : cycleKeys[cycleIndex]
    this.setData({
      showForm: true,
      showFormClosing: false,
      editingId: id,
      formName: editing ? (editing.name || '') : '',
      formPlatform: editing ? (editing.platform || '') : '',
      formAmount: editing ? String(editing.amount || '') : '',
      formNote: editing ? (editing.note || '') : '',
      formNextCharge: nextCharge,
      formSaving: false,
      cycleIndex,
      customMonths,
      usageIndex,
      statusIndex,
      payChannelIndex,
      formPreview: this._previewFromForm({
        cycle: derivedCycle,
        nextCharge,
        amount: editing ? editing.amount : 0,
        customMonths: editing && editing.cycle === 'custom' ? editing.customMonths : undefined
      })
    })
    this._measureFormScroll()
  },

  closeForm() {
    if (this._formCloseTimer) { clearTimeout(this._formCloseTimer); this._formCloseTimer = null }
    this.setData({ showFormClosing: true })
    this._formCloseTimer = setTimeout(() => {
      this._formCloseTimer = null
      this.setData({ showForm: false, showFormClosing: false, editingId: '' })
    }, 240)
  },

  _measureFormScroll() {
    // 弹层内 scroll-view 高度：屏高 56vh 兜底，内容少时让 scroll-view 自然撑开
    // （与 my.js recurScrollHeight 同款思路：先按 56vh 占位，JS 不做测量干预）
    this.setData({ formScrollHeight: '56vh' })
  },

  /* ---------- 表单输入 ---------- */
  onFormNameInput(e) { this.setData({ formName: e.detail.value }) },
  onFormPlatformInput(e) { this.setData({ formPlatform: e.detail.value }) },
  onFormAmountInput(e) { this.setData({ formAmount: e.detail.value, formPreview: this._previewFromForm(this._formSnapshot()) }) },
  onFormNextChargeChange(e) {
    // 用户选了「下次扣费 / 首次到期日期」→ 直接当主字段
    this.setData({
      formNextCharge: e.detail.value,
      formPreview: this._previewFromForm(this._formSnapshot({ formNextCharge: e.detail.value }))
    })
  },
  onFormNoteInput(e) { this.setData({ formNote: e.detail.value }) },

  /** 「今天新开」快捷:把 nextCharge 设为「今天 + 1 周期」,等价于刚订阅的下一期到期日。
   *  custom 周期需 customMonths 已填;否则兜底按「今天 + 1 月」并提示。
   */
  setNextChargeAsNewToday() {
    const cycleKeys = ['monthly', 'yearly', 'quarterly', 'weekly']
    const idx = this.data.cycleIndex
    const isCustom = idx === 4
    let cm = 0
    if (isCustom) {
      cm = Number(this.data.customMonths)
      if (!Number.isInteger(cm) || cm < 1 || cm > 36) {
        wx.showToast({ title: '请先填自定义周期月数', icon: 'none' })
        return
      }
    }
    const cycle = isCustom ? 'custom' : (cycleKeys[idx] || 'monthly')
    const today = new Date()
    const advanced = isCustom
      // custom 按 customMonths 月累加;daily 校验交给 db 层
      ? (() => {
          const totalM = today.getFullYear() * 12 + today.getMonth() + cm
          const ny = Math.floor(totalM / 12)
          const nm = totalM % 12
          const dd = Math.min(today.getDate(), new Date(ny, nm + 1, 0).getDate())
          return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
        })()
      : (() => {
          // monthly +1、quarterly +3、yearly +1 年、weekly +7 天
          if (cycle === 'weekly') {
            const t = new Date(today.getTime() + 7 * 86400000)
            return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
          }
          const step = cycle === 'monthly' ? 1 : cycle === 'quarterly' ? 3 : 12
          const totalM = today.getFullYear() * 12 + today.getMonth() + step
          const ny = Math.floor(totalM / 12)
          const nm = totalM % 12
          const dd = Math.min(today.getDate(), new Date(ny, nm + 1, 0).getDate())
          return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
        })()
    this.setData({
      formNextCharge: advanced,
      formPreview: this._previewFromForm(this._formSnapshot({ formNextCharge: advanced }))
    })
  },

  onCycleChange(e) {
    const idx = Number(e.detail.value) || 0
    const patch = { cycleIndex: idx }
    // 切到 custom:保留 customMonths 让用户输入(若编辑老数据空值则置空)
    // 切走 custom:清空 customMonths,避免脏数据落地
    if (idx === 4) {
      // 进入 custom:无 customMonths 时留空让用户输入
      if (!this.data.customMonths) patch.customMonths = ''
    } else {
      patch.customMonths = ''
    }
    patch.formPreview = this._previewFromForm(this._formSnapshot({ cycleIndex: idx, customMonths: patch.customMonths }))
    this.setData(patch)
  },

  onCustomMonthsInput(e) {
    // 自定义周期月数:1-36 整数,半角数字
    const raw = (e.detail.value || '').toString().replace(/[^\d]/g, '').slice(0, 2)
    this.setData({
      customMonths: raw,
      formPreview: this._previewFromForm(this._formSnapshot({ customMonths: raw }))
    })
  },
  onUsageChange(e) {
    this.setData({ usageIndex: Number(e.detail.value) || 0 })
  },
  onStatusChange(e) {
    this.setData({ statusIndex: Number(e.detail.value) || 0 })
  },
  onPayChannelChange(e) {
    // 不能用 `|| 4`:选「微信自动续费」(索引 0)时 e.detail.value===0,Number(0)||4 会吞掉 0 落回 4(unknown)
    // 其他 picker 兜底是 0 没事,这里兜底是 4 必须用范围判断
    const idx = Number(e.detail.value)
    this.setData({ payChannelIndex: idx >= 0 && idx <= 4 ? idx : 4 })
  },

  _formSnapshot(overrides) {
    const o = overrides || {}
    const cycleKeys = ['monthly', 'yearly', 'quarterly', 'weekly']
    const idx = o.cycleIndex != null ? o.cycleIndex : this.data.cycleIndex
    const cycle = idx === 4 ? 'custom' : cycleKeys[idx]
    return {
      cycle,
      nextCharge: o.formNextCharge != null ? o.formNextCharge : this.data.formNextCharge,
      amount: o.formAmount != null ? o.formAmount : this.data.formAmount,
      customMonths: o.customMonths != null ? o.customMonths : this.data.customMonths
    }
  },

  /** 预览:实时计算下次扣费 + 年化金额 + 派生日历(4.3 节 v2)
   *  - 主路径(传 nextCharge):nextCharge 由用户照抄;cycleDay = day(nextCharge)(custom 无 cycleDay)
   *  - 未填 nextCharge:derived=false,不展示推导块
   *  - custom 周期:customMonths 必填;nextCharge 用户必填,无兜底
   */
  _previewFromForm({ cycle, nextCharge, amount, customMonths }) {
    const a = Number(amount) || 0
    let yearly = 0
    if (cycle === 'monthly') yearly = a * 12
    else if (cycle === 'yearly') yearly = a
    else if (cycle === 'quarterly') yearly = a * 4
    else if (cycle === 'weekly') yearly = a * 52
    else if (cycle === 'custom') {
      const cm = Number(customMonths)
      if (Number.isInteger(cm) && cm >= 1 && cm <= 36) yearly = Math.round(a * 12 / cm * 100) / 100
      else yearly = 0
    }
    let derivedCycleDay = ''
    let nc = (nextCharge || '').toString().trim()
    const cmNum = Number(customMonths)
    const customReady = cycle !== 'custom' || (Number.isInteger(cmNum) && cmNum >= 1 && cmNum <= 36)
    if (nc && /^\d{4}-\d{2}-\d{2}$/.test(nc) && customReady) {
      // 主路径:nextCharge 是用户照抄的,系统自动反推 cycleDay
      if (cycle !== 'custom') {
        const cd = util.deriveCycleDay(cycle, nc)
        derivedCycleDay = (cd != null) ? String(cd) : ''
      }
    }
    const cycleDayText = derivedCycleDay
      ? (cycle === 'yearly' ? `每年 ${derivedCycleDay}（月-日）` : `每月 ${derivedCycleDay} 号`)
      : ''
    return {
      nextCharge: nc,
      yearlyText: util.moneyThousand(yearly),
      cycleDayText,
      derived: !!(nc && /^\d{4}-\d{2}-\d{2}$/.test(nc) && customReady)
    }
  },

  /* ---------- 保存 ---------- */
  async saveSubscription() {
    const name = (this.data.formName || '').trim()
    const platform = (this.data.formPlatform || '').trim()
    const amountStr = (this.data.formAmount || '').toString().trim()
    const nextChargeRaw = (this.data.formNextCharge || '').toString().trim()
    const note = (this.data.formNote || '').trim()
    const cycleKeys = ['monthly', 'yearly', 'quarterly', 'weekly']
    const usages = ['frequent', 'occasional', 'rare', 'never']
    const statuses = ['active', 'paused', 'cancelled']
    const payChannels = ['wechat', 'alipay', 'apple', 'inapp', 'unknown']
    const isCustom = this.data.cycleIndex === 4
    const cycle = isCustom ? 'custom' : (cycleKeys[this.data.cycleIndex] || 'monthly')
    const usage = usages[this.data.usageIndex] || 'rare'
    const status = statuses[this.data.statusIndex] || 'active'
    const payChannel = payChannels[this.data.payChannelIndex] || 'unknown'

    if (!name) { wx.showToast({ title: '请输入订阅名称', icon: 'none' }); return }
    if (name.length > 20) { wx.showToast({ title: '名称不超过 20 字', icon: 'none' }); return }
    if (!platform) { wx.showToast({ title: '请输入平台名', icon: 'none' }); return }
    const amount = Number(amountStr)
    if (!Number.isFinite(amount) || amount <= 0) { wx.showToast({ title: '金额需大于 0', icon: 'none' }); return }
    // amount ≤ 2 位小数
    if (Math.round(amount * 100) !== amount * 100) { wx.showToast({ title: '金额最多 2 位小数', icon: 'none' }); return }

    // custom 周期校验:customMonths 必须是 1-36 的整数
    let customMonths = 0
    if (isCustom) {
      const cmRaw = (this.data.customMonths || '').toString().trim()
      const cm = Number(cmRaw)
      if (!/^\d{1,2}$/.test(cmRaw) || !Number.isInteger(cm) || cm < 1 || cm > 36) {
        wx.showToast({ title: '自定义周期需填 1-36 整数月', icon: 'none' })
        return
      }
      customMonths = cm
    }

    // 4.3 节 v2:nextCharge 是主录入字段 + 唯一到期判断依据,用户必填;系统自动反推 cycleDay + firstChargeDate
    if (!nextChargeRaw || !/^\d{4}-\d{2}-\d{2}$/.test(nextChargeRaw)) {
      wx.showToast({ title: isCustom ? '请选择首次到期日期' : '请选择下次扣费日期', icon: 'none' })
      return
    }
    const nextCharge = nextChargeRaw
    // cycleDay 由 nextCharge 反推(custom 周期无 cycleDay,留空)
    let cycleDay = ''
    if (cycle !== 'custom') {
      const d = util.deriveCycleDay(cycle, nextCharge)
      if (d == null) { wx.showToast({ title: '日期无效', icon: 'none' }); return }
      cycleDay = String(d)
    }
    // firstChargeDate 由 nextCharge - 1 周期推算(年度报告用)
    const firstChargeDate = util.deriveFirstChargeDate
      ? util.deriveFirstChargeDate(cycle, nextCharge, isCustom ? customMonths : undefined)
      : ''

    this.setData({ formSaving: true })
    try {
      const payload = {
        name,
        platform,
        amount,
        cycle,
        cycleDay,
        firstChargeDate,
        nextCharge,
        usage,
        payChannel,
        status,
        note
      }
      // custom 周期写入 customMonths;standard 不写(保持老数据形态)
      if (isCustom) payload.customMonths = customMonths
      if (this.data.editingId) {
        await dbApi.updateSubscription(this.data.editingId, payload)
        wx.showToast({ title: '已更新', icon: 'success' })
      } else {
        await dbApi.addSubscription(payload)
        wx.showToast({ title: '已添加', icon: 'success' })
      }
      this.closeForm()
      // 强制重查:本次写操作已 invalidate 缓存但有 60s 窗口竞态,force 保险
      await this.loadSubscriptions(true)
    } catch (e) {
      console.error('保存订阅失败', e)
      wx.showToast({ title: util.errTip(e, '保存失败，请重试'), icon: 'none' })
    } finally {
      this.setData({ formSaving: false })
    }
  },

  /* ---------- 删除 ---------- */
  confirmRemove(e) {
    const id = e.currentTarget.dataset.id
    const name = e.currentTarget.dataset.name || ''
    this.setData({
      showRemoveConfirm: true,
      showRemoveConfirmClosing: false,
      removeTargetId: id,
      removeTargetName: name
    })
  },

  closeRemoveConfirm() {
    if (this._rmCloseTimer) { clearTimeout(this._rmCloseTimer); this._rmCloseTimer = null }
    this.setData({ showRemoveConfirmClosing: true })
    this._rmCloseTimer = setTimeout(() => {
      this._rmCloseTimer = null
      this.setData({ showRemoveConfirm: false, showRemoveConfirmClosing: false, removeTargetId: '', removeTargetName: '' })
    }, 200)
  },

  async doRemove() {
    const id = this.data.removeTargetId
    if (!id) { this.closeRemoveConfirm(); return }
    try {
      await dbApi.removeSubscription(id)
      wx.showToast({ title: '已删除', icon: 'success' })
      this.closeRemoveConfirm()
      await this.loadSubscriptions(true)
    } catch (e) {
      console.error('删除订阅失败', e)
      wx.showToast({ title: util.errTip(e, '删除失败，请重试'), icon: 'none' })
    }
  },

  /* ---------- T2.3 取消指引展开/收起 ---------- */
  toggleCancelGuide(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const list = (this.data.subscriptions || []).map((s) => {
      if (s._id !== id) return s
      return { ...s, cancelGuideOpen: !s.cancelGuideOpen }
    })
    this.setData({ subscriptions: list })
  },

  /* ---------- 年度浪费报告(T2.2) ---------- */
  /** 打开报告:取当年订阅,聚合年化 + 浪费系数,调 subReport 云函数生成 AI 解读 */
  async openSubReport() {
    // 无订阅不让开:按钮已经被 wx:if 拦住,这里再兜一层
    if (!this.data.totalCount) {
      wx.showToast({ title: '还没订阅,先去添加', icon: 'none' })
      return
    }
    // 先打开 sheet + 展示 loading,再异步拉数据(避免冷启动时白屏)
    this.setData({
      showReport: true,
      showReportClosing: false,
      reportLoading: true,
      reportError: '',
      reportData: null
    })
    this._measureFormScroll()
    const year = this.data.reportYear || String(new Date().getFullYear())
    let result
    try {
      result = await dbApi.getSubReport(year)
    } catch (e) {
      console.error('年度订阅报告失败', e)
      this.setData({ reportLoading: false, reportError: util.errTip(e, '报告生成失败,稍后再试') })
      return
    }
    if (!result || !result.text) {
      this.setData({ reportLoading: false, reportError: '报告生成失败,稍后再试' })
      return
    }
    // 数据块已经在 db.js 算好,这里只把数字转成 .toFixed(0) 字符串给 wxml 用
    const dataBlock = await this._buildReportDataBlock(year)
    this.setData({
      reportLoading: false,
      reportData: {
        ...dataBlock,
        text: result.text,
        source: result.source
      }
    })
  },

  /** 同步拉一次订阅聚合数据(给报告数字概览 + 明细用)
   *  custom 周期走 amount × 12 / customMonths(与 subReport / finChat 同款,保证 LLM 数据块一致)
   */
  async _buildReportDataBlock(year) {
    try {
      const subs = await dbApi.listSubscriptions(false)
      const filtered = (subs || []).filter((s) => !s.deleted)
      const CYCLE_UNIT = { monthly: 12, quarterly: 4, yearly: 1, weekly: 52 }
      const WASTE_FACTOR = { never: 1.0, rare: 0.5, occasional: 0, frequent: 0 }
      const USAGE_LABEL = { frequent: '常用', occasional: '偶尔', rare: '很少', never: '从不' }
      const CHANNEL_LABEL = { wechat: '微信', alipay: '支付宝', apple: '苹果', inapp: 'App内', unknown: '渠道未知' }
      const items = []
      let yearTotal = 0
      let yearWaste = 0
      for (const s of filtered) {
        const amount = Number(s.amount) || 0
        const cycle = s.cycle || 'monthly'
        let yearly
        if (cycle === 'custom') {
          const cm = Number(s.customMonths)
          if (Number.isInteger(cm) && cm >= 1 && cm <= 36) yearly = Math.round(amount * 12 / cm * 100) / 100
          else yearly = Math.round(amount * 12 * 100) / 100
        } else {
          yearly = Math.round(amount * (CYCLE_UNIT[cycle] || 12) * 100) / 100
        }
        const usage = s.usage || 'rare'
        const wasteFactor = (usage in WASTE_FACTOR) ? WASTE_FACTOR[usage] : WASTE_FACTOR.rare
        const waste = Math.round(yearly * wasteFactor * 100) / 100
        if (s.status !== 'cancelled') yearTotal += yearly
        yearWaste += waste
        items.push({
          name: s.name || '',
          platform: s.platform || '',
          channel: CHANNEL_LABEL[s.payChannel || 'unknown'] || CHANNEL_LABEL.unknown,
          usageText: USAGE_LABEL[usage] || USAGE_LABEL.rare,
          amountText: amount.toFixed(2),
          yearlyText: yearly.toFixed(0),
          waste: waste,
          wasteText: waste.toFixed(0)
        })
      }
      yearTotal = Math.round(yearTotal * 100) / 100
      yearWaste = Math.round(yearWaste * 100) / 100
      return {
        year,
        yearTotal: yearTotal,
        yearTotalText: yearTotal.toFixed(0),
        yearWaste: yearWaste,
        yearWasteText: yearWaste.toFixed(0),
        optimized: Math.round((yearTotal - yearWaste) * 100) / 100,
        optimizedText: yearWaste.toFixed(0),
        items: items.slice().sort((a, b) => b.waste - a.waste)
      }
    } catch (e) {
      console.warn('聚合报告数字块失败', e)
      return { year, yearTotal: 0, yearTotalText: '0', yearWaste: 0, yearWasteText: '0', optimized: 0, optimizedText: '0', items: [] }
    }
  },

  closeSubReport() {
    if (this._reportCloseTimer) { clearTimeout(this._reportCloseTimer); this._reportCloseTimer = null }
    this.setData({ showReportClosing: true })
    this._reportCloseTimer = setTimeout(() => {
      this._reportCloseTimer = null
      this.setData({ showReport: false, showReportClosing: false, reportLoading: false, reportError: '', reportData: null })
    }, 240)
  },

  /** 阻止穿透滚动(catchtouchmove="preventTouchmove" 已挂载;此函数保留兜底) */
  preventTouchmove() {}
})
