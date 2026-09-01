/**
 * 账本君会话持久化
 *
 * 存最近 50 条消息(约 25KB,storage 限额 10MB 远够用),为多轮上下文预留完整历史。
 * 「上次会话」摘要展示用 loadSummary() 只取最后 2 条,避免冷启动一次渲染 50 条。
 *
 * key 版本: v2。v1 只存 2 条且带撤销临时字段,升版让老数据自然失效。
 */

const KEY = 'aiChat_lastSession_v2'
const MAX_MESSAGES = 50
// 是否已展示过欢迎消息(独立 key,避免污染 sessions 摘要;用户清空聊天后不再重复展示)
const KEY_WELCOMED = 'aiChat_welcomed_v1'
// 账本君主动询问的工资问题(云函数 salaryReminder 推送时写入,用户回应或忽略后清除)
// 结构: { text: '询问文案', ts: 时间戳, round: 1|2 }
const KEY_PENDING_QUESTION = 'aiChat_pendingQuestion_v1'
// 账本君主动开场白去重:同一天同一场景只说一次,避免每次打开聊天都重复唠叨
// 结构: { date: 'YYYY-MM-DD', budget: bool, repay: bool }
// v2:开场白改「追加到消息末尾」后,旧 v1 标记(顶部埋没时期误写入的「已提醒」)作废,
//     否则同一天被去重永久挡住,用户永远看不到提醒。升版本让存量标记失效、重新生效。
const KEY_HINTS = 'aiChat_activeHints_v2'

/**
 * 保存最近 50 条消息
 * 剥离 undoable / toolResult 等撤销临时字段:
 * 撤销窗口只在会话内存活,持久化后重开必然过期,存了反而让旧气泡带出失效的撤销按钮
 * @param {Array} messages 完整 messages 数组
 */
function save(messages) {
  if (!Array.isArray(messages) || !messages.length) return
  const slim = messages.slice(-MAX_MESSAGES).map((m) => ({
    role: m.role,
    content: m.content,
    ts: m.ts,
    source: m.source
  }))
  try {
    wx.setStorageSync(KEY, slim)
  } catch (e) {
    // 静默失败:storage 满 / 隐私模式
  }
}

/**
 * 读取完整持久化会话(最多 50 条,给多轮上下文 / 历史展示用)
 * @returns {Array} messages 数组(可能为空)
 */
function load() {
  try {
    const v = wx.getStorageSync(KEY)
    return Array.isArray(v) ? v : []
  } catch (e) {
    return []
  }
}

/** 清空上次会话(不重置 welcomed 标记 —— 用户已见过,清空是主动选择) */
function clear() {
  try {
    wx.removeStorageSync(KEY)
  } catch (e) {}
}

/** 上次会话摘要(最后 2 条,冷启动「上次你问了」展示用,避免一次渲染 50 条) */
function loadSummary() {
  return load().slice(-2)
}

/** 是否已经展示过欢迎消息(用于决定是否在首次打开空聊天时插入欢迎) */
function isWelcomed() {
  try { return !!wx.getStorageSync(KEY_WELCOMED) }
  catch (e) { return false }
}

/** 标记已展示欢迎消息(只在 chatStorage.js 内部用) */
function markWelcomed() {
  try { wx.setStorageSync(KEY_WELCOMED, true) }
  catch (e) {}
}

/** 清除欢迎消息标记（重置全部数据时调用，让聊天回到首次使用、重新展示欢迎语） */
function clearWelcomed() {
  try { wx.removeStorageSync(KEY_WELCOMED) }
  catch (e) {}
}

/**
 * 保存账本君待回应的询问（云函数推送后写入，本地兜底，离线也能看到）
 * @param {{ text: string, ts: number, round: number }} q
 */
function savePendingQuestion(q) {
  if (!q || !q.text) return
  try { wx.setStorageSync(KEY_PENDING_QUESTION, q) }
  catch (e) {}
}

/**
 * 读取账本君待回应的询问
 * @returns {{ text: string, ts: number, round: number } | null}
 */
function loadPendingQuestion() {
  try {
    const v = wx.getStorageSync(KEY_PENDING_QUESTION)
    return (v && typeof v === 'object' && v.text) ? v : null
  } catch (e) {
    return null
  }
}

/** 清除账本君待回应的询问（用户已回应或主动忽略） */
function clearPendingQuestion() {
  try { wx.removeStorageSync(KEY_PENDING_QUESTION) }
  catch (e) {}
}

/**
 * 读取今天的主动开场白标记。非今天的旧标记直接作废返回 { date: 今天 }。
 * @param {string} date 'YYYY-MM-DD'
 * @returns {{ date: string, budget?: boolean, repay?: boolean }}
 */
function loadHints(date) {
  try {
    const v = wx.getStorageSync(KEY_HINTS)
    if (v && typeof v === 'object' && v.date === date) return v
  } catch (e) {}
  return { date }
}

/** 标记今天某个场景已主动说过（budget / repay） */
function markHintShown(date, key) {
  try {
    const v = loadHints(date)
    v[key] = true
    wx.setStorageSync(KEY_HINTS, v)
  } catch (e) {}
}

/** 清除开场白标记（重置全部数据时调用，让主动提醒重新生效） */
function clearHints() {
  try { wx.removeStorageSync(KEY_HINTS) }
  catch (e) {}
}

// AI 待办提醒已读标记：用户打开 chat sheet 看到提醒后，今日不再重复提示/角标
const KEY_REMINDER_READ = 'aiChat_reminderRead_v1'

function markReminderRead(date) {
  try { wx.setStorageSync(KEY_REMINDER_READ, { date }) } catch (e) {}
}
function isReminderRead(date) {
  try {
    const v = wx.getStorageSync(KEY_REMINDER_READ)
    return v && v.date === date
  } catch (e) { return false }
}
function clearReminderRead() {
  try { wx.removeStorageSync(KEY_REMINDER_READ) } catch (e) {}
}

// 每日 board-brief（"今天9月1号，按你的余额和节奏…"）已读标记：
// 当天看过一次即不再主动弹出/角标（内容随日期与余额变化，跨天自动重新生效）
const KEY_BRIEF_READ = 'aiChat_briefRead_v1'

function markBriefRead(date) {
  try { wx.setStorageSync(KEY_BRIEF_READ, { date }) } catch (e) {}
}
function isBriefRead(date) {
  try {
    const v = wx.getStorageSync(KEY_BRIEF_READ)
    return v && v.date === date
  } catch (e) { return false }
}
function clearBriefRead() {
  try { wx.removeStorageSync(KEY_BRIEF_READ) } catch (e) {}
}

module.exports = { save, load, loadSummary, clear, isWelcomed, markWelcomed, clearWelcomed,
  savePendingQuestion, loadPendingQuestion, clearPendingQuestion,
  loadHints, markHintShown, clearHints,
  markReminderRead, isReminderRead, clearReminderRead,
  markBriefRead, isBriefRead, clearBriefRead }