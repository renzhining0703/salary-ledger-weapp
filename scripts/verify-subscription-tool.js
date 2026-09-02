/**
 * 验证:T1.4 AI 智能录入(finChat 加 addSubscription 工具)
 * - cloudfunctions/finChat/index.js:
 *   1. TOOL_DEFS 含 addSubscription 工具 schema
 *      (name/amount/cycle/nextCharge 主录入 + cycleDay 降级/usage/platform/payChannel)
 *   2. executeAddSubscription 安全校验 + 「口径归一」:nextCharge → cycleDay + firstChargeDate + _openid 显式写入
 *   3. RECORD_TOOLS 数组含 'addSubscription'
 *   4. 工具分发处有 addSubscription 分支(handleSubscriptionTool)
 *   5. PROMPT_RECORD 含 addSubscription 使用规则 + 触发词 + nextCharge 主录入字段说明
 * - 验收:账本君对话输入「记个订阅 爱奇艺每月25」→ 工具被调用,subscriptions 集合多一条记录,回复带确认语
 *        输入「爱奇艺到9月15号每年298」→ nextCharge=2026-09-15 正确入库,cycleDay=15,firstChargeDate=2025-09-15
 *
 * 运行: node scripts/verify-subscription-tool.js
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

/* ---------------- 2. TOOL_DEFS: addSubscription schema ---------------- */
console.log('\n== 2. TOOL_DEFS 含 addSubscription 工具 ==')
ok(/name:\s*'addSubscription'/.test(code), 'TOOL_DEFS 数组含 addSubscription 工具条目')
ok(/name:\s*'addSubscription'[\s\S]*?description:\s*'.*订阅.*自动续费/s.test(code), 'addSubscription description 提及订阅/自动续费')
ok(/name:\s*'addSubscription'[\s\S]*?爱奇艺到9月15号每年298/.test(code), 'description 包含新示例「爱奇艺到9月15号每年298」')
ok(/name:\s*'addSubscription'[\s\S]*?腾讯视频半年包88\s*到期/.test(code) || /name:\s*'addSubscription'[\s\S]*?腾讯视频[\s\S]{0,60}?半年包/.test(code), 'description 包含新示例「腾讯视频半年包88」')
ok(/name:\s*'addSubscription'[\s\S]*?nextCharge\s*是\s*\*?\*?主录入字段/.test(code) || /name:\s*'addSubscription'[\s\S]*?nextCharge[\s\S]{0,200}?主录入字段/.test(code), 'description 标注 nextCharge 是主录入字段')
ok(/name:\s*'addSubscription'[\s\S]*?parameters:\s*\{[\s\S]*?properties:\s*\{[\s\S]*?name:\s*\{\s*type:\s*'string'/.test(code), 'parameters.properties.name 是 string')
ok(/amount:\s*\{\s*type:\s*'number',\s*description:\s*'单期金额/.test(code), 'parameters.properties.amount 是 number(单期金额)')
ok(/cycle:\s*\{[\s\S]*?enum:\s*\[\s*'monthly',\s*'yearly',\s*'quarterly',\s*'weekly',\s*'custom'\s*\]/.test(code), 'cycle enum 含 monthly/yearly/quarterly/weekly/custom 五种周期')
ok(/cycle:\s*\{[\s\S]*?enum:\s*\[\s*'monthly',\s*'yearly',\s*'quarterly',\s*'weekly',\s*'custom'\s*\][\s\S]*?description:[\s\S]*?半年包|半年包.*腾讯视频|腾讯视频.*半年包/.test(code), 'cycle enum.description 提示 custom 用于半年包 / 季包等期限包(腾讯视频半年包 88 示例)')
ok(/nextCharge:\s*\{[\s\S]*?type:\s*'string'/.test(code), 'nextCharge 字段存在(type=string)')
ok(/nextCharge:\s*\{[\s\S]*?description:\s*'.*下次扣费|下次扣费.*首次到期/.test(code) || /nextCharge:\s*\{[\s\S]*?首次到期日期/.test(code), 'nextCharge 描述含「下次扣费日期 / 首次到期日期」')
ok(/cycleDay:\s*\{[\s\S]*?description:\s*'.*降级兜底/.test(code) || /cycleDay[\s\S]*?降级/.test(code), 'cycleDay 描述标注「降级兜底」(用户只记得每月几号时用)')
ok(/cycleDay[\s\S]*?传了\s*nextCharge\s*就不要传/.test(code), 'cycleDay description 标注「传了 nextCharge 就不要传」')
ok(/usage:\s*\{[\s\S]*?enum:\s*\[\s*'frequent',\s*'occasional',\s*'rare',\s*'never'\s*\]/.test(code), 'usage enum 含 frequent/occasional/rare/never 四种频率')
ok(/platform:\s*\{\s*type:\s*'string',\s*description:[\s\S]*?扣费平台/.test(code), 'platform 字段存在(可选扣费平台)')
ok(/required:\s*\[\s*'name',\s*'amount',\s*'nextCharge'\s*\]/.test(code), 'addSubscription 必填 name + amount + nextCharge(分层追问:缺 nextCharge 不准发起调用)')

/* ---------------- 3. executeAddSubscription 实现 ---------------- */
console.log('\n== 3. executeAddSubscription 执行器 ==')
ok(/async\s+function\s+executeAddSubscription\s*\(args,\s*openid\)/.test(code), 'executeAddSubscription(args, openid) 函数存在')
ok(/executeAddSubscription[\s\S]*?openid 空值拦截[\s\S]*?用户身份异常/.test(code) || /openid 拦截[\s\S]*?用户身份异常/.test(code), 'openid 空值拦截逻辑')
ok(/executeAddSubscription[\s\S]*?CYCLE_WHITELIST\s*=\s*\[\s*'monthly',\s*'yearly',\s*'quarterly',\s*'weekly',\s*'custom'\s*\]/.test(code), 'cycle 白名单(月/季/年/周/custom)')
ok(/executeAddSubscription[\s\S]*?USAGE_WHITELIST\s*=\s*\[\s*'frequent',\s*'occasional',\s*'rare',\s*'never'\s*\]/.test(code), 'usage 白名单(四档频率)')
ok(/executeAddSubscription[\s\S]*?amountRounded\s*=\s*Math\.round\(amount\s*\*\s*100\)\s*\/\s*100/.test(code), '金额保留 2 位小数')
ok(/executeAddSubscription[\s\S]*?nextCharge[\s\S]*?deriveCycleDay\(cycle,\s*nextCharge\)/.test(code), '口径归一路径 A:传 nextCharge → 调 deriveCycleDay 反推 cycleDay')
ok(/executeAddSubscription[\s\S]*?deriveFirstChargeDate_\(cycle,\s*nextCharge/.test(code), '口径归一路径 A:传 nextCharge → 调 deriveFirstChargeDate_ 反推 firstChargeDate')
ok(/executeAddSubscription[\s\S]*?fallbackNextCharge\(cycle,\s*cycleDay\)/.test(code), '口径归一路径 B:只传 cycleDay → 调 fallbackNextCharge 反填 nextCharge')
ok(/executeAddSubscription[\s\S]*?nextCharge\s*=\s*fallbackNextCharge\(cycle,\s*cycleDay\)/.test(code) || /nextCharge\s*=\s*[\s\S]{0,40}?fallbackNextCharge/.test(code), '口径归一路径 C:啥都没传 → fallbackNextCharge(用 cycleDay 兜底)反推 nextCharge')
ok(/executeAddSubscription[\s\S]*?db\.collection\('subscriptions'\)/.test(code), '写 subscriptions 集合(非其他集合名)')
const subAddBlock = /db\.collection\('subscriptions'\)\.add\(\{[\s\S]*?data:\s*\{([\s\S]*?)\}\s*\}\)/.exec(code)
ok(subAddBlock && /_openid:\s*openid/.test(subAddBlock[1]), 'subscriptions add 显式带 _openid')
ok(subAddBlock && /\bname\b/.test(subAddBlock[1]) && /\bplatform\b/.test(subAddBlock[1]) && /\bamount:\s*amountRounded/.test(subAddBlock[1]), 'subscriptions add 含 name/platform/amount 字段')
ok(subAddBlock && /\bcycle\b/.test(subAddBlock[1]) && /\bcycleDay\b/.test(subAddBlock[1]) && /\bnextCharge\b/.test(subAddBlock[1]), 'subscriptions add 含 cycle/cycleDay/nextCharge 字段')
ok(subAddBlock && /\bfirstChargeDate\b/.test(subAddBlock[1]), 'subscriptions add 含 firstChargeDate 字段(从 nextCharge 反推)')
ok(subAddBlock && /\busage\b/.test(subAddBlock[1]) && /status:\s*'active'/.test(subAddBlock[1]), 'subscriptions add 含 usage + status=active')
ok(/executeAddSubscription[\s\S]*?doc\._openid\s*!==\s*openid/.test(code), '写入验证:按 _id 回查校验 _openid')
ok(/executeAddSubscription[\s\S]*?return\s*\{[\s\S]*?type:\s*'subscription'[\s\S]*?record:\s*\{[\s\S]*?name,[\s\S]*?nextCharge[\s\S]*?\}/.test(code), '成功返回 type:subscription + record{name,nextCharge...}')

/* ---------------- 4. 云函数侧 nextChargeOf / deriveCycleDay / deriveFirstChargeDate_ ---------------- */
console.log('\n== 4. 云函数侧 nextChargeOf / deriveCycleDay / deriveFirstChargeDate_ ==')
ok(/function\s+nextChargeOf\s*\(\s*cycle,\s*currentNextCharge,\s*now,\s*customMonths\s*\)/.test(code) ||
   /function\s+nextChargeOf\s*\(\s*cycle,\s*currentNextCharge,\s*now\s*\)/.test(code),
  '云函数侧 nextChargeOf(cycle, currentNextCharge, now[, customMonths]) 签名 — 滚动更新语义')
ok(/nextChargeOf[\s\S]*?cycle\s*===\s*'weekly'[\s\S]*?7\s*\*\s*86400000|\+\s*7\s*\*\s*86400000|\+=\s*7|cy\s*\+\s*1/.test(code), 'nextChargeOf:weekly 分支稳定推进 7 天 / yearly +1 年')
ok(/nextChargeOf[\s\S]*?cycle\s*===\s*'monthly'[\s\S]*?cycle\s*===\s*'quarterly'/.test(code), 'nextChargeOf:monthly/quarterly 步长映射(1/3 月)')
ok(/function\s+deriveCycleDay\s*\(\s*cycle,\s*nextCharge\s*\)/.test(code), '云函数侧 deriveCycleDay(cycle, nextCharge) 函数存在(从 nextCharge 反推)')
ok(/deriveCycleDay[\s\S]*?cycle\s*===\s*'yearly'[\s\S]*?'MM-DD'|parts\[1\][\s\S]*?parts\[2\]/.test(code), 'deriveCycleDay:yearly 返回 MM-DD 字符串')
ok(/deriveCycleDay[\s\S]*?cycle\s*===\s*'custom'[\s\S]*?return\s+null/.test(code), 'deriveCycleDay:custom 返回 null(无 cycleDay 概念)')
ok(/function\s+deriveFirstChargeDate_\s*\(\s*cycle,\s*nextCharge/.test(code), '云函数侧 deriveFirstChargeDate_(cycle, nextCharge) 函数存在')

/* ---------------- 5. RECORD_TOOLS 注册 ---------------- */
console.log('\n== 5. RECORD_TOOLS 注册 ==')
ok(/const\s+RECORD_TOOLS\s*=\s*\[[\s\S]*?'addSubscription'/.test(code), 'RECORD_TOOLS 数组含 \'addSubscription\'')

/* ---------------- 6. 工具分发 switch ---------------- */
console.log('\n== 6. 工具分发 switch ==')
ok(/if\s*\(\s*fname\s*===\s*'addSubscription'\s*\)\s*\{[\s\S]*?handleSubscriptionTool\(call,\s*openid\)/.test(code), 'callLLM 分发:addSubscription → handleSubscriptionTool')
ok(/async\s+function\s+handleSubscriptionTool\s*\(\s*call,\s*openid\s*\)/.test(code), 'handleSubscriptionTool(call, openid) 函数存在')
ok(/handleSubscriptionTool[\s\S]*?await\s+executeAddSubscription\(args,\s*openid\)/.test(code), 'handleSubscriptionTool 调 executeAddSubscription')
ok(/handleSubscriptionTool[\s\S]*?unitMap\s*=\s*\{\s*monthly:\s*'月',\s*quarterly:\s*'季',\s*yearly:\s*'年',\s*weekly:\s*'周'\s*\}/.test(code), '周期单位映射表(月/季/年/周)')
ok(/handleSubscriptionTool[\s\S]*?✓\s*已记订阅/.test(code), '确认语带「✓ 已记订阅」')
ok(/handleSubscriptionTool[\s\S]*?下次扣费|下次到期/.test(code), '确认语带「下次扣费 / 下次到期」')
ok(/handleSubscriptionTool[\s\S]*?type:\s*'subscription'[\s\S]*?subscription:\s*rec/.test(code), 'toolResult: type=subscription + subscription=rec(供前端路由撤销)')

/* ---------------- 7. PROMPT_RECORD 规则 ---------------- */
console.log('\n== 7. PROMPT_RECORD 使用规则 ==')
ok(/PROMPT_RECORD[\s\S]*?addSubscription[\s\S]*?记订阅/.test(code), 'PROMPT_RECORD 段提及 addSubscription + 「记订阅」')
ok(/PROMPT_RECORD[\s\S]*?触发词[\s\S]*?记订阅/.test(code), 'PROMPT_RECORD 触发词包含「记订阅」')
ok(/PROMPT_RECORD[\s\S]*?续费/.test(code) && /PROMPT_RECORD[\s\S]*?包月/.test(code) && /PROMPT_RECORD[\s\S]*?年费/.test(code) && /PROMPT_RECORD[\s\S]*?会员/.test(code), 'PROMPT_RECORD 触发词覆盖 续费/包月/年费/会员')
ok(/PROMPT_RECORD[\s\S]*?addSubscription[\s\S]*?cycle[\s\S]*?monthly[\s\S]*?yearly[\s\S]*?quarterly[\s\S]*?weekly/.test(code), 'PROMPT_RECORD 说明 cycle 四种周期')
ok(/PROMPT_RECORD[\s\S]*?nextCharge[\s\S]*?主录入字段/.test(code) || /PROMPT_RECORD[\s\S]*?nextCharge\s*是.*?主录入字段/.test(code), 'PROMPT_RECORD 标注 nextCharge 是主录入字段')
ok(/PROMPT_RECORD[\s\S]*?爱奇艺到9月15号.*298|腾讯视频半年包88/.test(code), 'PROMPT_RECORD 包含 nextCharge 解析新示例')
ok(/PROMPT_RECORD[\s\S]*?cycleDay[\s\S]*?降级/.test(code), 'PROMPT_RECORD 说明 cycleDay 降级使用场景')
ok(/PROMPT_RECORD[\s\S]*?frequent[\s\S]*?occasional[\s\S]*?rare[\s\S]*?never/.test(code), 'PROMPT_RECORD 说明 usage 四档频率')
ok(/PROMPT_RECORD[\s\S]*?addExpense[\s\S]*?addSalary[\s\S]*?addSubscription[\s\S]*?互斥/.test(code), 'PROMPT_RECORD 说明三记账工具互斥')

/* ---------------- 8. T1.4 增量: payChannel 参数 ---------------- */
console.log('\n== 8. T1.4 payChannel 参数(增量) ==')
ok(/payChannel:\s*\{[\s\S]*?enum:\s*\[\s*'wechat',\s*'alipay',\s*'apple',\s*'inapp',\s*'unknown'\s*\]/.test(code), 'payChannel enum 含 wechat/alipay/apple/inapp/unknown 五种渠道')
ok(/payChannel[\s\S]*?description:[\s\S]*?微信自动续费/.test(code), 'payChannel description 包含微信自动续费触发词')
ok(/payChannel[\s\S]*?description:[\s\S]*?支付宝自动扣款/.test(code), 'payChannel description 包含支付宝自动扣款触发词')
ok(/payChannel[\s\S]*?description:[\s\S]*?苹果订阅/.test(code), 'payChannel description 包含苹果订阅触发词')
ok(/payChannel[\s\S]*?description:[\s\S]*?App\s*内/.test(code), 'payChannel description 包含 App 内开通触发词')
ok(/executeAddSubscription[\s\S]*?PAYCHANNEL_WHITELIST\s*=\s*\[\s*'wechat',\s*'alipay',\s*'apple',\s*'inapp',\s*'unknown'\s*\]/.test(code), 'PAYCHANNEL_WHITELIST 5 渠道白名单')
ok(/executeAddSubscription[\s\S]*?payChannel\s*=\s*PAYCHANNEL_WHITELIST\.indexOf\(args\.payChannel\)\s*>=\s*0\s*\?\s*args\.payChannel\s*:\s*'unknown'/.test(code), 'payChannel 非法值兜底 unknown(与 CYCLE/USAGE_WHITELIST 同模式)')
ok(subAddBlock && /\bpayChannel\b/.test(subAddBlock[1]), 'subscriptions add 写库 payload 含 payChannel 字段')
ok(/executeAddSubscription[\s\S]*?return\s*\{[\s\S]*?type:\s*'subscription'[\s\S]*?record:\s*\{[\s\S]*?payChannel[\s\S]*?\}/.test(code), '成功返回 record 含 payChannel(供 T2.3 取消指引匹配)')
ok(/PROMPT_RECORD[\s\S]*?payChannel[\s\S]*?wechat[\s\S]*?alipay[\s\S]*?apple[\s\S]*?inapp[\s\S]*?unknown/.test(code), 'PROMPT_RECORD 含 payChannel 五渠道说明')
ok(/PROMPT_RECORD[\s\S]*?微信\s*自动续费[\s\S]*?支付宝\s*自动扣款/.test(code), 'PROMPT_RECORD 含微信/支付宝触发词示例')

/* ---------------- 8.5 custom 周期(腾讯视频半年包 88 等) ---------------- */
console.log('\n== 8.5 custom 周期参数 ==')
ok(/customMonths:\s*\{[\s\S]*?type:\s*['"]number['"][\s\S]*?description:[\s\S]*?1\s*-\s*36/.test(code) ||
   /customMonths:\s*\{[\s\S]*?1\s*-\s*36[\s\S]*?正整数/.test(code),
  'customMonths 参数:type number + description 标注 1-36 正整数(防荒谬值)')
ok(/customMonths[\s\S]*?cycle\s*===\s*['"]custom['"]/.test(code) || /customMonths[\s\S]*?cycle\s*为?\s*custom/.test(code), 'customMonths.description 标注仅 cycle=custom 时使用')
ok(/executeAddSubscription[\s\S]*?CYCLE_WHITELIST\s*=\s*\[\s*'monthly',\s*'yearly',\s*'quarterly',\s*'weekly',\s*'custom'\s*\]/.test(code), 'CYCLE_WHITELIST 含 custom(5 项)')
ok(/executeAddSubscription[\s\S]*?cycle\s*===\s*'custom'[\s\S]*?customMonths[\s\S]*?1\s*-\s*36/.test(code) || /executeAddSubscription[\s\S]*?cycle\s*===\s*'custom'[\s\S]*?整数[\s\S]*?1[\s\S]*?36/.test(code), 'executeAddSubscription:custom 时校验 customMonths 1-36 整数')
ok(subAddBlock && /\bcustomMonths\b/.test(subAddBlock[1]), 'subscriptions add 写库 payload 含 customMonths 字段')
ok(/executeAddSubscription[\s\S]*?return\s*\{[\s\S]*?type:\s*'subscription'[\s\S]*?record:\s*\{[\s\S]*?customMonths[\s\S]*?\}/.test(code), '成功返回 record 含 customMonths(前端撤销/编辑可读回)')
ok(/PROMPT_RECORD[\s\S]*?addSubscription[\s\S]*?cycle[\s\S]*?monthly[\s\S]*?yearly[\s\S]*?quarterly[\s\S]*?weekly[\s\S]*?custom/.test(code), 'PROMPT_RECORD 说明 cycle 含 custom')
ok(/PROMPT_RECORD[\s\S]*?customMonths[\s\S]*?1[\s\S]*?36/.test(code) || /PROMPT_RECORD[\s\S]*?customMonths[\s\S]*?半年包|季包|期限包/.test(code), 'PROMPT_RECORD 标注 customMonths 范围 / 期限包语义')
ok(/handleSubscriptionTool[\s\S]*?unit\s*=[\s\S]*?cm\s*>\s*0\s*\?\s*[`'"][^`'"]*\{\s*cm\s*\}\s*个月/.test(code) || /handleSubscriptionTool[\s\S]*?customMonths[\s\S]*?N\s*个月|\$\{cm\}\s*个月|cm\s*\}\s*个月/.test(code), 'handleSubscriptionTool 确认语:custom 显示「N 个月」单位')
ok(/handleSubscriptionTool[\s\S]*?下次到期/.test(code), 'handleSubscriptionTool 确认语:custom 用「下次到期」而非「下次扣费」')

/* ---------------- 8.6 防重闸门(漏洞 1+2 修复) ---------------- */
console.log('\n== 8.6 防重闸门:confirmed + 查重 + conflict 转述 ==')
// TOOL_DEFS 加 confirmed 参数
ok(/confirmed:\s*\{[\s\S]*?type:\s*['"]boolean['"][\s\S]*?description:[\s\S]*?跳过查重|默认\s*false/.test(code), 'TOOL_DEFS confirmed 参数:type=boolean + 描述说明跳过查重 + 默认 false')
ok(/confirmed[\s\S]*?跳过查重|confirmed[\s\S]*?默认\s*false|confirmed[\s\S]*?不允许默认|confirmed[\s\S]*?严禁默认\s*true/.test(code), 'confirmed description 显式标注默认 false / 禁止默认 true(防绕过防重闸门)')
ok(!/required:\s*\[[\s\S]*?'confirmed'[\s\S]*?\]/.test(code), 'confirmed 非必填(默认 false,只在用户明确确认「再记一条」时传)')
// executeAddSubscription 查重闸门 5 要件
ok(/executeAddSubscription[\s\S]*?_findDuplicateSubscription[\s\S]*?conflict:\s*true/.test(code), 'executeAddSubscription:写库前调 _findDuplicateSubscription + 命中返回 conflict:true')
ok(/executeAddSubscription[\s\S]*?conflict:\s*true[\s\S]*?existing:\s*\{/.test(code), 'executeAddSubscription:conflict 返回带 existing{name/amount/cycle/nextCharge...}')
ok(/executeAddSubscription[\s\S]*?confirmed\s*=\s*args\.confirmed\s*===\s*true/.test(code) || /executeAddSubscription[\s\S]*?confirmed\s*=\s*!!\s*args\.confirmed/.test(code), 'executeAddSubscription:读取 args.confirmed 作为跳过查重开关')
ok(/executeAddSubscription[\s\S]*?confirmed\s*[\s\S]*?_findDuplicateSubscription/.test(code) || /executeAddSubscription[\s\S]*?!confirmed[\s\S]*?_findDuplicateSubscription/.test(code), 'executeAddSubscription:confirmed=true 时跳过查重(短路放行)')
// _findDuplicateSubscription helper
ok(/async\s+function\s+_findDuplicateSubscription/.test(code) || /function\s+_findDuplicateSubscription\s*\(/.test(code), '_findDuplicateSubscription helper 函数定义')
ok(/_findDuplicateSubscription[\s\S]*?deleted[\s\S]*?neq\(true\)|_findDuplicateSubscription[\s\S]*?\.neq\(true\)/.test(code), '_findDuplicateSubscription:where 过滤 deleted:neq(true)(软删记录不参与查重)')
ok(/_findDuplicateSubscription[\s\S]*?status\s*!==\s*['"]cancelled['"]/.test(code) || /_findDuplicateSubscription[\s\S]*?cancelled[\s\S]*?continue/.test(code), '_findDuplicateSubscription:跳过 cancelled 记录(已取消的不算有效订阅)')
ok(/_findDuplicateSubscription[\s\S]*?includes\(.+?\)|_findDuplicateSubscription[\s\S]*?\.includes/.test(code), '_findDuplicateSubscription:双向包含匹配(腾讯视频 vs 腾讯视频VIP)')
ok(/_findDuplicateSubscription[\s\S]*?toLowerCase\(\)|_findDuplicateSubscription[\s\S]*?\.toLowerCase\(\)/.test(code), '_findDuplicateSubscription:大小写不敏感 + trim')
ok(/_findDuplicateSubscription[\s\S]*?-502005|_findDuplicateSubscription[\s\S]*?not exist/i.test(code), '_findDuplicateSubscription:集合未创建时视为无冲突(放行主流程)')
// handleSubscriptionTool conflict 转述
ok(/handleSubscriptionTool[\s\S]*?out\.conflict[\s\S]*?out\.existing/.test(code), 'handleSubscriptionTool 优先判 conflict + existing 再走普通 !out.ok 分支')
ok(/handleSubscriptionTool[\s\S]*?conflict[\s\S]*?改这条还是再记一条|conflict[\s\S]*?改\s*这条|conflict[\s\S]*?再记一条/.test(code), 'handleSubscriptionTool conflict 转述文案:「改这条还是再记一条」')
ok(/handleSubscriptionTool[\s\S]*?needsChoice/.test(code), 'handleSubscriptionTool conflict 返回 needsChoice:true 标记 AI 二选一流程')
ok(/handleSubscriptionTool[\s\S]*?conflict[\s\S]*?existing:\s*ex/.test(code), 'handleSubscriptionTool 把 existing 喂回 toolResult 供前端 / LLM 用')
// PROMPT_RECORD 两条纪律
ok(/PROMPT_RECORD[\s\S]*?addSubscription[\s\S]*?数据库优先|数据库优先[\s\S]*?addSubscription/.test(code), 'PROMPT_RECORD 含「数据库优先」纪律(防历史幻觉)')
ok(/PROMPT_RECORD[\s\S]*?会话历史[\s\S]*?已录入|会话历史[\s\S]*?数据库现状|不准以会话历史为准|禁止以会话历史为准/.test(code), 'PROMPT_RECORD:已录与否只看工具结果,不看会话历史')
ok(/PROMPT_RECORD[\s\S]*?conflict\s*处理|conflict\s*处理纪律/.test(code), 'PROMPT_RECORD 含「conflict 处理纪律」')
ok(/PROMPT_RECORD[\s\S]*?禁止编造[\s\S]*?已记上|禁止编造[\s\S]*?记上|c[\s\S]*?库里实际没写入|库里\s*实际没写入/.test(code), 'PROMPT_RECORD conflict 纪律:禁止编造"已记上"(库里没写入)')
ok(/PROMPT_RECORD[\s\S]*?confirmed\s*:\s*true[\s\S]*?重调|再记一条[\s\S]*?confirmed\s*:\s*true/.test(code), 'PROMPT_RECORD conflict 纪律:用户答「再记一条」→ 带 confirmed:true 重调')

/* ---------------- 8.7 分层追问(防连环问) ---------------- */
console.log('\n== 8.7 分层追问:required + description + PROMPT_RECORD + 双确认语 ==')
// 1) schema required 升级
ok(/required:\s*\[\s*'name',\s*'amount',\s*'nextCharge'\s*\]/.test(code), 'addSubscription required = [name, amount, nextCharge](JSON schema 层面强制)')
// 2) description 硬规则
ok(/name:\s*'addSubscription'[\s\S]*?nextCharge\s*与\s*cycleDay\s*必须传其一/.test(code), 'description 含「nextCharge 与 cycleDay 必须传其一」硬规则')
ok(/name:\s*'addSubscription'[\s\S]*?禁止\s*LLM\s*用.*?今天\s*\+\s*1\s*周期.*?默写/.test(code), 'description 禁止 LLM 用「今天+1周期」默写默认值')
ok(/name:\s*'addSubscription'[\s\S]*?半年包[\s\S]*?custom[\s\S]*?customMonths/.test(code), 'description 标注「半年包 → cycle=custom + customMonths」(防 LLM 误识别 weekly)')
ok(/name:\s*'addSubscription'[\s\S]*?反问用户|先反问|打开\s*App\s*会员中心|有效期至/.test(code), 'description 给出 nextCharge 阻塞追问的具体话术(去 App 会员中心照抄有效期)')
ok(/name:\s*'addSubscription'[\s\S]*?platform\s*缺失不追问/.test(code), 'description 硬规则:platform 缺失不追问(name 兜底)')
ok(/name:\s*'addSubscription'[\s\S]*?usage\s*缺失不追问/.test(code), 'description 硬规则:usage 缺失不追问(默认 rare)')
ok(/name:\s*'addSubscription'[\s\S]*?payChannel\s*缺失[\s\S]*?非阻塞|非阻塞顺带/.test(code), 'description 硬规则:payChannel 缺失非阻塞顺带问')
ok(/name:\s*'addSubscription'[\s\S]*?一次最多\s*1\s*个阻塞式|禁止连环问/.test(code), 'description 硬规则:一次最多 1 个阻塞式问题 / 禁止连环问')
// 3) PROMPT_RECORD 分层追问表 4 字段
ok(/PROMPT_RECORD[\s\S]*?分层追问纪律/.test(code), 'PROMPT_RECORD 含「分层追问纪律」段')
ok(/PROMPT_RECORD[\s\S]*?nextCharge[\s\S]*?阻塞式追问/.test(code), 'PROMPT_RECORD:nextCharge 阻塞式追问(到期日是提醒命根子)')
ok(/PROMPT_RECORD[\s\S]*?platform[\s\S]*?不追问|name\s*≈\s*platform|name\s*直接填/.test(code), 'PROMPT_RECORD:platform 不追问,name 直接填')
ok(/PROMPT_RECORD[\s\S]*?usage[\s\S]*?不追问[\s\S]*?rare|默认\s*rare/.test(code), 'PROMPT_RECORD:usage 不追问,默认 rare')
ok(/PROMPT_RECORD[\s\S]*?payChannel[\s\S]*?非阻塞[\s\S]*?unknown/.test(code), 'PROMPT_RECORD:payChannel 非阻塞顺带问(unknown)')
// 4) 追问纪律
ok(/PROMPT_RECORD[\s\S]*?禁止连环问|一次最多\s*1\s*个阻塞/.test(code), 'PROMPT_RECORD 追问纪律:一次最多 1 个阻塞 + 禁止连环问')
ok(/PROMPT_RECORD[\s\S]*?不知道[\s\S]*?不想说[\s\S]*?默认|不知道[\s\S]*?不再纠缠/.test(code), 'PROMPT_RECORD 追问纪律:用户说「不知道/不想说」立即按默认录入,不再纠缠')
ok(/PROMPT_RECORD[\s\S]*?slot\s*filling|多轮[\s\S]*?会话历史凑齐/.test(code), 'PROMPT_RECORD:多轮 slot filling 用会话历史凑齐参数(LLM 反问后用户答,下一轮重调)')
// 5) executeAddSubscription usage 默认 rare 与 PROMPT_RECORD 一致
ok(/executeAddSubscription[\s\S]*?USAGE_WHITELIST[\s\S]*?usage\s*=\s*USAGE_WHITELIST\.indexOf[\s\S]*?\?\s*args\.usage\s*:\s*['"]rare['"]/.test(code), 'executeAddSubscription usage 默认 rare(与 PROMPT_RECORD 一致,不再 occasional)')
// 6) 双确认语模板
ok(/handleSubscriptionTool[\s\S]*?payChannel[\s\S]*?unknown[\s\S]*?微信[\s\S]*?支付宝[\s\S]*?苹果/.test(code), 'handleSubscriptionTool 双确认语:payChannel=unknown 时末尾追问渠道')
ok(/handleSubscriptionTool[\s\S]*?payChannel[\s\S]*?unknown[\s\S]*?取消订阅时[\s\S]*?精确路径/.test(code), '双确认语文案:「取消订阅时给你精确路径」')
// 7) executeAddSubscription 硬拦截:nextCharge + cycleDay 都缺时工具侧直接 return reason
ok(/executeAddSubscription[\s\S]*?cycleDay[\s\S]*?return[\s\S]*?ok:\s*false[\s\S]*?有效期至|会员中心|请先告诉账本君/.test(code), 'executeAddSubscription 硬拦截:nextCharge + cycleDay 都缺时 return reason,反问用户去 App 会员中心')
ok(/executeAddSubscription[\s\S]*?禁止\s*LLM\s*用.*?今天|默写默认值|今天\s*\+\s*1\s*周期\s*偷偷兜底/.test(code), 'executeAddSubscription 注释说明禁止 LLM 用「今天」偷偷兜底')

/* ---------------- 9. 语法检查 ---------------- */
console.log('\n== 9. 语法检查 ==')
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
