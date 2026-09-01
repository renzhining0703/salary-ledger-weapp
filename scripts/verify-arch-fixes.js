/**
 * 架构评审 5 项修复的静态验证脚本
 * 用法:node scripts/verify-arch-fixes.js
 * 覆盖:P0-1 expAgg 双写同步 / 会话云端持久化 / 查询润色 / LLM 熔断 / 首页脏标记
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const finChat = read('cloudfunctions/finChat/index.js')
const aiChat = read('utils/aiChat.js')
const chatSheet = read('components/ai-chat-sheet/ai-chat-sheet.js')
const db = read('utils/db.js')
const index = read('pages/index/index.js')

let pass = 0
let fail = 0
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ok  ${msg}`) }
  else { fail++; console.log(`FAIL  ${msg}`) }
}

console.log('--- 1. P0-1:finChat 写路径补 expAgg 原子自增 ---')
ok(/await bumpExpAgg\(openid, dateStr\.slice\(0, 7\), amountRounded\)/.test(finChat),
  'executeAddExpense 写库成功后调用 bumpExpAgg')
ok(/async function bumpExpAgg\(openid, month, amount\)/.test(finChat),
  'finChat 内有 bumpExpAgg 实现')
ok(/\['expAgg\.' \+ month\]: _\.inc\(/.test(finChat),
  '云端用子文档路径 + _.inc 原子自增(无读改写竞态)')
ok(/if \(!u \|\| !u\.expAgg \|\| typeof u\.expAgg !== 'object'\) return/.test(finChat),
  '快照未回填时跳过(与前端语义一致,交给 reconcile)')
const salaryBody = finChat.slice(
  finChat.indexOf('async function executeAddSalary'),
  finChat.indexOf('async function checkDuplicateSalary')
)
ok(salaryBody.indexOf('bumpExpAgg') < 0,
  'executeAddSalary 函数体不维护 expAgg(只聚合支出,口径正确)')

console.log('--- 1b. P0-1:前端 bumpExpAgg 同步改原子 inc ---')
ok(/\['expAgg\.' \+ month\]: _\.inc\(delta\)/.test(db),
  'utils/db.js bumpExpAgg 改为 _.inc 原子自增')
ok(/expAgg: agg, updatedAt/.test(db) === false,
  '旧的整表覆盖写已移除(不再抹掉云端 AI 记账增量)')

console.log('--- 2. 会话服务端持久化(chatLogs) ---')
ok(/event\.action === 'clearChatLogs'/.test(finChat),
  'finChat 支持 clearChatLogs 动作')
ok(/async function saveChatLog\(/.test(finChat) && /await saveChatLog\(OPENID, q, result\.text, mode\)/.test(finChat)
  && /await saveChatLog\(OPENID, q, text, mode\)/.test(finChat),
  '回答成功后摘要入云(工具/普通问答两条路径)')
ok(/String\(q \|\| ''\)\.slice\(0, 80\)/.test(finChat) && /String\(a \|\| ''\)\.slice\(0, 200\)/.test(finChat),
  '只存摘要(问 ≤80 字 + 答 ≤200 字)控写入量')
ok(/logs\.slice\(-CHAT_LOGS_MAX\)/.test(finChat) && /const CHAT_LOGS_MAX = 40/.test(finChat),
  'LRU 上限 40 条')
ok(/if \(!lastSession\.length\) \{\s*\n\s*lastSession = await loadCloudLastSession\(OPENID\)/.test(finChat),
  '本地无上次会话时从云端 chatLogs 恢复(换设备不失忆)')
ok(/aiChat\.clearCloudSession\(\)/.test(chatSheet),
  '清空会话时同步清云端摘要')
ok(/function clearCloudSession\(\)/.test(aiChat) && /module\.exports = \{ send, buildHistory, clearCloudSession \}/.test(aiChat),
  'aiChat 导出 clearCloudSession')

console.log('--- 3. 查询答案低成本润色 ---')
ok(/async function polishAnswer\(rawText, openid, budget\)/.test(finChat),
  'polishAnswer 实现')
ok(/await polishAnswer\(raw, openid, budget\)/.test(finChat),
  'handleQueryTool / handleCompareTool 返回前过润色')
ok(/timeoutMs: 4500/.test(finChat) && /maxTokens: 260/.test(finChat),
  '润色 4.5s 硬超时 + max_tokens 260(低成本)')
ok(/budget\.used > budget\.limit \* 0\.8/.test(finChat),
  '超预算 80% 时跳过润色(熔断让路)')
ok(/text\.length <= rawText\.length \+ 30/.test(finChat),
  '润色结果异常膨胀时回退模板')
ok(/callLLM\(data, q, mode, history, OPENID, profile, memories, lastSession, budget\)/.test(finChat),
  'budget 从 main 透传到 callLLM')

console.log('--- 4. LLM 成本熔断 ---')
ok(/const DAILY_TOKEN_LIMIT = Number\(process\.env\.LLM_DAILY_TOKEN_LIMIT\) \|\| 120000/.test(finChat),
  '日 token 预算常量(默认 120k,环境变量可覆盖)')
ok(/async function checkTokenBudget\(/.test(finChat) && /await checkTokenBudget\(OPENID\)/.test(finChat),
  '入口处预算检查')
ok(/code: 'COST_LIMIT'/.test(finChat),
  '超限返回 COST_LIMIT')
ok(/async function trackTokens\(/.test(finChat) && /await trackTokens\(openid, usedTokens\)/.test(finChat),
  'callDeepSeek 返回后累计 token')
ok(/callDeepSeek\(\{ messages, tools, temperature \}, openid\)/.test(finChat),
  '主链路 LLM 调用挂 openid 计数')
ok(/code === 'COST_LIMIT'/.test(aiChat),
  '前端 COST_LIMIT 降级到本地模板(finTemplate)')
ok(/doc\.date === todayStr\(\)/.test(finChat),
  '跨天自动重置计数(无需定时任务)')

console.log('--- 5. 首页 onShow 脏标记 ---')
ok(/app\.globalData\.dataDirty = true/.test(db),
  'db.js invalidate() 统一置脏(所有写操作必经)')
ok(/const dirty = !!\(app\.globalData && app\.globalData\.dataDirty\)/.test(index)
  && /this\.loadData\(dirty\)/.test(index),
  'onShow 仅脏时 force,否则吃 60s TTL 缓存')
ok(/this\.loadData\(true\) \/\/ 撤销/.test(index) || /onAiChatRefresh/.test(index),
  'chat refresh 事件仍显式 force(云函数写库兜底)')
ok(/await this\.loadData\(true, true\)/.test(index),
  '下拉刷新保持 force + reconcile 对账')

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
