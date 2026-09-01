/**
 * 验证：小程序弹框滚动穿透修复
 *
 * 覆盖：
 * 1. app.js 全局 Page 劫持，注入 preventTouchmove（所有页面默认拥有）
 * 2. 所有页面 wxml 中 mask / sheet / share-pop 弹层元素都带 catchtouchmove="preventTouchmove"
 * 3. ai-chat-sheet 组件：wxml 带拦截 + js 自带 preventTouchmove 方法（组件不吃 Page 注入）
 * 4. 长内容弹框改用内部 scroll-view 承载滚动（expenses 记一笔 / my 固定支出 / calendar 当日明细）
 * 5. 样式存在：.sheet-scroll（全局）、.form-sheet/.form-scroll（expenses）
 * 6. 所有页面用 Page() 构造（无 Component() 页面，全局注入才有效）
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
let pass = 0
let fail = 0

function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}`) }
}

function read(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8')
}

function listWxml(dir) {
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) out.push(...listWxml(full))
    else if (name.endsWith('.wxml')) out.push(full)
  }
  return out
}

console.log('== 1. 全局注入 ==')
const appJs = read('app.js')
ok(/const originalPage = Page/.test(appJs), 'app.js 劫持 Page 构造')
ok(/options\.preventTouchmove = function/.test(appJs), 'app.js 默认注入 preventTouchmove')
ok(/typeof options\.preventTouchmove !== 'function'/.test(appJs), '不覆盖页面自定义的同名方法')

console.log('== 2. 页面构造方式 ==')
const pageDirs = ['pages/index', 'pages/expenses', 'pages/salary', 'pages/cards',
  'pages/my', 'pages/calendar', 'pages/statement', 'pages/lock', 'pages/recycle']
for (const d of pageDirs) {
  const js = read(`${d}/${path.basename(d)}.js`)
  ok(/^Page\(/m.test(js) && !/^Component\(/m.test(js), `${d} 使用 Page() 构造（吃全局注入）`)
}

console.log('== 3. 弹层元素拦截扫描（mask / sheet / share-pop / form-sheet） ==')
const wxmlFiles = listWxml(path.join(ROOT, 'pages')).concat(listWxml(path.join(ROOT, 'components')))
let sheetCount = 0
for (const f of wxmlFiles) {
  const rel = path.relative(ROOT, f)
  const src = read(rel)
  // 抓所有弹层容器开标签（跨行属性），class 含 mask/sheet/share-pop
  const tagRe = /<view\b[^>]*class="[^"]*(?:mask|sheet|share-pop)[^"]*"[^>]*>/gs
  let m
  while ((m = tagRe.exec(src)) !== null) {
    const tag = m[0]
    // 纯展示性 class（如 sheet-title/sheet-actions/sheet-foot/pending-recur-row 等）不算弹层容器
    const cls = /class="([^"]*)"/.exec(tag)[1]
    const isContainer = /\bmask\b|\bsheet\b|\bshare-pop\b|\bform-sheet\b/.test(cls) &&
      !/(sheet-title|sheet-actions|sheet-foot|sheet-title-sub)/.test(cls)
    if (!isContainer) continue
    sheetCount++
    ok(/catchtouchmove="preventTouchmove"/.test(tag), `${rel}: 「${cls.trim()}」带 catchtouchmove`)
  }
}
ok(sheetCount >= 20, `扫描到 ${sheetCount} 个弹层容器（≥20，含 mask+sheet 成对）`)

console.log('== 4. ai-chat-sheet 组件 ==')
const chatWxml = read('components/ai-chat-sheet/ai-chat-sheet.wxml')
ok((chatWxml.match(/catchtouchmove="preventTouchmove"/g) || []).length >= 2, 'wxml mask+sheet 均带拦截')
const chatJs = read('components/ai-chat-sheet/ai-chat-sheet.js')
ok(/preventTouchmove\(\)\s*\{\}/.test(chatJs), '组件 js 自带 preventTouchmove 空方法（组件不吃 Page 注入）')
ok(/scroll-view class="ai-chat-history"/.test(chatWxml), '聊天记录区用 scroll-view 承载滚动（不受 catch 阻断）')

console.log('== 5. 长内容弹框内部滚动 ==')
const expWxml = read('pages/expenses/expenses.wxml')
ok(/class="sheet form-sheet/.test(expWxml), '记一笔弹框使用 form-sheet 结构')
ok(/scroll-view class="form-scroll"/.test(expWxml), '记一笔表单包裹在 scroll-view 内')
const expWxss = read('pages/expenses/expenses.wxss')
ok(/\.form-sheet\s*\{/.test(expWxss) && /overflow:\s*hidden/.test(expWxss), '.form-sheet flex 布局 + overflow:hidden')
ok(/\.form-scroll\s*\{[^}]*height:\s*62vh/s.test(expWxss), '.form-scroll 固定高度 62vh（scroll-view 内部滚动需要确定高度）')

const myWxml = read('pages/my/my.wxml')
ok(/<scroll-view class="sheet-scroll"[^>]*>\s*\n\s*<view class="recur-tip">/.test(myWxml.replace(/\r/g, '')), '固定支出列表包裹在 sheet-scroll 内')

const calWxml = read('pages/calendar/calendar.wxml')
ok(/scroll-view class="sheet-scroll"/.test(calWxml) && /day-total/.test(calWxml), '当日明细包裹在 sheet-scroll 内')

const appWxss = read('app.wxss')
ok(/\.sheet\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s.test(appWxss), '全局 .sheet 是 flex 列布局')
ok(/\.sheet-scroll\s*\{[^}]*height:\s*56vh/s.test(appWxss), '全局 .sheet-scroll 固定高度 56vh（scroll-view 内部滚动需要确定高度）')

console.log('== 6. 内层既有 scroll-view 不受影响（抽查） ==')
ok(/scroll-view[^>]*class="opt-list"/.test(read('pages/index/index.wxml')), '最优还款列表仍为 scroll-view')
ok(/scroll-x="\{\{true\}\}"/.test(expWxml), '记一笔固定支出横滑条仍为 scroll-x')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
