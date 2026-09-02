/**
 * 验证:T1.2 订阅页 UI
 * - app.json: pages/subscriptions/subscriptions 已注册
 * - pages/subscriptions/* 三件套存在 + 关键字段
 * - pages/my/*: 资产区块加「订阅续费管理」cell + goSubscriptions
 * - 弹层/表单/删除确认结构齐全
 * - 4.3 节 v2:nextCharge 是「主录入字段 + 唯一到期判断依据」
 *   + picker mode="date" 日期选择器
 *   + 「今天新开」快捷(nextCharge = 今天 + 1 周期)
 *   + 录入引导(冷启动友好:去 App 会员中心照抄)
 *   + 删「不记得了」降级 + 删前端 firstChargeDate 录入字段
 * - saveSubscription 走「口径归一」逻辑:nextCharge → cycleDay + firstChargeDate
 *
 * 运行: node scripts/verify-subscriptions-page.js
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

/* ---------------- 1. app.json 注册 ---------------- */
console.log('== 1. app.json 注册 ==')
const app = read('app.json')
ok(/"pages\/subscriptions\/subscriptions"/.test(app), 'app.json 注册 pages/subscriptions/subscriptions')

/* ---------------- 2. 页面三件套 ---------------- */
console.log('\n== 2. 页面三件套 ==')
for (const f of ['pages/subscriptions/subscriptions.json', 'pages/subscriptions/subscriptions.wxml', 'pages/subscriptions/subscriptions.wxss', 'pages/subscriptions/subscriptions.js']) {
  ok(fs.existsSync(path.join(ROOT, f)), `${f} 存在`)
}
const subJson = read('pages/subscriptions/subscriptions.json')
ok(/"navigationBarTitleText"\s*:\s*"订阅续费管理"/.test(subJson), 'navigationBarTitleText = 订阅续费管理')
ok(/"enablePullDownRefresh"\s*:\s*true/.test(subJson), 'enablePullDownRefresh = true')

/* ---------------- 3. subscriptions.js 关键逻辑 ---------------- */
console.log('\n== 3. subscriptions.js 逻辑 ==')
const sjs = read('pages/subscriptions/subscriptions.js')
ok(/Page\(/m.test(sjs), 'Page() 入口')
ok(/loadSubscriptions\(\s*force\s*\)/.test(sjs), 'loadSubscriptions(force) 方法存在')
ok(/onShow[\s\S]*?loadSubscriptions\(\)/.test(sjs), 'onShow 调 loadSubscriptions（解决进入页面数据空白 bug）')
ok(/listSubscriptions\(/.test(sjs), '调用 dbApi.listSubscriptions')
ok(/openForm\(/.test(sjs), 'openForm 方法存在')
ok(/saveSubscription\(\)/.test(sjs), 'saveSubscription 方法存在')
ok(/removeSubscription/.test(sjs), '调用 dbApi.removeSubscription')
ok(/confirmRemove\(/.test(sjs), 'confirmRemove 方法存在')
ok(/doRemove\(\)/.test(sjs), 'doRemove 方法存在')
ok(/closeForm\(\)/.test(sjs), 'closeForm 方法存在')
ok(/closeRemoveConfirm\(\)/.test(sjs), 'closeRemoveConfirm 方法存在')
ok(/_yearly\(/.test(sjs) && /'monthly'\)\s*return\s+a\s*\*\s*12/.test(sjs) && /'yearly'\)\s*return\s+a(?!\s*\*)/.test(sjs) && /'quarterly'\)\s*return\s*a\s*\*\s*4/.test(sjs) && /'weekly'\)\s*return\s*a\s*\*\s*52/.test(sjs), '年化金额公式：monthly×12 / yearly×1 / quarterly×4 / weekly×52')
ok(/_yearly[\s\S]*?'custom'[\s\S]*?12\s*\/\s*cm/.test(sjs) || /_yearly[\s\S]*?'custom'[\s\S]*?12\s*\/\s*customMonths/.test(sjs), '年化金额公式:custom = amount × 12 / customMonths(半年包 88 → 176/年)')
ok(/_summary\(/.test(sjs) && /status\s*!==\s*'active'/.test(sjs), '汇总只计 active 项（暂停/取消不计入）')

// 4.3 节 v2:nextCharge 主录入字段 + 口径归一
ok(/formNextCharge\s*:/.test(sjs), 'data 字段 formNextCharge(form 日期选择器双向绑定,主字段)')
ok(!/formFirstChargeDate\s*:/.test(sjs), 'data 字段无 formFirstChargeDate(已删除旧口径字段)')
ok(!/formCycleDay\s*:/.test(sjs), 'data 字段无 formCycleDay(已删除 cycleDay 前端录入字段)')
ok(!/formFallback\s*:/.test(sjs), 'data 字段无 formFallback(已删除「不记得了」降级 mode 开关)')
ok(/formDateEnd\s*:/.test(sjs) || /onShow[\s\S]*?formDateEnd/.test(sjs), 'formDateEnd:date picker 上限(默认明天)')
ok(/onFormNextChargeChange\(/.test(sjs), 'onFormNextChargeChange 处理日期选择变化')
ok(!/onFormFirstChargeDateChange/.test(sjs), '无 onFormFirstChargeDateChange(旧事件已删除)')
ok(!/openCycleDayFallback/.test(sjs), '无 openCycleDayFallback(「不记得了」已删除)')
ok(!/setTodayAsFirstCharge/.test(sjs), '无 setTodayAsFirstCharge(已替换为今天新开)')
ok(/setNextChargeAsNewToday\(/.test(sjs), 'setNextChargeAsNewToday 方法存在(快捷项:今天新开,nextCharge = 今天 + 1 周期)')
ok(/setNextChargeAsNewToday[\s\S]*?今天\s*\+\s*1\s*周期|today[\s\S]*?\+\s*1[\s\S]*?周期/.test(sjs) || /setNextChargeAsNewToday[\s\S]*?monthly\s*\?\s*1|step\s*=\s*cycle\s*===\s*'monthly'\s*\?\s*1/.test(sjs), 'setNextChargeAsNewToday:按 cycle 推进 1 周期(monthly +1 月 / quarterly +3 月 / yearly +1 年 / weekly +7 天 / custom +customMonths 月)')
ok(!/_fallbackFirstChargeDate\b/.test(sjs) && !/fallbackFirstChargeDate\(/.test(sjs), '无 _fallbackFirstChargeDate 兜底函数(cycleDay 不再是前端录入字段)')
ok(/util\.deriveCycleDay\(/.test(sjs), '调 util.deriveCycleDay 从 nextCharge 推导 cycleDay')
ok(/util\.deriveFirstChargeDate\b/.test(sjs) || /deriveFirstChargeDate\(/.test(sjs), '调 util.deriveFirstChargeDate 从 nextCharge 推算 firstChargeDate(年度报告用)')
ok(/nextChargeRaw[\s\S]*?\\d\{4\}-\\d\{2\}-\\d\{2\}[\s\S]*?\.test/.test(sjs), 'saveSubscription 校验 nextCharge 格式 YYYY-MM-DD')
ok(/saveSubscription[\s\S]*?deriveCycleDay\(cycle,\s*nextCharge\)/.test(sjs), 'saveSubscription:nextCharge → deriveCycleDay 反推 cycleDay')
ok(/saveSubscription[\s\S]*?deriveFirstChargeDate\(cycle,\s*nextCharge/.test(sjs), 'saveSubscription:nextCharge → deriveFirstChargeDate 反推 firstChargeDate')
ok(/saveSubscription[\s\S]*?payload[\s\S]*?nextCharge/.test(sjs), 'saveSubscription:写库 payload 含 nextCharge(主录入字段)')
ok(/saveSubscription[\s\S]*?payload[\s\S]*?cycleDay/.test(sjs) && /saveSubscription[\s\S]*?payload[\s\S]*?firstChargeDate/.test(sjs), 'saveSubscription:写库 payload 含 cycleDay + firstChargeDate(从 nextCharge 反推)')
ok(/amount\s*<=\s*0/.test(sjs), '金额合法性校验（>0）')
ok(/util\.errTip/.test(sjs), '失败用 util.errTip 转成用户可读提示')

/* ---------------- 4. subscriptions.wxml 结构 ---------------- */
console.log('\n== 4. subscriptions.wxml 结构 ==')
const swxml = read('pages/subscriptions/subscriptions.wxml')
ok(!/<view class="navbar"/.test(swxml), 'wxml 不含冗余的自定义 navbar(用原生 navigationBarTitleText 即可)')
ok(/sum-card/.test(swxml), '汇总卡 sum-card')
ok(/月均支出/.test(swxml) && /年化支出/.test(swxml), '汇总卡含「月均支出」「年化支出」')
ok(/{{activeCount}} 项使用中 \/ 共 {{totalCount}} 项/.test(swxml), '汇总卡头显 activeCount / totalCount')
ok(/sub-list-card/.test(swxml), '列表卡 sub-list-card')
ok(/wx:for="{{subscriptions}}"/.test(swxml), '订阅列表 wx:for')
ok(/bindtap="openForm" data-id="{{item\._id}}"/.test(swxml), '点行打开编辑（openForm + data-id）')
ok(/catchtap="confirmRemove" data-id="{{item\._id}}"/.test(swxml), '删除入口（confirmRemove + data-id）')
ok(/showForm/.test(swxml) && /showRemoveConfirm/.test(swxml), '弹层 showForm / showRemoveConfirm')
ok(/<view class="sheet\b/.test(swxml) && /sheet-actions/.test(swxml), '表单 sheet 复用了 .sheet + .sheet-actions')
ok(/<scroll-view class="sheet-scroll"/.test(swxml), '表单内部用 scroll-view.sheet-scroll')
ok(/<picker mode="selector" range="{{cycleOptions}}"/.test(swxml), '周期 picker(cycleOptions 含 standard + custom)')
ok(/\['每月',\s*'每年',\s*'每季',\s*'每周',\s*'自定义'\]/.test(sjs), 'cycleOptions 5 选项:每月/每年/每季/每周/自定义')
ok(/wx:if="\{\{cycleIndex === 4\}\}"[\s\S]*?customMonths/.test(swxml), 'wxml:选「自定义」时显示 customMonths 输入框')
ok(/bindinput="onCustomMonthsInput"/.test(swxml), 'wxml:customMonths 输入框绑定 onCustomMonthsInput')
ok(/每个周期含几个月|半年包.*季包/.test(swxml), 'wxml:customMonths 输入框 placeholder 提示「如 6 = 半年包,3 = 季包」')
ok(/首次到期日期/.test(swxml), 'wxml:custom 时首扣日标签改为「首次到期日期」')
ok(/下次到期/.test(swxml), 'wxml:custom 时推导展示 + 预览块文案用「下次到期」')

ok(/customMonths:\s*'/.test(sjs), 'data 字段 customMonths(空字符串初始化)')
ok(/onCustomMonthsInput\(/.test(sjs), 'onCustomMonthsInput 处理方法存在')
ok(/onCycleChange[\s\S]*?customMonths/.test(sjs), 'onCycleChange:切到/切走 custom 时维护 customMonths 状态')
ok(/openForm[\s\S]*?customMonths\s*=\s*editing[\s\S]*?'custom'/.test(sjs) || /openForm[\s\S]*?cycleIndex === 4[\s\S]*?customMonths/.test(sjs), 'openForm:从记录回填 cycleIndex + customMonths(custom 落索引 4)')
ok(/_enrich[\s\S]*?cycle\s*===\s*'custom'[\s\S]*?每\s*\$\{cm\}\s*个月/.test(sjs) || /_enrich[\s\S]*?custom[\s\S]*?每\s*cm\s*个月|\$\{cm\}\s*个月/.test(sjs), '_enrich:custom 显示「每 N 个月」周期文本')
ok(/_previewFromForm[\s\S]*?customMonths/.test(sjs), '_previewFromForm:custom 接收 customMonths 参数')
ok(/saveSubscription[\s\S]*?custom[\s\S]*?1[\s\S]*?36/.test(sjs), 'saveSubscription:custom 校验 customMonths 1-36 整数')
ok(/saveSubscription[\s\S]*?payload[\s\S]*?customMonths/.test(sjs) || /saveSubscription[\s\S]*?isCustom[\s\S]*?customMonths/.test(sjs), 'saveSubscription:写库 payload 含 customMonths(仅 custom 时)')
ok(/<picker mode="selector" range="{{usageOptions}}"/.test(swxml), '使用频率 picker 4 选项')
ok(/<picker mode="selector" range="{{statusOptions}}"/.test(swxml), '状态 picker 3 选项')

// 4.3 节 v2:nextCharge 主录入 picker + 录入引导 + 今天新开快捷 + 只读推导展示(无 cycleDay 降级 mode)
ok(/<picker mode="date" value="{{formNextCharge}}"/.test(swxml), 'wxml 用 picker mode="date" 日期选择器(主录入字段 nextCharge)')
ok(/bindchange="onFormNextChargeChange"/.test(swxml), 'date picker 绑定 onFormNextChargeChange 事件')
ok(!/formFirstChargeDate/.test(swxml), 'wxml 不再含 formFirstChargeDate 旧字段')
ok(!/formCycleDay\b/.test(swxml), 'wxml 不再含 formCycleDay 旧字段')
ok(!/formFallback\b/.test(swxml), 'wxml 不再含 formFallback 旧开关')
// 「不记得了」可能在注释里出现(说明文档),不能简单搜关键字;改用检查「不记得了」是否绑定了 openCycleDayFallback 事件
ok(!/bindtap="openCycleDayFallback"/.test(swxml), 'wxml 不再含「不记得了」bindtap 旧快捷项')
ok(/form-guide/.test(swxml) && /不知道怎么填|会员中心|会员有效期/.test(swxml), 'wxml 含录入引导(去 App 会员中心照抄有效期)')
ok(/bindtap="setNextChargeAsNewToday"/.test(swxml), '快捷项:今天新开 bindtap=setNextChargeAsNewToday')
ok(/今天新开/.test(swxml), 'wxml 含「今天新开」快捷项')
ok(/form-derived[\s\S]*?每月扣费日[\s\S]*?下次扣费/.test(swxml), 'wxml 只读推导展示块 form-derived(每月扣费日 + 下次扣费)')
ok(!/cycleIndex\s*===\s*3/.test(swxml), 'wxml 不再含 cycleIndex === 3(笔误已修复:3 是 weekly,不是 yearly)')

// T1.2 增量:扣费渠道 picker(5 选项)
ok(/<picker mode="selector" range="{{payChannelOptions}}"/.test(swxml), '扣费渠道 picker 5 选项(微信/支付宝/苹果/App内/不清楚)')
ok(/bindchange="onPayChannelChange"/.test(swxml), '扣费渠道 picker 绑定 onPayChannelChange')
ok(/payChannelOptions:/.test(sjs), 'data 字段 payChannelOptions')
ok(/payChannelIndex:/.test(sjs), 'data 字段 payChannelIndex(默认 4=unknown)')
ok(/onPayChannelChange\(/.test(sjs), 'onPayChannelChange 方法存在')
ok(/saveSubscription[\s\S]*?payChannel[\s\S]*?payChannels\[/.test(sjs), 'saveSubscription 透传 payChannel')
ok(/\['微信自动续费',\s*'支付宝自动扣款',\s*'苹果订阅',\s*'App\s*内开通',\s*'不清楚'\]/.test(sjs), 'payChannelOptions 5 个选项完整')

// T1.2 增量:空状态录入引导文案
ok(/不知道自己开通了哪些自动续费/.test(swxml), '空态 onboarding 核心句')
ok(/微信[：:]\s*我\s*→\s*服务\s*→\s*钱包/.test(swxml) || /微信：.*我.*服务.*钱包.*支付设置.*自动续费/.test(swxml), '空态 onboarding:微信路径文案')
ok(/支付宝[：:]\s*我的\s*→\s*设置\s*→\s*支付设置/.test(swxml) || /支付宝：.*我的.*设置.*支付设置.*免密支付/.test(swxml), '空态 onboarding:支付宝路径文案')

ok(/form-preview/.test(swxml), '保存预览：年化金额 + 下次扣费实时显示')
ok(/catchtouchmove="preventTouchmove"/.test(swxml), '弹层 catchtouchmove 防滚动穿透')

/* ---------------- 5. subscriptions.wxss 样式 ---------------- */
console.log('\n== 5. subscriptions.wxss 样式 ==')
const swxss = read('pages/subscriptions/subscriptions.wxss')
ok(/\.sum-card/.test(swxss) && /\.sum-num/.test(swxss), '汇总卡样式 .sum-card / .sum-num')
ok(/\.sub-row/.test(swxss), '列表行样式 .sub-row')
ok(/\.sub-row\.inactive/.test(swxss), '暂停/取消行变灰 .sub-row.inactive')
ok(/\.form-quick-row/.test(swxss) && /\.form-quick-btn/.test(swxss), '快捷项样式 .form-quick-row / .form-quick-btn')
ok(/\.form-derived/.test(swxss) && /\.form-derived-label/.test(swxss), '只读推导展示样式 .form-derived / .form-derived-label')
ok(/\.form-guide/.test(swxss), '录入引导样式 .form-guide')
ok(/\.mini-sheet/.test(swxss) && /miniSheetIn/.test(swxss), '删除确认迷你弹层 + 入场动画')
// T1.2 增量:空态 onboarding 样式
ok(/\.empty-card\s+\.empty-guide/.test(swxss), 'wxss 含 .empty-guide 样式')
ok(/\.empty-card\s+\.empty-guide\s+\.guide-key/.test(swxss), 'wxss 含 .guide-key 高亮样式(路径文字加粗)')

/* ---------------- 6. pages/my 次入口 ---------------- */
console.log('\n== 6. pages/my 次入口 ==')
const myWxml = read('pages/my/my.wxml')
ok(/bindtap="goSubscriptions"/.test(myWxml), 'my.wxml 有 bindtap="goSubscriptions"')
ok(/my-row-label">订阅续费管理</.test(myWxml), '次入口 label = 订阅续费管理')
ok(/subCount\s*>\s*0\s*\?\s*subCount\s*\+\s*' 项 · 年化 ¥' \+ subYearlyText/.test(myWxml), '副文案根据 subCount/subYearlyText 拼接')
const myJs = read('pages/my/my.js')
ok(/goSubscriptions\(\)/.test(myJs), 'my.js 有 goSubscriptions 方法')
ok(/wx\.navigateTo\(\{\s*url:\s*'\/pages\/subscriptions\/subscriptions'\s*\}\)/.test(myJs), 'goSubscriptions navigateTo 到订阅页')
ok(/loadSubscriptions\(\)/.test(myJs), 'my.js 有 loadSubscriptions 方法')
ok(/onShow[\s\S]*?loadSubscriptions\(\)/.test(myJs), 'onShow 调用 loadSubscriptions')
ok(/subCount:/.test(myJs) && /subYearlyText:/.test(myJs), 'data 声明 subCount / subYearlyText')
ok(/listSubscriptions\(\)/.test(myJs), 'loadSubscriptions 调 listSubscriptions')
ok(/'monthly'\)\s*yearly\s*\+=\s*a\s*\*\s*12[\s\S]*'yearly'\)\s*yearly\s*\+=\s*a(?!\s*\*)[\s\S]*'quarterly'\)\s*yearly\s*\+=\s*a\s*\*\s*4[\s\S]*'weekly'\)\s*yearly\s*\+=\s*a\s*\*\s*52/.test(myJs), 'my.js 同样用 monthly×12/yearly×1/quarterly×4/weekly×52 算年化')

/* ---------------- 7. 语法检查 ---------------- */
console.log('\n== 7. 语法检查 ==')
const NODE = process.execPath
for (const f of [
  'app.json',
  'pages/subscriptions/subscriptions.js',
  'pages/subscriptions/subscriptions.wxml',
  'pages/subscriptions/subscriptions.wxss',
  'pages/my/my.js',
  'pages/my/my.wxml'
]) {
  try {
    if (f.endsWith('.json')) {
      JSON.parse(read(f))
      pass++
      console.log(`  ✓ ${f} JSON 合法`)
    } else if (f.endsWith('.js')) {
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
