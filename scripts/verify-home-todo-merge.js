/**
 * 验证:T1.5 首页「待办账务」区块改造(合并还款 + 订阅续费两类待办)
 * - pages/index/index.js:
 *   1. todoList 包含 type 字段('card' | 'sub')
 *   2. 遍历 batch.subscriptions 取 active + nextCharge 在「已过扣费日 / 今天 / 明天」范围内的订阅
 *   3. 订阅项字段 { id, type:'sub', name, amount, days, dueText, level, canPay:false }
 *   4. 订阅只取最近 2 条进首页区块,按 days asc 混排
 *   5. 订阅 level 三档语义(tomorrow/today/overdue),custom 周期 + 非 wechat/alipay/apple 渠道 → 用「到期/已过期·未续费」
 *   6. onTodoTap 按 type 分支:sub 跳订阅页;card 走 markPaid
 *   7. goSubscriptions 跳订阅页(区块头「订阅管理」入口)
 * - pages/index/index.wxml:
 *   1. 标题「待办账务」(升级自「今天要处理」)
 *   2. todo-item 按 type 分支渲染:card 有「标记已还」按钮;sub 整条 bindtap + 无按钮
 *   3. 区块头有「订阅管理」入口(catchtap=goSubscriptions)
 * - pages/index/index.wxss:
 *   1. .todo-sub-link / .todo-platform / .todo-arrow 样式齐全
 *
 * 运行: node scripts/verify-home-todo-merge.js
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

/* ---------------- 1. index.js todoList 合并逻辑 ---------------- */
console.log('== 1. pages/index/index.js todoList 合并 ==')
const idx = read('pages/index/index.js')
ok(/loadData\(/.test(idx), 'loadData 主入口')
ok(/todoList\s*=\s*\[\]/.test(idx), 'todoList 数组初始化')
// 1) cards 循环:每条带 type:'card'
ok(/todoList\.push\(\{[\s\S]*?type:\s*['"]card['"][\s\S]*?canPay:\s*true/.test(idx), 'cards 循环 push type=card + canPay=true')
// 2) subscriptions 循环
ok(/batch\.subscriptions|subscriptions\s*=\s*batch\.subscriptions/.test(idx) || /\(batch\.subscriptions\s*\|\|\s*\[\]\)/.test(idx), '从 batch.subscriptions 取订阅(T1.1 已并入 batchHomeRead)')
ok(/s\.status\s*===\s*['"]active['"][\s\S]*?s\.nextCharge/.test(idx), '订阅过滤:status=active + nextCharge 非空')
ok(/todoList\.push\(\{[\s\S]*?type:\s*['"]sub['"][\s\S]*?canPay:\s*false/.test(idx), '订阅循环 push type=sub + canPay=false(无「标记已还」按钮)')
ok(/type:\s*['"]sub['"][\s\S]*?name:\s*s\.name/.test(idx), '订阅项含 name 字段')
ok(/type:\s*['"]sub['"][\s\S]*?amount:[\s\S]*?s\.amount/.test(idx), '订阅项含 amount 字段(moneyThousand 包装)')
ok(/type:\s*['"]sub['"][\s\S]*?nextCharge:\s*s\.nextCharge/.test(idx), '订阅项含 nextCharge 字段(展示用)')
ok(/type:\s*['"]sub['"][\s\S]*?days:\s*days/.test(idx), '订阅项含 days 字段(混排用)')
ok(/type:\s*['"]sub['"][\s\S]{0,400}\blevel\b/.test(idx), '订阅项含 level 字段(tomorrow/today/overdue)')
ok(/type:\s*['"]sub['"][\s\S]{0,400}\bdueText\b/.test(idx), '订阅项含 dueText 字段')

// 3) 订阅只取最近 2 条进区块
ok(/subTodos\.slice\(0,\s*2\)/.test(idx) || /subTodos[\s\S]*?\.slice\(\s*0\s*,\s*2\s*\)/.test(idx), '订阅只取最近 2 条进首页区块(subTodos.slice(0, 2))')
ok(/todoList\.push\(\.\.\.subTop\)/.test(idx) || /todoList\.push\(\.\.\.subTodos\.slice/.test(idx), 'subTop 合并进 todoList')

// 4) 统一按 days asc 混排
ok(/todoList\.sort\(\(a,\s*b\)\s*=>\s*a\.days\s*-\s*b\.days\)/.test(idx), 'todoList 按 days asc 统一混排')

// 5) 订阅 level 三档语义
ok(/days\s*===\s*1[\s\S]*?level\s*=\s*['"]tomorrow['"]/.test(idx), '订阅 level: days===1 → tomorrow')
ok(/days\s*===\s*0[\s\S]*?level\s*=\s*['"]today['"]/.test(idx), '订阅 level: days===0 → today')
ok(/days\s*<\s*0[\s\S]*?level\s*=\s*['"]overdue['"]/.test(idx), '订阅 level: days<0 → overdue')

// 6) custom + 非 wechat/alipay/apple 渠道 → 期限包文案
ok(/AUTO_CHANNEL\s*=\s*\[\s*['"]wechat['"]\s*,\s*['"]alipay['"]\s*,\s*['"]apple['"]\s*\]/.test(idx), 'AUTO_CHANNEL = [wechat, alipay, apple] 三渠道')
ok(/isTermPack[\s\S]*?cycle\s*===\s*['"]custom['"][\s\S]*?AUTO_CHANNEL/.test(idx), 'isTermPack 判断:cycle=custom && 不在 AUTO_CHANNEL')

// 7) 三档 dueText:期限包 vs 自动扣
ok(/dueText\s*=\s*isTermPack\s*\?\s*['"]明天到期['"]\s*:\s*['"]明天扣费['"]/.test(idx), 'dueText tomorrow:期限包「明天到期」/ 自动扣「明天扣费」')
ok(/dueText\s*=\s*isTermPack\s*\?\s*['"]今天到期['"]\s*:\s*['"]今天扣费['"]/.test(idx), 'dueText today:期限包「今天到期」/ 自动扣「今天扣费」')
ok(/dueText\s*=\s*isTermPack\s*\?\s*['"]已过期·未续费['"]\s*:\s*['"]已扣费·未取消['"]/.test(idx), 'dueText overdue:期限包「已过期·未续费」/ 自动扣「已扣费·未取消」')

// 8) onTodoTap 分支
ok(/onTodoTap\(/.test(idx), 'onTodoTap handler 存在')
ok(/onTodoTap[\s\S]*?type\s*===\s*['"]sub['"][\s\S]*?navigateTo[\s\S]*?pages\/subscriptions\/subscriptions/.test(idx), 'onTodoTap: type=sub → navigateTo 订阅页')
ok(/onTodoTap[\s\S]*?type\s*!==\s*['"]sub['"][\s\S]*?markPaid/.test(idx) || /onTodoTap[\s\S]*?type\s*===\s*['"]sub['"][\s\S]*?else[\s\S]*?markPaid/.test(idx), 'onTodoTap: type≠sub → markPaid')

// 9) goSubscriptions
ok(/goSubscriptions\(/.test(idx), 'goSubscriptions handler 存在')
ok(/goSubscriptions\(\)[\s\S]*?navigateTo[\s\S]*?pages\/subscriptions\/subscriptions/.test(idx), 'goSubscriptions → navigateTo 订阅页')

/* ---------------- 2. index.wxml 区块改造 ---------------- */
console.log('\n== 2. pages/index/index.wxml 待办账务区块 ==')
const iwxml = read('pages/index/index.wxml')
ok(/>待办账务</.test(iwxml) || /card-title">待办账务</.test(iwxml), '标题升级为「待办账务」(原「今天要处理」)')
// 注释里可能有"今天要处理"作为历史说明,但可见文字里不能有
ok(!/card-title">[\s\S]*?今天要处理/.test(iwxml) && !/<text[^>]*>[\s\S]*?今天要处理[\s\S]*?<\/text>/.test(iwxml), 'wxml 标题/文本节点不再含旧标题「今天要处理」')
ok(/wx:if="\{\{todoList\.length\}\}"/.test(iwxml), 'todoList 空时整卡隐藏')

// 按 type 分支渲染
ok(/wx:for="\{\{todoList\}\}"/.test(iwxml), 'todoList wx:for 循环')
ok(/bindtap="onTodoTap"/.test(iwxml), '整条 todo-item bindtap=onTodoTap(type 分支)')
ok(/wx:if="\{\{item\.type === 'card'\}\}"/.test(iwxml), 'card 分支 wx:if')
ok(/wx:if="\{\{item\.canPay\}\}"/.test(iwxml) && /catchtap="markPaid"/.test(iwxml), 'card 分支「标记已还」按钮(canPay=true 才显示)')
ok(/wx:else/.test(iwxml) && /item\.type === 'card'/.test(iwxml), 'sub 分支 wx:else(无「标记已还」按钮)')

// sub 项展示:name + amount + nextCharge + 标签
ok(/\{\{item\.name\}\}/.test(iwxml), 'sub 项展示 item.name')
ok(/\{\{item\.platform\}\}/.test(iwxml) || /item\.platform/.test(iwxml), 'sub 项展示 item.platform(有就显示)')
ok(/\{\{item\.amount\}\}/.test(iwxml), 'sub 项展示 item.amount')
ok(/\{\{item\.dueText\}\}/.test(iwxml), 'sub 项展示 item.dueText')
ok(/\{\{item\.nextCharge\}\}/.test(iwxml), 'sub 项展示 item.nextCharge 日期')
ok(/>›</.test(iwxml) || /todo-arrow/.test(iwxml), 'sub 项右侧 chevron 箭头')

// 订阅管理入口(区块头)
ok(/todo-sub-link/.test(iwxml) || /订阅管理/.test(iwxml), '区块头「订阅管理」二级入口')
ok(/catchtap="goSubscriptions"/.test(iwxml), '订阅管理入口 catchtap=goSubscriptions')

// 标签三档:sub 用「已扣 / 今天 / 明天」,card 用「逾期 / 今天 / 明天」
ok(/item\.level === 'overdue'/.test(iwxml) && />已扣</.test(iwxml), 'sub overdue 标签「已扣」')
ok(/item\.level === 'today'/.test(iwxml) && /今天/.test(iwxml), 'sub today 标签「今天」')
ok(/tag-yellow/.test(iwxml), 'tomorrow 标签 tag-yellow(订阅/还款共用黄色系)')

/* ---------------- 3. index.wxss 样式 ---------------- */
console.log('\n== 3. pages/index/index.wxss 样式 ==')
const iwxss = read('pages/index/index.wxss')
ok(/\.todo-sub-link/.test(iwxss), '.todo-sub-link 样式(订阅管理入口)')
ok(/\.todo-platform/.test(iwxss), '.todo-platform 样式(订阅平台副文案)')
ok(/\.todo-arrow/.test(iwxss), '.todo-arrow 样式(订阅项右侧 chevron)')
ok(/\.todo-item\.overdue/.test(iwxss), '.todo-item.overdue 逾期样式(订阅/还款共用)')
ok(/\.todo-item\.today/.test(iwxss), '.todo-item.today 今天样式')
ok(/\.todo-item\.tomorrow/.test(iwxss), '.todo-item.tomorrow 明天样式')

/* ---------------- 4. 语法检查 ---------------- */
console.log('\n== 4. 语法检查 ==')
const NODE = process.execPath
for (const f of ['pages/index/index.js', 'pages/index/index.wxml', 'pages/index/index.wxss']) {
  try {
    if (f.endsWith('.js')) {
      execSync(`"${NODE}" --check "${path.join(ROOT, f)}"`, { stdio: 'pipe' })
      pass++
      console.log(`  ✓ ${f} 语法通过`)
    } else {
      // wxml/wxss 不做语法检查
      pass++
      console.log(`  ✓ ${f} 存在`)
    }
  } catch (e) {
    fail++
    console.log(`  ✗ ${f}: ${(e.stderr || e.message || '').toString().split('\n')[0]}`)
  }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
