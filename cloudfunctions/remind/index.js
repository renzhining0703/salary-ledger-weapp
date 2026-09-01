/**
 * 云函数 remind：还款日前一天推送订阅消息
 * 由定时触发器每天 09:00 自动执行（见 config.json triggers）
 *
 * 上线前必做：
 * 1. 已与前端 utils/config.js 同步模板 ID（TEMPLATE_ID = SUBSCRIBE_TEMPLATE_ID）
 * 2. 模板字段为 thing1（通知类型）/ date2（还款时间）/ amount3（还款金额）/ thing4（备注信息），需与后台模板一致
 * 3. 体验版联调推送时把 miniprogramState 改为 'trial'，正式发布后保持 'formal'
 */
const cloud = require('wx-server-sdk')
const { fmtDate, calcDueDate, nowInChina } = require('./lib/date')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const TEMPLATE_ID = 'wA_ZPWiHPGe4kD17FfpT2HFKPEHBOXmMXDi03viQczM'

exports.main = async () => {
  if (TEMPLATE_ID.indexOf('请填入') === 0) {
    console.log('尚未配置订阅消息模板 ID，本次跳过提醒')
    return { skipped: 'no-template' }
  }

  const now = nowInChina()
  const tomorrow = new Date(now.getTime() + 86400000)
  const tomorrowStr = fmtDate(tomorrow)

  // 全部未还款的卡（排除已软删除进回收站的卡）
  const cardsRes = await db.collection('cards').where({ status: 'pending', deleted: _.neq(true) }).limit(1000).get()
  const dueCards = cardsRes.data.filter((c) => {
    const due = calcDueDate(c.repayDay, 'pending', now)
    return due === tomorrowStr
  })

  // 按用户聚合
  const byUser = {}
  dueCards.forEach((c) => {
    const uid = c._openid || c.openid
    if (!uid) return
    if (!byUser[uid]) byUser[uid] = []
    byUser[uid].push(c)
  })

  let sent = 0
  for (const uid of Object.keys(byUser)) {
    const list = byUser[uid]
    const total = list.reduce((s, c) => s + (c.amount || 0), 0)
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: uid,
        templateId: TEMPLATE_ID,
        page: 'pages/cards/cards',
        miniprogramState: 'formal', // 开发联调时改成 'trial'，正式发布用 'formal'
        data: {
          thing1: { value: `${list.length} 张信用卡明天到期还款` },
          date2: { value: tomorrowStr },
          amount3: { value: `¥${total.toFixed(2)}` },
          thing4: { value: '请确保账户余额充足，避免逾期' }
        }
      })
      sent++
    } catch (e) {
      console.error('推送失败 uid=', uid, e)
    }
  }

  return { checked: cardsRes.data.length, due: dueCards.length, sent }
}
