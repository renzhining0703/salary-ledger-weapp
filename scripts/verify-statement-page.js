/**
 * 验证：账单弹框迁移为独立页面 + 账本君聊天 sheet 抽公共组件
 *
 * 改动点：
 * 1. 记账页「查看本月账单」→ wx.navigateTo 跳转 pages/statement（标题「x月账单」）
 * 2. 账单弹框全部样式（Hero/环比/分类/AI 解读/分类预算）迁移到 statement 页
 * 3. 账本君聊天弹框抽为公共组件 components/ai-chat-sheet，首页与账单页共用同一套
 * 4. 记账页 / 首页删除各自的内联聊天实现，chatController 行为不再被引用
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const appJson = JSON.parse(read('app.json'))
const expensesJs = read('pages/expenses/expenses.js')
const expensesWxml = read('pages/expenses/expenses.wxml')
const expensesWxss = read('pages/expenses/expenses.wxss')
const expensesJson = read('pages/expenses/expenses.json')
const stmtJs = read('pages/statement/statement.js')
const stmtWxml = read('pages/statement/statement.wxml')
const stmtJson = read('pages/statement/statement.json')
const compJs = read('components/ai-chat-sheet/ai-chat-sheet.js')
const compWxml = read('components/ai-chat-sheet/ai-chat-sheet.wxml')
const compJson = read('components/ai-chat-sheet/ai-chat-sheet.json')
const idxJs = read('pages/index/index.js')
const idxWxml = read('pages/index/index.wxml')
const idxJson = read('pages/index/index.json')

let pass = 0
let fail = 0
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg) }
  else { fail++; console.log('  ✗ ' + msg) }
}

console.log('== 1. 账单独立页面注册与标题 ==')
ok(appJson.pages.includes('pages/statement/statement'), 'app.json 注册 statement 页')
ok(stmtJs.includes("CN_MONTHS"), 'statement.js 中文月份数组（九月账单）')
ok(stmtJs.includes('wx.setNavigationBarTitle'), 'onLoad 动态设置页面标题')
ok(stmtJs.includes("options.month") || stmtJs.includes('options && options.month'), 'onLoad 接收 month 参数')
ok(stmtJs.includes('shiftMonth(month, -1)'), '环比上月数据')
ok(stmtJs.includes('shiftMonth(month, -12)'), '去年同月数据（AI 上下文）')
ok(stmtJs.includes('k < month'), '累计支出：历史用快照 + 本月实际（expAgg 漂移修复口径）')
ok(stmtJs.includes('finReport'), 'AI 解读调 finReport 云函数')
ok(stmtJs.includes('finTemplate.build'), 'AI 解读失败回退本地模板')

console.log('== 2. statement 页复用公共聊天组件 ==')
const stmtUsing = JSON.parse(stmtJson).usingComponents || {}
ok(stmtUsing['ai-chat-sheet'] === '/components/ai-chat-sheet/ai-chat-sheet', 'statement.json 注册 ai-chat-sheet')
ok(/<ai-chat-sheet[\s\S]*?bindclose="onChatClose"/.test(stmtWxml), 'statement.wxml 使用组件 + close 事件')
ok(stmtWxml.includes('bindrefresh="onChatRefresh"'), '记账/撤销后刷新事件接线')
ok(stmtWxml.includes('openChat'), '「有问题问账本君」入口')
ok(stmtJs.includes('onChatRefresh()'), 'onChatRefresh 强刷数据（force）')

console.log('== 3. 记账页：弹框已移除，入口改跳页 ==')
ok(expensesJs.includes("wx.navigateTo({ url: '/pages/statement/statement?month='"), 'openStatement 改 wx.navigateTo 跳转')
ok(!expensesWxml.includes('showStatement'), 'expenses.wxml 无账单弹框标记')
ok(!expensesWxml.includes('showChatSheet'), 'expenses.wxml 无内联聊天弹框标记')
ok(!expensesWxml.includes('showCatBudget'), 'expenses.wxml 无分类预算弹框标记')
ok(!expensesJs.includes('chatController'), 'expenses.js 不再引用 chatController')
ok(!expensesJs.includes('_buildStatementData'), 'expenses.js 账单拼装逻辑已删除')
ok(!expensesJs.includes('finTemplate'), 'expenses.js 不再依赖 finTemplate')
ok(!expensesWxss.includes('.stmt-hero'), 'expenses.wxss 账单样式已迁移')
ok(!expensesWxss.includes('.chat-sheet-'), 'expenses.wxss 聊天样式已迁移')
ok(!expensesWxss.includes('.page-locked'), 'expenses.wxss page-locked 锁滚样式已移除')

console.log('== 4. 公共组件结构完整性 ==')
ok(JSON.parse(compJson).component === true, 'ai-chat-sheet.json 声明 component')
ok(compJs.includes("styleIsolation: 'apply-shared'"), 'apply-shared 复用全局样式')
for (const m of ['sendChat', 'onQuickChipTap', 'onUndoAiRecord', 'onReRecord', 'onKeyboardChange', '_scrollToBottom', 'syncMessages', 'clear', 'close']) {
  ok(new RegExp(m + '\\s*\\(').test(compJs), '组件方法 ' + m + ' 存在')
}
ok(compJs.includes('RATE_LIMIT_PER_MIN'), '组件内置节流')
ok(compJs.includes('_startUndoCountdown'), '组件内置撤销倒计时')
ok(compJs.includes("triggerEvent('refresh')"), '记账/撤销后通知宿主刷新')
ok(compJs.includes("triggerEvent('close')"), '关闭动画结束通知宿主')
ok(compJs.includes("triggerEvent('clear')"), '清空会话通知宿主')
ok(compJs.includes('<slot name="head">'.replace(/<|>/g, '')) || compWxml.includes('<slot name="head">'), '组件提供 head 插槽')

console.log('== 5. 首页：改用公共组件，删除内联实现 ==')
const idxUsing = JSON.parse(idxJson).usingComponents || {}
ok(idxUsing['ai-chat-sheet'] === '/components/ai-chat-sheet/ai-chat-sheet', 'index.json 注册 ai-chat-sheet')
ok(idxWxml.includes('<ai-chat-sheet'), 'index.wxml 使用公共组件')
ok(idxWxml.includes('slot="head"'), '首页插槽注入询问气泡/订阅引导/上次摘要')
ok(idxWxml.includes('bindbeforesend="onAiChatBeforeSend"'), 'beforesend 事件接线')
ok(idxJs.includes('onAiChatClose()') || /onAiChatClose\s*\(/.test(idxJs), 'onAiChatClose 处理关闭')
ok(idxJs.includes('onAiChatClear') , 'onAiChatClear 处理清空')
ok(idxJs.includes('onAiChatRefresh'), 'onAiChatRefresh 刷新数据')
ok(idxJs.includes('onAiChatBeforeSend'), 'onAiChatBeforeSend 清未读询问')
ok(idxJs.includes('_buildAiStmt()'), '_buildAiStmt 保留（aiStmt 数据源）')
ok(!idxJs.includes('behaviors: [chatController]'), 'index.js 不再挂 chatController behavior')
ok(!idxJs.includes('onAiKeyboardChange'), 'index.js 键盘自适应逻辑已入组件')
ok(!idxJs.includes('_scrollChatToBottom'), 'index.js 滚底逻辑已入组件')
ok(!idxWxml.includes('bindconfirm="sendChat"'), 'index.wxml 无内联输入框')
ok(!idxWxml.includes('quickChips'), 'index.wxml 无内联快捷 chip')

console.log('== 6. 两入口共用一套弹框（核心诉求） ==')
ok(compJs.includes('globalData.chatMessages'), '组件读写 globalData 会话（首页↔账单页接着聊）')
ok(idxWxml.includes('<ai-chat-sheet') && stmtWxml.includes('<ai-chat-sheet'), '首页与账单页都引用同一组件')

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail > 0 ? 1 : 0)
