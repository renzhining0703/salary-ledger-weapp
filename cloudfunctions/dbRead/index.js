/**
 * 云函数 dbRead：统一读入口
 *
 * 背景：
 * - 小程序端数据库单次 get() 最多返回 20 条（官方限制），此前列表查询 limit(100~1000) 被静默截断，
 *   单月流水超过 20 笔时看板 / 分类 / 热力图 / AI 数据块全部基于残缺数据计算
 * - 云端单次 get() 最多 1000 条，个人账本数据量足够，无需分页
 *
 * 收益：
 * - 每个列表 1 次读请求（客户端分页按 20 条/页，读请求按页数翻倍消耗免费额度）
 * - 显式按 _openid 过滤（云端为管理员权限、不自动隔离），不再依赖集合权限配置
 * - 排序在 JS 内完成，不依赖控制台建复合索引；客户端 db.js 会再排一次，权威顺序以客户端为准
 *
 * 部署：右键本目录 → 上传并部署：云端安装依赖
 * 约束：与 finChat 同款 —— 不要模块级缓存 openid（容器复用会串号），
 *       openid 一律由 exports.main 从 cloud.getWXContext() 取出后传入。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const MAX = 1000 // 云端单次 get 上限
const RECYCLE_COLS = ['salary', 'cards', 'expenses', 'recurring', 'subscriptions']

/** createdAt 统一转毫秒时间戳（兼容 Date 对象 / ISO 字符串 / {$date} 包装对象） */
const tsOf = (v) => {
  if (!v) return 0
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'object' && v.$date != null) return Number(v.$date) || 0
  const n = Date.parse(v)
  return Number.isFinite(n) ? n : 0
}
const cmpAsc = (a, b) => tsOf(a) - tsOf(b)
const cmpDesc = (a, b) => tsOf(b) - tsOf(a)

/** 'YYYY-MM' → 下一月（Date 第 13 月自动跨年） */
function monthNext(monthStr) {
  const [y, m] = monthStr.split('-').map(Number)
  const d = new Date(y, m, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function assertMonth(v, name) {
  if (!v || !/^\d{4}-\d{2}$/.test(v)) throw new Error(`${name} 必须是 YYYY-MM`)
}

/** 集合未创建时把列表类读取兜底为空（与前端原 listRecurring 行为一致） */
function missingAsEmpty(e) {
  if (e && (e.errCode === -502005 || /collection.*not exist/i.test(e.errMsg || ''))) return []
  throw e
}

/* ---------------- 各集合读取 ---------------- */

async function getUser(openid) {
  const r = await db.collection('users').where({ _openid: openid }).limit(1).get()
  return r.data[0] || null
}

async function listSalary(openid) {
  const r = await db.collection('salary')
    .where({ _openid: openid, deleted: _.neq(true) })
    .limit(MAX).get()
  r.data.sort((a, b) => (b.payDate || '').localeCompare(a.payDate || '')) // payDate desc
  return r.data
}

async function listCards(openid) {
  const r = await db.collection('cards')
    .where({ _openid: openid, deleted: _.neq(true) })
    .limit(MAX).get()
  r.data.sort(cmpAsc) // createdAt asc
  return r.data
}

async function listRecurring(openid) {
  const r = await db.collection('recurring')
    .where({ _openid: openid, deleted: _.neq(true) })
    .limit(MAX).get()
  r.data.sort(cmpAsc) // createdAt asc
  return r.data
}

async function listSubscriptions(openid) {
  // 集合未创建时 dbRead 云端兜底为空（与 listRecurring 行为一致），由调用方 catch 后返回 []
  const r = await db.collection('subscriptions')
    .where({ _openid: openid, deleted: _.neq(true) })
    .limit(MAX).get()
  r.data.sort(cmpAsc) // createdAt asc；客户端 db.js 再按 nextCharge asc 排
  return r.data
}

async function listExpenses(openid, month) {
  assertMonth(month, 'month')
  const end = monthNext(month)
  const r = await db.collection('expenses')
    .where({
      _openid: openid,
      date: _.gte(month + '-01').and(_.lt(end + '-01')),
      deleted: _.neq(true)
    })
    .limit(MAX).get()
  r.data.sort(cmpDesc) // createdAt desc：刚加的在最上面（新记录立即可见，不用滑到底）
  return r.data
}

async function listExpensesRange(openid, startMonth, endMonth) {
  assertMonth(startMonth, 'startMonth')
  assertMonth(endMonth, 'endMonth')
  if (startMonth > endMonth) throw new Error('startMonth 不能晚于 endMonth')
  const end = monthNext(endMonth)
  const r = await db.collection('expenses')
    .where({
      _openid: openid,
      date: _.gte(startMonth + '-01').and(_.lt(end + '-01')),
      deleted: _.neq(true)
    })
    .limit(MAX).get()
  r.data.sort((a, b) => (a.date || '').localeCompare(b.date || '')) // date asc
  return r.data
}

/* ---------------- 首页批量读（方案B）+ 支出快照（方案C） ---------------- */

/**
 * 全量扫描支出按月聚合（快照首次回填 / 对账重建用）。
 * 分页拉取防单次 1000 条上限；skip 保险丝防异常数据死循环。
 * 返回 { 'YYYY-MM': 支出合计 }，每月金额四舍五入到分，避免浮点误差累积。
 */
async function aggregateAllExpenses(openid) {
  const agg = {}
  const PAGE = 1000
  let skip = 0
  for (;;) {
    const r = await db.collection('expenses')
      .where({ _openid: openid, deleted: _.neq(true) })
      .skip(skip).limit(PAGE).get()
    for (const x of r.data) {
      const m = (x.date || '').slice(0, 7)
      if (!/^\d{4}-\d{2}$/.test(m)) continue
      agg[m] = Math.round(((agg[m] || 0) + (x.amount || 0)) * 100) / 100
    }
    if (r.data.length < PAGE) break
    skip += PAGE
    if (skip >= 20000) break
  }
  return agg
}

/**
 * 首页一次拿全（方案B）：用户 / 工资 / 卡片 / 本月支出 / 近12月区间支出
 *   5 查在服务端 Promise.all 并行，客户端 1 次云函数调用替代 5 次
 *   （省 4 次网络往返与多次冷启动，onShow 每次 force 的场景收益最大）。
 *
 * 附带月度支出聚合快照（方案C）：users.expAgg = { 'YYYY-MM': 支出合计 }。
 *   - 快照缺失（老用户首次迁移）或 reconcile=true（下拉刷新对账）时：
 *     全量扫描重算并回写 users 文档；
 *   - 首页「累计可用余额」由快照按月求和直接得出，任意历史月都精确，
 *     不再需要客户端发 36 个月区间大查询（方案A 的阶段2缺口补查）。
 *   - 回写失败不影响本次返回（响应里已带算好的 expAgg），下次对账重试。
 */
async function batchHomeRead(openid, event) {
  assertMonth(event.month, 'month')
  assertMonth(event.startMonth, 'startMonth')
  let [user, salary, cards, expenses, trend, subscriptions] = await Promise.all([
    getUser(openid),
    listSalary(openid),
    listCards(openid),
    listExpenses(openid, event.month),
    listExpensesRange(openid, event.startMonth, event.month),
    listSubscriptions(openid).catch(missingAsEmpty)
  ])
  let expAgg = (user && user.expAgg) || null
  let reconciled = false
  if (!expAgg || event.reconcile === true) {
    expAgg = await aggregateAllExpenses(openid)
    reconciled = true
    if (user && user._id) {
      try {
        await db.collection('users').doc(user._id).update({
          data: { expAgg, snapUpdatedAt: new Date() }
        })
      } catch (e) {
        console.warn('expAgg 回写失败（不影响本次返回，下次对账重试）', e)
      }
    }
  }
  if (user) user = { ...user, expAgg }
  return { user, salary, cards, expenses, trend, subscriptions, expAgg, reconciled }
}

async function listRecycle(openid) {
  const jobs = RECYCLE_COLS.map(async (col) => {
    try {
      const r = await db.collection(col)
        .where({ _openid: openid, deleted: true })
        .limit(MAX).get()
      return r.data.map((d) => ({ ...d, _col: col }))
    } catch (e) {
      // recurring 集合可能未创建
      if (e && (e.errCode === -502005 || /collection.*not exist/i.test(e.errMsg || ''))) return []
      throw e
    }
  })
  const all = (await Promise.all(jobs)).flat()
  all.sort(cmpDesc) // deletedAt desc
  return all
}

/* ---------------- 入口 ---------------- */

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event && event.action
  if (!OPENID) return { code: 'NO_OPENID', msg: '缺少 openid' }
  try {
    let data = null
    switch (action) {
      case 'getUser':
        data = await getUser(OPENID)
        break
      case 'listSalary':
        data = await listSalary(OPENID)
        break
      case 'listCards':
        data = await listCards(OPENID)
        break
      case 'listRecurring':
        data = await listRecurring(OPENID).catch(missingAsEmpty)
        break
      case 'listSubscriptions':
        data = await listSubscriptions(OPENID).catch(missingAsEmpty)
        break
      case 'listExpenses':
        data = await listExpenses(OPENID, event.month)
        break
      case 'listExpensesRange':
        data = await listExpensesRange(OPENID, event.startMonth, event.endMonth)
        break
      case 'batchHomeRead':
        data = await batchHomeRead(OPENID, event)
        break
      case 'listRecycle':
        data = await listRecycle(OPENID)
        break
      default:
        return { code: 'BAD_ACTION', msg: `未知 action：${action}` }
    }
    return { ok: true, data, _v: 4 }
  } catch (e) {
    console.error('dbRead 失败', action, e)
    return { code: 'DB_FAIL', msg: String((e && e.message) || e) }
  }
}
