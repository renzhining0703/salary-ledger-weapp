const util = require('../../utils/util')
const dbApi = require('../../utils/db')
const config = require('../../utils/config')
const themeUtil = require('../../utils/theme')

Page({
  data: {
    list: [],
    loading: true,
    recycleDays: config.RECYCLE_DAYS
  },

  onShow() {
    util.checkLock()
    themeUtil.applyToPage(this)
    this.loadData()
  },

  /** 外观偏好 / 系统主题变化时由 app 统一回调 */
  applyTheme() {
    themeUtil.applyToPage(this)
  },

  async onPullDownRefresh() {
    try {
      await this.loadData(true)
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  async loadData() {
    const app = getApp()
    await app.ready()
    if (!this._loaded) this.setData({ loading: true })
    try {
      const raw = await dbApi.listRecycle()
      const now = Date.now()
      const list = raw.map((d) => {
        const ts = d.deletedAt ? new Date(d.deletedAt).getTime() : 0
        const daysLeft = Math.max(0, 30 - Math.floor((now - ts) / 86400000))
        // 按类型组装标题与金额
        let typeText = '开销'
        let typeClass = 'tag-gray'
        let title = d.note || d.name || ''
        let amountText = d.amount ? util.moneyThousand(d.amount) : ''
        if (d._col === 'salary') {
          typeText = '工资'
          typeClass = 'tag-blue'
          title = `到账 ${d.payDate || ''}`
        } else if (d._col === 'cards') {
          typeText = '信用卡'
          typeClass = 'tag-gold'
          title = d.bank || ''
        } else if (d._col === 'recurring') {
          typeText = '固定支出'
          typeClass = 'tag-gold'
          title = d.name || ''
        } else {
          title = `${d.date || ''} ${d.note || d.category || ''}`
        }
        return {
          ...d,
          typeText,
          typeClass,
          title: title.trim(),
          amountText,
          deletedAtText: ts ? util.fmtDate(new Date(ts)) : '-',
          daysLeft
        }
      })
      this._loaded = true
      this.setData({ list, loading: false })
    } catch (e) {
      this._loaded = true
      this.setData({ loading: false })
      console.error('加载回收站失败', e)
      wx.showToast({ title: util.errTip(e, '加载失败，请下拉重试'), icon: 'none' })
    }
  },

  async restoreItem(e) {
    const { col, id, title } = e.currentTarget.dataset
    try {
      await dbApi.restoreDoc(col, id)
      wx.showToast({ title: '已恢复', icon: 'success' })
      this.loadData()
    } catch (err) {
      console.error('恢复失败', err)
      wx.showToast({ title: '恢复失败', icon: 'none' })
    }
  },

  destroyItem(e) {
    const { col, id, title } = e.currentTarget.dataset
    wx.showModal({
      title: '彻底删除',
      content: `「${title}」将被永久删除，无法恢复。确定吗？`,
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await dbApi.destroyDoc(col, id)
          wx.showToast({ title: '已彻底删除', icon: 'success' })
          this.loadData()
        } catch (err) {
          wx.showToast({ title: '删除失败', icon: 'none' })
        }
      }
    })
  },

  clearAll() {
    if (!this.data.list.length) return
    wx.showModal({
      title: '清空回收站',
      content: `将永久删除回收站里的 ${this.data.list.length} 条记录，无法恢复。确定吗？`,
      confirmText: '清空',
      confirmColor: '#ef4444',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await dbApi.clearRecycle()
          wx.showToast({ title: '已清空', icon: 'success' })
          this.loadData()
        } catch (err) {
          wx.showToast({ title: '操作失败', icon: 'none' })
        }
      }
    })
  }
})
