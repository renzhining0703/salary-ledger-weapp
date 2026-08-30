/**
 * 云函数端日期工具
 * 与 cloudfunctions/remind/lib/date.js 保持一致（云函数独立运行，不直接 require 前端模块）
 */
function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function fmtDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function monthStart(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`
}

module.exports = { pad, fmtDate, monthStart }