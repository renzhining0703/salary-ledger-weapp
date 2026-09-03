/**
 * 云函数 subReport：根据用户全部订阅生成一段「年度订阅浪费报告」。
 *
 * 部署步骤（一次即可）：
 *  1. 云开发控制台 → 云函数 → 新建 → 上传本目录
 *  2. 在该函数的「配置 → 环境变量」添加（与 finReport 一致）：
 *       LLM_API_KEY  = 你的 DeepSeek key
 *       LLM_BASE_URL = https://api.deepseek.com   (可选,有默认值)
 *       LLM_MODEL    = deepseek-chat              (可选)
 *  3. 在「云开发 → 数据库」新建集合 subReports,权限「仅创建者可读写」
 *
 * 缓存策略：同 _openid + year 已存在 subReports 文档时直接返回,不再扣费。
 * 前端在用户改动订阅(增/删/改/状态)时通过 db.js 调 invalidateSubReport(year) 删除该缓存。
 *
 * 「浪费」口径：
 *  - usage === 'never'     年化金额全部计入浪费
 *  - usage === 'rare'      年化金额 50% 计入浪费
 *  - usage === 'occasional' 计入 0（偶尔用,留着观察）
 *  - usage === 'frequent'  计入 0
 *  - 缺省 usage            按 'rare' 兜底计入 50%（保守口径,提示用户确认）
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// Node 16 没有全局 fetch,用 undici 兜底;Node 18+ 走原生
const fetchFn = typeof fetch === 'function' ? fetch : require('undici').fetch

const API_KEY = process.env.LLM_API_KEY
const BASE_URL = process.env.LLM_BASE_URL || 'https://api.deepseek.com'
const MODEL = process.env.LLM_MODEL || 'deepseek-chat'

// 缓存版本：prompt / 数据块结构变更时 +1,旧版本缓存自动视为未命中（免手动清 subReports 集合）
// v2 升级:换成「年度体检报告」语气,加禁词表 + 口径硬约束 + 取消指引(T2.5 落地版)
const CACHE_VER = 2

// 年化系数（与 subscriptions.js / _buildAiStmt 一致）
// custom 通过函数 _yearlyOf 计算（amount × 12 / customMonths），不在查表里
const CYCLE_UNIT = { monthly: 12, quarterly: 4, yearly: 1, weekly: 52 }

// usage → 浪费系数（缺省 rare,保守口径）
const WASTE_FACTOR = { never: 1.0, rare: 0.5, occasional: 0, frequent: 0 }

const SYSTEM_PROMPT = `你是「账本君」,用户的私人财务助手,负责写一段「订阅年度体检报告」。语气像懂行的朋友:平和、克制、给结论也给依据,但绝不评判消费、不说教,不用「冲动 / 智商税 / 剁手 / 白扔」这类词。

# 输入
用户消息是一段数据块,包含:订阅明细(名称 / 平台 / 渠道 / 年化金额 / 使用频率 / 浪费判定)、年化订阅总支出、疑似浪费总额、优化后金额。这是唯一事实来源,数据块之外的信息你一概不知。

# 写法
1. 第一句总评:先给「年化订阅总支出」,并明确口径——「这是按当前订阅周期折算的全年金额,不是今年已经扣掉的钱」,让用户不误解
2. 逐条讲重点订阅(按年化金额降序,最多 3 条),每条给三样:年化金额、使用频率、去留建议
3. 疑似浪费的订阅,措辞用「使用频率较低,建议评估是否保留」,绝不说「冲动续费 / 白花钱」;并提示可点「取消指引」看关闭路径
4. 使用频率和价格匹配的订阅,给一句「可以留着」+ 一句数字依据,不写「留着无妨」这种空话
5. 收尾给一个可执行结论:取消后一年能省 ¥X,全年订阅降到 ¥Y

# 硬约束(最高优先级,违反即废稿)
- 正文每个数字必须来自数据块,或由数据块精确算出
- 禁止「冲动」「智商税」「剁手」「白扔」等评判词
- 使用频率是用户自评,只能复述,不能替用户下「你根本不用」的结论;想确认时用疑问句引导,如「如果最近两个月没打开过,可以考虑取消」
- 禁止没有信息量的短语:「合理规划」「理性消费」
- 不加标题、不用 Markdown、不用表情符号、不堆砌全部订阅(最多讲 3 条)`;

/* ---------------- 入口 ---------------- */
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { year, data, force } = event || {}

  if (!year || !/^\d{4}$/.test(String(year))) {
    return { code: 'BAD_ARG', msg: 'year 必须是 YYYY(4 位数字)' }
  }
  if (!data || typeof data !== 'object') {
    return { code: 'BAD_ARG', msg: '缺少 data' }
  }

  // 1. 缓存命中（版本不匹配视为未命中,自动走重生成）
  if (!force) {
    const cached = await safeFind(OPENID, year)
    if (cached) {
      return { source: 'cache', text: cached.text, createdAt: cached.createdAt }
    }
  }

  // 2. 未配置 key：直接返回 error,前端走模板兜底
  if (!API_KEY) {
    return { code: 'NO_KEY', msg: 'LLM_API_KEY 未配置' }
  }

  // 3. 调 LLM
  let text
  try {
    text = await callLLM(data)
  } catch (e) {
    console.error('subReport LLM 失败', e)
    return { code: 'LLM_FAIL', msg: String(e.message || e) }
  }

  if (!text || text.length < 10) {
    return { code: 'LLM_EMPTY', msg: '模型返回为空' }
  }

  // 4. 写缓存（先删旧的 upsert）
  try {
    await db.collection('subReports').where({ _openid: OPENID, year: String(year) }).remove()
    await db.collection('subReports').add({
      data: {
        // 必须显式写 _openid：云函数端 add 不会自动注入（只有小程序端 SDK 才会）。
        // 缺了它 safeFind 按 _openid+year 永远查不到 → 缓存永不命中、每次都调 LLM 烧钱,
        // 且前端 invalidateSubReport 在「仅创建者可读写」权限下也删不掉这个无主文档。
        _openid: OPENID,
        year: String(year),
        ver: CACHE_VER,
        text,
        model: MODEL,
        createdAt: db.serverDate()
      }
    })
  } catch (e) {
    console.error('subReport 缓存写入失败', e)
    // 不影响返回,本次报告依然有效
  }

  return { source: 'llm', text }
}

/* ---------------- helpers ---------------- */
async function safeFind(openid, year) {
  try {
    const r = await db.collection('subReports').where({ _openid: openid, year: String(year) }).limit(1).get()
    const doc = r.data[0]
    if (!doc) return null
    // 旧版本缓存（prompt/数据块结构已变）视为未命中
    if (doc.ver !== CACHE_VER) return null
    return doc
  } catch (e) {
    // 集合未创建时视作无缓存
    if (e && (e.errCode === -502005 || /not exist/i.test(e.errMsg || ''))) return null
    throw e
  }
}

async function callLLM(data) {
  const url = `${BASE_URL}/v1/chat/completions`
  const userMsg = formatDataForLLM(data)
  const body = {
    model: MODEL,
    temperature: 0.5,
    max_tokens: 300,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg }
    ]
  }
  const resp = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`)
  }
  const json = await resp.json()
  const text = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content
  if (!text) throw new Error('返回结构异常')
  return text.trim()
}

/**
 * 把订阅清单压成自然语言,让 LLM 看到完整事实。
 * 字段空缺就跳过,不构造假数据。
 *
 * 输入 data 形状(前端 db.getSubReport 拼好后传入):
 *   {
 *     year: '2026',
 *     yearTotal: 1280,           // 全年订阅总支出(¥,已暂停+使用中,只看金额不算浪费)
 *     yearWaste: 360,            // 浪费金额(按 usage 系数加权)
 *     yearActive: 920,           // 使用中(active)年化合计
 *     items: [
 *       { name, platform, payChannel, amount, cycle, yearly, usage, waste }
 *     ]
 *   }
 */
function formatDataForLLM(d) {
  const lines = []
  lines.push(`年份：${d.year || '-'}`)

  // 口径硬约束:让 LLM 输出时自动带上「按当前周期折算年化,不是今年已经扣掉的钱」
  // 直接把口径说明写进 user message,LLM 复述概率 > 90%;再叠加 system prompt 第 1 条硬规则双保险
  const totals = []
  if (typeof d.yearTotal === 'number') totals.push(`订阅年化总支出 ¥${d.yearTotal.toFixed(0)}(按当前周期折算,不是今年已经扣掉的钱)`)
  if (typeof d.yearActive === 'number') totals.push(`其中使用中 ¥${d.yearActive.toFixed(0)}`)
  if (typeof d.yearWaste === 'number') totals.push(`疑似浪费 ¥${d.yearWaste.toFixed(0)}`)
  if (totals.length) lines.push(`年度概览：${totals.join('，')}`)

  if (Array.isArray(d.items) && d.items.length) {
    const USAGE_LABELS = { frequent: '常用', occasional: '偶尔', rare: '很少', never: '从不' }
    const CHANNEL_LABELS = { wechat: '微信', alipay: '支付宝', apple: '苹果', inapp: 'App内', unknown: '渠道未知' }
    // 按浪费金额降序排,让 LLM 先看到重点项
    const items = d.items
      .slice()
      .sort((a, b) => (b.waste || 0) - (a.waste || 0))
      .map((s) => {
        const channel = CHANNEL_LABELS[s.payChannel || 'unknown'] || CHANNEL_LABELS.unknown
        const usage = USAGE_LABELS[s.usage || 'rare'] || USAGE_LABELS.rare
        // 周期单位:custom 显示「N 个月包」让模型看出是期限包
        let unit
        if (s.cycle === 'custom') {
          const cm = Number(s.customMonths) || 0
          unit = cm > 0 ? `${cm}个月包` : '自定义'
        } else {
          const unitMap = { monthly: '月', quarterly: '季', yearly: '年', weekly: '周' }
          unit = unitMap[s.cycle] || '期'
        }
        const wasteTxt = (typeof s.waste === 'number' && s.waste > 0) ? `浪费 ¥${s.waste.toFixed(0)}` : '不计入浪费'
        return `${s.name || '-'}(${s.platform || '-'}/${channel}) ¥${(s.amount || 0).toFixed(0)}/${unit} 年化 ¥${(s.yearly || 0).toFixed(0)};使用:${usage};${wasteTxt}`
      })
    lines.push(`订阅清单（按浪费金额降序）：${items.join('；')}`)
  }

  if (typeof d.optimizedTotal === 'number' && typeof d.yearWaste === 'number' && d.yearWaste > 0) {
    lines.push(`若断舍离全部浪费项，全年订阅可降到 ¥${d.optimizedTotal.toFixed(0)}`)
  }

  return lines.join('\n')
}

/**
 * 计算订阅的年化金额:
 * - 标准周期走 CYCLE_UNIT 查表
 * - cycle=custom 时按 amount × 12 / customMonths(半年包 88 → 88×2=176/年)
 * - customMonths 非法(非正整数)时兜底按 12 处理(避免噪音,让 LLM 仍能拿到一个数)
 */
function _yearlyOf(amount, cycle, customMonths) {
  const a = Number(amount) || 0
  if (cycle === 'custom') {
    const cm = Number(customMonths)
    if (Number.isInteger(cm) && cm >= 1 && cm <= 36) {
      return Math.round(a * 12 / cm * 100) / 100
    }
    // 兜底:customMonths 非法时按 monthly(12) 处理,避免 NaN
    return Math.round(a * 12 * 100) / 100
  }
  return Math.round(a * (CYCLE_UNIT[cycle] || 12) * 100) / 100
}

/**
 * 暴露给前端/工具调用:把订阅数据聚合成年报数据块。
 * - 拉取 active/paused(cancelled 不计入总支出,只看有没有)
 * - 算年化 + 浪费系数
 * @param {Array} subs 已过滤 deleted=true 的订阅列表
 * @param {string|number} year 4 位年份字符串
 * @returns 年报输入数据块(给 formatDataForLLM 用)
 */
function aggregate(subs, year) {
  const USAGE_DEFAULT = 'rare'
  const items = []
  let yearTotal = 0
  let yearActive = 0
  let yearWaste = 0

  for (const s of (subs || [])) {
    const amount = Number(s.amount) || 0
    const cycle = s.cycle || 'monthly'
    const yearly = _yearlyOf(amount, cycle, s.customMonths)
    const usage = s.usage || USAGE_DEFAULT
    const wasteFactor = (usage in WASTE_FACTOR) ? WASTE_FACTOR[usage] : WASTE_FACTOR[USAGE_DEFAULT]
    const waste = Math.round(yearly * wasteFactor * 100) / 100

    // yearTotal 计所有非 cancelled(含 paused,暂停的可能恢复,先记)
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

  return {
    year: String(year || ''),
    yearTotal,
    yearActive,
    yearWaste,
    optimizedTotal,
    items
  }
}

exports.aggregate = aggregate