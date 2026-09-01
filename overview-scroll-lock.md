# 弹框滚动穿透修复总览

## 问题

1. **记一笔弹框**：框内滑动时，金额输入框 0.00 跟着移动
2. **全局**：所有弹框（sheet）内滑动时，底部页面跟着滚动

## 根因

所有页面的 `.mask` / `.sheet` 只绑了 `bindtap`，**没有任何 touchmove 拦截**——触摸滑动事件一路冒泡到 page 层，底部页面照常滚动。「0.00 跟着移动」是同一根因的表现：页面滚动带动了 fixed 弹框内的视觉偏移。

## 修复方案（三层）

### 1. 全局注入空方法（app.js）

```js
const originalPage = Page
Page = function (options = {}) {
  if (typeof options.preventTouchmove !== 'function') {
    options.preventTouchmove = function () {}
  }
  return originalPage(options)
}
```

所有页面默认拥有 `preventTouchmove`，无需每页 JS 各写一遍（页面自定义同名方法不会被覆盖）。

### 2. 所有弹层容器加 catchtouchmove（34 个元素）

| 页面 | 弹框 |
|------|------|
| index | 分享弹层、最优还款顺序 |
| expenses | 记一笔 |
| salary | 记录收入、发薪日设置 |
| cards | 添加信用卡、更新账单 |
| my | 编辑资料、总预算、签名、分类预算列表、单分类预算、固定支出管理、固定支出表单（7 个） |
| calendar | 当日明细 |
| statement | 分类预算设置 |
| ai-chat-sheet 组件 | 账本君聊天（组件自带 preventTouchmove 方法，不吃 Page 注入） |

### 3. 长内容弹框改内部 scroll-view 承载滚动

catchtouchmove 在部分机型会同时阻断 CSS `overflow-y: auto` 滚动，**原生 scroll-view 不受影响**。因此长内容弹框的滚动全部交给内部 scroll-view：

- **记一笔**：`.form-sheet`（flex + overflow:hidden）+ `.form-scroll`（scroll-view），标题/保存按钮固定
- **固定支出管理 / 当日明细**：列表包进 `scroll-view class="sheet-scroll"`（全局样式，max-height 56vh）
- 既有 scroll-view（聊天记录、最优还款列表、固定支出横滑条）本就不受影响

## 验证

`scripts/verify-scroll-lock.js` **59 项断言全过**：

- 全局注入逻辑正确（含不覆盖自定义方法）
- 9 个页面全部 Page() 构造（注入才有效）
- 34 个弹层容器逐一扫描，全部带 catchtouchmove
- 组件自带方法 + 结构/样式断言

## 部署

纯前端改动，**重编译小程序即可**，无云函数变更。

手测路径：记一笔弹框内滑动（0.00 不动、底部页面不动）→ 账本君聊天弹框滑动 → 我的页各弹框滑动。
