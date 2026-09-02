/**
 * 云函数端日期工具
 * 与前端 utils/util.js 保持一致（云函数独立运行，不直接 require 前端模块）
 *
 * 注意：云函数容器默认 UTC，北京时间凌晨如果用原生 new Date() 取日期会得到前一天。
 * 本文件所有"取今天"的入口统一用 nowInChina()，与北京时间（Asia/Shanghai）对齐。
 */
function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

/** 返回北京时间对应的 Date 对象（与容器本地时区无关） */
function nowInChina() {
  const now = new Date()
  const localOffsetMs = now.getTimezoneOffset() * 60 * 1000
  const cnOffsetMs = 8 * 60 * 60 * 1000
  return new Date(now.getTime() + localOffsetMs + cnOffsetMs)
}

function fmtDate(d) {
  const t = d || nowInChina()
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}

function dayInMonth(y, m, day) {
  return Math.min(day, new Date(y, m + 1, 0).getDate())
}

function calcDueDate(repayDay, status, today) {
  const t = today || nowInChina()
  const y = t.getFullYear()
  const m = t.getMonth()
  if (status === 'paid') {
    const nm = m + 1
    return fmtDate(new Date(y, nm, dayInMonth(y, nm, repayDay)))
  }
  return fmtDate(new Date(y, m, dayInMonth(y, m, repayDay)))
}

/**
 * 从当前 nextCharge 滚动到下一周期的 nextCharge(remind 推送后回写用)。
 * 与前端 utils/util.js nextChargeOf 同款语义:
 * - 仅订阅到期后滚动下一期时用;用户首次录入不走这条路径
 * - monthly/quarterly +N 月、yearly +1 年、weekly +7 天、custom +customMonths 月
 * - 月末溢出用 dayInMonth clamp 一次到位
 * - 参数非法返回 ''
 */
function nextChargeOf(cycle, currentNextCharge, now, customMonths) {
  const dayInMonth = (yy, mm, dd) => Math.min(dd, new Date(yy, mm + 1, 0).getDate())
  const fmt = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
  const raw = String(currentNextCharge == null ? '' : currentNextCharge).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return ''
  const parts = raw.split('-').map(Number)
  const cy = parts[0]
  const cm0 = parts[1] - 1
  const cd = parts[2]
  if (!Number.isFinite(cy) || !Number.isFinite(cm0) || !Number.isFinite(cd)) return ''
  if (cycle === 'yearly') {
    return fmt(new Date(cy + 1, cm0, dayInMonth(cy + 1, cm0, cd)))
  }
  if (cycle === 'weekly') {
    const base = new Date(cy, cm0, cd)
    return fmt(new Date(base.getTime() + 7 * 86400000))
  }
  if (cycle === 'custom') {
    const cm = Number(customMonths)
    if (!Number.isInteger(cm) || cm < 1 || cm > 36) return ''
    const totalM = cy * 12 + cm0 + cm
    const ny = Math.floor(totalM / 12)
    const nm = totalM % 12
    return fmt(new Date(ny, nm, dayInMonth(ny, nm, cd)))
  }
  const step = cycle === 'monthly' ? 1 : cycle === 'quarterly' ? 3 : 0
  if (!step) return ''
  const totalM = cy * 12 + cm0 + step
  const ny = Math.floor(totalM / 12)
  const nm = totalM % 12
  return fmt(new Date(ny, nm, dayInMonth(ny, nm, cd)))
}

module.exports = { pad, fmtDate, dayInMonth, calcDueDate, nowInChina, nextChargeOf }