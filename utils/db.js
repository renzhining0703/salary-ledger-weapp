/**
 * 数据层封装：所有集合的读写，数据按 openid 隔离
 * 依赖 app.js 已 wx.cloud.init
 *
 * 【读缓存】所有查询带 60s TTL 缓存：
 *  - 切 Tab / 反复进入页面时命中缓存，不再重复读数据库
 *  - 任何写操作（增/删/改/重置）成功后自动失效缓存，下次读必取最新
 * 目的：大幅降低云开发免费额度读请求消耗，避免 LimitExceeded.OutOfReadRequestQuota
 */
const db = wx.cloud.database()
const _ = db.command
const config = require('./config')

const CACHE_TTL = 60 * 1000
const cache = {
  user: null,     // { t: timestamp, d: data }
  salary: null,
  cards: null,
  recurring: null,
  expenses: {}    // { [monthStr]: { t, d } }
}

function fresh(entry) {
  return !!entry && Date.now() - entry.t < CACHE_TTL
}

/** 失效全部缓存（写操作后调用，保证下次读为最新） */
function invalidate() {
  cache.user = null
  cache.salary = null
  cache.cards = null
  cache.recurring = null
  cache.expenses = {}
}

/* ---------------- users ---------------- */
async function getMyUser(force) {
  if (!force && fresh(cache.user)) return cache.user.d
  // 不依赖 openid：集合权限「仅创建者可读写」下，云端自动按 _openid 过滤为当前用户自己的文档
  const r = await db.collection('users').limit(1).get()
  cache.user = { t: Date.now(), d: r.data[0] || null }
  return cache.user.d
}

async function updateMyUser(data) {
  let u = await getMyUser(true)
  if (!u) {
    // 用户文档缺失时兜底创建，绝不静默丢失（正常情况下 silentLogin 已创建用户文档）
    const app = getApp()
    const openid = (app && app.globalData && app.globalData.openid) || ''
    const res = await db.collection('users').add({
      data: {
        openid,
        nickname: '',
        avatarUrl: '',
        payday: 15,
        budget: 4000,
        ...data,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })
    invalidate()
    return res
  }
  const r = await db.collection('users').doc(u._id).update({
    data: { ...data, updatedAt: db.serverDate() }
  })
  invalidate()
  return r
}

/* ---------------- salary ---------------- */
async function addSalary(data) {
  const r = await db.collection('salary').add({ data: { ...data, createdAt: db.serverDate() } })
  invalidate()
  return r
}

async function listSalary(force) {
  if (!force && fresh(cache.salary)) return cache.salary.d
  const r = await db.collection('salary').where({ deleted: _.neq(true) }).orderBy('payDate', 'desc').limit(200).get()
  cache.salary = { t: Date.now(), d: r.data }
  return r.data
}

/** 软删除：进回收站，保留 30 天 */
async function removeSalary(id) {
  const r = await db.collection('salary').doc(id).update({ data: { deleted: true, deletedAt: db.serverDate() } })
  invalidate()
  return r
}

/* ---------------- cards ---------------- */
async function addCard(data) {
  const r = await db.collection('cards').add({ data: { ...data, createdAt: db.serverDate(), updatedAt: db.serverDate() } })
  invalidate()
  return r
}

async function listCards(force) {
  if (!force && fresh(cache.cards)) return cache.cards.d
  const r = await db.collection('cards').where({ deleted: _.neq(true) }).orderBy('createdAt', 'asc').limit(100).get()
  cache.cards = { t: Date.now(), d: r.data }
  return r.data
}

async function updateCard(id, data) {
  const r = await db.collection('cards').doc(id).update({ data: { ...data, updatedAt: db.serverDate() } })
  invalidate()
  return r
}

/** 软删除：进回收站，保留 30 天 */
async function removeCard(id) {
  const r = await db.collection('cards').doc(id).update({ data: { deleted: true, deletedAt: db.serverDate() } })
  invalidate()
  return r
}

/* ---------------- expenses ---------------- */
async function addExpense(data) {
  const r = await db.collection('expenses').add({ data: { ...data, createdAt: db.serverDate() } })
  invalidate()
  return r
}

async function listExpenses(monthStr, force) {
  if (!force && fresh(cache.expenses[monthStr])) return cache.expenses[monthStr].d
  const start = monthStr + '-01'
  const nextMonth = monthNext(monthStr)
  const end = nextMonth + '-01'
  const r = await db
    .collection('expenses')
    .where({ date: _.gte(start).and(_.lt(end)), deleted: _.neq(true) })
    .orderBy('date', 'desc')
    .limit(500)
    .get()
  // 多字段 orderBy 需要控制台建复合索引，这里改为 JS 内二次排序（同一天内新建的在前），不依赖索引
  r.data.sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
    return tb - ta
  })
  cache.expenses[monthStr] = { t: Date.now(), d: r.data }
  return r.data
}

/**
 * 区间查询开销（趋势图等跨月聚合场景用）
 * @param {string} startMonth 'YYYY-MM'（含）
 * @param {string} endMonth   'YYYY-MM'（含）
 */
async function listExpensesRange(startMonth, endMonth, force) {
  const key = `range_${startMonth}_${endMonth}`
  if (!force && fresh(cache.expenses[key])) return cache.expenses[key].d
  const end = monthNext(endMonth) + '-01'
  const r = await db
    .collection('expenses')
    .where({ date: _.gte(startMonth + '-01').and(_.lt(end)), deleted: _.neq(true) })
    .orderBy('date', 'asc')
    .limit(1000)
    .get()
  cache.expenses[key] = { t: Date.now(), d: r.data }
  return r.data
}

/**
 * 热力图专用：拉最近 N 个月的开销，聚合日级 + 返回全量明细（用于点击单元格展开）。
 * 复用 listExpenses 的 60s 缓存（单月粒度），所以同一月多次访问不会重复查库。
 *
 * @param {number} monthsBack  往前推几个月（4 / 7 / 13，覆盖 13 / 26 / 52 周 + 余量）
 * @param {boolean} [force]    跳过缓存
 * @returns {Promise<{ byDay: {[date]: number}, items: expense[] }>}
 *   byDay  : 'YYYY-MM-DD' -> 当天合计金额
 *   items  : 全部明细（供点击单元格时按 date 过滤）
 */
async function listExpensesForHeatmap(monthsBack, force) {
  const today = new Date()
  const months = []
  for (let i = monthsBack - 1; i >= 0; i--) {
    const y = today.getFullYear()
    const m = today.getMonth() + 1 - i
    const d = new Date(y, m - 1, 1)
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  const key = `heat_${monthsBack}`
  if (!force && fresh(cache.expenses[key])) return cache.expenses[key].d

  // 并行按月拉（每单月 ≤500 条,符合 listExpenses 上限）
  const results = await Promise.all(months.map((m) => listExpenses(m, force)))
  const items = results.flat()
  const byDay = {}
  for (const x of items) {
    const d = x.date
    if (!d) continue
    byDay[d] = (byDay[d] || 0) + (x.amount || 0)
  }
  const data = { byDay, items }
  cache.expenses[key] = { t: Date.now(), d: data }
  return data
}

/** 软删除：进回收站，保留 30 天 */
async function removeExpense(id) {
  const r = await db.collection('expenses').doc(id).update({ data: { deleted: true, deletedAt: db.serverDate() } })
  invalidate()
  return r
}

/* ---------------- recurring 固定支出 ---------------- */

async function addRecurring(data) {
  try {
    const r = await db.collection('recurring').add({
      data: {
        ...data,
        active: true,
        autoRecord: data.autoRecord === true,
        lastRecorded: '',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })
    invalidate()
    return r
  } catch (e) {
    // 集合尚未在控制台创建时给出明确提示（errCode -502005）
    if (e && (e.errCode === -502005 || /collection.*not exist/i.test(e.errMsg || ''))) {
      const err = new Error('请先创建 recurring 集合：云开发控制台 → 数据库 → 添加集合 → 输入 recurring → 权限设为「仅创建者可读写」')
      err.isCollectionMissing = true
      throw err
    }
    throw e
  }
}

async function listRecurring(force) {
  if (!force && fresh(cache.recurring)) return cache.recurring.d
  let r
  try {
    r = await db.collection('recurring').where({ deleted: _.neq(true) }).orderBy('createdAt', 'asc').limit(100).get()
  } catch (e) {
    // 集合尚未在控制台创建时兜底为空（errCode -502005 / DATABASE_COLLECTION_NOT_EXIST）
    if (e && (e.errCode === -502005 || /collection.*not exist/i.test(e.errMsg || ''))) {
      return []
    }
    throw e
  }
  cache.recurring = { t: Date.now(), d: r.data }
  return r.data
}

async function updateRecurring(id, data) {
  const r = await db.collection('recurring').doc(id).update({ data: { ...data, updatedAt: db.serverDate() } })
  invalidate()
  return r
}

/** 软删除：进回收站，保留 30 天（模板删除不影响已记入的流水） */
async function removeRecurring(id) {
  const r = await db.collection('recurring').doc(id).update({ data: { deleted: true, deletedAt: db.serverDate() } })
  invalidate()
  return r
}

/**
 * 手动确认记账（用户点了「记入本月」才扣）：
 * 按模板金额在【今天】生成一条开销记录（现金流口径：钱今天实际出去），
 * 并把 lastRecorded 标记为当前月份，用于界面显示「本月已记」、防止重复点击。
 */
async function recordRecurring(id) {
  const r = await db.collection('recurring').doc(id).get()
  const item = r.data
  if (!item) throw new Error('固定支出不存在')
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  if (item.lastRecorded === month) {
    return { dup: true }
  }
  const today = `${month}-${String(now.getDate()).padStart(2, '0')}`
  await db.collection('expenses').add({
    data: {
      date: today,
      category: item.category || '其他',
      amount: item.amount,
      note: item.name || '固定支出',
      recurringId: id,
      createdAt: db.serverDate()
    }
  })
  await db.collection('recurring').doc(id).update({
    data: { lastRecorded: month, updatedAt: db.serverDate() }
  })
  invalidate()
  return { dup: false }
}

/**
 * 手动确认还款（用户点了「标记已还」才扣）：
 * 按卡片金额在【今天】生成一条开销记录(category=还款, note=信用卡·卡名),
 * 并把卡片标记为已还 + 写入 repayDate(首页看板按月归集已还金额)。
 *
 * 防重：status==='paid' 直接返回 dup(true)。note/cardId 字段让流水可追溯到卡。
 */
async function recordCardRepayment(id) {
  const r = await db.collection('cards').doc(id).get()
  const card = r.data
  if (!card) throw new Error('信用卡不存在')
  if (card.status === 'paid') {
    return { dup: true }
  }
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const today = `${month}-${String(now.getDate()).padStart(2, '0')}`
  const bankName = (card.bank || '').trim()
  await db.collection('expenses').add({
    data: {
      date: today,
      category: '还款',
      amount: card.amount,
      note: bankName ? `信用卡·${bankName}` : '信用卡',
      cardId: id,
      createdAt: db.serverDate()
    }
  })
  await db.collection('cards').doc(id).update({
    data: { status: 'paid', repayDate: today, updatedAt: db.serverDate() }
  })
  invalidate()
  return { dup: false }
}

/**
 * 自动落账扫描：对所有 autoRecord=true 且当月未记的固定支出,
 * 自动调 recordRecurring 写入本月流水。
 *
 * 调用方负责防抖(建议只在 app.js onShow 跨月/跨 App 启动时调一次),
 * 这里不做内部去重——每次调用都做完整扫描,因为 recordRecurring 内部 lastRecorded 防重,
 * 即使 caller 重复调也只会写一次。
 *
 * 失败策略：单个模板失败不影响其他;整体失败抛错由 caller 处理(静默 log)。
 * 返回 { swept: number, skipped: number } 便于调试。
 */
async function sweepAutoRecord() {
  const now = new Date()
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const due = (await listRecurring(true))
    .filter((r) => r.active !== false)
    .filter((r) => r.autoRecord === true)
    .filter((r) => r.lastRecorded !== thisMonth)

  let swept = 0
  let skipped = 0
  for (const r of due) {
    try {
      const res = await recordRecurring(r._id)
      if (res && res.dup) {
        skipped++
      } else {
        swept++
      }
    } catch (e) {
      console.error('自动落账失败', r.name, e)
      skipped++
    }
  }
  return { swept, skipped, thisMonth, due: due.length }
}

/* ---------------- 回收站（软删除，保留 RECYCLE_DAYS 天） ---------------- */

const RECYCLE_DAYS = config.RECYCLE_DAYS
const RECYCLE_COLS = ['salary', 'cards', 'expenses', 'recurring']

/** 回收站列表：四类集合里 deleted=true 的文档合并，按删除时间倒序 */
async function listRecycle() {
  const jobs = RECYCLE_COLS.map(async (col) => {
    try {
      const r = await db.collection(col).where({ deleted: true }).orderBy('deletedAt', 'desc').limit(100).get()
      return r.data.map((d) => ({ ...d, _col: col }))
    } catch (e) {
      // recurring 集合可能未创建
      if (e && (e.errCode === -502005 || /collection.*not exist/i.test(e.errMsg || ''))) return []
      throw e
    }
  })
  const all = (await Promise.all(jobs)).flat()
  all.sort((a, b) => {
    const ta = a.deletedAt ? new Date(a.deletedAt).getTime() : 0
    const tb = b.deletedAt ? new Date(b.deletedAt).getTime() : 0
    return tb - ta
  })
  return all
}

/** 恢复：清掉删除标记，数据回到原列表 */
async function restoreDoc(col, id) {
  const r = await db.collection(col).doc(id).update({ data: { deleted: false, deletedAt: null, updatedAt: db.serverDate() } })
  invalidate()
  return r
}

/** 彻底删除单条（回收站里手动删除） */
async function destroyDoc(col, id) {
  const r = await db.collection(col).doc(id).remove()
  invalidate()
  return r
}

/** 清空回收站：把所有 deleted=true 的文档物理删除 */
async function clearRecycle() {
  for (const col of RECYCLE_COLS) {
    try {
      for (;;) {
        const r = await db.collection(col).where({ deleted: true }).limit(100).get()
        if (!r.data.length) break
        await Promise.all(r.data.map((d) => db.collection(col).doc(d._id).remove()))
      }
    } catch (e) {
      if (e && (e.errCode === -502005 || /collection.*not exist/i.test(e.errMsg || ''))) continue
      throw e
    }
  }
  invalidate()
}

/** 过期清理：删除时间超过 30 天的软删文档物理删除（app 启动时静默调用） */
async function purgeExpired() {
  const deadline = new Date(Date.now() - RECYCLE_DAYS * 86400000)
  for (const col of RECYCLE_COLS) {
    try {
      for (;;) {
        const r = await db.collection(col)
          .where({ deleted: true, deletedAt: _.lt(deadline) })
          .limit(100)
          .get()
        if (!r.data.length) break
        await Promise.all(r.data.map((d) => db.collection(col).doc(d._id).remove()))
      }
    } catch (e) {
      if (e && (e.errCode === -502005 || /collection.*not exist/i.test(e.errMsg || ''))) continue
      console.error('回收站过期清理失败', col, e)
    }
  }
}

/* ---------------- helper ---------------- */

/**
 * 失效 finReports 当月缓存（用户改了本月数据 → AI 解读过期，需重生成）
 * 失败静默：缓存失效不该阻塞用户操作
 */
async function invalidateFinCache(month) {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return
  try {
    await db.collection('finReports').where({ month }).remove()
  } catch (e) {
    if (e && (e.errCode === -502005 || /not exist/i.test(e.errMsg || ''))) return
    console.warn('失效 AI 解读缓存失败', month, e)
  }
}

function monthNext(monthStr) {
  const [y, m] = monthStr.split('-').map(Number)
  const d = new Date(y, m, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 重置当前用户全部数据（二次确认后调用）。连同 users 一起清，重新打开小程序会重建用户配置并预置示例数据 */
async function clearAllData() {
  const clear = async (col) => {
    // 分页删，避免单次 20 条限制
    for (;;) {
      try {
        const r = await db.collection(col).where({}).limit(100).get()
        if (r.data.length === 0) break
        await Promise.all(r.data.map((d) => db.collection(col).doc(d._id).remove()))
      } catch (e) {
        // 集合可能尚未在控制台创建（finReports / finChatRate），静默跳过，不阻塞整体重置
        if (e && (e.errCode === -502005 || /collection.*not exist/i.test(e.errMsg || ''))) return
        throw e
      }
    }
  }
  // finReports / finChatRate 一并清：AI 解读缓存和限流计数不应在重置后残留
  await Promise.all([
    clear('users'),
    clear('salary'),
    clear('cards'),
    clear('expenses'),
    clear('recurring'),
    clear('finReports'),
    clear('finChatRate')
  ])
  invalidate()
}

module.exports = {
  getMyUser,
  updateMyUser,
  addSalary,
  listSalary,
  removeSalary,
  addCard,
  listCards,
  updateCard,
  removeCard,
  addExpense,
  listExpenses,
  listExpensesRange,
  listExpensesForHeatmap,
  removeExpense,
  addRecurring,
  listRecurring,
  updateRecurring,
  removeRecurring,
  recordRecurring,
  recordCardRepayment,
  sweepAutoRecord,
  listRecycle,
  restoreDoc,
  destroyDoc,
  clearRecycle,
  purgeExpired,
  clearAllData,
  invalidateFinCache
}
