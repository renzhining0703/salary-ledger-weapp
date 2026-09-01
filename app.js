/**
 * 薪账本 - 小程序入口
 * 云开发环境: cloud1-8gembxhfa18dcf14
 * AppID: wx7326e353b2996845
 */
const config = require('./utils/config')
const chatStorage = require('./utils/chatStorage')
const themeUtil = require('./utils/theme')

// 全局注入 preventTouchmove：所有页面默认拥有该方法，
// 供 .mask / .sheet 的 catchtouchmove 绑定，阻止弹框滚动穿透到底部页面。
// 组件需在其自己的 methods 中声明同名方法（见 ai-chat-sheet）。
const originalPage = Page
Page = function (options = {}) {
  if (typeof options.preventTouchmove !== 'function') {
    options.preventTouchmove = function () {}
  }
  return originalPage(options)
}

App({
  globalData: {
    openid: '',
    user: null,
    env: config.CLOUD_ENV,
    loginReady: false,
    lastUnlockTs: 0, // 最近一次成功解锁/设置的时间戳,守卫用
    theme: 'light', // 系统主题 'light' | 'dark'
    themeMode: 'system', // 外观偏好 'system' | 'light' | 'dark'（我的页可改）
    // 账本君对话状态(首页 chat sheet + 记账页账单 sheet 内 chat 共用)
    // 冷启动从 storage 恢复最近 50 条,会话跨启动延续(撤销临时字段已在 save 时剥离)
    chatMessages: chatStorage.load(),
    chatInput: '',
    chatSending: false,
    // 首页「+」记账按钮置 true,记账页 onShow 消费后置 false
    quickExpense: false,
    // 订阅消息(salaryReminder)点击进入时,onShow 透传到首页 → 自动打开账本君 sheet
    pendingAiQuestionFromNotif: false
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
    // 外观偏好冷启动从 storage 恢复（不等云端 user，保证首帧就用上手动指定主题）
    try {
      this.globalData.themeMode = themeUtil.normalize(wx.getStorageSync('themeMode'))
    } catch (e) { /* storage 异常时维持默认 system */ }
    wx.onThemeChange(({ theme }) => {
      this.globalData.theme = theme || 'light'
      // 仅「跟随系统」模式需要联动刷新；手动指定时生效主题不变
      if ((this.globalData.themeMode || 'system') !== 'system') return
      this.applyNavBarColor()
      this.applyTabBar()
      this.notifyPagesThemeChange()
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

  onShow(options) {
    // 每次回到前台再同步一次主题(系统设置可能在后台被改)
    this.syncTheme()
    this.applyNavBarColor()
    this.applyTabBar()
    this.checkPrivacyLock()
    // 自动落账扫描：当月已扫过则跳过,避免每次切 tab 都查库
    this.maybeSweepAutoRecord()
    // 订阅消息(salary_reminder)点击进入,透传 query 到首页消费
    if (options && options.query && options.query.from === 'salary_reminder') {
      this.globalData.pendingAiQuestionFromNotif = true
    }
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

  /** 最终生效主题：手动指定优先，否则跟随系统（canvas / chrome 统一取这个） */
  resolvedTheme() {
    const mode = this.globalData.themeMode || 'system'
    if (mode === 'dark' || mode === 'light') return mode
    return this.globalData.theme === 'dark' ? 'dark' : 'light'
  },

  /**
   * 同步导航栏颜色到生效主题（普通页：信用卡/回收站/锁）
   * 浅色模式:背景 #FFFFFF 文字黑色;深色模式:背景 #283A52(与自定义导航栏 --navy-800 同色)文字白色
   * 4 个 tab 页已改 navigationStyle: custom，本调用仅对普通页生效。
   */
  applyNavBarColor() {
    const dark = this.resolvedTheme() === 'dark'
    wx.setNavigationBarColor({
      frontColor: dark ? '#ffffff' : '#000000',
      backgroundColor: dark ? '#283A52' : '#FFFFFF',
      animation: { duration: 0, timingFunc: 'linear' },
      fail: () => { /* 自定义导航页无系统导航栏，忽略 */ }
    })
  },

  /**
   * 同步 tabBar 颜色到生效主题。
   * app.json 的 theme.json @变量只跟随系统，手动指定深/浅时需 JS 覆盖；
   * 颜色与 theme.json 保持一致。非 tabBar 页调用会 fail，静默忽略。
   */
  applyTabBar() {
    const dark = this.resolvedTheme() === 'dark'
    wx.setTabBarStyle({
      color: dark ? '#6E7B8E' : '#ADA294',
      selectedColor: dark ? '#E5C26B' : '#2B2620',
      backgroundColor: dark ? '#1A2532' : '#FBF7F0',
      borderStyle: dark ? 'black' : 'white',
      fail: () => { /* 非 tabBar 页忽略 */ }
    })
  },

  /**
   * 切换外观偏好（我的页 picker 调用）：
   * storage + globalData 立即生效，并同步 chrome（导航栏/tabBar）
   * 与当前页面栈（页面各自 applyTheme 刷根节点 class / 重绘 canvas）。
   * 云端持久化由调用方负责（updateMyUser({ themeMode })）。
   */
  setThemeMode(mode) {
    this.globalData.themeMode = themeUtil.setMode(mode)
    this.applyNavBarColor()
    this.applyTabBar()
    this.notifyPagesThemeChange()
  },

  /** 通知页面栈内所有页面刷新主题呈现（页面实现 applyTheme 即可） */
  notifyPagesThemeChange() {
    getCurrentPages().forEach((p) => {
      if (p && typeof p.applyTheme === 'function') p.applyTheme()
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
        // 跨设备同步外观偏好：本地仍是默认「跟随系统」时采纳云端配置
        // （本地已手动指定则信本地——本机的修改一定也写过云端，只是可能有写入失败/延迟）
        if ((this.globalData.themeMode || 'system') === 'system') {
          const cloudMode = themeUtil.normalize(userRes.data[0].themeMode)
          if (cloudMode !== 'system') this.setThemeMode(cloudMode)
        }
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

    // 用户配置：发薪日 0=未设置（新用户从空态引导开始）；示例数据用户视作已设置（完整体验）
    // 存量老用户 payday 保持原值不动，仅新用户从 0 开始（设计稿 v3 数据链路整改）
    const userDoc = {
      openid,
      nickname: '',
      avatarUrl: '',
      payday: config.DEMO_DATA ? 15 : 0,
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
      { payDate: fmt(-2, 15), amount: 11800, note: '上上月工资', demo: true }
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
