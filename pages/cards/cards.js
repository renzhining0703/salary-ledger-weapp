const util = require('../../utils/util')
const dbApi = require('../../utils/db')
const config = require('../../utils/config')

Page({
  data: {
    list: [],
    loading: true,
    summary: null,
    showForm: false,
    showEdit: false,
    saving: false,
    repayDayRange: Array.from({ length: 31 }, (_, i) => i + 1),
    billDayRange: ['不设置'].concat(Array.from({ length: 31 }, (_, i) => i + 1)),
    formBank: '',
    formRepayDay: 25,
    formBillDay: 0,
    formAmount: '',
    formNote: '',
    editId: '',
    editBank: '',
    editAmount: '',
    editRepayDay: 25,
    editBillDay: 0
  },

  onShow() {
    util.checkLock()
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
      const cards = await dbApi.listCards(force)
      const today = util.todayStr()
      const thisMonth = util.thisMonthStr()
      const fmtList = cards.map((c) => {
        const dueDate = util.calcDueDate(c.repayDay, c.status)
        const days = util.daysBetween(today, dueDate)
        let level = 'ok'
        let daysText = ''
        if (c.status === 'paid') {
          level = 'paid'
          daysText = `下期 ${dueDate} 还款`
        } else if (days < 0) {
          level = 'overdue'
          daysText = `已逾期 ${-days} 天（${dueDate}）`
        } else if (days === 0) {
          level = 'today'
          daysText = '今天还款'
        } else if (days === 1) {
          level = 'tomorrow'
          daysText = '明天还款'
        } else {
          daysText = `${days} 天后（${dueDate}）`
        }
        // 账单周期信息：账单日 + 免息期（设置了账单日才展示）
        let billCycleText = ''
        if (c.billDay) {
          const ifd = util.interestFreeDays(c.billDay, c.repayDay)
          billCycleText = `账单日每月 ${c.billDay} 号${ifd > 0 ? ` · 最长免息 ${ifd} 天` : ''}`
        }
        return {
          ...c,
          amountText: util.moneyThousand(c.amount),
          repayDayText: `每月 ${c.repayDay} 号`,
          dueDateText: dueDate,
          daysText,
          billCycleText,
          level
        }
      })

      // 顶部账单汇总：本期待还 / 最近到期 / 本月已还
      const pendingList = fmtList.filter((c) => c.status === 'pending')
      const totalPending = pendingList.reduce((s, c) => s + (c.amount || 0), 0)
      const paidThisMonth = fmtList
        .filter((c) => c.status === 'paid' && (c.repayDate || '').startsWith(thisMonth))
        .reduce((s, c) => s + (c.amount || 0), 0)
      const dueList = pendingList
        .map((c) => ({ bank: c.bank, days: util.daysBetween(today, c.dueDateText) }))
        .filter((c) => c.days >= 0)
        .sort((a, b) => a.days - b.days)
      const next = dueList[0]
      const summary = {
        totalText: util.moneyThousand(totalPending),
        count: pendingList.length,
        paidText: util.moneyThousand(paidThisMonth),
        nextText: next ? (next.days === 0 ? '今天' : `${next.days} 天后`) : '暂无待还',
        urgent: !!(next && next.days <= 3)
      }

      this._loaded = true
      this.setData({ list: fmtList, summary, loading: false })
    } catch (e) {
      this._loaded = true
      this.setData({ loading: false })
      console.error('加载信用卡失败', e)
      wx.showToast({ title: util.errTip(e, '加载失败，请下拉重试'), icon: 'none' })
    }
  },

  /* ---------- 新增 ---------- */
  openForm() {
    if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null }
    util.openSheet(this, 'showForm', { formBank: '', formRepayDay: 25, formBillDay: 0, formAmount: '', formNote: '' })
  },

  closeForm() {
    this._closeTimer = util.closeSheet(this, 'showForm')
  },

  onBankInput(e) {
    this.setData({ formBank: e.detail.value })
  },

  onRepayChange(e) {
    this.setData({ formRepayDay: Number(e.detail.value) + 1 })
  },

  onBillChange(e) {
    this.setData({ formBillDay: Number(e.detail.value) })
  },

  onAmountInput(e) {
    this.setData({ formAmount: e.detail.value })
  },

  onNoteInput(e) {
    this.setData({ formNote: e.detail.value })
  },

  async saveCard() {
    const { formBank, formRepayDay, formBillDay, formAmount, formNote } = this.data
    const amount = Number(formAmount)
    if (!formBank.trim()) {
      wx.showToast({ title: '请填写卡名', icon: 'none' })
      return
    }
    if (!amount || amount <= 0) {
      wx.showToast({ title: '请输入应还金额', icon: 'none' })
      return
    }
    if (this.data.saving) return
    this.setData({ saving: true })
    try {
      await dbApi.addCard({
        bank: formBank.trim(),
        repayDay: formRepayDay,
        billDay: formBillDay || 0,
        amount,
        status: 'pending',
        note: formNote.trim()
      })
      wx.showToast({ title: '已添加', icon: 'success' })
      util.closeSheet(this, 'showForm')
      this.loadData()
    } catch (e) {
      wx.showToast({ title: '保存失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  /* ---------- 标记已还 ---------- */
  async markPaid(e) {
    const id = e.currentTarget.dataset.id
    try {
      // 一并写一条分类=还款的流水,让记账 Tab 自然看到这笔还款
      const r = await dbApi.recordCardRepayment(id)
      if (r && r.dup) {
        wx.showToast({ title: '已标记还款', icon: 'success' })
      } else {
        // 产生了新流水 → 失效当月 AI 解读缓存,避免账本君基于旧数据说话
        dbApi.invalidateFinCache(util.thisMonthStr())
        wx.showToast({ title: '已记账', icon: 'success' })
      }
      this.loadData()
    } catch (err) {
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  /* ---------- 编辑账单（金额 / 还款日 / 账单日） ---------- */
  openEdit(e) {
    if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null }
    const { id, bank, amount, repayDay, billDay } = e.currentTarget.dataset
    util.openSheet(this, 'showEdit', {
      editId: id,
      editBank: bank,
      editAmount: String(amount),
      editRepayDay: repayDay || 25,
      editBillDay: billDay || 0
    })
  },

  closeEdit() {
    this._closeTimer = util.closeSheet(this, 'showEdit')
  },

  onEditAmountInput(e) {
    this.setData({ editAmount: e.detail.value })
  },

  onEditRepayChange(e) {
    this.setData({ editRepayDay: Number(e.detail.value) + 1 })
  },

  onEditBillChange(e) {
    this.setData({ editBillDay: Number(e.detail.value) })
  },

  async saveEdit() {
    const { editId, editAmount, editRepayDay, editBillDay } = this.data
    const amount = Number(editAmount)
    if (!amount || amount <= 0) {
      wx.showToast({ title: '请输入正确金额', icon: 'none' })
      return
    }
    if (this.data.saving) return
    this.setData({ saving: true })
    try {
      // 新一期账单：更新金额与周期，重置为待还
      await dbApi.updateCard(editId, {
        amount,
        repayDay: editRepayDay,
        billDay: editBillDay || 0,
        status: 'pending'
      })
      wx.showToast({ title: '已更新', icon: 'success' })
      util.closeSheet(this, 'showEdit')
      this.loadData()
    } catch (e) {
      wx.showToast({ title: '保存失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  /* ---------- 删除 ---------- */
  removeCard(e) {
    const { id, bank } = e.currentTarget.dataset
    wx.showModal({
      title: '删除卡片',
      content: `确定删除「${bank}」吗？删除后可在回收站恢复（保留 ${config.RECYCLE_DAYS} 天）。`,
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await dbApi.removeCard(id)
          wx.showToast({ title: '已移入回收站', icon: 'success' })
          this.loadData()
        } catch (err) {
          wx.showToast({ title: '删除失败', icon: 'none' })
        }
      }
    })
  }
})
