/**
 * 云函数端日期工具
 * 与 cloudfunctions/remind/lib/date.js 保持一致（云函数独立运行，不直接 require 前端模块）
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

function monthStart(d) {
  const t = d || nowInChina()
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-01`
}

module.exports = { pad, fmtDate, monthStart, nowInChina }