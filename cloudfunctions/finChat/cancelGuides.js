/**
 * 取消指引内容库 — 两级匹配(渠道 × 平台)
 *
 * 为什么两级:
 * - 同一个爱奇艺,通过微信自动续费开通的,取消要去微信支付设置关,去爱奇艺 App 里关不掉。
 * - 「在哪开的」(payChannel)比「开的什么」(platform)更决定取消路径
 * - 渠道级路径通用且稳定(微信/支付宝/苹果路径几乎不变);平台级只兜「App 内开通」场景
 *
 * 步骤是「内容资产」,人工维护 + 定期校验,禁止 AI 现场编造。
 *
 * 匹配优先级:
 *   1. payChannel ∈ {wechat, alipay, apple} → 直接给 CHANNEL_GUIDES[payChannel]
 *   2. payChannel ∈ {inapp, unknown}     → 按 platform 匹配 PLATFORM_GUIDES
 *   3. 双兜底:渠道 unknown + 平台未命中 → 同时给微信 + 支付宝两条通用路径,让用户自己对照
 *
 * 新增平台:在 PLATFORM_GUIDES 加一行,key 用平台标准名(与 aiChat.executeAddSubscription 一致);
 * 路径要复制用户实际操作截图后写,不要凭印象。
 */

/* ---------------- 渠道级(主路径,覆盖绝大多数场景) ---------------- */
const CHANNEL_GUIDES = {
  wechat: '微信 → 我 → 服务 → 钱包 → 支付设置 → 自动续费 → 选择项目 → 关闭服务',
  alipay: '支付宝 → 我的 → 设置（右上角齿轮）→ 支付设置 → 免密支付/自动扣款 → 选择项目 → 关闭服务',
  apple: 'iOS 设置 → 顶部姓名（Apple ID）→ 订阅 → 选择项目 → 取消订阅'
}

/* ---------------- 平台级(App 内开通,inapp/unknown 时兜底) ----------------
 * 仅当 payChannel = inapp / unknown 时匹配;命中后给「该 App 内的关闭路径」
 */
const PLATFORM_GUIDES = {
  '爱奇艺': '爱奇艺 App → 我的 → 会员中心 → 自动续费管理 → 关闭自动续费',
  '腾讯视频': '腾讯视频 App → 我的 → VIP 会员 → 管理自动续费 → 关闭',
  '优酷': '优酷 App → 我的 → 会员中心 → 续费管理 → 关闭自动续费',
  '芒果TV': '芒果 TV App → 我的 → 会员中心 → 自动续费 → 关闭',
  '网易云音乐': '网易云音乐 App → 我的 → 会员中心 → 管理自动续费 → 关闭',
  'QQ音乐': 'QQ 音乐 App → 我的 → 绿钻会员 → 管理自动续费 → 关闭',
  '百度网盘': '百度网盘 App → 我的 → 会员中心 → 自动续费管理 → 关闭',
  'iCloud': 'iOS 设置 → 顶部姓名（Apple ID）→ iCloud → 管理存储空间 → 更改存储空间套餐 → 降级/取消',
  'Apple Music': 'iOS 设置 → 顶部姓名（Apple ID）→ 订阅 → Apple Music → 取消订阅',
  '美团': '美团 App → 我的 → 设置 → 支付设置 → 自动续费 → 选择项目 → 关闭',
  '饿了么': '饿了么 App → 我的 → 超级会员 → 管理自动续费 → 关闭',
  '知乎': '知乎 App → 我的 → 会员中心 → 自动续费 → 关闭',
  'B站': '哔哩哔哩 App → 我的 → 大会员 → 自动续费管理 → 关闭',
  '喜马拉雅': '喜马拉雅 App → 我的 → 会员中心 → 自动续费管理 → 关闭',
  '印象笔记': '印象笔记 App → 设置 → 账户 → 管理订阅 → 取消订阅'
}

/* ---------------- 双兜底(渠道未知 + 平台未知) ----------------
 * 微信 + 支付宝两条都列,用户自选对照
 */
const FALLBACK_GUIDES = [
  CHANNEL_GUIDES.wechat,
  CHANNEL_GUIDES.alipay
]

/**
 * 两级匹配取消指引
 * @param {object} sub 订阅文档(含 payChannel + platform)
 * @returns {{ guide: string, guides?: string[], source: 'channel'|'platform'|'fallback' }}
 */
function matchCancelGuide(sub) {
  const channel = sub && sub.payChannel
  const platform = sub && sub.platform

  // 1. 渠道命中
  if (channel === 'wechat' || channel === 'alipay' || channel === 'apple') {
    return { guide: CHANNEL_GUIDES[channel], source: 'channel' }
  }

  // 2. 平台命中(payChannel = inapp / unknown)
  if (platform && PLATFORM_GUIDES[platform]) {
    return { guide: PLATFORM_GUIDES[platform], source: 'platform' }
  }

  // 3. 双兜底
  return { guides: FALLBACK_GUIDES.slice(), source: 'fallback' }
}

module.exports = {
  CHANNEL_GUIDES,
  PLATFORM_GUIDES,
  FALLBACK_GUIDES,
  matchCancelGuide
}