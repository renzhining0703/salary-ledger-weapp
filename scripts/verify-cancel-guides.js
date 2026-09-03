/**
 * 验证:T2.3 取消指引(结构化内容库 + AI 匹配 + 前端展开)
 * - cloudfunctions/finChat/cancelGuides.js:
 *   1. CHANNEL_GUIDES 含 wechat/alipay/apple 三键
 *   2. PLATFORM_GUIDES ≥8 个平台(爱奇艺/腾讯视频/优酷/网易云音乐/QQ音乐/百度网盘/iCloud/美团/饿了么 等)
 *   3. matchCancelGuide 三级匹配优先级:channel > platform > fallback
 *   4. fallback 返回 guides(数组),channel/platform 返回 guide(字符串)
 * - cloudfunctions/finChat/index.js:
 *   5. require('./cancelGuides')
 *   6. executeAddSubscription 写 cancelGuide + cancelGuideSource 入库 + 返回 record
 *   7. executeEvaluateSubscription 附 cancelGuide(实时匹配,不依赖 DB 旧值)
 *   8. formatEvaluateAnswer 把 cancelGuide 拼到事实块供 LLM 一并告诉用户
 * - pages/subscriptions/:
 *   9. wxml 每行订阅加 .sub-cancel 展开区 + toggleCancelGuide
 *   10. wxss .sub-cancel 样式 + .sub-cancel-arrow-open(展开 90° 旋转)
 *   11. JS _enrich 派生 cancelGuideLabel/List + _parseCancelGuide 兼容 JSON 字符串数组
 *
 * 验收:录入微信开通的爱奇艺 → 列表项展开看到「取消指引(按扣费渠道)」给微信路径;
 *      payChannel=inapp + 平台爱奇艺 → 展开看到 App 内路径;渠道 unknown + 平台未命中 → 两条通用路径并列。
 *
 * 运行: node scripts/verify-cancel-guides.js
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

/* ---------------- 1. cancelGuides.js 加载 ---------------- */
console.log('== 1. cloudfunctions/finChat/cancelGuides.js ==')
const cg = read('cloudfunctions/finChat/cancelGuides.js')
ok(/^exports\.|module\.exports/.test(cg), 'cancelGuides.js 通过 module.exports 导出')

/* ---------------- 2. CHANNEL_GUIDES 三渠道 ---------------- */
console.log('\n== 2. CHANNEL_GUIDES 三渠道 ==')
ok(/const\s+CHANNEL_GUIDES\s*=/.test(cg), 'CHANNEL_GUIDES 常量存在')
ok(/CHANNEL_GUIDES[\s\S]*?wechat:\s*'/.test(cg), 'CHANNEL_GUIDES.wechat 路径')
ok(/CHANNEL_GUIDES[\s\S]*?alipay:\s*'/.test(cg), 'CHANNEL_GUIDES.alipay 路径')
ok(/CHANNEL_GUIDES[\s\S]*?apple:\s*'/.test(cg), 'CHANNEL_GUIDES.apple 路径')
ok(/CHANNEL_GUIDES[\s\S]*?wechat:[\s\S]*?钱包[\s\S]*?支付设置/.test(cg), '微信路径含「钱包 → 支付设置」')
ok(/CHANNEL_GUIDES[\s\S]*?alipay:[\s\S]*?免密支付|自动扣款/.test(cg), '支付宝路径含「免密支付/自动扣款」')
ok(/CHANNEL_GUIDES[\s\S]*?apple:[\s\S]*?Apple ID[\s\S]*?订阅/.test(cg), '苹果路径含「Apple ID → 订阅」')

/* ---------------- 3. PLATFORM_GUIDES ≥8 平台 ---------------- */
console.log('\n== 3. PLATFORM_GUIDES ≥8 平台 ==')
ok(/const\s+PLATFORM_GUIDES\s*=/.test(cg), 'PLATFORM_GUIDES 常量存在')
const requiredPlatforms = ['爱奇艺', '腾讯视频', '优酷', '网易云音乐', 'QQ音乐', '百度网盘', 'iCloud', '美团', '饿了么']
for (const p of requiredPlatforms) {
  ok(new RegExp(`PLATFORM_GUIDES[\\s\\S]*?'${p}':\\s*'`).test(cg), `PLATFORM_GUIDES 含「${p}」`)
}
// 实际命中数量:统计 PLATFORM_GUIDES 对象字面量内 'name': 'path' 的行数
const platformBlockMatch = cg.match(/PLATFORM_GUIDES\s*=\s*\{([\s\S]*?)\n\}/)
const platformCount = platformBlockMatch
  ? (platformBlockMatch[1].match(/^\s*'[^']+'\s*:\s*'/gm) || []).length
  : 0
ok(platformCount >= 8, `PLATFORM_GUIDES 平台总数 ≥8(实际 ${platformCount})`)

/* ---------------- 4. FALLBACK 双兜底 ---------------- */
console.log('\n== 4. FALLBACK 双兜底 ==')
ok(/const\s+FALLBACK_GUIDES\s*=/.test(cg), 'FALLBACK_GUIDES 常量存在')
ok(/FALLBACK_GUIDES[\s\S]*?CHANNEL_GUIDES\.wechat/.test(cg), 'FALLBACK_GUIDES 含微信')
ok(/FALLBACK_GUIDES[\s\S]*?CHANNEL_GUIDES\.alipay/.test(cg), 'FALLBACK_GUIDES 含支付宝')

/* ---------------- 5. matchCancelGuide 三级优先级 ---------------- */
console.log('\n== 5. matchCancelGuide 三级匹配 ==')
ok(/function\s+matchCancelGuide\(/.test(cg), 'matchCancelGuide 函数存在')
ok(/matchCancelGuide[\s\S]*?channel\s*===\s*'wechat'\s*\|\|[\s\S]*?channel\s*===\s*'alipay'\s*\|\|[\s\S]*?channel\s*===\s*'apple'/.test(cg), '第一优先级:wechat/alipay/apple 任一命中 → CHANNEL_GUIDES')
ok(/matchCancelGuide[\s\S]*?return\s*\{\s*guide:\s*CHANNEL_GUIDES\[channel\][\s\S]*?source:\s*'channel'\s*\}/.test(cg), '渠道命中返回 { guide, source: "channel" }')
ok(/matchCancelGuide[\s\S]*?platform[\s\S]*?PLATFORM_GUIDES\[platform\]/.test(cg), '第二优先级:platform 命中 → PLATFORM_GUIDES')
ok(/matchCancelGuide[\s\S]*?return\s*\{[\s\S]*?guides:[\s\S]*?source:\s*'fallback'/.test(cg), '双兜底返回 { guides: [微信,支付宝], source: "fallback" }')
ok(/module\.exports[\s\S]*?matchCancelGuide/.test(cg), 'matchCancelGuide 通过 module.exports 暴露')

/* ---------------- 6. finChat 接 cancelGuides ---------------- */
console.log('\n== 6. cloudfunctions/finChat/index.js ==')
const fc = read('cloudfunctions/finChat/index.js')
ok(/const\s+cancelGuides\s*=\s*require\(['"]\.\/cancelGuides['"]\)/.test(fc), 'finChat 顶部 require("./cancelGuides")')

/* ---------------- 7. executeAddSubscription 写 cancelGuide ---------------- */
console.log('\n== 7. executeAddSubscription 写 cancelGuide ==')
ok(/async\s+function\s+executeAddSubscription[\s\S]*?cancelGuides\.matchCancelGuide\(\{[\s\S]*?payChannel[\s\S]*?platform[\s\S]*?\}\)/.test(fc), 'executeAddSubscription 调 matchCancelGuide({payChannel, platform})')
ok(/executeAddSubscription[\s\S]*?const\s+cancelGuide\s*=[\s\S]*?cancelMatch\.source\s*===\s*'fallback'[\s\S]*?JSON\.stringify\(cancelMatch\.guides\)[\s\S]*?:\s*cancelMatch\.guide/.test(fc), 'cancelGuide:双兜底 JSON 序列化数组 / 其他取 guide 字符串')
ok(/executeAddSubscription[\s\S]*?db\.collection\('subscriptions'\)\.add\(\{[\s\S]*?cancelGuide,[\s\S]*?cancelGuideSource:[\s\S]*?\}\)/.test(fc), 'add() 入库字段含 cancelGuide + cancelGuideSource')
ok(/executeAddSubscription[\s\S]*?return\s*\{[\s\S]*?record:\s*\{[\s\S]*?cancelGuide[\s\S]*?cancelGuideSource[\s\S]*?\}\s*\}/.test(fc), 'executeAddSubscription 返回 record 含 cancelGuide + cancelGuideSource')

/* ---------------- 8. executeEvaluateSubscription 实时匹配 ---------------- */
console.log('\n== 8. executeEvaluateSubscription 实时匹配 ==')
ok(/async\s+function\s+executeEvaluateSubscription[\s\S]*?cancelGuides\.matchCancelGuide\(\{[\s\S]*?payChannel:\s*sub\.payChannel[\s\S]*?platform:\s*sub\.platform[\s\S]*?\}\)/.test(fc), 'executeEvaluateSubscription 实时调 matchCancelGuide(不依赖 DB 旧值)')
ok(/executeEvaluateSubscription[\s\S]*?return\s*\{[\s\S]*?cancelGuide:[\s\S]*?cancelGuideSource:[\s\S]*?\}[\s\S]*?\}/.test(fc), 'executeEvaluateSubscription 返回 cancelGuide + cancelGuideSource')

/* ---------------- 9. formatEvaluateAnswer 拼取消指引 === */
console.log('\n== 9. formatEvaluateAnswer 拼取消指引 ==')
ok(/function\s+formatEvaluateAnswer[\s\S]*?【取消指引】/.test(fc), '事实块含【取消指引】段')
ok(/formatEvaluateAnswer[\s\S]*?cancelGuideSource\s*===\s*'channel'/.test(fc), '事实块按 source 分三种展示')
ok(/formatEvaluateAnswer[\s\S]*?cancelGuideSource\s*===\s*'platform'/.test(fc), '事实块 platform 分支')
ok(/formatEvaluateAnswer[\s\S]*?cancelGuideSource\s*===\s*'fallback'[\s\S]*?r\.cancelGuide\.forEach/.test(fc), '事实块 fallback 双兜底 forEach 列多条路径')

/* ---------------- 10. 订阅页 WXML 取消指引 ---------------- */
console.log('\n== 10. pages/subscriptions/subscriptions.wxml ==')
const swxml = read('pages/subscriptions/subscriptions.wxml')
ok(/class="sub-cancel/.test(swxml), 'wxml .sub-cancel 展开区(v2 改主提示卡样式)')
ok(/catchtap="toggleCancelGuide"/.test(swxml), 'wxml 展开 catchtap=toggleCancelGuide')
ok(/data-id="{{item\._id}}"/.test(swxml), 'wxml data-id 传订阅 _id')
ok(/想取消.{0,5}关闭指引|收起取消指引/.test(swxml) || /\{\{item\.cancelGuideLabel\}\}/.test(swxml), 'wxml 用 cancelGuideLabel 或新硬引导文案')
ok(/\{\{item\.cancelGuideOpen\}\}/.test(swxml), 'wxml 用 cancelGuideOpen 控制展开状态')
ok(/\{\{item\.cancelGuideSource[^}]*\}\}/.test(swxml) && /cancelGuideSource === 'fallback'/.test(swxml), 'wxml 三分支渲染:channel/platform/fallback')
ok(/cancelGuideList/.test(swxml), 'wxml 双兜底场景迭代 cancelGuideList')
ok(/sub-cancel-arrow-open/.test(swxml), 'wxml 展开箭头 90° 旋转 class')

/* ---------------- 11. 订阅页 WXSS ---------------- */
console.log('\n== 11. pages/subscriptions/subscriptions.wxss ==')
const swxss = read('pages/subscriptions/subscriptions.wxss')
ok(/\.sub-cancel\s*\{/.test(swxss), 'wxss .sub-cancel 样式')
ok(/\.sub-cancel-head/.test(swxss), 'wxss .sub-cancel-head')
ok(/\.sub-cancel-arrow/.test(swxss), 'wxss .sub-cancel-arrow')
ok(/\.sub-cancel-arrow-open/.test(swxss) && /transform:\s*rotate\(90deg\)/.test(swxss), 'wxss 展开箭头 rotate(90deg)')
ok(/\.sub-cancel-fallback/.test(swxss) && /\.sub-cancel-fallback-tag/.test(swxss), 'wxss 双兜底两条路径并列 + 路径标签')

/* ---------------- 12. 订阅页 JS ---------------- */
console.log('\n== 12. pages/subscriptions/subscriptions.js ==')
const sjs = read('pages/subscriptions/subscriptions.js')
ok(/toggleCancelGuide\(e\)\s*\{[\s\S]*?dataset\.id/.test(sjs), 'toggleCancelGuide 方法存在,读 dataset.id')
ok(/toggleCancelGuide[\s\S]*?subscriptions:\s*list/.test(sjs), 'toggleCancelGuide 局部替换 subscriptions 数组')
ok(/toggleCancelGuide[\s\S]*?cancelGuideOpen:\s*!s\.cancelGuideOpen/.test(sjs), 'toggleCancelGuide 翻转 cancelGuideOpen')

ok(/_enrich[\s\S]*?_parseCancelGuide\(s\.cancelGuide\)/.test(sjs), '_enrich 调 _parseCancelGuide 解析 DB 字段')
ok(/_enrich[\s\S]*?cancelGuideSource\s*===\s*'channel'[\s\S]*?按扣费渠道/.test(sjs), '_enrich channel label = 按扣费渠道')
ok(/_enrich[\s\S]*?cancelGuideSource\s*===\s*'platform'[\s\S]*?按平台/.test(sjs), '_enrich platform label = 按平台')
ok(/_enrich[\s\S]*?cancelGuideSource\s*===\s*'fallback'[\s\S]*?双兜底/.test(sjs), '_enrich fallback label = 双兜底')
ok(/_enrich[\s\S]*?JSON\.parse/.test(sjs), '_enrich 双兜底用 JSON.parse 解析路径列表')

ok(/_parseCancelGuide\(raw\)\s*\{/.test(sjs), '_parseCancelGuide 函数存在')
ok(/_parseCancelGuide[\s\S]*?typeof\s+raw\s*===\s*'string'[\s\S]*?try[\s\S]*?JSON\.parse/.test(sjs), '_parseCancelGuide 兼容 JSON 字符串数组形态')

/* ---------------- 13. 语法检查 ---------------- */
console.log('\n== 13. 语法检查 ==')
const files = [
  'cloudfunctions/finChat/cancelGuides.js',
  'cloudfunctions/finChat/index.js',
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

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)