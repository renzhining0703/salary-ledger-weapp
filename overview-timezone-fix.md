# 账本君日期错误（UTC 时区漂移）修复总览

## 问题

9 月 2 日凌晨 1:07，首页账本君把"今天"说成 9 月 1 日。

## 根因

云函数容器默认 **UTC 时区**。北京时间 9 月 2 日 01:07 时，UTC 时间是 9 月 1 日 17:07；代码里直接用 `new Date().getDate()` 取日期，得到的是 `1`。用户问"今天几号"时，AI 只能按错误日期回答。

## 修复范围

改 3 个云函数，全部把"取当前时间"从 `new Date()` 替换为北京时间 `nowInChina()`：

| 云函数 | 改动文件 | 影响点 |
|--------|----------|--------|
| finChat | `cloudfunctions/finChat/index.js` | 数据块里的"今天"、工资提醒窗口、token 计数日期、画像聚合月份、记账查重日期 |
| salaryReminder | `cloudfunctions/salaryReminder/index.js`<br>`cloudfunctions/salaryReminder/lib/date.js` | 发薪日提醒的 today / monthStart / 第二轮兜底判断 |
| remind | `cloudfunctions/remind/index.js`<br>`cloudfunctions/remind/lib/date.js` | 还款提醒的"明天"日期计算 |

### 核心算法

```js
function nowInChina() {
  const now = new Date()
  const localOffsetMs = now.getTimezoneOffset() * 60 * 1000
  const cnOffsetMs = 8 * 60 * 60 * 1000
  return new Date(now.getTime() + localOffsetMs + cnOffsetMs)
}
```

思路：先把本地时间戳反推回 UTC，再加东八区偏移，得到北京时刻。与容器本身是什么时区无关。

## 关键边界验证

`scripts/verify-china-timezone.js` 9 项断言全过：

- UTC 容器 + 北京 01:07 → 9 月 2 日
- UTC 容器 + 北京 23:59:59 → 仍为当天
- UTC 容器 + 北京 00:00 → 正确跨天
- 东八区 / 西五区本机 → 均正确
- 源码扫描：无裸 `new Date()` 取当前时间

## 部署清单

1. 重新上传 `cloudfunctions/finChat`
2. 重新上传 `cloudfunctions/salaryReminder`
3. 重新上传 `cloudfunctions/remind`
4. 前端无需改动，重编译一次更保险

## 后续注意

以后任何云函数需要取"今天"，都必须走 `nowInChina()`，不能直接 `new Date()`。
