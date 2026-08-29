/**
 * 账本君会话持久化
 *
 * 只存最近 1 条 user + 1 条 assistant(共 2 条),作为「上次会话」摘要展示。
 * 存更多会爆 storage 限额,且同步 API 慢。
 *
 * key 版本: v1。后续 schema 变更时改成 v2 让老数据自然失效。
 */

const KEY = 'aiChat_lastSession_v1'

/**
 * 保存最近 2 条消息(user + assistant)作为摘要
 * @param {Array} messages 完整 messages 数组
 */
function save(messages) {
  if (!Array.isArray(messages) || !messages.length) return
  const last2 = messages.slice(-2)
  try {
    wx.setStorageSync(KEY, last2)
  } catch (e) {
    // 静默失败:storage 满 / 隐私模式
  }
}

/**
 * 读取上次会话摘要
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

/** 清空上次会话 */
function clear() {
  try {
    wx.removeStorageSync(KEY)
  } catch (e) {}
}

module.exports = { save, load, clear }