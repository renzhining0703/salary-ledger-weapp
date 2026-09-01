/**
 * 验证:账本君数据喂养 C8+C9(长期记忆工具 + 跨会话去重)
 * C8:finChat saveMemory/forgetMemory 工具 → users.aiMemories → buildMessages 注入【长期记忆】
 * C9:chatController 冷启动 lastSession → aiChat.send 透传 → buildMessages 注入【上次对话结尾】
 * 运行:node scripts/verify-feed-c89.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

let pass = 0
let fail = 0
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.log(`  ✗ ${msg}`) }
}

/** 提取函数体:优先 function name( 形式,回退对象方法 name(args) { 形式 */
function fnBody(src, name) {
  let idx = src.indexOf(`function ${name}(`)
  let closer = '\n}'
  if (idx < 0) {
    const re = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*\\{`)
    const m = re.exec(src)
    if (!m) return ''
    idx = m.index
    closer = '\n  },'
  }
  const end = src.indexOf(closer, idx)
  return src.slice(idx, end > 0 ? end : undefined)
}

const fc = read('cloudfunctions/finChat/index.js')

console.log('== 1. TOOL_DEFS 记忆工具定义 ==')
ok(fc.includes("name: 'saveMemory'"), 'TOOL_DEFS 定义 saveMemory')
ok(fc.includes("name: 'forgetMemory'"), 'TOOL_DEFS 定义 forgetMemory')
ok(/saveMemory[\s\S]{0,600}亲口明确表达长期目标/.test(fc), 'saveMemory description 限定「亲口明确表达」')
ok(/saveMemory[\s\S]{0,800}不调用/.test(fc), 'saveMemory description 含「不调用」负面清单(防自作主张)')
ok(/forgetMemory[\s\S]{0,500}不调用/.test(fc), 'forgetMemory description 限定「问"记住了什么"时不调用」')

console.log('== 2. main 入口 ==')
ok(/const memories = await loadMemories\(OPENID\)/.test(fc), 'main 读长期记忆')
ok(/const lastSession = sanitizeHistory\(event && event\.lastSession\)/.test(fc), 'main 解析+清洗 lastSession')
ok(/callLLM\(data, q, mode, history, OPENID, profile, memories, lastSession\)/.test(fc), 'callLLM 收到 memories+lastSession')

console.log('== 3. callLLM 工具挂载与分发 ==')
const call = fnBody(fc, 'callLLM')
ok(call.length > 0, 'callLLM 函数体提取成功')
ok(/buildMessages\(data, question, mode, history, profile, memories, lastSession\)/.test(call), 'callLLM 传递 memories+lastSession 给 buildMessages')
ok(/RECORD_TOOLS = \[[^\]]*'saveMemory'[^\]]*'forgetMemory'/.test(call), 'record 模式挂载记忆工具')
ok(/QUERY_TOOLS = \['saveMemory', 'forgetMemory'/.test(call), 'chat 模式挂载记忆工具')
ok(/fname === 'saveMemory' \|\| fname === 'forgetMemory'/.test(call), '工具分发有记忆分支')
ok(/handleMemoryTool\(call, fname, openid\)/.test(call), '分发到 handleMemoryTool')
// 记忆分支必须在 addExpense 校验分支之前(否则被未知工具兜底拦截)
ok(call.indexOf("fname === 'saveMemory'") < call.indexOf("fname !== 'addExpense'"), '记忆分支位于 addExpense 校验之前')

console.log('== 4. buildMessages 注入 ==')
const bm = fnBody(fc, 'buildMessages')
ok(bm.length > 0, 'buildMessages 函数体提取成功')
ok(/【长期记忆】/.test(bm) && /memories\.slice\(0, 10\)/.test(bm), '注入【长期记忆】块(top-10)')
ok(/【上次对话结尾】/.test(bm) && /跨会话参考/.test(bm), '注入【上次对话结尾】块')
ok(/!hist\.length && Array\.isArray\(lastSession\) && lastSession\.length/.test(bm), '上次对话仅 history 为空时注入(会话内不重复)')
ok(/lastSession\.slice\(-8\)/.test(bm), '上次对话取尾部 8 条')
// 顺序:画像 → 长期记忆 → 上次对话 → 本月数据 → 用户问题
const pProfile = bm.indexOf('【用户画像】')
const pMem = bm.indexOf('【长期记忆】')
const pLast = bm.indexOf('【上次对话结尾】')
const pData = bm.indexOf('【本月数据】')
const pQ = bm.indexOf('【用户问题】')
ok(pProfile < pMem && pMem < pLast && pLast < pData && pData < pQ, '块顺序:画像→记忆→上次对话→数据→问题')

console.log('== 5. 记忆执行层 ==')
const lm = fnBody(fc, 'loadMemories')
ok(lm.length > 0, 'loadMemories 提取成功')
ok(/aiMemories/.test(lm) && /return \[\]/.test(lm), '读 users.aiMemories,异常返回空数组')
const sm = fnBody(fc, 'executeSaveMemory')
ok(sm.length > 0, 'executeSaveMemory 提取成功')
ok(/list\.indexOf\(text\) >= 0[\s\S]*unchanged/.test(sm), '完全相同记忆去重(unchanged)')
ok(/while \(list\.length > 10\) list\.pop\(\)/.test(sm), 'LRU 上限 10 条')
ok(/slice\(0, 60\)/.test(sm), '记忆文本截断 60 字')
const fm = fnBody(fc, 'executeForgetMemory')
ok(fm.length > 0, 'executeForgetMemory 提取成功')
ok(/m\.indexOf\(kw\) < 0/.test(fm), 'keyword 模糊匹配删除')
ok(/aiMemories: \[\]/.test(fm), '空 keyword 清空全部')
const hmt = fnBody(fc, 'handleMemoryTool')
ok(hmt.length > 0, 'handleMemoryTool 提取成功')
ok(/记住了：/.test(hmt) && /可删除/.test(hmt), 'saveMemory 确定性确认语(含删除指引)')
ok(/added: false, memory: true/.test(hmt), 'toolResult.added=false → 前端不出撤销按钮')
ok(!/callDeepSeek/.test(hmt), '不追加 LLM 调用(504003 超时教训)')

console.log('== 6. 前端 chatController 冷启动 ==')
const cc = read('utils/chatController.js')
ok(/lastSession = \(app\.globalData\.chatMessages \|\| \[\]\)\.length/.test(cc), '冷启动判定 globalData.chatMessages 为空')
ok(/\? null\s*\n\s*: aiChat\.buildHistory\(chatStorage\.load\(\)\)/.test(cc), '空时从 chatStorage.load() 构建上次对话')
ok(/lastSession\s*\n\s*\}\)/.test(cc), 'lastSession 随 aiChat.send 传云端')

console.log('== 7. aiChat.send 透传 ==')
const ai = read('utils/aiChat.js')
ok(/lastSession: Array\.isArray\(lastSession\) && lastSession\.length \? lastSession : undefined/.test(ai), 'lastSession 透传(空不发省流量)')
ok(/async function send\(\{ month, stmt, recentList, question, mode = 'chat', history, lastSession \}\)/.test(ai), 'send 签名含 lastSession')

console.log('== 8. finReport 不涉及 ==')
const fr = read('cloudfunctions/finReport/index.js')
ok(!fr.includes('aiMemories') && !fr.includes('lastSession'), 'finReport 不涉及新机制')

console.log('== 9. 语法检查 ==')
const { execSync } = require('child_process')
const NODE = '/Users/renzhining/.workbuddy/binaries/node/versions/22.22.2/bin/node'
for (const f of ['cloudfunctions/finChat/index.js', 'utils/aiChat.js', 'utils/chatController.js']) {
  try {
    execSync(`"${NODE}" --check "${path.join(ROOT, f)}"`, { stdio: 'pipe' })
    pass++
    console.log(`  ✓ ${f} 语法通过`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${f} 语法错误: ${e.stderr}`)
  }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
