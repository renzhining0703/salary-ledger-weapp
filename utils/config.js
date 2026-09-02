/**
 * 全局配置
 * 云开发环境 ID 与订阅消息模板 ID 都在这改
 */
module.exports = {
  /** 云开发环境 ID（你的环境） */
  CLOUD_ENV: 'cloud1-8gembxhfa18dcf14',

  /**
   * 订阅消息模板 ID
   * 申请方式：小程序后台(mp.weixin.qq.com) → 功能 → 订阅消息 → 选用「还款提醒」类模板
   * 拿到模板 ID 后替换下面字符串，并同步把 cloudfunctions/remind/index.js 里的模板字段对上
   */
  SUBSCRIBE_TEMPLATE_ID: 'wA_ZPWiHPGe4kD17FfpT2HFKPEHBOXmMXDi03viQczM',

  /**
   * 订阅消息模板 ID - 工资到账询问（账本君主动询问）
   * 申请方式：同 SUBSCRIBE_TEMPLATE_ID，在订阅消息后台选用「工资到账询问」类模板
   * 模板字段 thing.DATA（询问文案）+ date.DATA（日期），需与后台模板一致
   * 同步位置：cloudfunctions/salaryReminder/index.js TEMPLATE_ID
   */
  SALARY_REMIND_TEMPLATE_ID: '_7wp6rvHVPYC9QUj3SobEOUtXvW5l9076SUDh_4zrzg',

  /**
   * 订阅消息模板 ID - 订阅到期/续费提醒（T1.3 自动续费管家）
   * 申请方式：同 SUBSCRIBE_TEMPLATE_ID，在订阅消息后台选用「到期提醒 / 续费提醒」类一次性订阅模板
   * 模板字段建议：thing1=订阅名称(≤20字)、date2=扣费日期、amount3=金额、thing4=提醒语
   * 同步位置：cloudfunctions/remind/index.js SUB_TEMPLATE_ID
   * 注：上线前必须把占位符换成真实模板 ID，否则不会推送
   */
  SUBSCRIPTION_REMIND_TEMPLATE_ID: '请填入订阅到期提醒模板ID',

  /**
   * 示例数据开关（上线前改为 false）
   * true：首次进入自动写入近 3 个月演示数据（开发联调用）
   * false：新用户进入为空数据，从零开始记账
   */
  DEMO_DATA: false,

  /** 开销分类（"还款"由标记信用卡已还自动写入,用户也可手动选） */
  CATEGORIES: ['餐饮', '交通', '购物', '孩子', '居住', '还款', '其他'],

  /**
   * 收入类型（工资页 = 收入页）
   * 口径：只有「账户里真正多了一笔钱」才算收入；借款/朋友还钱/借出不算收入,不入账
   * 旧数据无 source 字段,展示时兜底为 main(主业)
   */
  INCOME_SOURCES: [
    { value: 'main', label: '主业' },
    { value: 'side', label: '副业' },
    { value: 'bonus', label: '年终奖/奖金' },
    { value: 'gift', label: '红包/礼金' },
    { value: 'invest', label: '理财收益' },
    { value: 'other', label: '其他收入' }
  ],

  /** 回收站保留天数（删除的记录多少天后自动清理） */
  RECYCLE_DAYS: 30
}
