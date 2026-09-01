// 记一笔 × 固定支出联动 · 验证脚本（临时，验证后可删）
const fs = require('fs')
const js = fs.readFileSync('pages/expenses/expenses.js', 'utf8')
const wxml = fs.readFileSync('pages/expenses/expenses.wxml', 'utf8')
const wxss = fs.readFileSync('pages/expenses/expenses.wxss', 'utf8')
let pass = 0, fail = 0
const assert = (name, cond) => { cond ? (pass++, console.log('✅ ' + name)) : (fail++, console.log('❌ ' + name)) }

// ---- 数据与逻辑 ----
assert('data 声明 pendingRecurring / linkedRecurring', js.includes('pendingRecurring: []') && js.includes('linkedRecurring: null'))
assert('openForm 重置 linkedRecurring 并拉取待记列表', /openForm\(\) \{[\s\S]*?linkedRecurring: null[\s\S]*?\}\)[\s\S]*?_loadPendingRecurring\(\)/.test(js))
assert('待记过滤：active 且 lastRecorded ≠ 当月', js.includes("r.active !== false && r.lastRecorded !== month"))
assert('点模板预填金额/分类/备注并挂关联', /onRecurringChipTap\(e\) \{[\s\S]*?formAmount: String\(item\.amount\)[\s\S]*?formNote: item\.name[\s\S]*?linkedRecurring: item/.test(js))
const clearBody = js.match(/clearLinkedRecurring\(\) \{([\s\S]*?)\n  \},/)
assert('可解除关联且保留预填内容', clearBody && clearBody[1].includes('linkedRecurring: null') && !clearBody[1].includes('formAmount'))
assert('保存时条件组装 recurringId（不传 undefined）', js.includes('payload.recurringId = linkedRecurring._id') && !js.includes('recurringId: linkedRecurring ?'))
assert('保存后标记 lastRecorded = 该笔日期所属月', js.includes("lastRecorded: formDate.slice(0, 7)"))
assert('标记失败不阻断记账（catch + console.warn）', /updateRecurring\(linkedRecurring\._id[\s\S]*?catch \(err\)[\s\S]*?console\.warn/.test(js))
assert('关联保存 toast 提示同步', js.includes("linkedRecurring.name + '本月已同步'"))
assert('保存后清空关联状态', /viewMonth: formDate\.slice\(0, 7\), linkedRecurring: null/.test(js))
assert('待记加载失败静默降级为空数组', /_loadPendingRecurring[\s\S]*?catch[\s\S]*?pendingRecurring: \[\]/.test(js))

// ---- WXML ----
assert('快捷条：有待记且未关联时显示', wxml.includes('pendingRecurring.length > 0 && !linkedRecurring'))
assert('快捷条横向滚动 chips', wxml.includes('scroll-x="{{true}}"') && wxml.includes('pending-recur-chip'))
assert('点 chip 传 data-id', /data-id="\{\{item\._id\}\}"/.test(wxml))
assert('已关联提示条 + ✕ 解除（catchtap 不冒泡）', wxml.includes('linked-recur-tag') && wxml.includes('catchtap="clearLinkedRecurring"'))
assert('快捷条位于金额输入上方', wxml.indexOf('pending-recur') < wxml.indexOf('amount-input'))

// ---- WXSS ----
assert('快捷条金色浅底引导样式', wxss.includes('.pending-recur {') && wxss.includes('var(--tint-gold-06)'))
assert('模板 chip 虚线金边胶囊', wxss.includes('border: 1rpx dashed var(--gold)'))
assert('关联提示条金边样式', wxss.includes('.linked-recur-tag {') && wxss.includes('border: 1rpx solid var(--gold)'))

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
