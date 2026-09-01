/**
 * 账本君聊天 sheet 公共组件
 *
 * 由首页 ai-chat-sheet 与记账页 chat-sheet 两处重复实现合并而成,
 * 全量承载对话交互逻辑(发送 / 节流 / 撤销倒计时 / 快捷 chip / 键盘自适应 / 滚动),
 * 宿主页面只负责数据源与页面级副作用。
 *
 * 使用方式(宿主页面):
 *   <ai-chat-sheet
 *     show="{{showAiChat}}"
 *     sub="你的 AI 财务助理"
 *     stmt="{{aiStmt}}"                 <!-- 发送时取的 statement blob,null 则中止发问 -->
 *     recent-list="{{recentExpenses}}"  <!-- 最近流水(给 LLM 看具体买了啥) -->
 *     bindclose="onAiChatClose"         <!-- 组件播完关闭动画后触发,宿主置 show=false -->
 *     bindclear="onAiChatClear"         <!-- 清空会话(核心清理组件内完成,宿主清页面级状态) -->
 *     bindbeforesend="onAiChatBeforeSend" <!-- 发送前副作用(首页:清未读询问+隐藏摘要) -->
 *     bindrefresh="onAiChatRefresh"     <!-- 记账/撤销后宿主 loadData(true) 刷新数据 -->
 *   />
 *   <!-- slot: 宿主自定义头部卡片(主动询问气泡/订阅引导/上次会话摘要),不传则不展示 -->
 *
 * 会话状态(getApp().globalData.chatMessages)全局共享,多处入口接着聊;
 * 输入框内容同步 globalData.chatInput(跨页恢复)。
 */
const aiChat = require('../../utils/aiChat')
const chatStorage = require('../../utils/chatStorage')
const dbApi = require('../../utils/db')

const QUICK_CHIPS = ['哪个分类花最多', '还剩多少预算', '最近买了啥']
const RATE_LIMIT_PER_MIN = 10
const CLOSE_ANIM_MS = 240

Component({
  options: {
    // 复用 app.wxss 全局样式(.mask/.sheet/.sheet-out 等)与 CSS 变量主题
    styleIsolation: 'apply-shared'
  },

  properties: {
    /** 是否展示(宿主 wx:if 同源控制;true 时组件同步 globalData 会话并滚到底) */
    show: {
      type: Boolean,
      value: false,
      observer(nv) {
        if (nv) this._onSheetShow()
      }
    },
    /** 副标题(如「你的 AI 财务助理」) */
    sub: { type: String, value: '你的 AI 财务助理' },
    /** 发送时读取的 statement blob,null/undefined 则中止发问 */
    stmt: { type: Object, value: null },
    /** 最近流水数组(给 LLM 看具体买了啥) */
    recentList: { type: Array, value: [] },
    /** 输入框 placeholder */
    placeholder: { type: String, value: '问问账本君…' }
  },

  data: {
    chatMessages: [],
    chatInput: '',
    chatSending: false,
    chatRateError: '',
    quickChips: QUICK_CHIPS,
    closing: false,
    sheetHeight: '80vh',
    sheetPaddingBottom: 'env(safe-area-inset-bottom)',
    scrollIntoView: '',
    scrollTop: 0
  },

  lifetimes: {
    detached() {
      if (this._undoTimer) {
        clearInterval(this._undoTimer)
        this._undoTimer = null
      }
      if (this._closeTimer) {
        clearTimeout(this._closeTimer)
        this._closeTimer = null
      }
    }
  },

  methods: {
    /* ---------- 打开 / 关闭 ---------- */

    /** 空方法:mask/sheet 的 catchtouchmove 绑定,阻止弹框滑动穿透到底部页面。
     *  组件不走 app.js 的全局 Page 注入,必须自带。内部 scroll-view 原生滚动不受影响。 */
    preventTouchmove() {},

    /** show=true:同步 globalData 会话状态进组件,有消息滚到底 */
    _onSheetShow() {
      const app = getApp()
      this.setData({
        chatMessages: (app.globalData.chatMessages || []).slice(),
        chatInput: app.globalData.chatInput || '',
        chatSending: app.globalData.chatSending || false,
        chatRateError: '',
        closing: false,
        sheetHeight: '80vh',
        sheetPaddingBottom: 'env(safe-area-inset-bottom)',
        scrollIntoView: '',
        scrollTop: 0
      })
      if ((app.globalData.chatMessages || []).length) {
        // wx:if 刚挂载 scroll-view,需等布局 ready 再滚
        setTimeout(() => this._scrollToBottom(), 120)
      }
    },

    /**
     * 关闭:先播滑出动画,动画结束再通知宿主卸载。
     * (宿主收到 close 事件后 setData show=false 即可,动画逻辑全在组件内)
     */
    close() {
      if (this._closeTimer) return
      this.setData({ closing: true })
      this._closeTimer = setTimeout(() => {
        this._closeTimer = null
        this.setData({ closing: false })
        this.triggerEvent('close')
      }, CLOSE_ANIM_MS)
    },

    /**
     * 宿主在 sheet 打开期间改动了 globalData.chatMessages(如移除询问气泡)后,
     * 调本方法让组件内消息列表立即同步(show 观察者只在开关时触发)。
     */
    syncMessages() {
      this.setData({
        chatMessages: (getApp().globalData.chatMessages || []).slice()
      })
      this._scrollToBottom()
    },

    /**
     * 清空会话:核心数据(globalData + storage + 组件态)组件内清,
     * 页面级状态(pendingAiQuestion / 摘要卡 / 云端 unreadQuestion)由宿主 clear 事件处理。
     */
    clear() {
      const app = getApp()
      app.globalData.chatMessages = []
      app.globalData.chatInput = ''
      chatStorage.clear()
      // 云端会话摘要(chatLogs)一并清空:换设备/清缓存后 AI 也不该再"记得"已删的对话
      aiChat.clearCloudSession()
      // 主动询问气泡独立存储,一并清掉避免下次打开 sheet 又冒出来
      chatStorage.clearPendingQuestion()
      this.setData({
        chatMessages: [],
        chatInput: ''
      })
      wx.showToast({ title: '已清空', icon: 'none' })
      this.triggerEvent('clear')
    },

    /* ---------- 输入 ---------- */

    onInput(e) {
      const v = e.detail.value || ''
      getApp().globalData.chatInput = v  // 跨页/切回恢复
      this.setData({ chatInput: v })
    },

    /** 输入框聚焦:滚到底,避免键盘遮挡输入框 */
    onFocus() {
      this._scrollToBottom()
    },

    /** 输入框失焦:键盘收起,还原 sheet 高度(兜底,keyboardheightchange 可能漏最终 0) */
    onBlur() {
      this.setData({
        sheetHeight: '80vh',
        sheetPaddingBottom: 'env(safe-area-inset-bottom)'
      })
    },

    /**
     * 键盘高度变化:动态调整 sheet 高度。
     * - 关闭键盘:80vh(顶部留 20vh mask 区可点关闭)
     * - 键盘弹起:固定 50vh,上限 = 可视区高度(防 sheet 顶部出屏),下限 280px
     */
    onKeyboardChange(e) {
      const h = (e && e.detail && e.detail.height) || 0
      if (h === 0) {
        this.setData({
          sheetHeight: '80vh',
          sheetPaddingBottom: 'env(safe-area-inset-bottom)'
        })
        return
      }
      const win = wx.getWindowInfo()
      const visibleH = win.screenHeight - win.safeArea.top - h
      const desiredH = win.screenHeight * 0.5
      const maxH = Math.max(280, Math.min(visibleH, desiredH))
      this.setData({
        sheetHeight: maxH + 'px',
        sheetPaddingBottom: '0px'
      })
    },

    /* ---------- 发送 ---------- */

    /**
     * 发送问题:节流 → 拼 user 气泡 → 调 aiChat.send → 拼 assistant 气泡 → 持久化。
     * mode='record':启用账本君记账工具(空白月也放行,云函数对 record 不短路 NO_DATA)。
     */
    async sendChat() {
      const app = getApp()
      const q = (this.data.chatInput || '').trim()
      if (!q || this.data.chatSending) return

      // 宿主页面级预发送副作用(首页:清未读询问 + 隐藏上次会话摘要)
      this.triggerEvent('beforesend')

      // 1. 节流:每分钟 ≤10 次(账本君记账后从 6 提到 10)
      const now = Date.now()
      this._chatTs = (this._chatTs || []).filter((t) => now - t < 60000)
      if (this._chatTs.length >= RATE_LIMIT_PER_MIN) {
        this.setData({ chatRateError: '一分钟最多问 10 次,稍等再问' })
        setTimeout(() => this.setData({ chatRateError: '' }), 2000)
        return
      }
      this._chatTs.push(now)

      // 2. 数据源由 properties 提供(stmt=null 中止;空白月也允许通过 stmt.expense=0)
      const stmt = this.properties.stmt
      if (!stmt) return
      const recentList = this.properties.recentList || []

      // 3. push user 消息 + 立刻滚动到底
      // (history 在 push 前取:不含本条问题,云端拼成多轮上下文,追问"那上个月呢"可被理解)
      const history = aiChat.buildHistory(app.globalData.chatMessages)
      // 冷启动(本进程还没聊过)时,把持久化会话尾部作为「上次对话」传云端:
      // AI 能看到自己上次说过什么,避免重复唠叨同一建议(跨会话去重)。
      const lastSession = (app.globalData.chatMessages || []).length
        ? null
        : aiChat.buildHistory(chatStorage.load())
      const userMsg = { role: 'user', content: q, ts: now }
      app.globalData.chatMessages = [...(app.globalData.chatMessages || []), userMsg]
      app.globalData.chatInput = ''
      app.globalData.chatSending = true
      this.setData({
        chatMessages: app.globalData.chatMessages.slice(),
        chatInput: '',
        chatSending: true
      })
      this._scrollToBottom()

      // 4. 调核心 aiChat.send(record 启用记账工具,账本君可记账)
      const result = await aiChat.send({
        month: stmt.month,
        stmt,
        recentList,
        question: q,
        mode: 'record',
        history,
        lastSession
      })

      // 5. 拼 assistant 气泡
      const assistant = {
        role: 'assistant',
        content: result.text,
        ts: Date.now(),
        source: result.source
      }

      // 5a. 账本君记账成功 → undoable 标记 + 15s 撤销窗口(带倒计时)
      if (result.toolResult && result.toolResult.added && result.toolResult.id) {
        assistant.toolResult = result.toolResult  // { added, expense, id }
        assistant.undoable = true
        assistant.undoExpireAt = Date.now() + 15000
        assistant.undoCountdown = 15
      }

      // 5a2. 账本君提示"已记过,是否再记" → needsConfirm,气泡出「再记一次」快捷按钮
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
      this._scrollToBottom()

      // 5b. 启动倒计时 + 通知宿主刷新页面数据(云函数写库不触发 dbApi 缓存失效)
      if (assistant.undoable) {
        this._startUndoCountdown()
        this.triggerEvent('refresh')
      }

      // 6. 截断 + 持久化(globalData 恒 ≤50 条,与 chatStorage 上限一致,撤销倒计时索引一致)
      app.globalData.chatMessages = app.globalData.chatMessages.slice(-50)
      chatStorage.save(app.globalData.chatMessages)
    },

    /** 快捷问题 chip:填入输入框并立即发送(chatSending 时不响应) */
    onQuickChipTap(e) {
      const text = e.currentTarget.dataset.text
      if (!text || this.data.chatSending) return
      this.setData({ chatInput: text })
      this.sendChat()
    },

    /**
     * 「再记一次」快捷确认:把"再记"当作下一条消息发送,复用完整对话链路。
     * 云函数侧 isDupConfirmReply + force 自动补位,真正写入第二笔。
     * 不覆盖输入框里已输入的内容(临时换入"再记",发送后恢复)。
     */
    onReRecord() {
      if (this.data.chatSending) return
      const saved = this.data.chatInput
      this.setData({ chatInput: '再记' }, () => {
        this.sendChat()
        this.setData({ chatInput: saved })
      })
    },

    /* ---------- 撤销 ---------- */

    /**
     * 撤销账本君刚记的那一笔(15s 撤销窗口内的气泡)。
     * 按 toolResult.type 路由:salary → removeSalary;expense → removeExpense。
     * 软删除后更新消息内容 + undone 标记,并通知宿主刷新数据。
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
        chatStorage.save(msgs)  // 同步持久化,另一页 / 冷启动重开也是"已撤销"状态
        this.triggerEvent('refresh')  // 宿主刷新看板/预算/流水(force 跳过缓存)
      } catch (err) {
        console.error('撤销失败', err)
        wx.showToast({ title: '撤销失败', icon: 'none' })
      }
    },

    /**
     * 撤销气泡倒计时:每秒扫描 chatMessages,更新所有 undoable 消息的 undoCountdown。
     * - 到期(undoExpireAt 已过):自动 undoable=false,气泡消失
     * - 所有 undoable 都处理完(撤销 or 到期):清 timer,避免空转
     * - setData 走精确路径(chatMessages[i].undoCountdown),不重渲染整个列表
     */
    _startUndoCountdown() {
      if (this._undoTimer) return  // 已有 timer 在跑,不重复起
      const app = getApp()
      this._undoTimer = setInterval(() => {
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
            m.undoable = false
            updates[`chatMessages[${i}].undoable`] = false
          } else {
            const remain = Math.max(0, Math.ceil((m.undoExpireAt - now) / 1000))
            if (m.undoCountdown !== remain) {
              m.undoCountdown = remain
              updates[`chatMessages[${i}].undoCountdown`] = remain
            }
            stillRunning = true
          }
        })
        if (Object.keys(updates).length > 0) {
          app.globalData.chatMessages = msgs
          this.setData(updates)
        }
        if (!stillRunning) {
          clearInterval(this._undoTimer)
          this._undoTimer = null
        }
      }, 1000)
    },

    /* ---------- 滚动 ---------- */

    /**
     * 滚 chat 历史到底,三层保险:
     * 1) scroll-into-view 立即指向哨兵,首屏/快速响应
     * 2) 重置 scroll-into-view 为空绕开「同值不触发」
     * 3) 80ms 后用 scroll-top + 累加器兜底,确保 DOM/layout ready 且值唯一
     */
    _scrollToBottom() {
      this.setData({ scrollIntoView: '' })
      setTimeout(() => {
        this.setData({ scrollIntoView: 'ai-chat-bottom' })
      }, 16)
      setTimeout(() => {
        this.setData({ scrollTop: this._bumpScrollTop(99999) })
      }, 80)
    },

    /** 累加器:每次调用返回唯一值,避免 scroll-top 同值不触发 */
    _bumpScrollTop(target) {
      this._scrollBump = (this._scrollBump || 0) + 1
      return target + this._scrollBump
    }
  }
})
