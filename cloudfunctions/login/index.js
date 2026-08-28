/**
 * 云函数 login：无感静默登录
 * 云函数环境自动识别用户身份，直接返回 openid，无需 code 换 session
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async () => {
  const { OPENID, APPID, UNIONID } = cloud.getWXContext()
  return {
    openid: OPENID,
    appid: APPID,
    unionid: UNIONID || ''
  }
}
