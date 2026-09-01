/**
 * 验证：固定支出 sheet scroll-view 高度自适应
 *
 * 背景：固定支出只有 2-3 项时，scroll-view 默认 height:56vh 会撑出 ~72% 屏高、
 * 底部大片空白的视觉问题（标题"被压在最顶端"）。
 *
 * 修复：scroll-view 用 inline style 引用 recurScrollHeight；openRecur 弹框入场后
 * 由 _fitRecurScrollHeight 测量内容真实像素高度——内容少时收敛为内容高度（自适应），
 * 内容多时回退到 56vh（保留 WX scroll-view 内部滚动能力）。
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

console.log('== 固定支出 sheet scroll-view 高度自适应 ==')
const myWxml = read('pages/my/my.wxml')
const myJs = read('pages/my/my.js')

// 1. scroll-view 仍保留 class="sheet-scroll"（沿用全局 56vh 兜底，保证滚动能力）
ok(/<scroll-view class="sheet-scroll"/.test(myWxml), 'scroll-view 保留 .sheet-scroll class（全局 56vh 兜底）')

// 2. scroll-view 加了 inline style 引用 recurScrollHeight
const scrollViewTag = (myWxml.match(/<scroll-view class="sheet-scroll"[^>]*>/g) || [])
  .find((t) => /style="height:\s*\{\{recurScrollHeight\}\}/.test(t))
ok(!!scrollViewTag, '固定支出 scroll-view 内联 style="height: {{recurScrollHeight}}"')

// 3. recurScrollHeight 是 data 字段,初值为 '56vh'(与全局 .sheet-scroll 一致)
ok(/recurScrollHeight:\s*'56vh'/.test(myJs), 'data 初值 recurScrollHeight = \'56vh\' (保留滚动兜底)')

// 4. openRecur 后调用 _fitRecurScrollHeight(给 setTimeout 320ms 等入场动画)
ok(/openRecur\(\)\s*\{[\s\S]*?util\.openSheet[\s\S]*?_fitRecurScrollHeight/.test(myJs),
  'openRecur 弹框入场后调用 _fitRecurScrollHeight')
ok(/setTimeout\(\(\)\s*=>\s*this\._fitRecurScrollHeight\(\),\s*320\)/.test(myJs),
  'openRecur 延迟 320ms 测量（等 sheetIn 动画 0.28s + DOM ready）')

// 5. closeRecur 重置为 56vh,避免下次开-关-开残留低高度
ok(/closeRecur[\s\S]*?recurScrollHeight:\s*'56vh'/.test(myJs),
  'closeRecur 重置 recurScrollHeight 为 56vh（防止下次打开残留）')

// 6. _fitRecurScrollHeight 测量 + 内容少/多分支
ok(/_fitRecurScrollHeight\s*\(\)\s*\{[\s\S]*?createSelectorQuery[\s\S]*?boundingClientRect/.test(myJs),
  '_fitRecurScrollHeight 用 wx.createSelectorQuery 测量内容')
ok(/_fitRecurScrollHeight[\s\S]*?contentPx\s*<=\s*maxPx/.test(myJs) ||
   /_fitRecurScrollHeight[\s\S]*?Math\.(?:ceil|floor)/.test(myJs),
  '_fitRecurScrollHeight 按内容像素 vs 56vh 取小收敛（自适应+兜底滚动）')
ok(/_fitRecurScrollHeight[\s\S]*?setData\(\{\s*recurScrollHeight/.test(myJs),
  '_fitRecurScrollHeight 把收敛结果写回 setData')

// 7. loadRecurring 在 sheet 打开时,增删行后重测高度
ok(/loadRecurring[\s\S]*?showRecur[\s\S]*?_fitRecurScrollHeight/.test(myJs) ||
   /loadRecurring[\s\S]*?_fitRecurScrollHeight\(/.test(myJs),
  'loadRecurring 后在 sheet 打开状态下重测高度（增删行后内容高度变化）')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
