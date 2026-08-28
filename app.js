/**
 * 薪账本 - 小程序入口
 * 云开发环境: cloud1-8gembxhfa18dcf14
 * AppID: wx7326e353b2996845
 */
const config = require('./utils/config')

App({
  globalData: {
    openid: '',
    user: null,
    env: config.CLOUD_ENV,
    loginReady: false,
    lastUnlockTs: 0, // 最近一次成功解锁/设置的时间戳,守卫用
    theme: 'light' // 系统主题 'light' | 'dark'
  },

  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({
        title: '提示',
        content: '当前微信版本过低，无法使用云能力，请升级微信后重试。',
        showCancel: false
      })
      return
    }
    wx.cloud.init({
      env: config.CLOUD_ENV,
      traceUser: true
    })
    // 主题检测（必须早于首屏渲染前完成）
    this.syncTheme()
    wx.onThemeChange(({ theme }) => {
      this.globalData.theme = theme || 'light'
      this.applyNavBarColor()
    })
    this.loginPromise = this.silentLogin().catch((e) => {
      console.error('静默登录异常', e)
    })
    // 冷启动也过一遍隐私锁检查（ready 后再判定）
    this.checkPrivacyLock()
    // 回收站过期清理（>30 天的软删数据物理删除），静默执行不阻塞
    this.loginPromise.then(() => {
      const dbApi = require('./utils/db')
      dbApi.purgeExpired().catch((e) => console.error('回收站清理异常', e))
    })
  },

  onHide() {
    // 保留钩子以便后续需要(例如统计时长);不再用于守卫判断
  },

  onShow() {
    // 每次回到前台再同步一次主题(系统设置可能在后台被改)
    this.syncTheme()
    this.applyNavBarColor()
    this.checkPrivacyLock()
    // 自动落账扫描：当月已扫过则跳过,避免每次切 tab 都查库
    this.maybeSweepAutoRecord()
  },

  /**
   * 自动落账扫描(防抖到「当月」粒度)
   * - 必须在 loginPromise 完成后再调(否则 db 查询未授权)
   * - 失败静默 log,不打扰用户
   * - 同一月内多次 onShow 只查一次(用户每天切回 App 都触发 onShow)
   */
  maybeSweepAutoRecord() {
    if (!this.loginPromise) return
    this.loginPromise.then(() => {
      const d = new Date()
      const thisMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      if (this.globalData._lastAutoSweepMonth === thisMonth) return
      this.globalData._lastAutoSweepMonth = thisMonth
      const dbApi = require('./utils/db')
      dbApi.sweepAutoRecord()
        .then((r) => {
          if (r && r.swept > 0) {
            console.log(`自动落账完成:${r.swept} 笔 (${r.thisMonth})`)
          }
        })
        .catch((e) => console.error('自动落账扫描异常', e))
    })
  },

  /** 读取系统主题并写入 globalData */
  syncTheme() {
    try {
      const info = (wx.getWindowInfo && wx.getWindowInfo()) || wx.getSystemInfoSync()
      this.globalData.theme = info && info.theme === 'dark' ? 'dark' : 'light'
    } catch (e) {
      this.globalData.theme = 'light'
    }
  },

  /**
   * 同步导航栏颜色到当前主题
   * 深色模式:背景 #0E1620 文字 #E8EDF3
   * 浅色模式:背景 #F3F5F8 文字 #151E2B
   */
  applyNavBarColor() {
    const dark = this.globalData.theme === 'dark'
    wx.setNavigationBarColor({
      frontColor: dark ? '#ffffff' : '#000000',
      backgroundColor: dark ? '#0E1620' : '#F3F5F8',
      animation: { duration: 0, timingFunc: 'linear' }
    })
  },

  /**
   * 隐私锁守卫：开启后冷启动、或切后台回来、或超过 60 秒没解锁,需重新解锁。
   * 解锁本身在 pages/lock/lock 完成。Tab 页 onShow 也调用 util.checkLock() 拦截。
   */
  async checkPrivacyLock() {
    await this.ready()
    const u = this.globalData.user
    if (!u || !u.privacyLock || u.privacyLock === 'off') return
    // 60 秒内解锁过的不打扰
    if (Date.now() - (this.globalData.lastUnlockTs || 0) < 60 * 1000) return
    // 已在锁页则不重复跳
    const pages = getCurrentPages()
    const cur = pages[pages.length - 1]
    if (cur && cur.route === 'pages/lock/lock') return
    wx.reLaunch({ url: '/pages/lock/lock' })
  },

  /**
   * 等待登录完成（最多 wait ms）。
   * 登录失败也放行：所有数据查询依赖云端按 _openid 自动隔离，不阻塞页面加载。
   */
  ready(wait = 3000) {
    return Promise.race([
      this.loginPromise,
      new Promise((resolve) => setTimeout(resolve, wait))
    ])
  },

  /** 无感静默登录：云函数直接识别 openid，无需授权弹窗 */
  async silentLogin() {
    try {
      const res = await wx.cloud.callFunction({ name: 'login' })
      const openid = res.result && res.result.openid
      if (!openid) throw new Error('login 云函数返回异常')
      this.globalData.openid = openid

      const db = wx.cloud.database()
      const userRes = await db.collection('users').where({ openid }).get()
      if (userRes.data.length === 0) {
        await this.initUser(openid)
      } else {
        this.globalData.user = userRes.data[0]
      }
      this.globalData.loginReady = true
    } catch (e) {
      console.error('静默登录失败', e)
      wx.showToast({ title: '登录失败，请重新进入小程序', icon: 'none' })
    }
  },

  /**
   * 首次进入：创建用户配置 + 预置示例数据
   * 覆盖近 3 个月（工资/开销/还款），8 月造超支用于演示预算预警
   * 数据仅写入当前用户 openid 下，多用户互不可见
   */
  async initUser(openid) {
    const db = wx.cloud.database()
    const now = new Date()
    const y = now.getFullYear()
    const m = now.getMonth()
    const today = new Date(y, m, now.getDate())
    const dayOf = (d) => d.getDate()
    const monthStr = (offset) => {
      const d = new Date(y, m + offset, 1)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    }
    const fmt = (offset, dd) => `${monthStr(offset)}-${String(dd).padStart(2, '0')}`
    const M0 = monthStr(0)   // 本月
    const M1 = monthStr(-1)  // 上月
    const M2 = monthStr(-2)  // 上上月

    // 用户配置：默认每月 15 号发薪、月预算 4000
    const userDoc = {
      openid,
      nickname: '',
      avatarUrl: '',
      payday: 15,
      budget: 4000,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
    const userAdd = await db.collection('users').add({ data: userDoc })
    this.globalData.user = { _id: userAdd._id, ...userDoc }

    // 示例数据开关：开发联调开启，正式上线前在 config.js 改为 false（新用户从零开始）
    if (!config.DEMO_DATA) return

    const tomorrow = new Date(today.getTime() + 86400000)
    const yesterday = new Date(today.getTime() - 86400000)

    // 工资：近 3 个月各一条
    const demoSalary = [
      { payDate: fmt(0, 15), amount: 12500, note: '本月工资', demo: true },
      { payDate: fmt(-1, 15), amount: 12000, note: '上月工资', demo: true },
      { payDate: fmt(-2, 15), amount: 11800, note: '上月工资', demo: true }
    ]

    // 信用卡：2 张本月待还（明天/昨天到期）+ 3 张历史已还（带 repayDate 归月）
    const demoCards = [
      { bank: '招行信用卡', repayDay: dayOf(tomorrow), amount: 3500, status: 'pending', note: '演示：明天还款', demo: true },
      { bank: '交行信用卡', repayDay: dayOf(yesterday), amount: 1200, status: 'pending', note: '演示：已逾期', demo: true },
      { bank: '工行信用卡', repayDay: dayOf(today), amount: 800, status: 'paid', repayDate: fmt(0, dayOf(today)), note: '演示：本月已还', demo: true },
      { bank: '建行信用卡', repayDay: 20, amount: 1800, status: 'paid', repayDate: fmt(-1, 20), note: '演示：上月已还', demo: true },
      { bank: '中行信用卡', repayDay: 15, amount: 2600, status: 'paid', repayDate: fmt(-2, 15), note: '演示：上上月已还', demo: true }
    ]

    // 开销：本月超预算（演示预警），上月接近预算，上上月正常
    const demoExpenses = [
      // 本月（约 4465，超预算 4000 → 首页红色预警）
      { date: fmt(0, dayOf(today)), category: '餐饮', amount: 12, note: '早餐', demo: true },
      { date: fmt(0, dayOf(today)), category: '交通', amount: 8, note: '地铁', demo: true },
      { date: fmt(0, dayOf(today)), category: '孩子', amount: 45, note: '给孩子买文具', demo: true },
      { date: fmt(0, dayOf(yesterday)), category: '居住', amount: 200, note: '水电费', demo: true },
      { date: fmt(0, 20), category: '购物', amount: 800, note: '换季衣服', demo: true },
      { date: fmt(0, 18), category: '孩子', amount: 2500, note: '课外班', demo: true },
      { date: fmt(0, 10), category: '餐饮', amount: 900, note: '请客吃饭', demo: true },
      // 上月（3920，接近预算）
      { date: fmt(-1, 5), category: '餐饮', amount: 1200, note: '日常三餐', demo: true },
      { date: fmt(-1, 12), category: '餐饮', amount: 350, note: '聚餐', demo: true },
      { date: fmt(-1, 8), category: '交通', amount: 150, note: '加油', demo: true },
      { date: fmt(-1, 16), category: '孩子', amount: 800, note: '课外班', demo: true },
      { date: fmt(-1, 20), category: '居住', amount: 950, note: '水电物业', demo: true },
      { date: fmt(-1, 24), category: '购物', amount: 260, note: '日用品', demo: true },
      { date: fmt(-1, 27), category: '其他', amount: 210, note: '话费', demo: true },
      // 上上月（3000，正常）
      { date: fmt(-2, 3), category: '餐饮', amount: 900, note: '日常三餐', demo: true },
      { date: fmt(-2, 9), category: '交通', amount: 120, note: '地铁', demo: true },
      { date: fmt(-2, 15), category: '孩子', amount: 700, note: '玩具', demo: true },
      { date: fmt(-2, 20), category: '居住', amount: 800, note: '水电物业', demo: true },
      { date: fmt(-2, 24), category: '购物', amount: 380, note: '衣服', demo: true },
      { date: fmt(-2, 28), category: '其他', amount: 100, note: '话费', demo: true }
    ]

    const tasks = [
      db.collection('salary').add({ data: demoSalary[0] }),
      db.collection('salary').add({ data: demoSalary[1] }),
      db.collection('salary').add({ data: demoSalary[2] }),
      ...demoCards.map((c) => db.collection('cards').add({ data: c })),
      ...demoExpenses.map((e) => db.collection('expenses').add({ data: e }))
    ]
    await Promise.all(tasks)
  }
})
