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

module.exports = { save, load, loadSummary, clear, isWelcomed, markWelcomed,
  savePendingQuestion, loadPendingQuestion, clearPendingQuestion }