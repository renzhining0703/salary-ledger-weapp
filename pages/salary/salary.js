const util = require('../../utils/util')
const dbApi = require('../../utils/db')

Page({
  data: {
    user: null,
    list: [],
    loading: true,
    yearTotal: '0.00',
    countdown: null,
    showForm: false,
    saving: false,
    showPayday: false,
    paydayRange: Array.from({ length: 31 }, (_, i) => i + 1),
    formPayday: 15,
    formDate: '',
    formAmount: '',
    formNote: ''
  },

  onShow() {
    this.loadData()
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
    if (!this._loaded) this.setData({ loading: true })
    try {
      const [user, list] = await Promise.all([dbApi.getMyUser(force), dbApi.listSalary(force)])
      const payday = (user && user.payday) || 15
      const np = util.nextPayday(payday)
      const npDays = util.daysBetween(util.todayStr(), util.fmtDate(np))
      const year = new Date().getFullYear()
      const yearTotal = list
        .filter((s) => (s.payDate || '').startsWith(String(year)))
        .reduce((s, x) => s + (x.amount || 0), 0)

      const fmtList = list.map((s) => ({
        ...s,
        amountText: util.moneyThousand(s.amount),
        dateText: s.payDate
      }))

      this._loaded = true
      this.setData({
        user,
        list: fmtList,
        loading: false,
        yearTotal: util.moneyThousand(yearTotal),
        countdown: { days: npDays, date: util.fmtDate(np), isToday: npDays === 0, payday }
      })
    } catch (e) {
      this._loaded = true
      this.setData({ loading: false })
      console.error('加载工资失败', e)
      wx.showToast({ title: '加载失败，请下拉重试', icon: 'none' })
    }
  },

  /* ---------- 发薪日设置（一次设置，之后可改） ---------- */
  openPayday() {
    if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null }
    const payday = (this.data.user && this.data.user.payday) || 15
    util.openSheet(this, 'showPayday', { formPayday: payday })
  },

  closePayday() {
    this._closeTimer = util.closeSheet(this, 'showPayday')
  },

  onPaydayChange(e) {
    this.setData({ formPayday: Number(e.detail.value) + 1 })
  },

  async savePayday() {
    if (this.data.saving) return
    this.setData({ saving: true })
    try {
      await dbApi.updateMyUser({ payday: this.data.formPayday })
      wx.showToast({ title: '发薪日已更新', icon: 'success' })
      util.closeSheet(this, 'showPayday')
      this.loadData()
    } catch (e) {
      wx.showToast({ title: '保存失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  /* ---------- 新增 ---------- */
  openForm() {
    if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null }
    // 日期自动带出最近一次发薪日，不用每次选
    const payday = (this.data.user && this.data.user.payday) || 15
    const lastPay = util.lastPayday(payday)
    util.openSheet(this, 'showForm', {
      formDate: util.fmtDate(lastPay),
      formAmount: '',
      formNote: ''
    })
  },

  closeForm() {
    this._closeTimer = util.closeSheet(this, 'showForm')
  },

  noop() {},

  onDateChange(e) {
    this.setData({ formDate: e.detail.value })
  },

  onAmountInput(e) {
    this.setData({ formAmount: e.detail.value })
  },

  onNoteInput(e) {
    this.setData({ formNote: e.detail.value })
  },

  async saveSalary() {
    const { formDate, formAmount, formNote } = this.data
    const amount = Number(formAmount)
    if (!formDate) {
      wx.showToast({ title: '请选择日期', icon: 'none' })
      return
    }
    if (!amount || amount <= 0) {
      wx.showToast({ title: '请输入正确金额', icon: 'none' })
      return
    }
    if (this.data.saving) return
    this.setData({ saving: true })
    try {
      await dbApi.addSalary({ payDate: formDate, amount, note: formNote.trim() })
      wx.showToast({ title: '已记录', icon: 'success' })
      util.closeSheet(this, 'showForm')
      this.loadData()
    } catch (e) {
      wx.showToast({ title: '保存失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  /* ---------- 删除 ---------- */
  removeSalary(e) {
    const { id, date, amount } = e.currentTarget.dataset
    wx.showModal({
      title: '删除记录',
      content: `确定删除 ${date} 的 ¥${amount} 吗？删除后可在回收站恢复（保留 30 天）。`,
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await dbApi.removeSalary(id)
          wx.showToast({ title: '已移入回收站', icon: 'success' })
          this.loadData()
        } catch (err) {
          wx.showToast({ title: '删除失败', icon: 'none' })
        }
      }
    })
  }
})
