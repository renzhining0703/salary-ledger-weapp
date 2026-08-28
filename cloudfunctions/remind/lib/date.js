/**
 * 云函数端日期工具
 * 与前端 utils/util.js 保持一致（云函数独立运行，不直接 require 前端模块）
 */
function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function fmtDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function dayInMonth(y, m, day) {
  return Math.min(day, new Date(y, m + 1, 0).getDate())
}

function calcDueDate(repayDay, status, today) {
  const t = today || new Date()
  const y = t.getFullYear()
  const m = t.getMonth()
  if (status === 'paid') {
    const nm = m + 1
    return fmtDate(new Date(y, nm, dayInMonth(y, nm, repayDay)))
  }
  return fmtDate(new Date(y, m, dayInMonth(y, m, repayDay)))
}

module.exports = { pad, fmtDate, dayInMonth, calcDueDate }