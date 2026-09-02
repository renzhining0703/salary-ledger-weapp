// 验证 nextChargeOf 新口径:从 currentNextCharge 推进 1 周期
const util = require('../utils/util')
let pass = 0, fail = 0
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

console.log('== nextChargeOf 新口径 ==')
// monthly: 每月一次,currentNextCharge + 1 月
ok(util.nextChargeOf('monthly', '2026-09-15') === '2026-10-15', 'monthly: 2026-09-15 → 2026-10-15')
ok(util.nextChargeOf('monthly', '2026-12-15') === '2027-01-15', 'monthly 跨年: 2026-12-15 → 2027-01-15')
ok(util.nextChargeOf('monthly', '2026-01-31') === '2026-02-28', 'monthly 月末 clamp: 2026-01-31 → 2026-02-28')
// quarterly: +3 月
ok(util.nextChargeOf('quarterly', '2026-09-15') === '2026-12-15', 'quarterly: 2026-09-15 → 2026-12-15')
// yearly: +1 年
ok(util.nextChargeOf('yearly', '2026-09-15') === '2027-09-15', 'yearly: 2026-09-15 → 2027-09-15')
// weekly: +7 天
ok(util.nextChargeOf('weekly', '2026-09-15') === '2026-09-22', 'weekly: 2026-09-15 → 2026-09-22')
// custom 半年包: +6 月
ok(util.nextChargeOf('custom', '2026-09-04', undefined, 6) === '2027-03-04', 'custom 半年包: 2026-09-04 → 2027-03-04')
// custom 季包: +3 月
ok(util.nextChargeOf('custom', '2026-09-15', undefined, 3) === '2026-12-15', 'custom 季包: 2026-09-15 → 2026-12-15')
// custom 两年包: +24 月
ok(util.nextChargeOf('custom', '2024-06-15', undefined, 24) === '2026-06-15', 'custom 两年包: 2024-06-15 → 2026-06-15')
// custom 非法 customMonths → ''
ok(util.nextChargeOf('custom', '2026-09-15', undefined, 0) === '', 'custom customMonths=0 → \'\'')
ok(util.nextChargeOf('custom', '2026-09-15', undefined, 37) === '', 'custom customMonths=37 → \'\'')
// 非法 nextCharge → ''
ok(util.nextChargeOf('monthly', '') === '', 'nextCharge 空 → \'\'')
ok(util.nextChargeOf('monthly', '2026-9-15') === '', 'nextCharge 格式错 → \'\'')

console.log('\n== deriveCycleDay 新口径 ==')
ok(util.deriveCycleDay('monthly', '2026-09-15') === 15, 'monthly: nextCharge 2026-09-15 → cycleDay 15')
ok(util.deriveCycleDay('quarterly', '2026-09-15') === 15, 'quarterly: → 15')
ok(util.deriveCycleDay('weekly', '2026-09-15') === 15, 'weekly: → 15')
ok(util.deriveCycleDay('yearly', '2026-09-15') === '09-15', 'yearly: → MM-DD')
ok(util.deriveCycleDay('custom', '2026-09-04') === null, 'custom: → null')
ok(util.deriveCycleDay('monthly', '') === null, '非法 nextCharge → null')

console.log('\n== deriveFirstChargeDate ==')
ok(util.deriveFirstChargeDate('monthly', '2026-09-15') === '2026-08-15', 'monthly: 2026-09-15 → 2026-08-15')
ok(util.deriveFirstChargeDate('yearly', '2026-09-15') === '2025-09-15', 'yearly: → -1 年')
ok(util.deriveFirstChargeDate('quarterly', '2026-09-15') === '2026-06-15', 'quarterly: → -3 月')
ok(util.deriveFirstChargeDate('weekly', '2026-09-15') === '2026-09-08', 'weekly: → -7 天')
ok(util.deriveFirstChargeDate('custom', '2026-09-04', 6) === '2026-03-04', 'custom 半年包: → -6 月')
ok(util.deriveFirstChargeDate('custom', '2026-09-15', 3) === '2026-06-15', 'custom 季包: → -3 月')
ok(util.deriveFirstChargeDate('custom', '2024-06-15', 24) === '2022-06-15', 'custom 两年包: → -24 月')
ok(util.deriveFirstChargeDate('custom', '2026-09-15', 0) === '', 'custom customMonths=0 → \'\'')
ok(util.deriveFirstChargeDate('monthly', '') === '', '非法 nextCharge → \'\'')

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)