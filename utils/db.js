/**
 * 数据层封装：所有集合的读写，数据按 openid 隔离
 * 依赖 app.js 已 wx.cloud.init
 *
 * 【读】统一走 cloudfunctions/dbRead 云函数：
 *  - 小程序端单次 get() 最多 20 条（历史坑：limit(500) 被静默截断，单月流水 >20 笔时数据算错）
 *  - 云端单次 get() 最多 1000 条，个人账本数据量足够；每个列表 1 次读请求
 *  - 云端显式按 _openid 过滤，不再依赖集合权限配置
 *  - 首页 5 查合并为 batchHomeRead 单次调用（服务端并行），见下方方案B+C 注释
 *
 * 【读缓存】所有查询带 60s TTL 缓存：
 *  - 切 Tab / 反复进入页面时命中缓存，不再重复调云函数
 *  - 任何写操作（增/删/改/重置）成功后自动失效缓存，下次读必取最新
 * 目的：大幅降低云开发免费额度读请求消耗，避免 LimitExceeded.OutOfReadRequestQuota
 */
const db = wx.cloud.database()
const _ = db.command
const config = require('./config')
const util = require('./util')

const CACHE_TTL = 60 * 1000
const cache = {
  user: null,         // { t: timestamp, d: data }
  salary: null,
  cards: null,
  recurring: null,
  subscriptions: null,
  expenses: {},       // { [monthStr]: { t, d } }
  subReports: {}      // { [year]: { t, d } }  年度订阅浪费报告缓存
}

function fresh(entry) {
  return !!entry && Date.now() - entry.t < CACHE_TTL
}

/* ---------------- 客户端排序 ----------------
 * 排序统一在客户端做,不依赖 dbRead 云端部署版本:
 * 云函数只负责「取全量」,顺序由这里保证 —— 改排序只需重新编译小程序,不用重新部署云函数
 */
const DBREAD_VERSION = 4

/* ---------------- 支出快照引用（方案C） ----------------
 * 写操作增量维护 users.expAgg（月度支出聚合 { 'YYYY-MM': 合计 }）用。
 * - 只记 _id 与 expAgg 两项：_id 恒定不会失效；expAgg 在每次 bump 后原地更新
 * - invalidate() 不清除它（不是读缓存，是写辅助引用；clearAllData 时清）
 * - 靠 getMyUser / batchHomeRead 读取时刷新
 */
let _userSnapRef = null
function rememberUserSnap(u) {
  if (u && u._id) _userSnapRef = { _id: u._id, expAgg: u.expAgg || null }
}

/** createdAt 从云函数回传可能是 Date / ISO 字符串 / {$date} 包装 / 数字,统一转毫秒 */
function tsOf(v) {
  if (!v) return 0
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return v
  if (typeof v === 'object' && v.$date != null) return Number(v.$date) || 0
  const n = Date.parse(v)
  return Number.isFinite(n) ? n : 0
}

/** 最新在前:createdAt 降序;缺失/同一秒时按 _id 降序兜底(_id 内嵌创建时间,字典序≈创建先后) */
function byCreatedDesc(a, b) {
  const d = tsOf(b.createdAt) - tsOf(a.createdAt)
  if (d !== 0) return d
  return String(b._id || '') > String(a._id || '') ? 1 : String(b._id || '') < String(a._id || '') ? -1 : 0
}

function byCreatedAsc(a, b) {
  return -byCreatedDesc(a, b)
}

function byDateAsc(a, b) {
  return (a.date || '').localeCompare(b.date || '')
}

function byPayDateDesc(a, b) {
  return (b.payDate || '').localeCompare(a.payDate || '')
}

function byDeletedAtDesc(a, b) {
  return tsOf(b.deletedAt) - tsOf(a.deletedAt)
}

/** 按下次扣费日升序：最近要扣的在前；nextCharge 缺失时回退到 createdAt 降序 */
function byNextChargeAsc(a, b) {
  const na = (a && a.nextCharge) || ''
  const nb = (b && b.nextCharge) || ''
  if (na && !nb) return -1
  if (!na && nb) return 1
  if (na && nb && na !== nb) return na.localeCompare(nb)
  return byCreatedDesc(a, b)
}

/** 失效全部缓存（写操作后调用，保证下次读为最新） */
function invalidate() {
  // 写操作统一入口 → 同步置首页脏标记:onShow 仅脏时 force 重查,
  // 平时切 tab 吃 60s TTL 缓存,省云调用(评审项:启动性能)。
  // 账本君云函数写库不经过这里,由 chat refresh 事件显式 force 兜底
  try {
    const app = typeof getApp === 'function' && getApp()
    if (app && app.globalData) app.globalData.dataDirty = true
  } catch (_) { /* 非 Page 环境(云函数侧单测)无 getApp,忽略 */ }
  cache.user = null
  cache.salary = null
  cache.cards = null
  cache.recurring = null
  cache.subscriptions = null
  cache.expenses = {}
  cache.subReports = {}
  invalidateAiProfile()
}

/**
 * 失效账本君用户画像缓存（aiProfiles 集合，云端 24h TTL）。
 * 2s 防抖：连续多次写操作只发一次删除；集合未创建时静默。
 */
let _profileInvTimer = null
function invalidateAiProfile() {
  if (_profileInvTimer) return
  _profileInvTimer = setTimeout(() => {
    _profileInvTimer = null
    db.collection('aiProfiles').where({}).remove()
      .catch((e) => {
        if (e && (e.errCode === -502005 || /not exist/i.test(e.errMsg || ''))) return
        console.warn('失效 AI 画像失败', e)
      })
  }, 2000)
}

/**
 * 调 dbRead 云函数统一读入口
 * @param {string} action 见 cloudfunctions/dbRead/index.js 的 switch
 * @param {object} [params] 附加参数（month / startMonth / endMonth 等）
 * @returns {Promise<any>} 云函数返回的 data
 */
async function cloudRead(action, params) {
  const res = await wx.cloud.callFunction({ name: 'dbRead', data: { action, ...(params || {}) } })
  const r = res && res.result
  if (!r) throw new Error('dbRead 云函数无返回，请确认已部署')
  if (!r.ok) throw new Error(r.msg || `dbRead 失败（${r.code || '未知错误'}）`)
  if (r._v !== DBREAD_VERSION) {
    console.warn(`[dbRead] 云端版本(_v=${r._v})与本地(${DBREAD_VERSION})不一致，请重新上传部署 cloudfunctions/dbRead`)
  }
  return r.data
}

/* ---------------- users ---------------- */
async function getMyUser(force) {
  if (!force && fresh(cache.user)) return cache.user.d
  const d = await cloudRead('getUser')
  cache.user = { t: Date.now(), d }
  rememberUserSnap(d)
  return d
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
        payday: 0,  // 0=未设置（新用户空态引导，见设计稿 v3；设置发薪日后才有值）
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
  const d = await cloudRead('listSalary')
  d.sort(byPayDateDesc) // 发薪日新的在前
  cache.salary = { t: Date.now(), d }
  return d
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
  const d = await cloudRead('listCards')
  d.sort(byCreatedAsc) // 先添加的卡在前
  cache.cards = { t: Date.now(), d }
  return d
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

/**
 * 方案C：写操作后增量维护 users.expAgg（月度支出聚合快照）。
 * - 子文档路径 + _.inc 原子自增:与云函数 finChat 的 bumpExpAgg 同一写法,
 *   消除「本地读改写整表覆盖 → 把云端 AI 记账的增量抹掉」的竞态(评审 P0-1)
 * - 快照尚未回填（对账从未跑过）时跳过——下次 batchHomeRead 全量对账天然包含本次变动
 * - 失败静默（warn），快照漂移不丢任何源数据，下拉刷新（reconcile=true）即全量修复
 * - 只动 expAgg 字段、不动读缓存：调用方随后的 invalidate() 统一失效读缓存
 */
async function bumpExpAgg(month, amount) {
  if (!month || !/^\d{4}-\d{2}$/.test(month) || !amount) return
  try {
    if (!_userSnapRef) {
      const u = await getMyUser()
      if (!u) return
      rememberUserSnap(u)
    }
    if (!_userSnapRef.expAgg) return // 快照未回填，交给下次对账
    const delta = Math.round(amount * 100) / 100
    await db.collection('users').doc(_userSnapRef._id).update({
      data: {
        ['expAgg.' + month]: _.inc(delta),
        updatedAt: db.serverDate()
      }
    })
    // 本地快照引用原地同步(连续多笔写时不需重读库)
    _userSnapRef.expAgg[month] = Math.round(((_userSnapRef.expAgg[month] || 0) + delta) * 100) / 100
  } catch (e) {
    console.warn('expAgg 增量更新失败（下次对账自动修正）', e)
  }
}

async function addExpense(data) {
  const r = await db.collection('expenses').add({ data: { ...data, createdAt: db.serverDate() } })
  await bumpExpAgg((data.date || '').slice(0, 7), data.amount)
  invalidate()
  return r
}

async function listExpenses(monthStr, force) {
  if (!force && fresh(cache.expenses[monthStr])) return cache.expenses[monthStr].d
  const d = await cloudRead('listExpenses', { month: monthStr })
  d.sort(byCreatedDesc) // 最新在前:刚记的这笔立刻出现在列表最上面
  cache.expenses[monthStr] = { t: Date.now(), d }
  return d
}

/**
 * 区间查询开销（趋势图等跨月聚合场景用）
 * @param {string} startMonth 'YYYY-MM'（含）
 * @param {string} endMonth   'YYYY-MM'（含）
 */
async function listExpensesRange(startMonth, endMonth, force) {
  const key = `range_${startMonth}_${endMonth}`
  if (!force && fresh(cache.expenses[key])) return cache.expenses[key].d
  const d = await cloudRead('listExpensesRange', { startMonth, endMonth })
  d.sort(byDateAsc) // 日期正序(趋势图/热力图口径)
  cache.expenses[key] = { t: Date.now(), d }
  return d
}

/**
 * 热力图专用：拉最近 N 个月的开销，聚合日级 + 返回全量明细（用于点击单元格展开）。
 * 复用 listExpensesRange 的 60s 缓存（区间粒度），所以同一范围多次访问不会重复查库。
 *
 * @param {number} monthsBack  往前推几个月（4 / 7 / 13，覆盖 13 / 26 / 52 周 + 余量）
 * @param {boolean} [force]    跳过缓存
 * @returns {Promise<{ byDay: {[date]: number}, items: expense[] }>}
 *   byDay  : 'YYYY-MM-DD' -> 当天合计金额
 *   items  : 全部明细（供点击单元格时按 date 过滤）
 */
async function listExpensesForHeatmap(monthsBack, force) {
  const today = new Date()
  const endMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
  const start = new Date(today.getFullYear(), today.getMonth() - (monthsBack - 1), 1)
  const startMonth = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`
  const key = `heat_${monthsBack}`
  if (!force && fresh(cache.expenses[key])) return cache.expenses[key].d
  // 整段一次拉取（云端单次 ≤1000 条），替代原来按月并行查 N 次
  const items = await listExpensesRange(startMonth, endMonth, force)
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

/** 软删除：进回收站，保留 30 天。同时从支出快照里扣减该月合计 */
async function removeExpense(id) {
  const r0 = await db.collection('expenses').doc(id).get().catch(() => null)
  const item = r0 && r0.data
  const r = await db.collection('expenses').doc(id).update({ data: { deleted: true, deletedAt: db.serverDate() } })
  if (item && !item.deleted) {
    await bumpExpAgg((item.date || '').slice(0, 7), -(item.amount || 0))
  }
  invalidate()
  return r
}

/**
 * 首页数据一次拿全（方案B+C）：用户 / 工资 / 卡片 / 本月支出 / 12月区间支出 / 月度支出快照 expAgg。
 * - 1 次云函数调用替代 5 次（onShow 每次都 force，这是首屏提速的主要来源）
 * - 命中后回填各单项缓存，其他页面（卡片/工资/流水/热力图）随后直接吃 60s 缓存
 * - 云端尚未部署新版 dbRead 时（BAD_ACTION）自动降级为 5 个单项读，功能不受影响
 *
 * @param {string}  month      'YYYY-MM' 查看月
 * @param {string}  startMonth 'YYYY-MM' 12 个月窗口起点
 * @param {boolean} force      跳过 60s 缓存
 * @param {boolean} reconcile  true=云端全量重算 expAgg 并回写（下拉刷新对账，修复快照漂移）
 * @returns {Promise<{user, salary, cards, expenses, trend, expAgg, reconciled, degraded?}>}
 */
async function batchHomeRead(month, startMonth, force, reconcile) {
  const key = `home_${month}_${startMonth}`
  if (!force && fresh(cache.expenses[key])) return cache.expenses[key].d
  let d = null
  try {
    d = await cloudRead('batchHomeRead', { month, startMonth, reconcile: !!reconcile })
  } catch (e) {
    // 云端还是旧版（无 batchHomeRead action）→ 降级为原有 5 个单项读，行为与方案A一致
    if (!/batchHomeRead|BAD_ACTION|未知 action/i.test(String((e && e.message) || ''))) throw e
    console.warn('[db] 云端暂无 batchHomeRead，降级为单项读（请重新部署 cloudfunctions/dbRead）')
    const [user, cards, salary, expenses, trend, subscriptions] = await Promise.all([
      getMyUser(force),
      listCards(force),
      listSalary(force),
      listExpenses(month, force),
      listExpensesRange(startMonth, month, force),
      listSubscriptions(force)
    ])
    return { user, salary, cards, expenses, trend, subscriptions, expAgg: (user && user.expAgg) || null, reconciled: false, degraded: true }
  }
  // 客户端排序与单项读完全一致（回填缓存后其他页面行为不变）
  d.salary = (d.salary || []).sort(byPayDateDesc)
  d.cards = (d.cards || []).sort(byCreatedAsc)
  d.expenses = (d.expenses || []).sort(byCreatedDesc)
  d.trend = (d.trend || []).sort(byDateAsc)
  d.subscriptions = (d.subscriptions || []).sort(byNextChargeAsc)
  // 回填各单项缓存：一次批量调用喂饱全部读缓存，后续页面零额外云调用
  const now = Date.now()
  cache.user = { t: now, d: d.user }
  cache.salary = { t: now, d: d.salary }
  cache.cards = { t: now, d: d.cards }
  cache.expenses[month] = { t: now, d: d.expenses }
  cache.expenses[`range_${startMonth}_${month}`] = { t: now, d: d.trend }
  cache.subscriptions = { t: now, d: d.subscriptions }
  cache.expenses[key] = { t: now, d }
  rememberUserSnap(d.user)
  return d
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
  // 集合未创建时 dbRead 云端兜底为空（与历史行为一致）
  const d = await cloudRead('listRecurring')
  d.sort(byCreatedAsc) // 先添加的模板在前
  cache.recurring = { t: Date.now(), d }
  return d
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
  await bumpExpAgg(month, item.amount)
  await db.collection('recurring').doc(id).update({
    data: { lastRecorded: month, updatedAt: db.serverDate() }
  })
  invalidate()
  return { dup: false }
}

/**
 * 手动确认还款（用户点了「标记已还」才扣）：
 * 按卡片金额在【今天】生成一条开销记录(category=还款, note=信用卡·卡名),
 * 并把卡片标记为已还 + 写入 repayDate(首页看板按月归集已还金额) + 累积 history。
 *
 * history 在这里统一追加（首页/信用卡页共用本函数）：
 * 趋势图按月聚合还款金额走 history,每期还款一条、跨月准确;旧数据回退 repayDate + 当前金额。
 * 同一天重复还款只记一次（编辑新账单后当天再还的场景,与历史行为一致）。
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
  await bumpExpAgg(month, card.amount)
  const hist = card.history || []
  const history = hist.some((h) => h && h.date === today)
    ? hist
    : [...hist, { date: today, amount: card.amount || 0 }]
  await db.collection('cards').doc(id).update({
    data: { status: 'paid', repayDate: today, history, updatedAt: db.serverDate() }
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
const RECYCLE_COLS = ['salary', 'cards', 'expenses', 'recurring', 'subscriptions']

/* ---------------- subscriptions 自动续费 ----------------
 * T1.1 数据层：5 个方法 + 1 个纯计算 nextChargeOf（实现见 utils/util.js，此处 re-export）
 * 字段约定（见 4.1 / 4.3 节）：
 *   nextCharge: 'YYYY-MM-DD' 主录入字段 + 唯一到期判断依据（用户照抄平台显示的「下次续费日」）
 *   cycleDay: 由 nextCharge 自动反推（monthly/quarterly/weekly 存「日」1-31；yearly 存「MM-DD」如 '09-15';custom 无）
 *   firstChargeDate: 'YYYY-MM-DD' 可选,系统用 nextCharge - 1 周期估算,仅年度报告算「已订阅几个月」用
 *   cycle / amount / platform / usage / status / note 等同约定
 *   status: 'active' | 'paused' | 'cancelled'（默认 active）
 *   deleted / deletedAt 软删除
 */

/** 新增订阅；errCode -502005 给出集合未创建的明确提示
 * 入库前自动归一：传 nextCharge 时自动 deriveCycleDay + deriveFirstChargeDate 反推字段
 */
async function addSubscription(data) {
  // 字段归一（4.3 节口径：nextCharge 是主录入字段,cycleDay/firstChargeDate 由系统反推）
  const payload = normalizeSubscriptionFields(data || {})
  try {
    const r = await db.collection('subscriptions').add({
      data: {
        ...payload,
        status: payload.status || 'active',
        deleted: false,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })
    invalidate()
    invalidateSubReport(currentYearStr())
    return r
  } catch (e) {
    if (e && (e.errCode === -502005 || /collection.*not exist/i.test(e.errMsg || ''))) {
      const err = new Error('请先创建 subscriptions 集合：云开发控制台 → 数据库 → 添加集合 → 输入 subscriptions → 权限设为「仅创建者可读写」')
      err.isCollectionMissing = true
      throw err
    }
    throw e
  }
}

/** 订阅字段归一：
 *  - 传 firstChargeDate + cycle → cycleDay 自动推导 + nextCharge 自动计算
 *  - 只传 cycleDay（降级路径，老用户「只记得每月几号」）→ firstChargeDate 用「本月该日」反填：
 *      本月该日已过则下月，未过则本月（避免 nextCharge 推算漂到下下个月）
 *  - 不传任何时间字段 → 兜底用今天作为 firstChargeDate
 *
 *  cycle=custom 时无 cycleDay（4.1 节），仅由 customMonths + firstChargeDate 推算 nextCharge。
 *  custom 不支持「不记得了」降级：必须传 firstChargeDate，否则 nextCharge 算不出来。
 */
function normalizeSubscriptionFields(d) {
  const out = { ...d }
  const cycle = out.cycle
  let nc = (out.nextCharge || '').toString().trim()
  let cycleDay = out.cycleDay
  const customMonths = out.customMonths
  if (nc && /^\d{4}-\d{2}-\d{2}$/.test(nc)) {
    // 传了 nextCharge(主录入字段)→ 反推 cycleDay + 估算 firstChargeDate
    if (cycle === 'custom') {
      // custom 无 cycleDay:清掉脏值避免误展示
      cycleDay = ''
      out.cycleDay = ''
    } else {
      const derived = deriveCycleDay(cycle, nc)
      if (derived != null) {
        cycleDay = derived
        out.cycleDay = derived
      }
    }
    const fcd = deriveFirstChargeDate(cycle, nc, customMonths)
    if (fcd) out.firstChargeDate = fcd
  } else if (cycle !== 'custom' && cycleDay != null && cycleDay !== '') {
    // 降级路径:只传 cycleDay → nextCharge 用「本月该日」反填
    // custom 不参与降级(没 cycleDay 概念)
    nc = fallbackNextCharge(cycle, cycleDay)
    if (nc) {
      out.nextCharge = nc
      const fcd = deriveFirstChargeDate(cycle, nc, customMonths)
      if (fcd) out.firstChargeDate = fcd
    }
  } else {
    // 兜底:没传任何时间字段,用今天作为 nextCharge
    const today = todayStr_()
    out.nextCharge = today
    if (cycle === 'custom') {
      cycleDay = ''
      out.cycleDay = ''
    } else {
      const derived = deriveCycleDay(cycle, today)
      if (derived != null) {
        cycleDay = derived
        out.cycleDay = derived
      }
    }
    const fcd = deriveFirstChargeDate(cycle, today, customMonths)
    if (fcd) out.firstChargeDate = fcd
  }
  return out
}

/** 取今天 'YYYY-MM-DD'（本地时区，封装避免循环依赖） */
function todayStr_() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 降级路径：cycleDay → nextCharge（本月该日 / 下月该日） */
function fallbackNextCharge(cycle, cycleDay) {
  const today = new Date()
  const y = today.getFullYear()
  const m = today.getMonth()
  const todayDate = today.getDate()
  if (cycle === 'yearly') {
    // yearly 的 cycleDay 形如 'MM-DD'
    const raw = String(cycleDay)
    const parts = raw.split('-')
    if (parts.length !== 2) return todayStr_()
    const tm = Number(parts[0]) - 1
    const td = Number(parts[1])
    if (!Number.isFinite(tm) || !Number.isFinite(td)) return todayStr_()
    if (m > tm || (m === tm && todayDate >= td)) {
      return `${y + 1}-${String(tm + 1).padStart(2, '0')}-${String(td).padStart(2, '0')}`
    }
    return `${y}-${String(tm + 1).padStart(2, '0')}-${String(td).padStart(2, '0')}`
  }
  // monthly/quarterly/weekly：1-31 整数
  const day = Number(cycleDay)
  if (!Number.isFinite(day) || day < 1 || day > 31) return todayStr_()
  if (todayDate < day) {
    return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  const nm = m + 1
  return `${new Date(y, nm, 1).getFullYear()}-${String((nm % 12) + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** 读取订阅列表：60s TTL；按下次扣费日升序（最近要扣的在前），nextCharge 缺失回退 createdAt 降序 */
async function listSubscriptions(force) {
  if (!force && fresh(cache.subscriptions)) return cache.subscriptions.d
  // 集合未创建时 dbRead 云端兜底为空（与 listRecurring 行为一致）
  const d = await cloudRead('listSubscriptions')
  d.sort(byNextChargeAsc)
  cache.subscriptions = { t: Date.now(), d }
  return d
}

/** 更新订阅并失效缓存 */
async function updateSubscription(id, data) {
  const r = await db.collection('subscriptions').doc(id).update({
    data: { ...data, updatedAt: db.serverDate() }
  })
  invalidate()
  invalidateSubReport(currentYearStr())
  return r
}

/** 软删除：进回收站，保留 30 天 */
async function removeSubscription(id) {
  const r = await db.collection('subscriptions').doc(id).update({
    data: { deleted: true, deletedAt: db.serverDate() }
  })
  invalidate()
  invalidateSubReport(currentYearStr())
  return r
}

/** 重新暴露纯计算 nextChargeOf / deriveCycleDay / deriveFirstChargeDate,便于订阅写入前的预计算 + 列表展示 */
const nextChargeOf = util.nextChargeOf
const deriveCycleDay = util.deriveCycleDay
const deriveFirstChargeDate = util.deriveFirstChargeDate

/** 回收站列表：四类集合里 deleted=true 的文档合并，按删除时间倒序（dbRead 云端合并，客户端排序） */
async function listRecycle() {
  const d = await cloudRead('listRecycle')
  d.sort(byDeletedAtDesc) // 最近删除的在前
  return d
}

/** 恢复：清掉删除标记，数据回到原列表。支出类恢复时同步加回月度快照 */
async function restoreDoc(col, id) {
  let doc = null
  if (col === 'expenses') {
    const r0 = await db.collection(col).doc(id).get().catch(() => null)
    doc = r0 && r0.data
  }
  const r = await db.collection(col).doc(id).update({ data: { deleted: false, deletedAt: null, updatedAt: db.serverDate() } })
  if (doc && doc.deleted) {
    await bumpExpAgg((doc.date || '').slice(0, 7), doc.amount || 0)
  }
  invalidate()
  return r
}

/** 彻底删除单条（回收站里手动删除）。已软删的支出不计入快照、无需调整；异常路径删到活文档时按账面扣减防虚高 */
async function destroyDoc(col, id) {
  let doc = null
  if (col === 'expenses') {
    const r0 = await db.collection(col).doc(id).get().catch(() => null)
    doc = r0 && r0.data
  }
  const r = await db.collection(col).doc(id).remove()
  if (doc && !doc.deleted) {
    await bumpExpAgg((doc.date || '').slice(0, 7), -(doc.amount || 0))
  }
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

/* ---------------- subReport 年度订阅浪费报告 ----------------
 * 缓存：客户端 60s TTL(免重复调云函数);云端按 _openid+year 永久缓存(LLM 报告本身按年生成),
 * 订阅增删改时主动调 invalidateSubReport(year) 让云端缓存失效,下次拉取走重生成。
 */

function currentYearStr() {
  return String(new Date().getFullYear())
}

/**
 * 取订阅年度浪费报告
 * - 客户端缓存 60s(切 tab 反复进入页面不重复调云函数)
 * - 云端缓存见 cloudfunctions/subReport/index.js
 * @param {number|string} [year] 不传默认当前年
 * @param {object} [opts] { force: boolean }
 * @returns {Promise<{ text: string, source: 'llm'|'cache'|'local', code?: string, msg?: string }>}
 */
async function getSubReport(year, opts) {
  const yearStr = String(year || currentYearStr())
  if (!/^\d{4}$/.test(yearStr)) {
    return { text: '', source: 'local', code: 'BAD_ARG', msg: 'year 必须是 4 位年份' }
  }
  const force = !!(opts && opts.force)

  // 客户端 60s TTL 缓存(避免页面反复进入重复调云函数)
  const ck = `subReport_${yearStr}`
  if (!force && cache.subReports && cache.subReports[ck] && fresh(cache.subReports[ck])) {
    return cache.subReports[ck].d
  }

  // 拉订阅数据(走 listSubscriptions 自身 60s 缓存)
  const subs = await listSubscriptions(false)

  // 客户端过滤 deleted,cancelled 仍参与计算(用户可能想看历史年花了多少)
  const filtered = (subs || []).filter((s) => !s.deleted)

  // 服务端聚合(LLM 数据块生成逻辑下沉到云函数,前端只透传清洗后的原始数据)
  // 但这里我们要先在客户端算 yearTotal/yearWaste,确保即便云函数 NO_KEY 也有兜底
  const CYCLE_UNIT = { monthly: 12, quarterly: 4, yearly: 1, weekly: 52 }
  const WASTE_FACTOR = { never: 1.0, rare: 0.5, occasional: 0, frequent: 0 }
  const items = []
  let yearTotal = 0
  let yearActive = 0
  let yearWaste = 0
  for (const s of filtered) {
    const amount = Number(s.amount) || 0
    const cycle = s.cycle || 'monthly'
    // custom 周期按 amount × 12 / customMonths(与 subReport 云函数 / 订阅页同款,半年包 88 → 176/年)
    let yearly
    if (cycle === 'custom') {
      const cm = Number(s.customMonths)
      if (Number.isInteger(cm) && cm >= 1 && cm <= 36) yearly = Math.round(amount * 12 / cm * 100) / 100
      else yearly = Math.round(amount * 12 * 100) / 100
    } else {
      yearly = Math.round(amount * (CYCLE_UNIT[cycle] || 12) * 100) / 100
    }
    const usage = s.usage || 'rare'
    const wasteFactor = (usage in WASTE_FACTOR) ? WASTE_FACTOR[usage] : WASTE_FACTOR.rare
    const waste = Math.round(yearly * wasteFactor * 100) / 100
    if (s.status !== 'cancelled') yearTotal += yearly
    if (s.status === 'active') yearActive += yearly
    yearWaste += waste
    items.push({
      name: s.name || '',
      platform: s.platform || '',
      payChannel: s.payChannel || 'unknown',
      amount,
      cycle,
      customMonths: Number(s.customMonths) || 0,
      yearly,
      usage,
      waste
    })
  }
  yearTotal = Math.round(yearTotal * 100) / 100
  yearActive = Math.round(yearActive * 100) / 100
  yearWaste = Math.round(yearWaste * 100) / 100
  const optimizedTotal = Math.round((yearTotal - yearWaste) * 100) / 100

  const dataBlock = {
    year: yearStr,
    yearTotal,
    yearActive,
    yearWaste,
    optimizedTotal,
    items
  }

  // 无订阅数据：直接返回本地兜底文案,不浪费 LLM 调用
  if (!items.length) {
    const localResult = { text: '还没有订阅数据,先去订阅页录几笔再来算', source: 'local' }
    if (!cache.subReports) cache.subReports = {}
    cache.subReports[ck] = { t: Date.now(), d: localResult }
    return localResult
  }

  // 调云函数
  const cloudResult = await new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ code: 'TIMEOUT', msg: '云函数超时' })
    }, 8000)
    wx.cloud.callFunction({
      name: 'subReport',
      data: { year: yearStr, data: dataBlock },
      success: (r) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const result = (r && r.result) || null
        if (!result) return resolve({ code: 'EMPTY', msg: '云函数返回空' })
        if (result.code) return resolve({ code: result.code, msg: result.msg || result.code })
        resolve({ text: result.text || '', source: result.source || 'llm' })
      },
      fail: (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code: 'TRANSPORT', msg: String((e && (e.errMsg || e.message)) || e) })
      }
    })
  })

  let out
  if (cloudResult.text) {
    out = { text: cloudResult.text, source: cloudResult.source }
  } else if (cloudResult.code === 'NO_KEY') {
    out = { text: buildSubReportFallback(dataBlock), source: 'local' }
  } else {
    out = { text: buildSubReportFallback(dataBlock), source: 'local' }
  }

  if (!cache.subReports) cache.subReports = {}
  cache.subReports[ck] = { t: Date.now(), d: out }
  return out
}

/**
 * 本地兜底报告(LLM 不可用时)
 * - 列年总支出 + 浪费金额 + 优化后可省金额
 * - 不调 LLM,不依赖云函数
 */
function buildSubReportFallback(d) {
  if (!d.items.length) return '还没有订阅数据,先去订阅页录几笔再来算'
  const sorted = d.items.slice().sort((a, b) => (b.waste || 0) - (a.waste || 0))
  const top = sorted.find((s) => (s.waste || 0) > 0)
  const saveTxt = d.yearWaste > 0 ? `若断舍离这些,一年能省 ¥${d.yearWaste.toFixed(0)}` : '没有需要断舍离的订阅'
  const topTxt = top ? `重点关注:${top.name},使用 ${usageLabel(top.usage)} 但年化 ¥${(top.yearly || 0).toFixed(0)}` : ''
  return `${d.year} 年订阅花了 ¥${d.yearTotal.toFixed(0)},其中疑似浪费 ¥${d.yearWaste.toFixed(0)}。${topTxt};${saveTxt}`
}

function usageLabel(u) {
  return ({ frequent: '常用', occasional: '偶尔', rare: '很少', never: '从不' })[u] || '很少'
}

/**
 * 失效 subReports 某年缓存(订阅增删改后调,下次 getSubReport 重新生成)
 * 失败静默:缓存失效不该阻塞用户操作
 */
async function invalidateSubReport(year) {
  const yearStr = String(year || currentYearStr())
  if (!/^\d{4}$/.test(yearStr)) return
  try {
    await db.collection('subReports').where({ year: yearStr }).remove()
  } catch (e) {
    if (e && (e.errCode === -502005 || /not exist/i.test(e.errMsg || ''))) return
    console.warn('失效 subReport 缓存失败', yearStr, e)
  }
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
    clear('subscriptions'),
    clear('subReports'),
    clear('finReports'),
    clear('finChatRate')
  ])
  _userSnapRef = null // 用户文档已删，快照引用一并作废（下次登录重建）
  invalidate()
}

/** 暴露给 subReport 客户端缓存清理:测试 / 重置场景调用 */
function _resetSubReportCache() {
  cache.subReports = {}
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
  batchHomeRead,
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
  invalidateFinCache,
  addSubscription,
  listSubscriptions,
  updateSubscription,
  removeSubscription,
  nextChargeOf,
  deriveCycleDay,
  deriveFirstChargeDate,
  getSubReport,
  invalidateSubReport
}
