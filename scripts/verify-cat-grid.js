// 分类选择器组件化改造 · 验证脚本（临时，验证后可删）
const fs = require('fs')
const read = (p) => fs.readFileSync(p, 'utf8')
const comp = {
  js: read('components/cat-grid/cat-grid.js'),
  wxml: read('components/cat-grid/cat-grid.wxml'),
  wxss: read('components/cat-grid/cat-grid.wxss'),
  json: read('components/cat-grid/cat-grid.json')
}
const pages = {
  expenses: {
    wxml: read('pages/expenses/expenses.wxml'), js: read('pages/expenses/expenses.js'),
    wxss: read('pages/expenses/expenses.wxss'), json: read('pages/expenses/expenses.json')
  },
  salary: {
    wxml: read('pages/salary/salary.wxml'), js: read('pages/salary/salary.js'),
    wxss: read('pages/salary/salary.wxss'), json: read('pages/salary/salary.json')
  },
  my: {
    wxml: read('pages/my/my.wxml'), js: read('pages/my/my.js'),
    wxss: read('pages/my/my.wxss'), json: read('pages/my/my.json')
  }
}
const app = read('app.wxss')
let pass = 0, fail = 0
const assert = (name, cond) => { cond ? (pass++, console.log('✅ ' + name)) : (fail++, console.log('❌ ' + name)) }

// ---- 组件 ----
assert('组件 json 声明 component:true', comp.json.includes('"component": true'))
const CATS = ['餐饮', '交通', '购物', '孩子', '居住', '还款', '其他']
const INCOMES = ['主业', '副业', '年终奖/奖金', '红包/礼金', '理财收益', '其他收入']
assert('ICON_MAP 覆盖 7 个支出分类', CATS.every(k => comp.js.includes("'" + k + "'")))
assert('ICON_MAP 覆盖 6 个收入类型', INCOMES.every(k => comp.js.includes("'" + k + "'")))
const ICONS = ['🍜', '🚇', '🛍️', '🧸', '🏠', '💳', '📦', '💼', '🚀', '🏆', '🧧', '📈', '💰']
assert('13 个 emoji 图标齐全', ICONS.every(i => comp.js.includes(i)))
assert('支持字符串/对象两种 items', comp.js.includes("typeof it === 'object'") && comp.js.includes('it.label || it.value'))
assert('change 事件带 value', comp.js.includes("triggerEvent('change', { value })"))
assert('未知项回退图标 🏷️', comp.js.includes('🏷️'))
assert('4 列宽度 calc', comp.wxss.includes('calc((100% - 60rpx) / 4)'))
assert('选中金色边框+金底图标', comp.wxss.includes('border-color: var(--gold)') && comp.wxss.includes('linear-gradient(135deg, var(--gold), var(--gold-700))'))
assert('勾标 ✓', comp.wxml.includes('cg-check') && comp.wxml.includes('✓'))
assert('点击态 hover-class', comp.wxml.includes('cg-cell-hover') && comp.wxss.includes('.cg-cell-hover'))
assert('6 种 tone 底色', ['tone-gold', 'tone-navy', 'tone-danger', 'tone-success', 'tone-warn', 'tone-text'].every(t => comp.wxss.includes('.' + t)))
assert('选中态选择器优先级正确（3 类名压过 tone 2 类名）', /\.cg-cell\.cg-selected \.cg-icon/.test(comp.wxss))
assert('格子底色/选中底用主题变量', comp.wxss.includes('background: var(--input-bg)') && comp.wxss.includes('background: var(--tint-gold-06)'))
assert('勾标带 card 描边圈', comp.wxss.includes('border: 2rpx solid var(--card)'))

// ---- app.wxss ----
assert('app.wxss 8 处新 tint 变量（4 主题块 × 2 变量）', (app.match(/--tint-(success|warn)-12/g) || []).length === 8)
assert('浅色 tint 值正确', app.includes('--tint-success-12: rgba(47, 155, 107, 0.12)') && app.includes('--tint-warn-12: rgba(201, 138, 45, 0.12)'))
assert('深色 tint 值正确', app.includes('--tint-success-12: rgba(79, 183, 138, 0.16)') && app.includes('--tint-warn-12: rgba(224, 160, 85, 0.16)'))

// ---- 三页面替换 ----
const specs = [
  ['expenses', 'categories', 'formCategory', 'onCategoryTap'],
  ['salary', 'sourceOptions', 'formSource', 'onSourceTap'],
  ['my', 'categories', 'rCategory', 'onRCategoryTap']
]
specs.forEach(([p, items, val, handler]) => {
  assert(p + '.json 注册 cat-grid', pages[p].json.includes('"cat-grid": "/components/cat-grid/cat-grid"'))
  const useRe = new RegExp('<cat-grid items="\\{\\{' + items + '\\}\\}" value="\\{\\{' + val + '\\}\\}" bindchange="' + handler + '"')
  assert(p + '.wxml 使用 cat-grid（items/value/bindchange 正确）', useRe.test(pages[p].wxml))
  const fnRe = new RegExp(handler + '\\(e\\) \\{[\\s\\S]*?e\\.detail\\.value[\\s\\S]*?\\},')
  // 只检查 handler 函数体内（到第一个 "}," 为止）是否残留 dataset
  const bodyMatch = pages[p].js.match(new RegExp(handler + '\\(e\\) \\{([\\s\\S]*?)\\n  \\},'))
  assert(p + '.js handler 读 e.detail.value 且函数体无 dataset 残留', fnRe.test(pages[p].js) && bodyMatch && !bodyMatch[1].includes('dataset'))
  assert(p + '.wxml 无旧 cat-chips / chip 类', !pages[p].wxml.includes('cat-chips') && !pages[p].wxml.includes("class=\"chip "))
  assert(p + '.wxss 无旧 chip 样式', !pages[p].wxss.includes('.cat-chips') && !/^\.chip /m.test(pages[p].wxss) && !pages[p].wxss.includes('.chip-active'))
})

// ---- 不受影响的独立 chip 类 ----
assert('my 页 cat-budget-chip 保留', pages.my.wxml.includes('cat-budget-chip') && pages.my.wxss.includes('.cat-budget-chip'))
assert('expenses 页 stmt-quick-chip 保留', pages.expenses.wxml.includes('stmt-quick-chip') && pages.expenses.wxss.includes('.stmt-quick-chip'))
assert('salary 页 source-tag（列表展示标签）保留', pages.salary.wxss.includes('.source-tag'))

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
