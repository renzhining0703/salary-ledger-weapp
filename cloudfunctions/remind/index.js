/**
 * 云函数 remind：定时推送订阅消息
 * 由定时触发器每天 09:00 自动执行（见 config.json triggers）
 *
 * 两类提醒：
 *  1. 还款提醒：还款日前一天推送（thing1/date2/amount3/thing4 模板）
 *  2. 订阅续费提醒（T1.3 自动续费管家）：nextCharge = 今天或明天的 active 订阅
 *
 * 上线前必做：
 *  1. 已与前端 utils/config.js 同步还款模板 ID（TEMPLATE_ID = SUBSCRIBE_TEMPLATE_ID）
 *  2. 模板字段为 thing1（通知类型）/ date2（还款时间）/ amount3（还款金额）/ thing4（备注信息），需与后台模板一致
 *  3. 已与 utils/config.js 同步订阅模板 ID（SUB_TEMPLATE_ID = SUBSCRIPTION_REMIND_TEMPLATE_ID）
 *  4. 订阅模板字段 thing1（订阅名） / date2（扣费日） / amount3（金额） / thing4（提醒语）
 *  5. 体验版联调推送时把 miniprogramState 改为 'trial'，正式发布后保持 'formal'
 */
const cloud = require('wx-server-sdk')
const { fmtDate, calcDueDate, nowInChina, nextChargeOf } = require('./lib/date')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 还款提醒模板 ID
const TEMPLATE_ID = 'wA_ZPWiHPGe4kD17FfpT2HFKPEHBOXmMXDi03viQczM'
// 订阅到期/续费提醒模板 ID（T1.3，替换占位符需同步 utils/config.js SUBSCRIPTION_REMIND_TEMPLATE_ID）
const SUB_TEMPLATE_ID = '请填入订阅到期提醒模板ID'

exports.main = async () => {
  const result = { cards: { checked: 0, due: 0, sent: 0 }, subs: { checked: 0, due: 0, sent: 0 } }
  const now = nowInChina()
  const todayStr = fmtDate(now)
  const tomorrow = new Date(now.getTime() + 86400000)
  const tomorrowStr = fmtDate(tomorrow)

  /* =========================================================
   * 第一段：信用卡还款提醒（明天到期还款）
   * ========================================================= */
  if (TEMPLATE_ID.indexOf('请填入') !== 0) {
    const cardsRes = await db.collection('cards').where({ status: 'pending', deleted: _.neq(true) }).limit(1000).get()
    result.cards.checked = cardsRes.data.length
    const dueCards = cardsRes.data.filter((c) => {
      const due = calcDueDate(c.repayDay, 'pending', now)
      return due === tomorrowStr
    })
    result.cards.due = dueCards.length

    // 按用户聚合
    const byUser = {}
    dueCards.forEach((c) => {
      const uid = c._openid || c.openid
      if (!uid) return
      if (!byUser[uid]) byUser[uid] = []
      byUser[uid].push(c)
    })

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
        result.cards.sent++
      } catch (e) {
        console.error('还款推送失败 uid=', uid, e)
      }
    }
  } else {
    console.log('尚未配置还款订阅消息模板 ID，跳过还款提醒')
  }

  /* =========================================================
   * 第二段：订阅续费提醒（T1.3 自动续费管家）
   * 触发条件：active 订阅 nextCharge = 今天 或 明天
   * 合并推送：同一用户多笔订阅合并为一条推送，thing1=订阅名清单(≤20字)，
   *           date2=最早扣费日，amount3=总金额，thing4=提醒语
   * ========================================================= */
  if (SUB_TEMPLATE_ID.indexOf('请填入') !== 0) {
    try {
      const subsRes = await db.collection('subscriptions')
        .where({ status: 'active', deleted: _.neq(true) })
        .limit(1000)
        .get()
      result.subs.checked = subsRes.data.length
      const dueSubs = subsRes.data.filter((s) =>
        s.nextCharge === todayStr || s.nextCharge === tomorrowStr
      )
      result.subs.due = dueSubs.length

      // 按 _openid 聚合,排序取最早 nextCharge
      const subByUser = {}
      dueSubs.forEach((s) => {
        const uid = s._openid || s.openid
        if (!uid) return
        if (!subByUser[uid]) subByUser[uid] = []
        subByUser[uid].push(s)
      })

      for (const uid of Object.keys(subByUser)) {
        const list = subByUser[uid]
        if (!list.length) continue
        const total = list.reduce((s, x) => s + (x.amount || 0), 0)
        // 最早扣费日(today < tomorrow)
        const dates = list.map((x) => x.nextCharge).filter(Boolean).sort()
        const earliest = dates[0] || tomorrowStr
        // 订阅名清单:thing1 ≤ 20 字,首笔 + 「等 N 笔」兜底
        const firstName = list[0].name || '订阅'
        const thing1 = list.length === 1
          ? firstName.slice(0, 20)
          : `${firstName}等${list.length}笔`.slice(0, 20)
        // 提醒语:今天扣费更紧急
        const isToday = earliest === todayStr
        const thing4 = isToday ? '今天扣费，看看要不要取消' : '明天扣费，看看要不要取消'

        try {
          await cloud.openapi.subscribeMessage.send({
            touser: uid,
            templateId: SUB_TEMPLATE_ID,
            page: 'pages/subscriptions/subscriptions',
            miniprogramState: 'formal',
            data: {
              thing1: { value: thing1 },
              date2: { value: earliest },
              amount3: { value: `¥${total.toFixed(2)}` },
              thing4: { value: thing4 }
            }
          })
          result.subs.sent++
          // 推送成功后:把每条订阅的 nextCharge 滚动到下一周期,避免明天/后天重复推送。
          // T1.1 nextChargeOf 新语义:从 currentNextCharge 推进 1 周期,custom 按 customMonths 累加。
          for (const x of list) {
            if (!x._id || !x.nextCharge || !x.cycle) continue
            const rolled = nextChargeOf(x.cycle, x.nextCharge, now, x.customMonths)
            if (!rolled || rolled === x.nextCharge) continue
            try {
              await db.collection('subscriptions').doc(x._id).update({
                data: {
                  nextCharge: rolled,
                  // custom 周期没有 cycleDay,显式置空;其它周期 cycleDay 不变(由 nextCharge 反推)
                  cycleDay: x.cycle === 'custom' ? null : x.cycleDay
                }
              })
            } catch (e) {
              console.error('订阅滚动回写失败 _id=', x._id, e)
            }
          }
        } catch (e) {
          console.error('订阅推送失败 uid=', uid, e)
        }
      }
    } catch (e) {
      // 订阅集合未创建时(-502005)静默,不阻塞还款主链路
      if (e && (e.errCode === -502005 || /not exist/i.test(e.errMsg || ''))) {
        console.log('subscriptions 集合未创建，跳过订阅提醒')
      } else {
        console.error('订阅扫描失败', e)
      }
    }
  } else {
    console.log('尚未配置订阅到期提醒模板 ID，跳过订阅提醒')
  }

  return result
}