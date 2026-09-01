# 2026-09-01 · 账单弹框升级为独立页面 + 账本君聊天弹框抽公共组件

两个诉求：① 记账页「查看本月账单」不再弹框，跳转独立账单页面，标题「x月账单」（如九月账单）；② 首页与账单页的账本君聊天弹框合并为同一套公共组件，方便后续维护迭代。

## 一、月度账单独立页面 `pages/statement/`

由记账页账单弹框整体迁移，不再是页内 sheet：

- **页面标题**：onLoad 读取 `?month=` 参数（缺省本月），`CN_MONTHS` 中文月转换，`wx.setNavigationBarTitle` 设置「九月账单」样式标题
- **完整迁移弹框内容**：结余 Hero 卡（可用余额 + 储蓄率徽章 + 累计收入/支出）、环比上月 chip、分类明细（含预算 chip + 超支标记）、AI 解读卡（finReport 云函数 8s 超时 → finTemplate 本地模板兜底）、分类预算设置 sheet
- **数据口径**：与首页看板一致的「累计可用余额（滚动结转）」；累计支出沿用上午修复的口径——历史月份用 `expAgg` 快照 + 本月用实际查询值，快照漂移不再污染本月数字
- **onShow force 重查**：从聊天记账/撤销返回时数字最新（云函数写库不触发 dbApi 缓存失效）
- **加载兜底**：statement 未就绪时显示 loading 态，不闪空值

记账页 `openStatement` 改为 `wx.navigateTo('/pages/statement/statement?month=' + viewMonth)`，保留「本月还没有数据」的空态拦截。

## 二、聊天公共组件 `components/ai-chat-sheet/`

原先首页 `ai-chat-sheet` 与记账页 `chat-sheet` 是两份重复实现（样式都两套），现已合并为一个组件：

- **组件内置全部交互逻辑**：发送、节流（10 次/分钟）、记账成功 15s 撤销倒计时、「再记一次」确认、快捷 chip、键盘高度自适应（弹起 50vh/收起 80vh）、三层滚底保险
- **宿主页面职责收窄**：只提供数据源（props）与页面级副作用（events）
  - props：`show` / `sub`（副标题）/ `stmt`（AI 数据源）/ `recentList`（最近流水）/ `placeholder`
  - events：`close`（动画播完）/ `clear`（清空后页面级状态）/ `beforesend`（首页清未读询问）/ `refresh`（记账/撤销后 force 刷新）
  - slot `head`：宿主自定义头部卡片（首页的询问气泡/订阅引导/上次会话摘要都走插槽）
- **会话全局共享不变**：`globalData.chatMessages`，首页聊过的账单页接着聊
- **公开方法 `syncMessages()`**：sheet 打开期间宿主改了 globalData（如点「忽略」移除询问气泡）后即时同步组件列表
- `styleIsolation: 'apply-shared'` 复用 app.wxss 全局样式与 CSS 变量主题

## 三、两个宿主页的接线

**首页 `pages/index/`**：
- `goAskAI` 保留全部会话注入逻辑（提醒/询问气泡/场景开场白/欢迎消息都写 globalData），末尾只 setData `showAiChat` + `aiStmt`（`_buildAiStmt()` 产出）+ slot 卡片状态
- 新增 4 个事件处理：`onAiChatClose`（卸载 + 趋势图重绘）、`onAiChatClear`（云端未读字段）、`onAiChatBeforeSend`（清未读询问/隐藏摘要）、`onAiChatRefresh`（force 重查 + 重建 aiStmt）
- 删除内联实现：onAiInput/onAiFocus/onAiBlur/onAiKeyboardChange/onReRecord/_scrollChatToBottom/_chatStmt/_chatRecentList 及 chatController behavior

**账单页 `pages/statement/`**：`openChat` 置 `showChat: true`，副标题「九月账单有疑问，尽管问」，refresh 事件触发 force 重查。

## 四、代码量变化

| 文件 | 之前 | 之后 |
|---|---|---|
| pages/expenses/expenses.js | 843 行 | 377 行 |
| pages/expenses/expenses.wxss | 995 行 | 340 行 |
| pages/index/index.js | ~1650 行 | ~1450 行 |
| pages/index/index.wxss | 1125 行 | 813 行 |
| components/ai-chat-sheet/ | —（两处重复） | 4 文件（唯一实现） |
| pages/statement/ | —（弹框混在记账页） | 4 文件（独立页面） |

## 五、验证

新建 `scripts/verify-statement-page.js`，**57 项断言全部通过**：
1. statement 页注册/标题/环比/快照口径/AI 解读兜底
2. statement 页复用公共组件（注册/事件接线）
3. 记账页弹框代码彻底清除（wxml 标记/js 方法/wxss 样式/page-locked）
4. 公共组件结构完整性（9 个核心方法/节流/倒计时/4 个事件/插槽）
5. 首页改用组件（注册/插槽/事件/旧方法清除）
6. 双入口共用同一组件 + globalData 会话共享

`node --check` 四个 JS 全过，五个 JSON 全部合法。

## 六、遗留待清理（未删，待确认）

- `utils/chatController.js`：已无任何运行时引用（死代码），可删
- `scripts/verify-chat-sheet.js`、`scripts/verify-feed-c89.js`：校验的是本次重构前的旧结构，重跑会失败，可删或并入 verify-statement-page.js

## 部署

纯前端改动，无需部署云函数——开发者工具重编译 + 上传体验版即可。
