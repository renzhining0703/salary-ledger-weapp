/**
 * 云函数 salaryReminder：发薪日主动询问工资到账
 * 触发器：每月 15 号 19:00 首次 + 17 号 10:00 沉默期补问（均见 config.json triggers）
 *
 * 上线前必做：
 * 1. 已与前端 utils/config.js 同步模板 ID（utils/config.js: SALARY_REMIND_TEMPLATE_ID）
 * 2. 模板字段 thing1（询问文案）/ date2（日期），需与后台模板一致
 * 3. miniprogramState 已配置为 'formal'；体验版联调推送时临时改回 'trial'
 * 4. 用户须在前端订阅授权后才会被推送（依赖 users.salaryRemindSubscribed 字段）
 */
const cloud = require('wx-server-sdk')
const { fmtDate, monthStart, nowInChina } = require('./lib/date')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 模板 ID 在 utils/config.js 同步填入；这里默认占位，未配置时直接跳过
const TEMPLATE_ID = '_7wp6rvHVPYC9QUj3SobEOUtXvW5l9076SUDh_4zrzg'

// 两轮询问文案模板（差异：第二轮更明确"补一笔"语义）
const FIRST_PROMPT = '今天工资到账了吗?跟账本君说"发了 12000"就行 ✓'
const SECOND_PROMPT = '本月的工资还没记录,要不要补一笔?点我跟账本君说'

exports.main = async (event) => {
  if (TEMPLATE_ID.indexOf('请填入') === 0) {
    console.log('尚未配置订阅消息模板 ID，本次跳过提醒')
    return { skipped: 'no-template' }
  }

  // 区分两轮触发：优先用触发器名（config.json 的 TriggerName，不受时区/触发时间偏移影响）；
  // 手动在控制台测试调用时没有 TriggerName，按小时兜底（17 号 10:00 → 沉默期）
  const now = nowInChina()
  const triggerName = (event && event.TriggerName) || ''
  const isSecondRound = triggerName
    ? triggerName === 'salaryRemindSecond'
    : now.getHours() === 10

  // 1. 拉所有订阅了"工资询问"的用户
  const usersRes = await db.collection('users')
    .where({ salaryRemindSubscribed: true })
    .limit(1000)
    .get()
  const users = usersRes.data
  if (users.length === 0) return { checked: 0, sent: 0, reason: 'no-subscribers' }

  const monthBegin = monthStart(now) // YYYY-MM-01
  const todayStr = fmtDate(now)       // YYYY-MM-DD

  let sent = 0
  let skipped = 0
  for (const u of users) {
    const uid = u._openid
    if (!uid) continue

    // 2. 查本月是否已记工资（payDate 在 [月初, 今天] 区间，排除回收站）
    const salaryRes = await db.collection('salary')
      .where({
        _openid: uid,
        deleted: _.neq(true),
        payDate: _.gte(monthBegin).and(_.lte(todayStr))
      })
      .limit(1)
      .get()
    if (salaryRes.data.length > 0) {
      // 本月已记 → 顺手清掉可能残留的未读字段
      if (u.unreadQuestion) {
        await db.collection('users').doc(u._id).update({
          data: { unreadQuestion: null, unreadQuestionCount: 0 }
        }).catch(() => {})
      }
      skipped++
      continue
    }

    // 3. 沉默期去重：17 号 10:00 cron 如果 15/16 号已推送过，跳过
    if (isSecondRound && u.lastSalaryReminderAt &&
        new Date(u.lastSalaryReminderAt) > new Date(now.getTime() - 48 * 3600 * 1000)) {
      skipped++
      continue
    }

    // 4. 写未读字段（账本君入口卡显示红点 + 进入 sheet 显示询问气泡）
    const questionText = isSecondRound ? SECOND_PROMPT : FIRST_PROMPT
    const unreadQuestion = {
      text: questionText,
      ts: now.getTime(),
      round: isSecondRound ? 2 : 1
    }
    await db.collection('users').doc(u._id).update({
      data: {
        unreadQuestion,
        unreadQuestionCount: (u.unreadQuestionCount || 0) + 1,
        lastSalaryReminderAt: now
      }
    })

    // 5. 发订阅消息
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: uid,
        templateId: TEMPLATE_ID,
        page: 'pages/index/index?from=salary_reminder',
        miniprogramState: 'formal', // 正式发布用 'formal'；体验版联调时改回 'trial'
        data: {
          thing1: { value: questionText },
          date2: { value: todayStr }
        }
      })
      sent++
    } catch (e) {
      // 失败不回滚 unreadQuestion —— 入口红点保留，用户打开 app 也能看到
      console.error('推送失败 uid=', uid, e)
    }
  }

  return { checked: users.length, sent, skipped }
}