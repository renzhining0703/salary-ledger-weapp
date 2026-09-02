/**
 * 验证:T2.1 订阅断舍离价值评估(finChat 加 evaluate_subscription 工具)
 * - cloudfunctions/finChat/index.js:
 *   1. TOOL_DEFS 含 evaluate_subscription 工具 schema(name 参数,required=['name'])
 *   2. QUERY_TOOLS 数组含 'evaluate subscription'
 *   3. callLLM 工具分发处有 evaluate subscription 分支
 *   4. executeEvaluateSubscription 查库 + 计算年化 + 模糊匹配 name/platform
 *   5. handleEvaluateSubscription 走 handleQueryTool 模式:查库 → 拼确定性事实 → 评估 LLM
 *   6. polishEvaluateAnswer 评估专用 system prompt:数字纪律 + 不编免费平替价格 + usage 缺失强制问
 *   7. PROMPT_CHAT 含 evaluate_subscription 触发场景 + 评估硬规则
 *
 * 验收:账本君问「爱奇艺还值不值」→ 工具被调用,云函数查订阅事实,返回结构化评估(含年化金额、频率判断、平替建议)
 *
 * 运行: node scripts/verify-subscription-eval.js
 */
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

let pass = 0
let fail = 0
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.log(`  ✗ ${msg}`) }
}
const NODE = process.execPath

/* ---------------- 1. finChat/index.js 加载 ---------------- */
console.log('== 1. cloudfunctions/finChat/index.js ==')
const code = read('cloudfunctions/finChat/index.js')

/* ---------------- 2. TOOL_DEFS: evaluate_subscription schema ---------------- */
console.log('\n== 2. TOOL_DEFS 含 evaluate_subscription 工具 ==')
ok(/name:\s*'evaluate_subscription'/.test(code), 'TOOL_DEFS 数组含 evaluate_subscription 工具条目')
ok(/name:\s*'evaluate_subscription'[\s\S]*?description:\s*'.*断舍离/s.test(code), 'description 提及「断舍离」价值评估')
ok(/name:\s*'evaluate_subscription'[\s\S]*?要不要留[\s\S]*?值不值/s.test(code), 'description 包含触发场景示例(要不要留/值不值)')
ok(/name:\s*'evaluate_subscription'[\s\S]*?parameters:\s*\{[\s\S]*?properties:\s*\{[\s\S]*?name:\s*\{\s*type:\s*'string'[\s\S]*?description:\s*'订阅名称或平台/s.test(code), 'parameters.properties.name 是 string(订阅名称或平台)')
ok(/name:\s*'evaluate_subscription'[\s\S]*?required:\s*\[\s*'name'\s*\]/.test(code), 'evaluate_subscription 必填 name')

/* ---------------- 3. QUERY_TOOLS 注册 ---------------- */
console.log('\n== 3. QUERY_TOOLS 注册 ==')
ok(/const\s+QUERY_TOOLS\s*=\s*\[[^\]]*'evaluate_subscription'/.test(code), 'QUERY_TOOLS 数组含 \'evaluate subscription\'')
// 严格把 'evaluate_subscription' 锁定在 RECORD_TOOLS 数组的 [ ] 之间,不能跨越到 QUERY_TOOLS
ok(!/const\s+RECORD_TOOLS\s*=\s*\[[^\]]*'evaluate_subscription'/.test(code), 'evaluate_subscription 不在 RECORD_TOOLS(纯查询工具)')

/* ---------------- 4. 工具分发 switch ---------------- */
console.log('\n== 4. callLLM 工具分发 ==')
ok(/if\s*\(\s*fname\s*===\s*'evaluate_subscription'\s*\)\s*\{[\s\S]*?handleEvaluateSubscription\(call,\s*openid,\s*budget\)/.test(code), 'callLLM 分发:evaluate_subscription → handleEvaluateSubscription(call, openid, budget)')

/* ---------------- 5. executeEvaluateSubscription 执行器 ---------------- */
console.log('\n== 5. executeEvaluateSubscription 执行器 ==')
ok(/async\s+function\s+executeEvaluateSubscription\s*\(\s*args,\s*openid\s*\)/.test(code), 'executeEvaluateSubscription(args, openid) 函数存在')
ok(/executeEvaluateSubscription[\s\S]*?db\.collection\('subscriptions'\)/.test(code), '查 subscriptions 集合(非其他集合名)')
ok(/executeEvaluateSubscription[\s\S]*?deleted:\s*_\.neq\(true\)/.test(code), '过滤 deleted=true(走软删)')
ok(/executeEvaluateSubscription[\s\S]*?_openid:\s*openid/.test(code), 'where 显式带 _openid(防跨用户)')
// 模糊匹配:JS 端 .includes 兜一层(防 RegExp 转义)
ok(/executeEvaluateSubscription[\s\S]*?\.includes\(q\)/.test(code), 'name 模糊匹配:.includes(q) 兜一层(中文/英文/平台名都能 hit)')
// 年化金额公式:monthly×12 + yearly×1 + quarterly×4 + weekly×52
ok(/executeEvaluateSubscription[\s\S]*?monthly:\s*12,\s*quarterly:\s*4,\s*yearly:\s*1,\s*weekly:\s*52/.test(code), '年化金额公式:monthly×12 + yearly×1 + quarterly×4 + weekly×52')
// 同名多条排序:active 优先 + nextCharge asc
ok(/executeEvaluateSubscription[\s\S]*?status\s*===\s*'active'\s*\)\s*\?\s*0\s*:\s*1/.test(code), '同名多条:active 优先(0=active,1=非 active)')
ok(/executeEvaluateSubscription[\s\S]*?localeCompare/.test(code), '同名多条:nextCharge asc(最近要扣的优先)')
// 找不到时返回 found: false
ok(/executeEvaluateSubscription[\s\S]*?if\s*\(!docs\.length\)\s*return\s*\{\s*found:\s*false\s*\}/.test(code), '无匹配返回 found:false(供 handler 转友好文案)')

/* ---------------- 6. handleEvaluateSubscription 分发 ---------------- */
console.log('\n== 6. handleEvaluateSubscription 查库+评估 ==')
ok(/async\s+function\s+handleEvaluateSubscription\s*\(\s*call,\s*openid,\s*budget\s*\)/.test(code), 'handleEvaluateSubscription(call, openid, budget) 函数存在')
ok(/handleEvaluateSubscription[\s\S]*?const\s+name\s*=\s*String\(args\.name\s*\|\|\s*''\)\.trim\(\)/.test(code), 'handler 校验 name(trim 后非空检查)')
ok(/handleEvaluateSubscription[\s\S]*?args\.name\s*\|\|\s*''\)\.trim\(\)[\s\S]*?if\s*\(\s*!name\s*\)/.test(code), 'handler name 空兜底文案「想评估哪个订阅」')
ok(/handleEvaluateSubscription[\s\S]*?withTimeout\(\s*executeEvaluateSubscription/.test(code), 'handler 走 5s 超时(同 handleQueryTool)')
ok(/handleEvaluateSubscription[\s\S]*?if\s*\(\s*!result\.found\s*\)/.test(code), 'handler 未找到走「还没记录 XX」文案')
ok(/handleEvaluateSubscription[\s\S]*?formatEvaluateAnswer\(result\)/.test(code), 'handler 拼事实块调 formatEvaluateAnswer')
ok(/handleEvaluateSubscription[\s\S]*?polishEvaluateAnswer\(\s*raw,\s*openid,\s*budget\s*\)/.test(code), 'handler 第 2 次 LLM 调 polishEvaluateAnswer(评估专用,非 polishAnswer 文案润色)')

/* ---------------- 7. formatEvaluateAnswer 事实块 ---------------- */
console.log('\n== 7. formatEvaluateAnswer 事实块 ==')
ok(/function\s+formatEvaluateAnswer\s*\(/.test(code), 'formatEvaluateAnswer 函数存在')
ok(/formatEvaluateAnswer[\s\S]*?【订阅评估事实】/.test(code), '事实块以「【订阅评估事实】」开头(让 LLM 识别为事实数据)')
ok(/formatEvaluateAnswer[\s\S]*?年化金额:\s*¥\$\{r\.yearly/.test(code), '事实块含年化金额(LLM 必须原样引用)')
ok(/formatEvaluateAnswer[\s\S]*?使用频率自评:/.test(code), '事实块含使用频率自评(评估核心输入)')
// usage 缺失/rare/never → 强制引导用户确认
ok(/formatEvaluateAnswer[\s\S]*?【评估前置】[\s\S]*?结论前必须先问用户/.test(code), 'usage 缺失/rare/never 时追加「【评估前置】」段,强制 LLM 先问用户')
ok(/formatEvaluateAnswer[\s\S]*?r\.usage\s*===\s*['"]rare['"][\s\S]*?r\.usage\s*===\s*['"]never['"]/.test(code), '触发「【评估前置】」的条件:usage 缺失/rare/never')

/* ---------------- 8. polishEvaluateAnswer 评估 LLM 硬规则 ---------------- */
console.log('\n== 8. polishEvaluateAnswer 评估专用 LLM ==')
ok(/async\s+function\s+polishEvaluateAnswer\s*\(\s*rawText,\s*openid,\s*budget\s*\)/.test(code), 'polishEvaluateAnswer 函数存在')
ok(/polishEvaluateAnswer[\s\S]*?4\.5\d*\s*[\s\S]*?4500/.test(code), '4.5s 硬超时(同 polishAnswer 安全阀)')
ok(/polishEvaluateAnswer[\s\S]*?budget\.used\s*>\s*budget\.limit\s*\*\s*0\.8/.test(code), '80% token 熔断(超预算跳过润色)')
ok(/polishEvaluateAnswer[\s\S]*?temperature:\s*0\.5/.test(code), 'temperature=0.5(平衡判断力与创造性,同 finReport)')
ok(/polishEvaluateAnswer[\s\S]*?maxTokens:\s*320/.test(code), 'max_tokens=320(评估比润色长一点,够 4 段结构)')
// 评估 system prompt 硬规则
ok(/polishEvaluateAnswer[\s\S]*?结论[\s\S]*?依据[\s\S]*?免费平替[\s\S]*?省钱数字/.test(code), '评估结构硬约束:结论→依据→免费平替→省钱数字')
ok(/polishEvaluateAnswer[\s\S]*?不得编造[\s\S]*?具体价格/.test(code), '硬规则:不得编造免费平替具体价格')
ok(/polishEvaluateAnswer[\s\S]*?数字必须[\s\S]*?原样照抄事实块/.test(code), '硬规则:数字必须原样照抄事实块')
ok(/polishEvaluateAnswer[\s\S]*?事实块里若含【评估前置】[\s\S]*?必须先用一句话问用户使用频率/.test(code), '硬规则:事实块含【评估前置】时 LLM 必须先问使用频率')
ok(/polishEvaluateAnswer[\s\S]*?不得新增事实块里没有的信息/.test(code), '硬规则:不得编造事实块外的信息')

/* ---------------- 9. PROMPT_CHAT 评估规则 ---------------- */
console.log('\n== 9. PROMPT_CHAT 评估规则 ==')
ok(/PROMPT_CHAT[\s\S]*?evaluate_subscription\(订阅断舍离评估\)/.test(code), 'PROMPT_CHAT 工具清单列出 evaluate_subscription')
ok(/PROMPT_CHAT[\s\S]*?evaluate_subscription[\s\S]*?爱奇艺还值不值[\s\S]*?续不续/.test(code), 'PROMPT_CHAT 给出触发场景示例(爱奇艺值不值/续不续)')
// 评估硬规则同步到主对话 prompt
ok(/PROMPT_CHAT[\s\S]*?数字只能来自订阅事实块/.test(code), 'PROMPT_CHAT 同步评估硬规则:数字只能来自事实块')
ok(/PROMPT_CHAT[\s\S]*?usage\s*是评估核心[\s\S]*?只能靠用户自评/.test(code), 'PROMPT_CHAT 强调 usage 只能用户自评,不允许 AI 编')
ok(/PROMPT_CHAT[\s\S]*?不得编造具体价格/.test(code), 'PROMPT_CHAT 强调不得编免费平替价格')

/* ---------------- 10. 安全阀与边界 ---------------- */
console.log('\n== 10. 安全阀与边界 ==')
ok(/handleEvaluateSubscription[\s\S]*?JSON\.parse[\s\S]*?catch[\s\S]*?评估参数解析失败/.test(code), 'args JSON.parse 兜底:解析失败给友好文案')
ok(/handleEvaluateSubscription[\s\S]*?查订阅数据时出了点问题/.test(code), '查库异常兜底文案')
ok(/handleEvaluateSubscription[\s\S]*?还没记录[\s\S]*?这个订阅[\s\S]*?先去订阅页加一条/.test(code), '未找到订阅兜底:引导用户去订阅页加一条')
ok(!/handleEvaluateSubscription[\s\S]*?await\s+executeEvaluateSubscription[\s\S]*?await\s+executeEvaluateSubscription/s.test(code), 'handler 不重复 await executeEvaluateSubscription(单次查库)')

/* ---------------- 11. 语法检查 ---------------- */
console.log('\n== 11. 语法检查 ==')
try {
  execSync(`"${NODE}" --check "${path.join(ROOT, 'cloudfunctions/finChat/index.js')}"`, { stdio: 'pipe' })
  pass++
  console.log('  ✓ cloudfunctions/finChat/index.js 语法通过')
} catch (e) {
  fail++
  console.log(`  ✗ cloudfunctions/finChat/index.js: ${(e.stderr || '').toString().split('\n')[0]}`)
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
