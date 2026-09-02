const config = require('../../utils/config')
const util = require('../../utils/util')
const dbApi = require('../../utils/db')
const chatStorage = require('../../utils/chatStorage')
const themeUtil = require('../../utils/theme')

/**
 * 账本君首次打招呼(空聊天时自动展示一次)。
 * 简洁自我介绍 + 能力清单 + 引导示例问题,让用户知道能问什么。
 * 用换行让排版清晰,bubble 样式 white-space:pre-wrap 已经支持。
 */
const WELCOME_MESSAGE = `你好,我是账本君,你的 AI 财务助理 

我能基于你真实的记账数据,帮你:
• 看收支、找超支的分类
• 给具体的规划建议(数字都来自你的账)
• 查具体某笔开销

试试问:
「这个月哪个分类花最多?」
「我该如何规划下个月开销?」`

Page({
  data: {
    user: null,
    todoList: [],
    boardMonth: '',          // 当前查看的月份，如 2026-08
    board: null,             // 月度结余看板
    daily: null,             // 今日指南·日均可花（仅当前月）
    streak: null,            // 今日指南·连续记账（仅当前月）
    boardAiSub: '',          // 「账本君说」副文案（距发薪 · 连续记账，本地拼装）
    boardAiState: '',        // 「账本君说」空态状态机：''=隐藏(历史月) welcome=全新用户 first=已设发薪日未记账 unset=缺发薪日 normal=正常
    aiReminders: [],         // AI 待办提醒（信用卡还款/发薪日），首页优先展示 + chat sheet 预设消息
    aiShakeOn: false,        // 头像抖动开关：仅提醒类未读时 true，进首页抖 2 次即停（CSS 动画播完静止）
    briefUnread: false,      // 每日 board-brief（"今天可以放心花…"）未读：角标提示，看过当天不再弹
    paydaySet: false,        // 发薪日是否已显式设置（payday>0；账本君 AI 数据块也用）
    hasRecorded: false,      // 是否记过账（有收支记录；账本君 AI 数据块也用）
    budgetAlert: null,       // 预算预警 { type: 'over'|'warn', text }
    budgetOver: false,       // 预算已超(账本君 AI 数据块用)
    budgetNear: false,       // 预算接近上限 ≥80%(账本君 AI 数据块用)
    repayHint: null,         // 场景开场白用:还款日 ≤3 天里最紧急的一张 { days, bank, amount }
    // 账单分享卡片
    showShare: false,
    showShareClosing: false,
    shareImagePath: '',
    shareBusy: false,
    // 最优还款顺序（≥3 张未还卡时显示入口卡）
    optimalPreview: null,    // { pendingCount, subText, first: { bank, amountText, dueText } }
    optimalFull: null,       // { pendingCount, order: [], savedInterestText }
    showOptimalSheet: false,
    showOptimalSheetClosing: false,
    // 账本君 AI 助理 chat sheet(公共组件 components/ai-chat-sheet,交互逻辑在组件内)
    showAiChat: false,
    aiStmt: null,            // 发送时取的 statement blob(组件 stmt 属性,_buildAiStmt 产出)
    chatStorage: { last: [], shown: false },  // 上次会话摘要(冷启动展示)
    recentExpenses: [],      // 给 aiChat.send 用,本月最近流水
    lastRecordGap: null,     // 距上次记账天数(0=今天记过;仅当前月,账本君断记提醒用)
    aiCards: [],             // 未还卡实时摘要(账本君逐卡明细用;画像里的信用卡是 24h 汇总)
    aiSubscriptions: [],     // T2.4 订阅摘要(账本君数据块自带;_buildAiStmt 派生 active+top10+年化)
    recurringList: [],       // 固定支出模板(账本君「本月待记」用,fire-and-forget 拉取)
    // 账本君主动询问(云函数 salaryReminder 推送后写入,本地兜底在 chatStorage)
    pendingAiQuestion: null,           // { text, ts, round }
    aiUnread: 0,                       // 入口卡未读红点计数(单条询问 = 1)
    showAiAskPrompt: false            // 首次进入 sheet 引导用户订阅的提示卡
  },

  onLoad() {
    // 自定义导航栏（navigationStyle: custom）：状态栏高度需 JS 注入
    this.setData({ statusBarHeight: wx.getWindowInfo().statusBarHeight || 44 })
  },

  onShow(options) {
    util.checkLock()
    // 外观偏好 / 系统主题刷新根节点 class + 窗口背景
    themeUtil.applyToPage(this)
    // 头像抖动重播：先摘掉 class，loadData 完成后重新挂上 →
    // CSS 动画按「class 从无到有」触发，每次进入首页都能抖一次（切 tab 回来也算）
    this.setData({ aiShakeOn: false })
    // 写操作置脏标记策略(评审项:启动性能):
    // dbApi 所有写操作(invalidate 统一入口)会置 globalData.dataDirty,
    // onShow 仅脏时 force 重查;不脏则吃 60s TTL 缓存(batchHomeRead 命中时 0 云调用),
    // 切 tab 回首页不再每次全量重查。脏标记先复位再加载——若本次加载失败,
    // 缓存同样没写进去(invalidate 时已清),下次 onShow 缓存 miss 自然重查,不会卡旧数据。
    // 例外:账本君云函数写库不经过 dbApi → chat 的 refresh 事件显式 force(见 onAiChatRefresh)
    const app = getApp()
    const dirty = !!(app.globalData && app.globalData.dataDirty)
    if (dirty) app.globalData.dataDirty = false
    this.loadData(dirty)

    // 账本君主动询问:不论是否从订阅消息进入,都先加载未读问题
    // (订阅消息点击场景:app.js onShow 写 globalData.pendingAiQuestionFromNotif=true,
    //  此处消费后自动打开 sheet;普通进入场景只 load,展示红点但不打扰)
    this._loadPendingQuestion()
    const fromNotif = (options && options.query && options.query.from === 'salary_reminder') ||
                       getApp().globalData.pendingAiQuestionFromNotif
    if (fromNotif) {
      getApp().globalData.pendingAiQuestionFromNotif = false
      // 用户从推送点进来 → 直接打开 sheet 让他看到气泡
      this.goAskAI()
    }
  },

  /**
   * 从本地 chatStorage 读取账本君未回应询问。
   * 仅展示/计数,**不清除**(用户主动 dismiss 或发送消息才清),
   * 这样关闭 sheet 后下次进入仍能看到气泡,直到他回应为止。
   * 例外:发出超 48h 未回应的询问视为过期,自动清除——
   * 否则会永久占位,堵住还款/预算的主动开场白(goAskAI 里 !pendingQ 才开讲)。
   */
  _loadPendingQuestion() {
    const q = chatStorage.loadPendingQuestion()
    if (q && util.isPendingQExpired(q)) {
      chatStorage.clearPendingQuestion()
      this.setData({ pendingAiQuestion: null, aiUnread: 0 })
      return
    }
    this.setData({
      pendingAiQuestion: q,
      aiUnread: q ? 1 : 0
    })
  },

  onHide() {
    // 切走页面时停掉趋势图动画，避免后台空转
    if (this._trendAnimId && this._trendCanvas && this._trendCanvas.cancelAnimationFrame) {
      this._trendCanvas.cancelAnimationFrame(this._trendAnimId)
      this._trendAnimId = null
    }
  },

  onUnload() {
    // 聊天撤销倒计时 timer 已随公共组件 detached 自动清理,页面无需处理
  },

  /**
   * 外观偏好或系统主题变化时由 app 统一回调（app.onThemeChange / setThemeMode）：
   * 刷根节点 class（CSS 变量子树覆盖）+ 重绘趋势图（canvas 颜色不跟随 CSS 变量）。
   */
  applyTheme() {
    themeUtil.applyToPage(this)
    this.drawTrend()
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
      // reconcile=true：云端全量重算 expAgg 并回写（对账修复快照漂移）
      await this.loadData(true, true)
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  /**
   * 首页数据加载（方案B+C：单次批量读 + 月度支出快照）：
   *
   * 阶段1（首屏，1 次云函数调用）：batchHomeRead 在服务端并行取回
   *   用户/卡片/工资/本月支出/近12月区间支出 + expAgg（月度支出聚合快照）
   *   → 立即渲染看板、待还、预算预警、趋势图、日均可花。
   *   有快照时「累计可用余额」由快照按月求和直接得出——任意历史月都精确，
   *   原来的 36 个月区间大查询（阶段2缺口补查）彻底消灭。
   *
   * 阶段2（仅降级路径）：云端未部署新版 dbRead（降级为 5 个单项读）或快照缺失时，
   *   退回方案A 行为——12 个月窗口近似 + 后台补查窗口外缺口修正余额。
   *
   * reconcile：下拉刷新传 true → 云端全量重算 expAgg 并回写（对账，
   *   修复写路径增量维护失败造成的快照漂移）。onShow 不传，靠增量维护保持新鲜。
   *
   * 竞态：切月/下拉刷新/标记已还会并发触发 loadData，用 _loadSeq 序号，
   *  旧一轮（尤其阶段2晚到的补查）直接丢弃，不覆盖新一轮数据。
   */
  async loadData(force, reconcile) {
    const app = getApp()
    await app.ready()
    const seq = (this._loadSeq || 0) + 1
    this._loadSeq = seq
    try {
      const month = this.data.boardMonth || util.thisMonthStr()
      const trendStart = this.shiftMonth(month, -11)
      // 方案B：5 查合并为 1 次云函数调用（服务端并行，客户端省 4 次网络往返）
      const batch = await dbApi.batchHomeRead(month, trendStart, force, reconcile)
      if (seq !== this._loadSeq) return // 已有更新的一轮加载，丢弃本轮
      const user = batch.user
      const cards = batch.cards
      const salaryList = batch.salary
      const expenses = batch.expenses
      const trendExpenses = batch.trend
      const expAgg = batch.expAgg || null

      const today = util.todayStr()
      const thisMonth = util.thisMonthStr()

      // 今天要处理：逾期/今天/明天 的待还卡 + 同期订阅续费(T1.5 合并成「待办账务」)
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
          type: 'card',
          bank: c.bank,
          amount: util.moneyThousand(c.amount),
          days,
          dueText,
          level,
          canPay: true
        })
      })
      // 订阅续费待办(T1.5):active 且 nextCharge 落在「已过扣费日 / 今天 / 明天」—— 「已扣费·未取消」是断舍离钩子
      // 仅取最近 2 条进首页区块,避免与还款项混排刷屏;其余进订阅页查看
      // 期限包(custom 周期)+ 非 wechat/alipay/apple 渠道:不走自动扣费,文案用「到期/已过期·未续费」
      const AUTO_CHANNEL = ['wechat', 'alipay', 'apple']
      const subs = (batch.subscriptions || []).filter((s) => s.status === 'active' && s.nextCharge)
      const subTodos = []
      subs.forEach((s) => {
        const days = util.daysBetween(today, s.nextCharge)
        const isTermPack = s.cycle === 'custom' && !AUTO_CHANNEL.includes(s.payChannel || '')
        let level = ''
        let dueText = ''
        if (days < 0) {
          level = 'overdue'
          dueText = isTermPack ? '已过期·未续费' : '已扣费·未取消'
        } else if (days === 0) {
          level = 'today'
          dueText = isTermPack ? '今天到期' : '今天扣费'
        } else if (days === 1) {
          level = 'tomorrow'
          dueText = isTermPack ? '明天到期' : '明天扣费'
        } else {
          return
        }
        subTodos.push({
          id: s._id,
          type: 'sub',
          name: s.name,
          platform: s.platform || '',
          amount: util.moneyThousand(s.amount || 0),
          nextCharge: s.nextCharge,
          days,
          dueText,
          level,
          canPay: false
        })
      })
      // 订阅只取最近 2 条(days 最小者,断舍离钩子优先),按 days 升序
      subTodos.sort((a, b) => a.days - b.days)
      const subTop = subTodos.slice(0, 2)
      todoList.push(...subTop)
      // 按到期天数升序统一混排:逾期 N 天 → 今天 → 明天(更靠前越紧急);订阅也用 days 字段参与
      todoList.sort((a, b) => a.days - b.days)

      // 场景开场白用:还款日 ≤3 天(含逾期)里最紧急的一张
      // (todoList 只覆盖逾期/今天/明天,这里补齐 2-3 天的,取 days 最小者)
      let repayHint = null
      cards.forEach((c) => {
        if (c.status === 'paid') return
        const dueDate = util.calcDueDate(c.repayDay, 'pending')
        const days = util.daysBetween(today, dueDate)
        if (days <= 3 && (!repayHint || days < repayHint.days)) {
          repayHint = { days, bank: c.bank, amount: c.amount }
        }
      })

      // 账本君逐卡实时明细(仅未还卡):画像里的信用卡是 24h 缓存汇总,还完款当天 AI 仍当未还
      const aiCards = cards
        .filter((c) => c.status !== 'paid')
        .map((c) => ({
          bank: c.bank || '',
          amount: c.amount || 0,
          days: util.daysBetween(today, util.calcDueDate(c.repayDay, 'pending'))  // 负=逾期天数
        }))

      // T2.4 订阅摘要(账本君数据块自带):active + nextCharge 按时间升序 + top10 + 老数据 payChannel 兜底
      const aiSubscriptions = (batch.subscriptions || [])
        .filter((s) => s.status === 'active' && s.nextCharge)
        .slice()
        .sort((a, b) => (a.nextCharge || '').localeCompare(b.nextCharge || ''))
        .slice(0, 10)
        .map((s) => ({
          name: s.name || '',
          platform: s.platform || '',
          payChannel: s.payChannel || 'unknown',  // 老数据无此字段兜底
          amount: Number(s.amount) || 0,
          cycle: s.cycle || 'monthly',
          usage: s.usage || '',
          nextCharge: s.nextCharge || ''
        }))

      // 多卡最优还款顺序(纯函数,无副作用)。<3 张未还时给 null,入口卡不显示
      this._computeOptimal(cards, today)

      // 月度结余看板：收入/支出/结余（按查看月份）
      // 还款并入支出：标记已还会写一条 category=还款 的流水，已含在 expenses 里，不再单独扣减
      const income = salaryList
        .filter((s) => (s.payDate || '').startsWith(month))
        .reduce((s, x) => s + (x.amount || 0), 0)
      const expense = expenses.reduce((s, x) => s + (x.amount || 0), 0)

      // 累计可用余额（滚动结转）：截至查看月末「全部收入 − 全部支出」
      // 解决发薪日≠月初导致跨月结余断裂：8/15 工资的剩余会结转到 9 月看板
      const cumIncome = salaryList
        .filter((s) => (s.payDate || '').slice(0, 7) <= month)
        .reduce((s, x) => s + (x.amount || 0), 0)
      // 【方案C】月度支出快照：users.expAgg 按月求和 → 精确累计支出
      // （含 12 个月窗口外的老账，查看任意历史月都准确）
      // 历史月份用快照，本月用实际 expense（避免快照漂移导致累计余额不准）
      const snapCum = expAgg
        ? Object.keys(expAgg)
            .filter((m) => m < month)
            .reduce((s, m) => s + expAgg[m], 0) + expense
        : null
      // 【降级路径】无快照（云端旧版 dbRead / 快照回填失败）时退回方案A：
      // 12 个月窗口内近似，窗口外缺口由阶段2后台补查修正
      const cumExpense = snapCum != null
        ? snapCum
        : trendExpenses
            .filter((x) => (x.date || '').slice(0, 7) <= month)
            .reduce((s, x) => s + (x.amount || 0), 0)
      // 漂移检测（仅诊断 warn，数字以快照为准）：快照窗口内合计 vs 刚实拉的 12 个月数据
      // 对不上（差 ≥1 分）→ 写路径增量维护出过岔子，下拉刷新（reconcile 对账）即修复
      if (snapCum != null) {
        const winSnap = Object.keys(expAgg)
          .filter((m) => m >= trendStart && m <= month)
          .reduce((s, m) => s + expAgg[m], 0)
        const winReal = trendExpenses
          .filter((x) => (x.date || '').slice(0, 7) >= trendStart)
          .reduce((s, x) => s + (x.amount || 0), 0)
        if (Math.abs(Math.round(winSnap * 100) - Math.round(winReal * 100)) >= 1) {
          console.warn(`[loadData] 支出快照疑似漂移：窗口内快照 ¥${winSnap.toFixed(2)} vs 实拉 ¥${winReal.toFixed(2)}，下拉刷新可对账修复`)
        }
      }
      // 阶段2缺口补查的回溯起点（仅降级路径用；有快照时置为 trendStart → 阶段2不触发）
      let earliestMonth = trendStart
      if (snapCum == null) {
        const salaryMonths = salaryList
          .map((s) => (s.payDate || '').slice(0, 7))
          .filter(Boolean)
        const earliestSalaryMonth = salaryMonths.length ? [...salaryMonths].sort()[0] : ''
        const bound36 = this.shiftMonth(month, -36)
        // 保守回溯 36 个月，防止「先记支出、后记工资」导致前期支出被漏算
        earliestMonth = earliestSalaryMonth && earliestSalaryMonth < bound36
          ? earliestSalaryMonth
          : bound36
      }
      const available = cumIncome - cumExpense      // 可用余额（含历史结转，阶段1近似值）
      const monthBalance = income - expense         // 本月收支差
      const carriedOver = available - monthBalance // 上月结转进来的金额

      const balance = available  // 主数字语义改为「可用余额」
      const board = {
        month,
        monthText: `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`,
        isThisMonth: month === thisMonth,
        income: util.moneyThousand(income),
        expense: util.moneyThousand(expense),
        balance: util.moneyThousand(Math.abs(available)),
        balancePositive: available >= 0,
        // 结转提示（wxml 显示「含上月结转 ¥X」）
        carriedOver,
        carriedOverText: util.moneyThousand(Math.abs(carriedOver)),
        carriedOverPositive: carriedOver >= 0,
        showCarry: Math.abs(carriedOver) >= 0.005,
        // 动画用原始数值
        _incomeNum: income,
        _expenseNum: expense,
        _balanceNum: Math.abs(available),
        _availableNum: available,
        _monthBalanceNum: monthBalance
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
      // 账本君 AI 数据块用(首页 _buildAiStmt 读取):预算状态标志
      const budgetOver = !!(budgetAlert && budgetAlert.type === 'over')
      const budgetNear = !!(budgetAlert && budgetAlert.type === 'warn')

      // 今日指南：日均可花 + 连续记账（语义基于「今天」，仅当前月展示）
      let daily = null
      let streak = null
      let lastRecordGap = null   // 距上次记账天数(0=今天记过):账本君断记提醒用
      // 「账本君说」空态状态机（设计稿 v3 §2）：payday 判定看用户是否显式设置（>0），不按默认 15 兜底
      const paydaySet = !!(user && user.payday)
      const hasRecorded = cumIncome > 0 || cumExpense > 0

      // AI 待办提醒：首页 board-ai 优先展示 + chat sheet 预设消息
      // 覆盖信用卡还款（≤7 天）和发薪日（≤3 天），按紧急程度排序
      const aiReminders = []
      // 信用卡还款提醒
      cards.forEach((c) => {
        if (c.status === 'paid') return
        const dueDate = util.calcDueDate(c.repayDay, 'pending')
        const days = util.daysBetween(today, dueDate)
        if (days <= 7) {
          const amt = util.moneyThousand(c.amount)
          let detail
          if (days < 0) {
            detail = `⚠️ 你的 ${c.bank} 卡款已逾期 ${-days} 天，¥${amt} 还没还。逾期会影响征信，今天赶紧处理吧！`
          } else if (days === 0) {
            detail = `⚠️ 今天有 ${c.bank} 的卡款要还，¥${amt}。记得还款，别逾期。`
          } else {
            detail = `📌 ${days} 天后有 ${c.bank} 的卡款要还，¥${amt}。提前把钱备好，别到时候手忙脚乱。`
          }
          aiReminders.push({
            type: 'credit',
            days,
            title: days < 0 ? `${c.bank} 已逾期 ${-days} 天` : (days === 0 ? `今天有${c.bank}要还` : `${days}天后有${c.bank}要还`),
            detail
          })
        }
      })
      // 发薪日提醒（≤3 天，且已设置）
      if (paydaySet && user && user.payday > 0) {
        const nextPay = util.nextPayday(user.payday, util.parseDate(today))
        const daysToPay = util.daysBetween(today, util.fmtDate(nextPay))
        if (daysToPay >= 0 && daysToPay <= 3) {
          aiReminders.push({
            type: 'payday',
            days: daysToPay,
            title: daysToPay === 0 ? '今天发薪' : `${daysToPay}天后发薪`,
            detail: `💰 ${daysToPay === 0 ? '今天' : daysToPay + '天后'}是发薪日，记得确认工资到账。`
          })
        }
      }
      aiReminders.sort((a, b) => a.days - b.days)
      // 今日已读：用户打开过 chat sheet 看到提醒 → 首页恢复日常文案、角标隐藏
      if (chatStorage.isReminderRead(today)) aiReminders.length = 0

      let boardAiState = ''
      if (month === thisMonth) {
        daily = util.calcDailyBudget({
          available,
          expense,
          budget,
          payday: (user && user.payday) || 0,
          today
        })
        // 连续记账：复用 trendExpenses（近12个月，覆盖90天窗口），零额外查询
        const cutoff = util.offsetDate(today, -89)
        const recentDates = trendExpenses
          .map((x) => x.date)
          .filter((d) => d && d >= cutoff)
        streak = util.calcStreak(recentDates, today)
        // 距上次记账天数:recentDates 顺序无保证,取最大日期与今天的差(0=今天记过)
        if (recentDates.length) {
          const lastDate = recentDates.reduce((a, b) => (a > b ? a : b))
          lastRecordGap = Math.max(0, util.daysBetween(lastDate, today))
        }
        if (!hasRecorded && !paydaySet) boardAiState = 'welcome'   // S1 全新用户
        else if (!hasRecorded) boardAiState = 'first'              // S2 已设发薪日，待记首笔
        else if (!paydaySet) boardAiState = 'unset'                // S3 有记录但缺发薪日（估算口径）
        else boardAiState = 'normal'                               // S4 正常
      }

      // 近 12 个月收支趋势（随看板查看月份滚动；趋势图只画最近 6 个月，账本君数据块用全量 12 个月）
      const trendMonths = []
      for (let i = 11; i >= 0; i--) trendMonths.push(this.shiftMonth(month, -i))
      const trend = trendMonths.map((m) => {
        const inc = salaryList
          .filter((s) => (s.payDate || '').startsWith(m))
          .reduce((s, x) => s + (x.amount || 0), 0)
        const exp = trendExpenses
          .filter((x) => (x.date || '').startsWith(m))
          .reduce((s, x) => s + (x.amount || 0), 0)
        return { month: m, label: `${Number(m.slice(5, 7))}月`, income: inc, expense: exp, balance: inc - exp }
      })
      const trendEmpty = trend.every((t) => !t.income && !t.expense && !t.balance)

      // 工资询问:云端 users.unreadQuestion(salaryReminder 云函数写入) → 同步到本地 storage
      // (断链修复:此前 _loadPendingQuestion 只读本地 chatStorage,本地从未被写入,
      //  导致红点与询问气泡永远不显示。loadData 拉到 user 后补上这一步同步)
      if (user && user.unreadQuestion) {
        const uq = user.unreadQuestion
        if (util.isPendingQExpired(uq)) {
          // 过期询问(48h 未回应):顺手清云端,避免下次加载又同步回来
          dbApi.updateMyUser({ unreadQuestion: null, unreadQuestionCount: 0 }).catch(() => {})
        } else if (!chatStorage.loadPendingQuestion()) {
          chatStorage.savePendingQuestion({ text: uq.text, ts: uq.ts, round: uq.round || 1 })
        }
      }
      const localPendingQ = chatStorage.loadPendingQuestion()

      this.setData({
        user,
        todoList,
        repayHint,
        boardMonth: month,
        board,
        daily,
        streak,
        lastRecordGap,
        aiCards,
        aiSubscriptions,
        boardAiSub: this._buildBoardAiSub(daily, streak, boardAiState, (user && user.payday) || 0),
        boardAiState,
        // 每日 brief 未读：账本君今天有话说（且非空态外的提醒优先场景），看过一次当天不再弹
        briefUnread: !!boardAiState && !chatStorage.isBriefRead(today),
        aiReminders,
        // 有提醒类未读才抖头：briefUnread/aiUnread 只是静默角标（呼吸脉冲），不召唤
        aiShakeOn: aiReminders.length > 0,
        paydaySet,
        hasRecorded,
        budgetAlert,
        budgetOver,
        budgetNear,
        trend,
        trendEmpty,
        // 工资询问气泡 + 入口红点(以本地为准;云端未同步到本地时保持现状)
        pendingAiQuestion: localPendingQ,
        aiUnread: localPendingQ ? 1 : 0,
        // 账本君 AI 用:本月分类统计 + 最近 60 条明细
        catStats: this._buildCatStats(expenses, expense),
        recentExpenses: expenses.slice(0, 60)  // 列表按时间倒序(最新在前),前 60 条=最近;多存点,发送前再截 top20
      })

      // 固定支出模板(60s 缓存):账本君「本月待记固定支出」用;fire-and-forget 不阻塞首页渲染
      dbApi.listRecurring()
        .then((list) => {
          if (seq === this._loadSeq) this.setData({ recurringList: list || [] })
        })
        .catch(() => {})

      if (!trendEmpty) {
        setTimeout(() => this.drawTrend(), 80)
      }

      // 数字滚动动画
      this._cancelAnim && this._cancelAnim.forEach((fn) => fn())
      this._cancelAnim = [
        util.animateNumber(this, 'board.income', income, { duration: 700, decimals: 2, thousand: true, prefix: '¥' }),
        util.animateNumber(this, 'board.expense', expense, { duration: 700, decimals: 2, thousand: true, prefix: '¥' }),
        util.animateNumber(this, 'board.balance', Math.abs(balance), { duration: 800, decimals: 2, thousand: true, prefix: '¥' })
      ]

      /* ---------- 阶段2（仅降级路径）：窗口外支出补查 ----------
       * 有快照（snapCum != null）时余额已精确求和，本段不触发（earliestMonth = trendStart）。
       * 仅无快照时退回方案A：earliestMonth 恒 ≤ bound36 < trendStart，
       * 只要记账起点早于 12 个月窗口就补查「缺口区间 [earliestMonth, trendStart 前一月]」，
       * 不重复拉已取回的 12 个月数据，且完全不阻塞首屏渲染。
       */
      if (snapCum == null && earliestMonth < trendStart) {
        const gapEnd = this.shiftMonth(trendStart, -1)
        const gapExpenses = await dbApi.listExpensesRange(earliestMonth, gapEnd, force)
        if (seq !== this._loadSeq) return // 切月/刷新已开启新一轮加载，丢弃本轮晚到的补查
        if (gapExpenses.length >= 999) {
          console.warn('[loadData] 缺口区间支出接近 1000 条上限，累计结余可能不准确')
        }
        const extra = gapExpenses
          .filter((x) => (x.date || '').slice(0, 7) <= month)
          .reduce((s, x) => s + (x.amount || 0), 0)
        if (Math.abs(extra) >= 0.005) {
          const available2 = available - extra
          const carried2 = available2 - monthBalance
          // 阶段1的 balance 动画可能仍在跑：先取消再重放，
          // 否则动画帧会把 setData 进来的修正值又覆盖回旧目标值
          this._cancelAnim && this._cancelAnim.forEach((fn) => fn())
          this._cancelAnim = [
            util.animateNumber(this, 'board.balance', Math.abs(available2), { duration: 400, decimals: 2, thousand: true, prefix: '¥' })
          ]
          this.setData({
            board: {
              ...this.data.board,
              balancePositive: available2 >= 0,
              carriedOver: carried2,
              carriedOverText: util.moneyThousand(Math.abs(carried2)),
              carriedOverPositive: carried2 >= 0,
              showCarry: Math.abs(carried2) >= 0.005,
              _balanceNum: Math.abs(available2),
              _availableNum: available2
            },
            // 日均可花依赖可用余额，同步修正（仅当前月有值）
            daily: month === thisMonth
              ? util.calcDailyBudget({
                  available: available2,
                  expense,
                  budget,
                  payday: (user && user.payday) || 0,
                  today
                })
              : this.data.daily
          })
        }
      }
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

  /** 一键标记已还（流水 / 卡片状态 / 还款 history 都在 db.recordCardRepayment 内统一完成） */
  async markPaid(e) {
    const id = e.currentTarget.dataset.id
    try {
      const r = await dbApi.recordCardRepayment(id)
      if (r && !r.dup) {
        // 产生了新流水 → 失效当月 AI 解读缓存,避免账本君基于旧数据说话
        dbApi.invalidateFinCache(util.thisMonthStr())
        wx.showToast({ title: '已记账', icon: 'success' })
      } else {
        wx.showToast({ title: '已标记还款', icon: 'success' })
      }
      this.loadData()
    } catch (err) {
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  /**
   * 待办账务行点击(T1.5)
   * - type='card':标记已还(同 markPaid 逻辑,但 bindtap 走这里避免与外层点击事件冲突)
   * - type='sub':整条跳订阅页(无内联按钮,用户感受是「看一眼就跳走」)
   */
  onTodoTap(e) {
    const item = e.currentTarget.dataset.item
    if (!item) return
    if (item.type === 'sub') {
      wx.navigateTo({ url: '/pages/subscriptions/subscriptions' })
    } else {
      // type=card:走标记已还(原有 markPaid 行为)
      this.markPaid({ currentTarget: { dataset: { id: item.id } } })
    }
  },

  /**
   * 「待办账务」区块头的二级入口：跳订阅续费管理页(T1.5)。
   * wxml 用 catchtap 调起,与整块点击分离(虽然此处区块没有外层 bindtap,但 catchtap 写法保持统一)
   */
  goSubscriptions() {
    wx.navigateTo({ url: '/pages/subscriptions/subscriptions' })
  },

  /* ---------- 记一笔快捷入口 ---------- */
  quickExpense() {
    getApp().globalData.quickExpense = true
    wx.switchTab({ url: '/pages/expenses/expenses' })
  },

  /**
   * 场景化开场白：打开聊天时，今天有紧急财务场景 → 账本君主动抛一句（纯模板，不走 LLM）
   * 优先级：还款（逾期 > 今天 > 1-3 天）> 预算（已超 > ≥80%），一次只挑最紧急的一条
   * 同一天同一场景只说一次（chatStorage 按日期去重，避免每次打开都重复唠叨）
   * @returns {{ key: 'repay'|'budget', text: string } | null}
   */
  _buildActiveHint() {
    const today = util.todayStr()
    const hints = chatStorage.loadHints(today)
    const repay = this.data.repayHint
    const alert = this.data.budgetAlert
    const daily = this.data.daily

    // 还款类 —— 最紧急（逾期 / 今天 / 1-3 天）
    if (repay && repay.days <= 3 && !hints.repay) {
      const amt = util.moneyThousand(repay.amount)
      let text
      if (repay.days < 0) {
        text = `⚠️ 你的 ${repay.bank} 卡款已逾期 ${-repay.days} 天，¥${amt} 还没还。逾期会影响征信，今天赶紧处理吧！`
      } else if (repay.days === 0) {
        text = `⚠️ 今天有 ${repay.bank} 的卡款要还，¥${amt}。记得还款，别逾期。`
      } else {
        text = `📌 ${repay.days} 天后有 ${repay.bank} 的卡款要还，¥${amt}。提前把钱备好，别到时候手忙脚乱。`
      }
      return { key: 'repay', text }
    }

    // 预算类（已超 > 达 80%）
    if (alert && !hints.budget) {
      let text
      if (alert.type === 'over') {
        text = `⚠️ ${alert.text}。要不要我帮你看看超在哪、怎么调整？`
      } else {
        const dailyTip = daily && daily.amount > 0
          ? `按现在的节奏，今天最多还能花 ¥${daily.amountText}。`
          : ''
        text = `📌 ${alert.text}。${dailyTip}`
      }
      return { key: 'budget', text }
    }

    return null
  },

  /**
   * 「账本君说」副文案（按空态状态机分支，设计稿 v3 §2）
   * - welcome：引导设置发薪日（绝不显示默认 15 推算的「距发薪」）
   * - first：确认发薪日已设置，引导记首笔
   * - unset：估算口径说明 + 去设置（不放默认值推算数据）
   * - normal：距发薪 X 天 · 连续记账（streak.text 自带引导话术，直接复用）
   * @param {{ paydayToday: boolean, daysToPayday: number } | null} daily
   * @param {{ text: string } | null} streak
   * @param {string} aiState boardAiState
   * @param {number} payday 用户发薪日（>0 已设置）
   * @returns {string}
   */
  _buildBoardAiSub(daily, streak, aiState, payday) {
    if (aiState === 'welcome') return '设置发薪日，开始规划每天能花多少'
    if (aiState === 'first') return `发薪日已设为每月 ${payday} 日`
    if (aiState === 'unset') return '按本月剩余天数估算 · 设置发薪日更准'
    if (!daily) return ''
    const pay = daily.paydayToday ? '今天是发薪日' : `距发薪 ${daily.daysToPayday} 天`
    return streak ? `${pay} · ${streak.text}` : pay
  },

  /**
   * 看板「账本君说」区块点击：由 daily/streak/状态机本地模板拼开场白后打开 chat sheet。
   * 保证 sheet 里账本君"必有所言"，且内容和看板区块一字对应（承诺与兑现同源）。
   * 空态（welcome/first/unset）同样有开场白——新用户点进来账本君先自我介绍/引导。
   */
  tapBoardAI() {
    const daily = this.data.daily
    const streak = this.data.streak
    const state = this.data.boardAiState
    const payday = (this.data.user && this.data.user.payday) || 0
    // 日期前缀（"今天9月1号"）：让每日一句有时间锚点，跨天看消息不混淆
    const t = util.todayStr().split('-')
    const datePrefix = `今天${Number(t[1])}月${Number(t[2])}号，`
    let opening = ''
    if (state === 'welcome') {
      opening = '你好，我是账本君，你的贴身记账管家。先设置一个发薪日，我就能帮你规划每天能花多少、盯预算、管还款。想记一笔、查个账，直接跟我说就行。'
    } else if (state === 'first') {
      opening = `发薪日已设为每月 ${payday} 日。记一笔工资，我就能算出你的日均可花，开始第一份收支规划。想记一笔、查个账，直接跟我说就行。`
    } else if (daily) {
      if (daily.zeroTip === '可用余额不足') {
        opening = `${datePrefix}手头有点紧——可用余额不足了，先省着花。`
      } else if (daily.zeroTip) {
        opening = `${datePrefix}本月预算已用完，先记账再消费，别让账目断档。`
      } else if (state === 'unset') {
        opening = `${datePrefix}按你的余额和本月剩余天数，今天可以放心花 ¥${daily.amountText}。设置发薪日后，我能算得更准。`
      } else {
        opening = `${datePrefix}按你的余额和节奏，今天可以放心花 ¥${daily.amountText}。`
      }
      const sub = this._buildBoardAiSub(daily, streak, state, payday)
      if (sub) opening += `${sub}。`
      opening += '想记一笔、查个账，直接跟我说就行。'
    }
    this.goAskAI(opening)
  },

  /**
   * 「账本君说」空态引导按钮（welcome/unset 的「去设置」）：
   * 与整块点击分离（catchtap 阻断冒泡），直达工资页并自动弹发薪日设置弹层。
   * 与 quickExpense 同模式：globalData 标志位 + 目标页 onShow 消费。
   */
  goSetPayday() {
    getApp().globalData.autoOpenPayday = true
    wx.switchTab({ url: '/pages/salary/salary' })
  },

  /**
   * 首页「问问账本君」入口：直接弹首页 chat sheet(不跳页)。
   * - 从 chatStorage 恢复上次会话摘要(热启动);本次会话已有消息则不展示摘要
   * - 首次打开(空聊天 + 无历史摘要 + 未欢迎过)→ 自动插入一条助手欢迎消息,
   *   介绍自己 + 列出能力 + 给示例问题,帮用户知道能问什么
   * - openingLine(tapBoardAI 传入)→ 追加「账本君说」开场消息(本地模板)，
   *   此时跳过欢迎消息(开场即数据，比自我介绍更切题)
   */
  goAskAI(openingLine) {
    const stored = chatStorage.loadSummary()
    const app = getApp()
    const today = util.todayStr()
    const reminders = this.data.aiReminders || []

    // 如果有 AI 待办提醒且今日未读，先作为预设消息写入 chatMessages（所有入口统一处理）
    if (reminders.length > 0 && !chatStorage.isReminderRead(today)) {
      let messages = app.globalData.chatMessages || []
      // 幂等：移除旧的 ai-reminder 和 board-brief，避免重复堆叠和顺序错乱
      messages = messages.filter((m) => m.source !== 'ai-reminder' && m.source !== 'board-brief')
      reminders.forEach((r) => {
        messages.push({
          role: 'assistant',
          content: r.detail,
          ts: Date.now(),
          source: 'ai-reminder'
        })
      })
      app.globalData.chatMessages = messages.slice()
      chatStorage.markReminderRead(today)
      chatStorage.markHintShown(today, 'repay')
      // 立即清空页面 data：chat sheet 是页内弹层，关闭不触发 onShow/loadData，
      // 不主动 setData 的话角标和提醒文案要等下次刷新才消失
      this.setData({ aiReminders: [], aiShakeOn: false })
      // 有提醒时，日常 board-brief 让位（提醒本身就是开场白）
      openingLine = null
    }

    let messages = app.globalData.chatMessages.slice()
    // 询问过期(发出超48h未回应)自动清除,让位给还款/预算主动开场白
    // (onShow 的 _loadPendingQuestion 已清过一次,这里兜底,防止跨页面进入时残留)
    // 注意:setData 是异步的,this.data 不会立即更新,必须直接用局部变量置 null,
    //   否则下方 `if (!pendingQ || repayUrgent)` 仍拿到旧值,开场白被误跳过
    let pendingQ = this.data.pendingAiQuestion
    if (pendingQ && util.isPendingQExpired(pendingQ)) {
      chatStorage.clearPendingQuestion()
      pendingQ = null
      this.setData({ pendingAiQuestion: null, aiUnread: 0 })
    }

    // 主动询问气泡去重:同一条 question 已经塞过就不再塞
    // (避免用户关闭-重开 sheet 时堆叠重复气泡)
    if (pendingQ && !messages.find((m) => m.isPendingQuestion && m.ts === pendingQ.ts)) {
      const questionBubble = {
        role: 'assistant',
        content: pendingQ.text,
        ts: pendingQ.ts,
        source: 'bot-question',
        isPendingQuestion: true,
        pendingRound: pendingQ.round
      }
      messages = [questionBubble, ...messages]
      app.globalData.chatMessages = messages.slice()
    }

    // 场景化开场白:今天有紧急财务场景(还款≤3天 / 预算超 80%)→ 账本君主动抛一句(纯模板不走 LLM)
    // 互斥:有未回应的工资询问时通常跳过(一次只主动讲一件事,避免气泡堆叠)。
    // 例外——还款逾期/今天(days<=0)比工资询问更紧急(征信风险),开场白照常插入,
    //   工资询问气泡保留在下方,两件都让用户看到。
    // 注意:开场白必须「追加到消息末尾」——打开 sheet 会自动滚到底部,
    //   插在顶部会被历史消息埋没(用户只看到底部),而且 markHintShown 已经写入,
    //   同天再打开被去重挡住,提醒就永远消失了。追加末尾=打开即见,符合聊天心智。
    const repayUrgent = !!(this.data.repayHint && this.data.repayHint.days <= 0)
    if (!pendingQ || repayUrgent) {
      const hint = this._buildActiveHint()
      if (hint) {
        messages = [...messages, {
          role: 'assistant',
          content: hint.text,
          ts: Date.now(),
          source: 'active-hint'
        }]
        chatStorage.markHintShown(util.todayStr(), hint.key)
        app.globalData.chatMessages = messages.slice()
      }
    }

    // 「账本君说」开场(tapBoardAI 传入)：与看板区块文案同源，本地模板不走 LLM、零延迟。
    // 每日一次：当天看过即不再主动弹出(高频重复会招人烦)，跨天金额变了再展示。
    // 已读时 openingLine 整体丢弃——sheet 只展示历史消息，保持安静。
    if (openingLine) {
      if (!chatStorage.isBriefRead(today)) {
        messages = messages.filter((m) => m.source !== 'board-brief')
        messages = [...messages, {
          role: 'assistant',
          content: openingLine,
          ts: Date.now(),
          source: 'board-brief'
        }]
        app.globalData.chatMessages = messages.slice()
        chatStorage.markBriefRead(today)
        // 立即清角标：页内弹层关闭不触发 onShow/loadData，须主动 setData
        this.setData({ briefUnread: false })
      }
      // 当天已读 → 不注入不标记，briefUnread 由 loadData 计算时已为 false
    }

    // 首次打开 + 空聊天 + 未欢迎过 → 自动插入欢迎消息
    // (注意:有询问气泡时不再插欢迎消息,以免两条 assistant 气泡堆叠;
    //  带 openingLine 时也跳过——board-brief 已是更切题的开场)
    if (
      !openingLine &&
      messages.length === 0 &&
      stored.length === 0 &&
      !chatStorage.isWelcomed()
    ) {
      messages = [{
        role: 'assistant',
        content: WELCOME_MESSAGE,
        ts: Date.now(),
        source: 'local'
      }]
      chatStorage.markWelcomed()
      app.globalData.chatMessages = messages.slice()
    }

    // 首次引导卡:进入 sheet 时,如果用户还没订阅,提示一次
    // (有询问气泡时不再提示 — 说明已经订阅过,无需打扰)
    const user = app.globalData.user || {}
    const showAiAskPrompt = !pendingQ && user.salaryRemindSubscribed !== true

    const hasCurrent = messages.length > 0
    // 会话注入已同步进 globalData,组件 show 观察者会拉取;
    // 页面只负责 slot 卡片(询问气泡/订阅引导/上次摘要)与 aiStmt 数据源
    this.setData({
      showAiChat: true,
      aiStmt: this._buildAiStmt(),
      chatStorage: {
        last: stored,
        shown: !hasCurrent && stored.length > 0
      },
      showAiAskPrompt,
      // 进入 sheet 即清未读红点(用户已经看见入口)
      aiUnread: 0
    })
  },

  /** 组件播完关闭动画后回调:卸载 sheet + 趋势图 canvas 随 wx:if 重建需重绘 */
  onAiChatClose() {
    this.setData({ showAiChat: false })
    this.redrawTrendAfterPopup()
  },

  /**
   * 清空会话(组件 clear 事件):核心数据(globalData/storage/组件态)组件内已清,
   * 页面只清页面级状态 + 云端未读字段。
   */
  onAiChatClear() {
    dbApi.updateMyUser({ unreadQuestion: null, unreadQuestionCount: 0 }).catch(() => {})
    this.setData({
      chatStorage: { last: [], shown: false },
      pendingAiQuestion: null,
      aiUnread: 0
    })
  },

  /**
   * 发送前副作用(组件 beforesend 事件):
   * - 用户回应了账本君的主动询问 → 清掉未读状态（本地 + 云端；失败静默，下次 cron 重置）
   * - 隐藏「上次会话」摘要（本次已开始新提问）
   */
  onAiChatBeforeSend() {
    if (this.data.pendingAiQuestion) {
      chatStorage.clearPendingQuestion()
      dbApi.updateMyUser({ unreadQuestion: null, unreadQuestionCount: 0 }).catch(() => {})
      this.setData({ pendingAiQuestion: null })
    }
    this.setData({ chatStorage: { ...this.data.chatStorage, shown: false } })
  },

  /**
   * 记账/撤销后刷新(组件 refresh 事件):
   * 云函数写库不触发 dbApi 缓存失效,必须 force;同时重建 aiStmt 让下一问拿到新数据。
   */
  async onAiChatRefresh() {
    await this.loadData(true)
    if (this.data.showAiChat) {
      this.setData({ aiStmt: this._buildAiStmt() })
    }
  },

  /**
   * 从本月 expenses 算出分类占比,给账本君 AI 用
   * 输出形如 [{ name, amount, percent, over }],over 标志用于预算对比
   */
  _buildCatStats(expenses, totalExpense) {
    const byCat = {}
    ;(expenses || []).forEach((x) => {
      const k = x.category || '其他'
      byCat[k] = (byCat[k] || 0) + (x.amount || 0)
    })
    const budgetMap = (this.data.user && this.data.user.budgets) || {}
    return Object.keys(byCat)
      .map((name) => {
        const amount = byCat[name]
        const percent = totalExpense > 0 ? Math.round((amount / totalExpense) * 100) : 0
        const b = budgetMap[name]
        const over = typeof b === 'number' && b > 0 && amount > b
        return { name, amount, percent, over }
      })
      .sort((a, b) => b.amount - a.amount)
  },

  /**
   * 从首页已有数据构造 stmt,供 aiChat.send 使用
   * 不依赖 expenses 的 _buildStatementData,首页独立可用
   */
  _buildAiStmt() {
    const board = this.data.board || {}
    const viewMonth = this.data.boardMonth || util.thisMonthStr()
    const catStats = this.data.catStats || []
    const recentList = this.data.recentExpenses || []

    // 当日已支出:仅查看当前月时聚合(recentExpenses 是查看月流水,历史月不含今天,
    // 恒 0 会误导 AI 说「今天没花钱」);历史月传 null 让云端跳过
    let todayExpense = null
    let todayExpenseCount = 0
    if (viewMonth === util.thisMonthStr()) {
      const t = util.todayStr()
      todayExpense = 0
      recentList.forEach((x) => {
        if (x.date === t) { todayExpense += (x.amount || 0); todayExpenseCount++ }
      })
    }

    // 备注聚合 top-3
    const noteByCat = {}
    recentList.forEach((x) => {
      const n = (x.note || '').trim()
      if (!n) return
      const k = x.category || '其他'
      if (!noteByCat[k]) noteByCat[k] = new Map()
      const m = noteByCat[k]
      m.set(n, (m.get(n) || 0) + (x.amount || 0))
    })
    const budgetMap = (this.data.user && this.data.user.budgets) || {}
    const categories = catStats
      .filter((c) => c.amount > 0)
      .map((c) => {
        const topNotes = noteByCat[c.name]
          ? [...noteByCat[c.name].entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n)
          : []
        const b = budgetMap[c.name]
        return {
          name: c.name, amount: c.amount, percent: c.percent, topNotes, over: c.over,
          budget: typeof b === 'number' && b > 0 ? b : 0  // 分类预算,让 AI 算"还剩多少能花"
        }
      })
    const expense = board._expenseNum || 0
    const income = board._incomeNum || 0
    const balance = income - expense
    const savingsRate = income > 0 ? Math.max(0, Math.round((balance / income) * 100)) : 0
    const trend = (this.data.trend || []).map((t) => ({
      month: t.month,
      income: t.income,
      expense: t.expense,
      balance: t.balance
    }))
    // 上月支出从 trend 倒数第 2 位取(trend 末位 = 当前查看月),环比对比行恢复可用
    const prev = trend.length >= 2 ? trend[trend.length - 2] : null
    const prevMonthExpense = prev ? prev.expense : 0
    return {
      month: viewMonth,
      monthText: `${Number(viewMonth.slice(0, 4))}年${Number(viewMonth.slice(5, 7))}月`,
      income,
      expense,
      balance,
      available: board._availableNum || 0,
      // 当日已支出+笔数(仅当前月有效,历史月 null):AI 直接答「今天花了多少」
      todayExpense,
      todayExpenseCount,
      // 距上次记账天数(仅当前月;历史月 data 残留旧值必须屏蔽):断记提醒依据
      lastRecordGap: viewMonth === util.thisMonthStr() ? this.data.lastRecordGap : null,
      // 本月待记固定支出(active 且 lastRecorded≠当月,与记一笔快捷条同源):AI 主动询问「记了吗」
      pendingRecurring: viewMonth === util.thisMonthStr()
        ? (this.data.recurringList || [])
            .filter((r) => r.active !== false && r.lastRecorded !== viewMonth)
            .map((r) => `${r.name || '未命名'} ¥${(r.amount || 0).toFixed(0)}`)
        : [],
      // 未还卡实时摘要(逐卡 bank/amount/days,负 days=逾期):卡片状态与查看月份无关,直传
      pendingCards: (this.data.aiCards || []).map((c) => ({
        bank: c.bank, amount: c.amount, days: c.days
      })),
      // 日预算三件套:amount 日均可花(含预算约束与距发薪口径)/sub 口径说明/zeroTip 0 额度告警。
      // 查看历史月份时 daily 为 null,serialize 透传 null 云端自然跳过
      dailyBudget: this.data.daily ? this.data.daily.amount : null,
      dailyBudgetSub: this.data.daily ? this.data.daily.sub : '',
      dailyBudgetTip: this.data.daily ? this.data.daily.zeroTip : '',
      streakDays: this.data.streak ? this.data.streak.count : 0,     // 连续记账天数,AI 可做鼓励
      paydaySet: !!this.data.paydaySet,   // 发薪日是否已设置:未设置时 AI 不应按默认值谈「距发薪」,优先引导设置
      payday: (this.data.user && this.data.user.payday) || 0,  // 发薪日(每月几号,0=未设置):AI 可直接答「发薪日是哪天」
      hasRecorded: !!this.data.hasRecorded, // 是否记过账:新用户 AI 优先引导记首笔而非分析数据
      savingsRate,
      // 近 12 个月趋势(loadData 现成算好的 trend 数组透传):
      // 让 AI 不用工具就能答"最近几个月走势 / 上个月花了多少"类问题
      trend,
      prevMonthExpense,
      hasPrevYear: false,
      recurTotal: 0,
      categories,
      budget: (this.data.user && this.data.user.budget) || 0,  // 总预算,让 AI 能算出"剩多少能花"
      budgetOver: this.data.budgetOver || false,
      budgetNear: this.data.budgetNear || false,
      overCategories: categories.filter((c) => c.over).map((c) => c.name),
      // T2.4 订阅摘要(数据块自带):
      // - subscriptions 已由 loadData 派生(active + nextCharge + top10 + 老数据兜底)存在 this.data.aiSubscriptions
      // - subYearlyTotal 在此再算一遍(月×12/年×1/季×4/周×52),保证与数据块 100% 一致
      subscriptions: Array.isArray(this.data.aiSubscriptions) ? this.data.aiSubscriptions : [],
      subYearlyTotal: (() => {
        let total = 0
        for (const s of (this.data.aiSubscriptions || [])) {
          const a = Number(s.amount) || 0
          if (s.cycle === 'monthly') total += a * 12
          else if (s.cycle === 'yearly') total += a
          else if (s.cycle === 'quarterly') total += a * 4
          else if (s.cycle === 'weekly') total += a * 52
        }
        return Math.round(total * 100) / 100
      })()
    }
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

  /** sheet 关闭后 canvas 随 wx:if 重建，需要重新绘制趋势图 */
  redrawTrendAfterPopup() {
    if (this.data.trendEmpty) return
    // 关闭动画 240ms,等 wx:if 重新挂载 canvas 后再画;中途若用户又打开弹层则放弃
    setTimeout(() => {
      if (this.data.showShare || this.data.showAiChat) return
      this.drawTrend()
    }, 280)
  },

  /** 同步更新 globalData.user（订阅成功后全局立即生效） */
  syncUser(patch) {
    const app = getApp()
    if (app.globalData.user) {
      app.globalData.user = { ...app.globalData.user, ...patch }
    }
    this.setData({ user: app.globalData.user })
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
    ctx.fillText('可用余额', center, 292)
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

    // 收入 / 支出 两列
    const cols = [
      { label: '收入', val: b._incomeNum },
      { label: '支出', val: b._expenseNum }
    ]
    cols.forEach((c, i) => {
      const x = 250 + i * 250
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
    ctx.fillText('结转 + 收入 − 支出 = 可用', center, 836)
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

  /* ---------- 收支趋势图（数据取 trend 最近 6 个月，柱密不挤） ---------- */
  /** canvas 2d 绘制：收入/支出双柱 + 结余折线（金色，可跌破零轴），带生长动画 */
  async drawTrend() {
    const list = (this.data.trend || []).slice(-6)
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

    // 取生效主题色（深色模式用浅色系以保证对比度；手动指定主题时优先生效主题）
    const app = getApp()
    const isDark = app.resolvedTheme() === 'dark'
    const NAVY = isDark ? '#8AA4C2' : '#14304F'
    const RED = isDark ? '#E55858' : '#BE4A3A'
    const GOLD = isDark ? '#E5C26B' : '#C8A04D'
    const SUB = isDark ? '#A8B4C5' : '#82766A'
    const GRID = isDark ? '#2D3A4D' : '#EFE7DA'
    const AXIS = isDark ? '#4A5A70' : '#D9D0BF'
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
  /**
   * 用户在询问气泡点「忽略」:清掉气泡 + 未读 + 云端字段
   * (云端 unreadQuestion 清掉,云函数下次推送时还能写新值,但本月不会重复推)
   */
  onDismissPendingQuestion() {
    chatStorage.clearPendingQuestion()
    dbApi.updateMyUser({ unreadQuestion: null, unreadQuestionCount: 0 }).catch(() => {})
    const app = getApp()
    const msgs = (app.globalData.chatMessages || []).filter((m) => !m.isPendingQuestion)
    app.globalData.chatMessages = msgs
    this.setData({
      pendingAiQuestion: null,
      aiUnread: 0
    })
    // sheet 开着时同步组件内消息列表(询问气泡从历史里移除)
    const chat = this.selectComponent('#aiChatSheet')
    if (chat && chat.syncMessages) chat.syncMessages()
  },

  /**
   * 账本君主动询问订阅授权(发薪日推送)。
   * 复用 subscribeRemind 的 error-code 映射,只是模板 ID 不同。
   * 成功 → 写 users.salaryRemindSubscribed=true,云函数会开始给该用户推送。
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
    // 标记今天已请求过,避免同一天重复弹授权(同模式 tryDailySubscribe)
    wx.setStorageSync('xz_subscribe_ask_date', util.todayStr())
    wx.requestSubscribeMessage({
      tmplIds: [tid],
      success: async (res) => {
        if (res[tid] === 'accept') {
          try {
            await dbApi.updateMyUser({ salaryRemindSubscribed: true })
            this.syncUser({ salaryRemindSubscribed: true })
            this.setData({ showAiAskPrompt: false })
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

  /** 关闭首次引导卡(以后再说):本次会话不再出现 */
  dismissAiAskPrompt() {
    this.setData({ showAiAskPrompt: false })
  },

})