/**
 * 外观主题模式管理：「跟随系统 / 浅色 / 深色」，默认跟随系统。
 *
 * 实现架构（两层）：
 * - CSS 层：app.wxss 用 @media (prefers-color-scheme) 跟随系统（首帧即正确，无闪屏）；
 *   手动指定时通过页面根节点 class（theme-force-light / theme-force-dark）
 *   在子树内重新定义全部 CSS 变量，覆盖 page 元素上由媒体查询给出的值。
 * - JS 层：mode 存 storage（冷启动立即生效，不等云端 user），同时写 users.themeMode
 *   （跨设备同步）；canvas / 导航栏 / tabBar 等非 CSS 场景统一取 resolvedTheme()。
 */
const STORAGE_KEY = 'themeMode'
const MODES = ['system', 'light', 'dark']
const PAGE_BG = { light: '#F6F2EA', dark: '#0E1620' }

function normalize(mode) {
  return MODES.indexOf(mode) >= 0 ? mode : 'system'
}

/** 当前模式：优先 app.globalData（内存缓存），兜底读 storage */
function getMode() {
  const app = typeof getApp === 'function' ? getApp() : null
  const fromApp = app && app.globalData && app.globalData.themeMode
  if (fromApp) return normalize(fromApp)
  try {
    return normalize(wx.getStorageSync(STORAGE_KEY))
  } catch (e) {
    return 'system'
  }
}

/** 写入模式：storage + globalData 同步更新（chrome 刷新由 app.setThemeMode 统一负责） */
function setMode(mode) {
  const m = normalize(mode)
  try {
    wx.setStorageSync(STORAGE_KEY, m)
  } catch (e) { /* storage 写失败不阻塞，内存值仍生效 */ }
  const app = typeof getApp === 'function' ? getApp() : null
  if (app && app.globalData) app.globalData.themeMode = m
  return m
}

/** 系统主题（'light' | 'dark'），来自 app.syncTheme 的检测结果 */
function systemTheme() {
  const app = typeof getApp === 'function' ? getApp() : null
  return (app && app.globalData && app.globalData.theme === 'dark') ? 'dark' : 'light'
}

/** 最终生效主题：手动指定优先，否则跟随系统 */
function resolvedTheme() {
  const mode = getMode()
  return mode === 'system' ? systemTheme() : mode
}

/**
 * 页面根节点 class：手动指定时返回 force class 覆盖媒体查询；
 * 跟随系统时返回空串（媒体查询自己就是正确的，无需干预）。
 */
function themeClass() {
  const mode = getMode()
  if (mode === 'dark') return 'theme-force-dark'
  if (mode === 'light') return 'theme-force-light'
  return ''
}

/**
 * 页面 onLoad/onShow 调用：注入根节点 class + 设置窗口背景。
 * （page 元素背景由媒体查询控制无法被 class 覆盖，
 *  根视图自绘 var(--bg) 遮住，下拉回弹区用 setBackgroundColor 兜底。）
 */
function applyToPage(page) {
  if (!page) return
  page.setData({ themeClass: themeClass() })
  wx.setBackgroundColor({
    backgroundColor: PAGE_BG[resolvedTheme()],
    fail: () => { /* 个别场景（如无窗口）忽略 */ }
  })
}

module.exports = {
  normalize,
  getMode,
  setMode,
  systemTheme,
  resolvedTheme,
  themeClass,
  applyToPage,
  PAGE_BG
}
