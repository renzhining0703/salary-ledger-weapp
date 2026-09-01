/* 验证弹框 scroll-view 高度链路：无头 Chrome 复现 4 种方案并测量几何数据 */
const { chromium } = require('playwright-core')

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  await page.goto('file:///Users/renzhining/Documents/salary%E2%80%91ledger-weapp/scripts/tmp-sheet-test.html')
  await page.waitForTimeout(300)

  const report = await page.evaluate(() => {
    const out = []
    const vh = window.innerHeight
    for (const cls of ['a', 'b', 'c', 'd']) {
      const sheet = document.querySelector('.sheet.' + cls)
      const sheetRect = sheet.getBoundingClientRect()
      // 找到滚动内层（含 recur-tip 的 sv-inner）
      const inner = sheet.querySelector('.sv-inner')
      const outer = inner.parentElement // scroll-view 外层元素（或 wrapper 里的 sv）
      const innerRect = inner.getBoundingClientRect()
      const outerRect = outer.getBoundingClientRect()
      const lastRow = sheet.querySelector('.recur-row:last-child')
      const lastRect = lastRow.getBoundingClientRect()
      const actionsRect = sheet.querySelector('.sheet-actions').getBoundingClientRect()
      // 判断最后一行是否完整可见：其 bottom 必须在滚动区/弹框可视范围内
      const clippedBottom = lastRect.bottom - Math.max(outerRect.bottom, sheetRect.bottom)
      out.push({
        plan: cls.toUpperCase(),
        sheetH: Math.round(sheetRect.height),
        scrollOuterH: Math.round(outerRect.height),
        contentH: Math.round(inner.scrollHeight),
        innerViewH: Math.round(innerRect.height),
        scrollable: inner.scrollHeight > innerRect.height,
        lastRowBottomBelowSheet: Math.round(clippedBottom),
        actionsVisible: actionsRect.bottom <= sheetRect.bottom + 1,
        lastRowFullyVisibleInScroll: lastRect.bottom <= outerRect.bottom + 1 && lastRect.top >= outerRect.top - 1
      })
    }
    return { vh, out }
  })

  console.log('viewport height =', report.vh, '(82vh =', Math.round(report.vh * 0.82) + 'px)')
  for (const r of report.out) {
    console.log(
      `[${r.plan}] sheetH=${r.sheetH} scrollOuterH=${r.scrollOuterH} contentH=${r.contentH} innerViewH=${r.innerViewH}`,
      `| scrollable=${r.scrollable} | 最后一行完整可见=${r.lastRowFullyVisibleInScroll} | 底部按钮在弹框内=${r.actionsVisible}`
    )
  }

  await page.screenshot({ path: '/Users/renzhining/Documents/salary‑ledger-weapp/scripts/tmp-sheet-compare.png' })
  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
