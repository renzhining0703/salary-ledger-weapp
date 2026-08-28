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
   * 示例数据开关（上线前改为 false）
   * true：首次进入自动写入近 3 个月演示数据（开发联调用）
   * false：新用户进入为空数据，从零开始记账
   */
  DEMO_DATA: false,

  /** 开销分类 */
  CATEGORIES: ['餐饮', '交通', '购物', '孩子', '居住', '其他'],

  /** 回收站保留天数（删除的记录多少天后自动清理） */
  RECYCLE_DAYS: 30
}
