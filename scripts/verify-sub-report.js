/**
 * 验证:T2.2 年度订阅浪费报告(subReport 云函数 + db.js + 订阅页 UI)
 * - cloudfunctions/subReport/index.js: SYSTEM_PROMPT + 浪费系数 + 年化聚合 + 缓存 ver=1 + 写 _openid
 * - cloudfunctions/subReport/package.json + config.json 存在且字段完整
 * - utils/db.js: getSubReport / invalidateSubReport + 60s 客户端缓存 + 当前年推算 + add/update/remove 调失效
 * - pages/subscriptions/: wxml 入口卡 + sheet + ai 解读 + 订阅明细 + js openSubReport/closeSubReport
 *
 * 验收:有 active 订阅 → 点报告 → 看到年总支出/浪费金额/账本君解读/订阅明细
 *
 * 运行: node scripts/verify-sub-report.js
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

/* ---------------- 1. subReport 云函数文件 ---------------- */
console.log('== 1. cloudfunctions/subReport 三件套 ==')
ok(fs.existsSync(path.join(ROOT, 'cloudfunctions/subReport/index.js')), 'cloudfunctions/subReport/index.js 存在')
ok(fs.existsSync(path.join(ROOT, 'cloudfunctions/subReport/package.json')), 'cloudfunctions/subReport/package.json 存在')
ok(fs.existsSync(path.join(ROOT, 'cloudfunctions/subReport/config.json')), 'cloudfunctions/subReport/config.json 存在')

/* ---------------- 2. package.json + config.json 内容 ---------------- */
console.log('\n== 2. package.json + config.json ==')
const pkg = read('cloudfunctions/subReport/package.json')
ok(/"name"\s*:\s*"subReport"/.test(pkg), 'package.json name = subReport')
ok(/"main"\s*:\s*"index\.js"/.test(pkg), 'package.json main = index.js')
ok(/"wx-server-sdk"\s*:\s*"~2\.6\.3"/.test(pkg), 'package.json 依赖 wx-server-sdk ~2.6.3')
ok(/"undici"\s*:\s*"[\^~]?\d/.test(pkg), 'package.json 依赖 undici(Node16 fetch 兜底)')

const cfg = read('cloudfunctions/subReport/config.json')
ok(/"timeout"\s*:\s*\d+/.test(cfg), 'config.json timeout 字段存在')
ok(/"timeout"\s*:\s*30/.test(cfg), 'config.json timeout = 30(与 finReport 一致)')

/* ---------------- 3. subReport/index.js 核心实现 ---------------- */
console.log('\n== 3. subReport/index.js 核心 ==')
const sr = read('cloudfunctions/subReport/index.js')
ok(/cloud\.init\(\s*\{\s*env:\s*cloud\.DYNAMIC_CURRENT_ENV\s*\}\s*\)/.test(sr), 'cloud.init 走 DYNAMIC_CURRENT_ENV')
ok(/const\s+API_KEY\s*=\s*process\.env\.LLM_API_KEY/.test(sr), '读环境变量 LLM_API_KEY')
ok(/const\s+BASE_URL\s*=\s*process\.env\.LLM_BASE_URL\s*\|\|\s*'https:\/\/api\.deepseek\.com'/.test(sr), 'BASE_URL 兜底 https://api.deepseek.com')
ok(/const\s+MODEL\s*=\s*process\.env\.LLM_MODEL\s*\|\|\s*'deepseek-chat'/.test(sr), 'MODEL 兜底 deepseek-chat')

// 缓存版本 CACHE_VER = 1
ok(/const\s+CACHE_VER\s*=\s*1\b/.test(sr), 'CACHE_VER = 1(首个稳定版)')

// 年化系数 12/4/1/52
ok(/monthly:\s*12,\s*quarterly:\s*4,\s*yearly:\s*1,\s*weekly:\s*52/.test(sr), 'CYCLE_UNIT 年化系数:monthly×12/quarterly×4/yearly×1/weekly×52')

// 浪费系数 never/rare/occasional/frequent
ok(/never:\s*1(?:\.0)?,\s*rare:\s*0\.5,\s*occasional:\s*0,\s*frequent:\s*0/.test(sr), 'WASTE_FACTOR:never=1.0 / rare=0.5 / occasional=0 / frequent=0')

// SYSTEM_PROMPT 关键约束
ok(/SYSTEM_PROMPT\s*=/.test(sr) && /断舍离|年度|浪费/.test(sr), 'SYSTEM_PROMPT 包含断舍离/年度/浪费语境')
ok(/数字必须来自数据块/.test(sr) || /每一个数字必须来自数据块/.test(sr), 'SYSTEM_PROMPT 硬约束:数字必须来自数据块')
ok(/不得|不许.*编造|不许给.*价格|不得给出平替名/.test(sr), 'SYSTEM_PROMPT 硬约束:不得编平替价格')

// 入口校验 year 格式(在 JS 源码里出现的 regex literal 是 \d{4},即字符序列 \\d{4})
ok(/\\d\{4\}/.test(sr), 'year 校验正则 /\\d{4}/(必须是 4 位数字)')
ok(/code:\s*'BAD_ARG'/.test(sr), '参数错误返回 BAD_ARG code')

// LLM 调用参数
ok(/max_tokens:\s*300/.test(sr), 'max_tokens = 300(spec:与 finReport 一致)')
ok(/temperature:\s*0\.5/.test(sr), 'temperature = 0.5(spec:与 finReport 一致)')

// 缓存读写(必须显式写 _openid,教训:P0 历史坑)
ok(/db\.collection\('subReports'\)\.where\(\{[^}]*_openid:\s*OPENID[^}]*\}\)\.remove\(\)/.test(sr), '缓存删除按 _openid+year 走')
ok(/\.add\([\s\S]*?_openid:\s*OPENID/.test(sr), '缓存写入显式带 _openid(防「永不命中」)')
ok(/safeFind[\s\S]*?if\s*\(\s*doc\.ver\s*!==\s*CACHE_VER\s*\)\s*return\s*null/.test(sr), 'safeFind 旧版本视为未命中')

// NO_KEY 兜底
ok(/code:\s*'NO_KEY'/.test(sr) && /API_KEY/.test(sr), '缺 key 返回 NO_KEY(前端走本地兜底)')

// 集合未创建兜底(-502005 / not exist)
ok(/-502005/.test(sr) && /not exist/i.test(sr), '集合未创建兜底(-502005 / not exist)')

/* ---------------- 4. formatDataForLLM 数据块 ---------------- */
console.log('\n== 4. formatDataForLLM ==')
ok(/function\s+formatDataForLLM/.test(sr), 'formatDataForLLM 函数存在')
ok(/年度概览/.test(sr), '数据块「年度概览」段')
ok(/订阅清单/.test(sr), '数据块「订阅清单」段')
ok(/按浪费金额降序/.test(sr), '数据块订阅清单按浪费金额降序')
ok(/CHANNEL_LABELS|CHANNEL_LABEL/.test(sr), '扣费渠道标签字典')
ok(/USAGE_LABELS|USAGE_LABEL/.test(sr), '使用频率标签字典')
ok(/优化后可省金额|优化后|断舍离全部浪费项/.test(sr), '数据块「优化后可省」段')

/* ---------------- 5. aggregate 聚合函数 ---------------- */
console.log('\n== 5. aggregate 聚合函数 ==')
ok(/function\s+aggregate\(/.test(sr), 'aggregate 函数存在')
ok(/aggregate[\s\S]*?_yearlyOf\(/.test(sr) || /aggregate[\s\S]*?CYCLE_UNIT\[cycle\]\s*\|\|\s*12/.test(sr), 'aggregate 算年化:走 _yearlyOf(支持 custom),或 CYCLE_UNIT[cycle] || 12 兜底')
ok(/aggregate[\s\S]*?\(usage\s+in\s+WASTE_FACTOR\)\s*\?\s*WASTE_FACTOR\[usage\]\s*:\s*WASTE_FACTOR\[USAGE_DEFAULT\]/.test(sr), 'aggregate 算浪费:usage 不在表按 rare 兜底')
ok(/aggregate[\s\S]*?cancelled/.test(sr), 'aggregate 区分 cancelled(不计入 yearTotal)')
ok(/exports\.aggregate\s*=\s*aggregate/.test(sr), 'aggregate 通过 exports 暴露(便于复用/对比)')

/* ---------------- 6. utils/db.js 接口 ---------------- */
console.log('\n== 6. utils/db.js getSubReport / invalidateSubReport ==')
const djs = read('utils/db.js')
ok(/async\s+function\s+getSubReport\(/.test(djs), 'getSubReport 函数定义')
ok(/async\s+function\s+invalidateSubReport\(/.test(djs), 'invalidateSubReport 函数定义')
ok(/function\s+currentYearStr\(\)/.test(djs), 'currentYearStr 辅助函数(默认取当前年)')
ok(/getSubReport[\s\S]*?cache\.subReports/.test(djs), 'getSubReport 走客户端 60s 缓存(cache.subReports)')
ok(/getSubReport[\s\S]*?fresh\(cache\.subReports\[ck\]\)/.test(djs), 'getSubReport 校验 60s TTL')
ok(/getSubReport[\s\S]*?listSubscriptions\(false\)/.test(djs), 'getSubReport 复用 listSubscriptions(自身 60s 缓存)')
ok(/getSubReport[\s\S]*?CYCLE_UNIT\s*=\s*\{[^}]*monthly:\s*12[^}]*\}/.test(djs), 'getSubReport 客户端算年化:CYCLE_UNIT 12/4/1/52')
ok(/getSubReport[\s\S]*?WASTE_FACTOR\s*=\s*\{[^}]*never:\s*1(?:\.0)?[^}]*\}/.test(djs), 'getSubReport 客户端算浪费:WASTE_FACTOR never=1/rare=0.5')
ok(/getSubReport[\s\S]*?wx\.cloud\.callFunction\(\s*\{[^}]*name:\s*'subReport'/.test(djs), 'getSubReport 调 subReport 云函数')
ok(/getSubReport[\s\S]*?8\d{3}/.test(djs), 'getSubReport 客户端 8s 超时(同 finReport)')
ok(/getSubReport[\s\S]*?buildSubReportFallback\(dataBlock\)/.test(djs), 'getSubReport NO_KEY/失败走本地兜底 buildSubReportFallback')
ok(/getSubReport[\s\S]*?function\s+buildSubReportFallback\(/.test(djs), 'buildSubReportFallback 本地兜底函数')
ok(/invalidateSubReport[\s\S]*?db\.collection\('subReports'\)\.where\(\{[^}]*year:\s*yearStr/.test(djs), 'invalidateSubReport 按 year 删 subReports')
ok(/invalidateSubReport[\s\S]*?-502005[\s\S]*?not exist/i.test(djs), 'invalidateSubReport 集合未创建静默')

// 模块导出
ok(/module\.exports\s*=\s*\{[^}]*getSubReport[\s\S]*?invalidateSubReport\s*\}/.test(djs), 'module.exports 含 getSubReport + invalidateSubReport')

// 写操作调失效
ok(/async\s+function\s+addSubscription\([\s\S]*?invalidate\(\)[\s\S]*?invalidateSubReport\(currentYearStr\(\)\)/.test(djs), 'addSubscription 写后失效当年 subReport 缓存')
ok(/async\s+function\s+updateSubscription\([\s\S]*?invalidate\(\)[\s\S]*?invalidateSubReport\(currentYearStr\(\)\)/.test(djs), 'updateSubscription 写后失效当年 subReport 缓存')
ok(/async\s+function\s+removeSubscription\([\s\S]*?invalidate\(\)[\s\S]*?invalidateSubReport\(currentYearStr\(\)\)/.test(djs), 'removeSubscription 写后失效当年 subReport 缓存')

// clearAllData 含 subReports
ok(/clearAllData[\s\S]*?clear\('subReports'\)/.test(djs), 'clearAllData 含 subReports(用户重置数据一并清报告缓存)')

// cache 加 subReports 字段(用 [\s\S]*? 跨过 {} 与注释,精确锁定 cache 字面量)
ok(/const\s+cache\s*=\s*\{[\s\S]*?subReports:\s*\{\s*\}/.test(djs), 'cache 对象加 subReports: {} 字段')
ok(/function\s+invalidate\(\)[\s\S]*?cache\.subReports\s*=\s*\{\s*\}/.test(djs), 'invalidate() 重置 subReports 缓存')

/* ---------------- 7. 订阅页 WXML ---------------- */
console.log('\n== 7. pages/subscriptions/subscriptions.wxml ==')
const swxml = read('pages/subscriptions/subscriptions.wxml')
ok(/class="[^"]*\breport-entry-card\b[^"]*"/.test(swxml), 'wxml 报告入口卡 .report-entry-card')
ok(/bindtap="openSubReport"/.test(swxml), 'wxml 入口卡 bindtap=openSubReport')
ok(/{{reportYear}}/.test(swxml), 'wxml 用 reportYear 字段')
ok(/年度报告|年度订阅|订阅浪费/.test(swxml), 'wxml 报告入口文案')
ok(/wx:if="{{totalCount}}"/.test(swxml) && /report-entry/.test(swxml), 'wxml 报告入口 wx:if 依赖 totalCount(无订阅隐藏)')

// sheet 报告区
ok(/class="report-ai"/.test(swxml), 'wxml 报告 sheet .report-ai(账本君解读)')
ok(/class="report-ai-body"/.test(swxml), 'wxml 报告 sheet .report-ai-body(原文展示)')
ok(/class="report-overview"/.test(swxml), 'wxml 报告 sheet .report-overview(数字概览)')
ok(/class="report-items"/.test(swxml), 'wxml 报告 sheet .report-items(订阅明细)')
ok(/report-item-waste|浪费 ¥/.test(swxml), 'wxml 报告订阅明细展示浪费金额')
ok(/showReport/.test(swxml) && /reportLoading/.test(swxml) && /reportError/.test(swxml), 'wxml 报告 sheet 含 loading/error/data 三态')
ok(/bindtap="closeSubReport"/.test(swxml), 'wxml 报告 sheet 关闭按钮 bindtap=closeSubReport')
ok(/catchtouchmove="preventTouchmove"/.test(swxml), 'wxml 报告 sheet 防滚动穿透')

/* ---------------- 8. 订阅页 JS ---------------- */
console.log('\n== 8. pages/subscriptions/subscriptions.js ==')
const sjs = read('pages/subscriptions/subscriptions.js')
ok(/async\s+openSubReport\(/.test(sjs), 'openSubReport 方法存在')
ok(/openSubReport\(\)[\s\S]*?dbApi\.getSubReport\(year\)/.test(sjs), 'openSubReport 调 dbApi.getSubReport(year)')
ok(/openSubReport\(\)[\s\S]*?reportLoading:\s*true/.test(sjs), 'openSubReport 先开 loading(避免白屏)')
ok(/closeSubReport\(\)/.test(sjs), 'closeSubReport 方法存在')
ok(/closeSubReport\(\)[\s\S]*?showReportClosing:\s*true[\s\S]*?setTimeout[\s\S]*?showReport:\s*false/.test(sjs), 'closeSubReport 走「关-200ms-真关」两段动画(与其他 sheet 一致)')
ok(/reportYear:/.test(sjs) && /showReport:/.test(sjs) && /reportData:/.test(sjs), 'data 字段 reportYear/showReport/reportData')
ok(/onShow[\s\S]*?reportYear:/.test(sjs), 'onShow 设置 reportYear = 当前年')

/* ---------------- 9. WXSS ---------------- */
console.log('\n== 9. pages/subscriptions/subscriptions.wxss ==')
const swxss = read('pages/subscriptions/subscriptions.wxss')
ok(/\.report-entry-card\s*\{/.test(swxss), 'wxss .report-entry-card 入口卡样式')
ok(/\.report-entry-arrow/.test(swxss), 'wxss .report-entry-arrow 右箭头')
ok(/\.report-overview/.test(swxss) && /\.report-overview-val-danger/.test(swxss), 'wxss 报告数字概览样式(浪费红字)')
ok(/\.report-ai/.test(swxss) && /\.report-ai-body/.test(swxss), 'wxss 报告 AI 解读样式')
ok(/\.report-ai-tag\b/.test(swxss), 'wxss 报告来源标签(AI/缓存/本地)')
ok(/\.report-items/.test(swxss) && /\.report-item-waste/.test(swxss), 'wxss 订阅明细样式 + 浪费红字')

/* ---------------- 9.5 custom 周期(腾讯视频半年包 88 等) ---------------- */
console.log('\n== 9.5 custom 周期年化聚合 ==')
ok(/function\s+_yearlyOf\s*\(\s*amount,\s*cycle,\s*customMonths\s*\)/.test(sr), '_yearlyOf(amount, cycle, customMonths) 辅助函数存在')
ok(/_yearlyOf[\s\S]*?cycle\s*===\s*'custom'[\s\S]*?12\s*\/\s*cm/.test(sr), '_yearlyOf:custom = amount × 12 / customMonths')
ok(/_yearlyOf[\s\S]*?cycle\s*===\s*'custom'[\s\S]*?Number\.isInteger[\s\S]*?1[\s\S]*?36/.test(sr) || /_yearlyOf[\s\S]*?cycle\s*===\s*'custom'[\s\S]*?cm\s*>=\s*1[\s\S]*?cm\s*<=\s*36/.test(sr), '_yearlyOf:custom 校验 customMonths 1-36 整数(兜底按 monthly)')
ok(/aggregate[\s\S]*?_yearlyOf\(/.test(sr), 'aggregate 调用 _yearlyOf 算年化')
ok(/aggregate[\s\S]*?customMonths:[\s\S]*?Number\([\s\S]*?\)\s*\|\|\s*0/.test(sr), 'aggregate 输出 items[].customMonths(数字化)')
ok(/formatDataForLLM[\s\S]*?cycle\s*===\s*'custom'[\s\S]*?N\s*个月包|\$\{cm\}\s*个月包/.test(sr), 'formatDataForLLM:custom 显示「N 个月包」单位')
ok(/getSubReport[\s\S]*?cycle\s*===\s*'custom'[\s\S]*?12\s*\/\s*cm/.test(djs) || /getSubReport[\s\S]*?_yearlyOf[\s\S]*?custom[\s\S]*?12\s*\/\s*cm/.test(djs), 'db.js getSubReport 客户端聚合:custom 走 amount × 12 / customMonths')

/* ---------------- 10. 语法检查 ---------------- */
console.log('\n== 10. 语法检查 ==')
const files = [
  'cloudfunctions/subReport/index.js',
  'utils/db.js',
  'pages/subscriptions/subscriptions.js'
]
for (const f of files) {
  try {
    execSync(`"${NODE}" --check "${path.join(ROOT, f)}"`, { stdio: 'pipe' })
    pass++
    console.log(`  ✓ ${f} 语法通过`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${f}: ${(e.stderr || '').toString().split('\n')[0]}`)
  }
}
try {
  JSON.parse(read('cloudfunctions/subReport/package.json'))
  JSON.parse(read('cloudfunctions/subReport/config.json'))
  pass++
  console.log('  ✓ package.json + config.json JSON 合法')
} catch (e) {
  fail++
  console.log(`  ✗ JSON 解析失败: ${e.message}`)
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)