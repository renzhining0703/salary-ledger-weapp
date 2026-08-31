const config = require('../../utils/config')
const util = require('../../utils/util')
const dbApi = require('../../utils/db')
const chatStorage = require('../../utils/chatStorage')

/**
 * 「我的」页：设置中心。
 * 方法自 pages/index/index.js 平移而来（业务逻辑原样），仅去掉了弹层
 * （showProfile sheet）相关的开合适配 —— 本页是独立 tab 页，无弹层。
 */
Page({
  data: {
    user: {},
    saving: false,
    recycleDays: config.RECYCLE_DAYS,
    privacyOptions: ['关闭', '手势图案', '指纹解锁'],
    privacyIndex: 0,
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
    editSaving: false
  },

  onShow() {
    util.checkLock()
    this.loadUser()
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
      privacyIndex: this.privacyIndexOf(u && u.privacyLock)
    })
  },

  privacyIndexOf(mode) {
    return mode === 'gesture' ? 1 : mode === 'finger' ? 2 : 0
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

  /* ---------- 回收站 ---------- */
  openRecycle() {
    wx.navigateTo({ url: '/pages/recycle/recycle' })
  },

  /* ---------- 编辑资料半屏弹层：头像 + 昵称，一次性保存 ---------- */
  /**
   * 打开编辑资料弹层：用当前顶部展示的 formAvatar / formNickname 初始化。
   * 注意：选头像（onChooseEditAvatar）只更新 editAvatar 预览，不立即上传；
   * 点保存按钮（saveEditProfile）时才统一上传头像 + 一次性 updateMyUser。
   */
  openEditProfile() {
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
          wx.showToast({ title: '已重置', icon: 'success' })
          this.loadUser()
        } catch (e) {
          wx.showToast({ title: '重置失败', icon: 'none' })
        }
      }
    })
  }
})
