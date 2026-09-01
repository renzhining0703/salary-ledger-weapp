/**
 * 验证：记账页账单弹框「去内嵌聊天窗 → 独立账本君聊天 sheet」改造
 *
 * 改动点：
 * 1. 账单 sheet 内 AI 解读卡保留，底部入口条改为「有问题问账本君」→ 点击弹独立 chat sheet
 * 2. 删除内嵌 stmt-chat 聊天面板（键盘顶起挤压账单内容的根源）
 * 3. 新增独立 chat sheet：深蓝头部 + 历史滚动 + 快捷 chip + 输入行 + 键盘高度自适应（复用首页策略）
 * 4. 会话仍与首页共享 globalData.chatMessages；月份上下文 = 账单查看月（_chatStmt 返回 statement）
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const PAGES = path.join(ROOT, 'pages', 'expenses')
const read = (f) => fs.readFileSync(path.join(PAGES, f), 'utf8')

const wxml = read('expenses.wxml')
const js = read('expenses.js')
const wxss = read('expenses.wxss')

let pass = 0
let fail = 0
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg) }
  else { fail++; console.log('  ✗ ' + msg) }
}

/** 提取函数体（兼容 function name( 与对象方法 name(args) { 两种形式） */
function fnBody(src, name) {
  let m = src.match(new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{'))
  if (!m) m = src.match(new RegExp('\\b' + name + '\\s*\\([^)]*\\)\\s*\\{'))
  if (!m) return null
  const start = m.index + m[0].length
  let depth = 1
  let i = start
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
    i++
  }
  return src.slice(start, i - 1)
}

console.log('== 1. WXML：账单 sheet 内保留摘要卡 + 新入口条 ==')
ok(wxml.includes('id="stmt-insight"'), 'AI 解读卡保留（stmt-insight）')
ok(/stmt-ask-bar[^>]*bindtap="openChat"/.test(wxml.replace(/\n/g, ' ')), '入口条 bindtap=openChat')
ok(wxml.includes('有问题问账本君'), '入口条文案「有问题问账本君」')
ok(!wxml.includes('{{chatOpen}}'), 'WXML 无 chatOpen 条件（内嵌聊天窗已移除）')
ok(!wxml.includes('stmt-chat'), 'WXML 无 stmt-chat 内嵌面板')
// 入口条在 insightSource 可用时显示（不再依赖 chatOpen）
ok(/wx:if="\{\{statement\.insightSource === 'cache'[^"]*\}\}" class="stmt-ask-bar"/.test(wxml.replace(/\n/g, ' ')),
  '入口条仅依赖 insightSource（loading 时不显示）')

console.log('== 2. WXML：独立 chat sheet 结构 ==')
ok(wxml.includes('wx:if="{{showChatSheet}}"'), 'chat sheet 由 showChatSheet 控制')
ok(/bindtap="closeChatSheet"/.test(wxml), 'mask + ✕ 均 closeChatSheet')
ok(wxml.includes('class="sheet chat-sheet'), 'chat sheet 使用全局 sheet 基类 + chat-sheet')
ok(wxml.includes('style="height: {{chatSheetHeight}}; padding-bottom: {{chatSheetPaddingBottom}};"'),
  'sheet 高度/padding 动态注入（键盘自适应）')
ok(wxml.includes('scroll-into-view="{{chatScrollIntoView}}"'), '历史区 scroll-into-view')
ok(wxml.includes('scroll-top="{{chatScrollTop}}"'), '历史区 scroll-top（兜底滚底）')
ok(wxml.includes('bindkeyboardheightchange="onChatKeyboardChange"'), '输入框监听键盘高度')
ok(wxml.includes('bindconfirm="sendChat"'), 'confirm 走 chatController.sendChat')
ok(wxml.includes('bindtap="onQuickChipTap"'), '快捷 chip 复用 chatController')
ok(wxml.includes('bindtap="onUndoAiRecord"'), '撤销 chip 复用 chatController')
ok(wxml.includes('bindtap="onReRecord"'), '「再记一次」chip 已接入（旧内嵌版没有）')
ok(wxml.includes('id="chat-bottom"'), '滚底哨兵节点')
ok(wxml.includes('{{statement.monthText}} 有疑问'), '头部副标题带账单月份（上下文可见）')

console.log('== 3. WXML：层级顺序（chat sheet 在账单 sheet 之后 = 更高层） ==')
const idxStmt = wxml.indexOf('showStatement}}" class="mask')
const idxChat = wxml.indexOf('showChatSheet}}" class="mask')
ok(idxStmt >= 0 && idxChat > idxStmt, 'chat sheet mask 在账单 sheet mask 之后（同 z-index DOM 靠后者在上）')

console.log('== 4. JS：状态与方法 ==')
ok(!/\bchatOpen\b/.test(js), 'JS 无 chatOpen 残留')
ok(/showChatSheet: false/.test(js), 'data 声明 showChatSheet')
ok(/chatSheetHeight: '80vh'/.test(js), 'data 声明 chatSheetHeight 默认 80vh')
ok(/chatScrollIntoView: ''/.test(js), 'data 声明 chatScrollIntoView')

const openChat = fnBody(js, 'openChat')
ok(!!openChat, 'openChat 方法存在')
ok(openChat && openChat.includes("util.openSheet(this, 'showChatSheet'"), 'openChat 走 util.openSheet（滑入动画统一）')
ok(openChat && openChat.includes('_scrollChatToBottom'), 'openChat 打开时有消息滚到底')

const closeChat = fnBody(js, 'closeChatSheet')
ok(!!closeChat, 'closeChatSheet 方法存在')
ok(closeChat && closeChat.includes("util.closeSheet(this, 'showChatSheet'"), 'closeChatSheet 走 util.closeSheet（滑出动画统一）')
ok(closeChat && closeChat.includes("chatSheetHeight: '80vh'"), '关闭时还原 sheet 高度（防下次带键盘态进来）')

const kb = fnBody(js, 'onChatKeyboardChange')
ok(!!kb, 'onChatKeyboardChange 方法存在')
ok(kb && kb.includes('screenHeight * 0.5'), '键盘弹起 sheet 收缩到 50vh（首页同策略）')
ok(kb && kb.includes('Math.max(280'), '下限 280px 保证输入框可见')

ok(!!fnBody(js, 'onChatBlur'), 'onChatBlur 兜底还原高度')
ok(!!fnBody(js, 'onReRecord'), 'onReRecord 已实现（与首页对齐）')

const scrollFn = fnBody(js, '_scrollChatToBottom')
ok(!!scrollFn, '_scrollChatToBottom 方法存在')
ok(scrollFn && scrollFn.includes("chatScrollIntoView: ''") && scrollFn.includes("chatScrollIntoView: 'chat-bottom'"),
  '滚底三层保险：重置 scroll-into-view 绕开同值不触发')
ok(scrollFn && scrollFn.includes('_bumpScrollTop(99999)'), '滚底三层保险：scroll-top 累加器兜底')

const hook = fnBody(js, '_chatScrollToBottom')
ok(!!hook && hook.includes('this._scrollChatToBottom()'), 'chatController 钩子 _chatScrollToBottom 委托给页面滚底')

const closeStmt = fnBody(js, 'closeStatement')
ok(closeStmt && closeStmt.includes('showChatSheet'), '关账单 sheet 顺带收掉聊天 sheet（不会剩孤儿弹层）')

const unload = fnBody(js, 'onUnload')
ok(unload && unload.includes('_chatSheetCloseTimer'), 'onUnload 清理 closeSheet 定时器')

const chatStmt = fnBody(js, '_chatStmt')
ok(chatStmt && chatStmt.includes('this.data.statement'), 'AI 上下文仍取 statement（= 账单查看月，月份不错配）')

console.log('== 5. WXSS：样式替换 ==')
ok(!wxss.includes('.stmt-chat'), '旧内嵌聊天样式已清除')
ok(wxss.includes('.chat-sheet {'), '.chat-sheet 样式存在')
ok(/\.chat-sheet\s*{[^}]*padding:\s*0/.test(wxss), 'chat-sheet 覆盖全局 sheet padding（头部通栏）')
ok(wxss.includes('.chat-sheet-title'), '深蓝渐变头部样式')
ok(/\.chat-sheet-history\s*{[^}]*flex:\s*1/.test(wxss.replace(/\n/g, ' ')), '历史区 flex:1 占满中间')
ok(wxss.includes('env(safe-area-inset-bottom)'), '输入行含安全区 padding')
ok(wxss.includes('.chat-sheet-reconfirm'), '「再记一次」虚线 chip 样式')
ok(wxss.includes('.chat-sheet-quick-chip'), '快捷 chip 样式')

console.log('== 6. 语法检查 ==')
const NODE = '/Users/renzhining/.workbuddy/binaries/node/versions/22.22.2/bin/node'
try {
  execFileSync(NODE, ['--check', path.join(PAGES, 'expenses.js')], { stdio: 'pipe' })
  ok(true, 'node --check expenses.js 通过')
} catch (e) {
  ok(false, 'node --check 失败: ' + e.stderr)
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
