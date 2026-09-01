/**
 * 账本君对话交互（WeChat Behavior，供首页 / 记账页复用）
 *
 * 背景：首页 index.js 与记账页 expenses.js 各有一份 ~150 行的账本君对话逻辑
 * （sendChat、撤销倒计时、撤销、快捷 chip、scroll 累加器 + 节流），高度重复且含易错的
 * 撤销倒计时 / 持久化代码。抽到这里统一维护，两页只留页面差异。
 *
 * 页面需要覆盖的钩子（默认空实现，不覆盖也能跑通发问但拿不到数据）：
 * - _chatStmt()            -> 返回 statement blob（null 则中止发问）
 * - _chatRecentList()      -> 返回最近流水数组（给 LLM 看具体买了啥）
 * - _chatScrollToBottom()  -> 页面自己的「滚到底」策略
 * - _chatSyncInput(v)      -> [可选] 同步输入框到 globalData（首页需要，记账页不需要）
 * - _chatBeforeSend()      -> [可选] 发送前的副作用（首页：清未读询问 + 隐藏摘要）
 *
 * 依赖约定：两页都实现 loadData(force)（撤销 / 记账后强制刷新数据用）。
 */
const aiChat = require('./aiChat')
const chatStorage = require('./chatStorage')
const dbApi = require('./db')

const QUICK_CHIPS = ['哪个分类花最多', '还剩多少预算', '最近买了啥']
const RATE_LIMIT_PER_MIN = 10

module.exports = Behavior({
  data: {
    chatMessages: [],        // 全局同步 getApp().globalData.chatMessages
    chatInput: '',
    chatSending: false,
    chatRateError: '',       // 限流错误文案（2 秒后自动消）
    quickChips: QUICK_CHIPS  // 输入框上方常驻 chip，点一下即发
  },

  methods: {
    /* ---------- 页面钩子（默认空实现，页面按需覆盖） ---------- */
    _chatStmt() { return null },
    _chatRecentList() { return [] },
    _chatScrollToBottom() {},
    _chatSyncInput() {},
    _chatBeforeSend() {},

    /**
     * 发送问题：节流 → 拼 user 气泡 → 调 aiChat.send → 拼 assistant 气泡 → 持久化
     * 状态同步到 app.globalData，首页 / 记账页共享同一份会话。
     *
     * mode='record'：启用账本君记账工具。允许空白月（expense=0）发问记账——
     * 云函数对 mode='record' 不短路 NO_DATA。
     */
    async sendChat() {
      const app = getApp()
      const q = (this.data.chatInput || '').trim()
      if (!q || this.data.chatSending) return

      // 页面级预发送副作用（首页：清未读询问 + 隐藏上次会话摘要）
      this._chatBeforeSend()

      // 1. 节流：每分钟 ≤10 次（账本君记账后从 6 提到 10）
      const now = Date.now()
      this._chatTs = (this._chatTs || []).filter((t) => now - t < 60000)
      if (this._chatTs.length >= RATE_LIMIT_PER_MIN) {
        this.setData({ chatRateError: '一分钟最多问 10 次,稍等再问' })
        setTimeout(() => this.setData({ chatRateError: '' }), 2000)
        return
      }
      this._chatTs.push(now)

      // 2. 算 statement + 最近流水（页面差异由钩子提供；空白月也允许通过 stmt.expense=0）
      const stmt = this._chatStmt()
      if (!stmt) return
      const recentList = this._chatRecentList()

      // 3. push user 消息 + 立刻滚动到底
      // (history 在 push 前取：不含本条问题，云端拼成多轮上下文，追问"那上个月呢"可被理解)
      const history = aiChat.buildHistory(app.globalData.chatMessages)
      const userMsg = { role: 'user', content: q, ts: now }
      app.globalData.chatMessages = [...(app.globalData.chatMessages || []), userMsg]
      app.globalData.chatInput = ''
      app.globalData.chatSending = true
      this.setData({
        chatMessages: app.globalData.chatMessages.slice(),
        chatInput: '',
        chatSending: true
      })
      this._chatScrollToBottom()

      // 4. 调核心 aiChat.send（mode='record' 启用 addExpense 工具，账本君可记账）
      const result = await aiChat.send({
        month: stmt.month,
        stmt,
        recentList,
        question: q,
        mode: 'record',
        history
      })

      // 5. 拼 assistant 气泡
      const assistant = {
        role: 'assistant',
        content: result.text,
        ts: Date.now(),
        source: result.source
      }

      // 5a. 账本君记账成功 → undoable 标记 + 15s 撤销窗口（带倒计时）
      if (result.toolResult && result.toolResult.added && result.toolResult.id) {
        assistant.toolResult = result.toolResult  // { added, expense, id }
        assistant.undoable = true
        assistant.undoExpireAt = Date.now() + 15000  // 到期时间戳
        assistant.undoCountdown = 15                  // 倒计时初始值（秒）
      }

      // 5a2. 账本君提示"已记过,是否再记" → needsConfirm，气泡出「再记一次」快捷按钮
      if (result.toolResult && result.toolResult.needsConfirm && result.toolResult.duplicate) {
        assistant.needsConfirm = true
        assistant.dupType = result.toolResult.type  // 'expense' | 'salary'
      }

      app.globalData.chatMessages = [...app.globalData.chatMessages, assistant]
      app.globalData.chatSending = false
      this.setData({
        chatMessages: app.globalData.chatMessages.slice(),
        chatSending: false
      })
      this._chatScrollToBottom()

      // 5b. 启动倒计时 setInterval + 写库后立即刷新页面数据（云函数写库不触发 dbApi.invalidate）
      if (assistant.undoable) {
        this._startUndoCountdown()
        this.loadData(true)
      }

      // 6. 截断 + 持久化（globalData 恒 ≤50 条，与 chatStorage 上限一致，撤销倒计时索引一致）
      app.globalData.chatMessages = app.globalData.chatMessages.slice(-50)
      chatStorage.save(app.globalData.chatMessages)
    },

    /**
     * 快捷问题 chip：填入输入框并立即发送。
     * - chatSending 时不响应（防止重复请求 + 旧 chip 状态错乱）
     * - 通过 _chatSyncInput 与手动输入走同一路径（首页让 onShow 切回时恢复输入）
     */
    onQuickChipTap(e) {
      const text = e.currentTarget.dataset.text
      if (!text || this.data.chatSending) return
      this.setData({ chatInput: text })
      this._chatSyncInput(text)
      this.sendChat()
    },

    /**
     * 撤销账本君刚记的那一笔（15s 撤销窗口内的气泡）
     * 按 toolResult.type 路由：
     * - salary → dbApi.removeSalary（写 salary collection）
     * - expense → dbApi.removeExpense（写 expenses collection）
     * 软删除对应记录，更新消息内容 + undone 标记，刷新当前页数据
     */
    async onUndoAiRecord(e) {
      const ts = e.currentTarget.dataset.msgTs
      const app = getApp()
      const msgs = (app.globalData.chatMessages || []).slice()
      const idx = msgs.findIndex((m) => m.ts === ts)
      if (idx < 0) return
      const msg = msgs[idx]
      if (!msg.toolResult || !msg.toolResult.id || msg.undone) return
      const isSalary = msg.toolResult.type === 'salary'
      try {
        if (isSalary) {
          await dbApi.removeSalary(msg.toolResult.id)
        } else {
          await dbApi.removeExpense(msg.toolResult.id)
        }
        msg.undoable = false
        msg.undone = true
        msg.content = (msg.content || '') + ' · ✓ 已撤销'
        app.globalData.chatMessages = msgs
        this.setData({ chatMessages: msgs.slice() })
        chatStorage.save(msgs)  // 同步持久化，另一页 / 冷启动重开也是"已撤销"状态
        this.loadData(true)  // 顶部预算条 / 分类 chip / 流水重新算（force 跳过缓存）
      } catch (err) {
        console.error('撤销失败', err)
        wx.showToast({ title: '撤销失败', icon: 'none' })
      }
    },

    /**
     * 撤销气泡倒计时：每秒扫描 chatMessages，更新所有 undoable 消息的 undoCountdown。
     * - 到期（undoExpireAt 已过）：自动 undoable=false，气泡消失
     * - 所有 undoable 都处理完（撤销 or 到期）：清 timer，避免空转
     * - setData 走精确路径（chatMessages[i].undoCountdown），不重渲染整个列表
     * 多个消息同时在 15s 窗口：timer 只起一次（去重），所有 m 一起倒计时
     */
    _startUndoCountdown() {
      if (this._undoTimer) return  // 已有 timer 在跑，不重复起
      const app = getApp()
      this._undoTimer = setInterval(() => {
        // 读写 globalData（首页 / 记账页共享）；page 的 chatMessages 是同一数组副本，索引一致
        const msgs = (app.globalData.chatMessages || []).slice()
        const now = Date.now()
        const updates = {}
        let stillRunning = false
        msgs.forEach((m, i) => {
          if (!m.undoable || m.undone) return
          if (!m.undoExpireAt) {
            stillRunning = true
            return
          }
          if (now >= m.undoExpireAt) {
            // 到期
            m.undoable = false
            updates[`chatMessages[${i}].undoable`] = false
          } else {
            // 还在窗口内
            const remain = Math.max(0, Math.ceil((m.undoExpireAt - now) / 1000))
            if (m.undoCountdown !== remain) {
              m.undoCountdown = remain
              updates[`chatMessages[${i}].undoCountdown`] = remain
            }
            stillRunning = true
          }
        })
        // 变更同步回 globalData，防止 sheet 关闭 / 重开后气泡带着过期 undo 标记
        if (Object.keys(updates).length > 0) {
          app.globalData.chatMessages = msgs
          this.setData(updates)
        }
        // 没消息在跑 → 清 timer
        if (!stillRunning) {
          clearInterval(this._undoTimer)
          this._undoTimer = null
        }
      }, 1000)
    },

    /**
     * 累加器：每次调用返回唯一值，避免 scroll-top 同值不触发。
     * 统一用 _scrollBump 字段，首页 / 记账页共享。
     */
    _bumpScrollTop(target) {
      this._scrollBump = (this._scrollBump || 0) + 1
      return target + this._scrollBump
    }
  }
})
