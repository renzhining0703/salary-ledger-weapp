# 2026-09-01 · 记一笔 × 固定支出联动（方案 A 快捷条）

## 问题
记一笔和固定支出模板两条链路完全断开：在记一笔里记了「房租」，模板仍显示待记 → 重复记账风险或模板永远对不上（recurringId 只在「记入本月」路径上存在）。

## 方案（用户选定 A：快捷条，零误判）
- 打开记一笔时拉本月未落账模板（active 且 lastRecorded ≠ 当月），sheet 顶部金色快捷条横向列出「名称 ¥金额」
- 点一下 → 预填金额/分类/备注 + 挂关联，显示「已关联「房租」，保存后本月不再提示」提示条（✕ 可解除，预填内容保留）
- 保存 → 开销写入 recurringId（可追溯），并按该笔日期所属月 updateRecurring({lastRecorded})（我的页「本月已记 ✓」同步点亮）
- 标记失败 catch 不阻断记账：模板保持待记，下次仍可确认，不丢数据

## 交互细节
- 快捷条与关联提示条互斥显示（有关联时快捷条隐藏）
- 关联保存 toast「已记 · 房租本月已同步」；保存后清空关联态，下次打开刷新待记列表
- updateRecurring 自带缓存 invalidate，重复打开不会看到已记模板

## 验证
`scripts/verify-recur-link.js` 19 项断言全过 + `node --check`。纯前端改动，无需部署云函数。

---

# 2026-09-01 · 分类选择器组件化：图标网格版 cat-grid

## 改动
按《记账页分类选择器设计稿.html》把「文字胶囊」分类选择器升级为 4 列图标网格，并抽为公共组件，三处统一替换：

| 位置 | 选择内容 | 图标 |
|---|---|---|
| 记账页记一笔弹框 | 支出分类（7 项） | 🍜🚇🛍️🧸🏠💳📦 |
| 工资页记录收入弹框 | 收入类型（6 项） | 💼🚀🏆🧧📈💰 |
| 我的页固定支出表单 | 支出分类（7 项） | 同上 |

## 组件 components/cat-grid
- 受控组件：`items`（字符串数组或 {value,label} 对象数组）+ `value`，`bindchange` 回传 `{value}`
- ICON_MAP 收录 13 个已知项，未知项回退 🏷️ + 中性灰底
- 样式全走 CSS 变量，浅/深主题自动跟随；4 列用 flex + calc((100%-60rpx)/4) 规避低版本 webview 的 grid 兼容问题
- 选中态：金色边框 + 金渐变图标底 + 右上角勾标（选择器优先级 3 类名压过 tone 的 2 类名，免 !important）

## 配套
- app.wxss 四个主题块各补 `--tint-success-12` / `--tint-warn-12`（共 8 处）
- 三页面 json 注册组件、js handler 改读 `e.detail.value`、wxss 删除三份重复的 .cat-chips/.chip/.chip-active
- cat-budget-chip / stmt-quick-chip / source-tag 等独立类不受影响

## 验证
`scripts/verify-cat-grid.js` 36 项断言全过 + `node --check` ×4。纯前端改动，无需部署云函数。
设计稿中的第 8 格「+自定义」占位未实现（无对应功能，避免假入口）。

---

# 2026-09-01 ·「我的」页信息架构整理：五分组重排

## 改动
按用户规划把设置项重组为五组（顶部资料区不动）：

| 分组 | 内容 |
|---|---|
| 资产与账单 | 信用卡管理、每月固定支出（大卡片 → 一行入口，副标题「N 项 · 每月 ¥xx」） |
| 数据概览 | 消费日历（大热力卡 → 一行入口，副标题「近 3 月支出 ¥xx・N 天有开销」，tap 跳 calendar） |
| 提醒与规则 | 还款提醒、账本君主动询问、每月发薪日、每月开销预算、分类预算（后三项从偏好设置移入） |
| 偏好设置 | 外观主题、隐私锁 |
| 数据 | 回收站、重置全部数据（不动） |

## 清理
- `my.js`：删 buildHeatmapCells（calendar 页有自己的一份）与 heatmapPreview data/渲染，_loadHeatmapPreview 精简为纯统计
- `my.wxss`：删热力图入口卡（heatmap-card*/preview/legend）与固定支出大卡（recur-card/summary/total/hint）样式，管理弹层样式保留

## 验证
42 项断言全过（分组顺序/行归属/旧结构清除/方法绑定一致性）+ `node --check` 通过。纯前端改动，无需部署云函数，重新编译体验版即可。

---

# 2026-09-01 · Bug 修复：账本君「过去时」规则误杀补记场景

## 问题
用户说「8月29号，午餐12」→ 账本君直接拒绝：「8月29号的午餐¥12是过去的事，现在记会记到当天，不太合适。」

## 根因
多处规则同时拦截补记场景（第二轮又发现 addSalary 段残留）：
1. 系统提示词（addExpense 段）：`描述过去 → 不调，提醒用户当下再说`
2. `addExpense` / `addSalary` 工具 schema：`过去时不调用`
3. `addSalary` 段不调场景残留：`描述过去("上月发了")→ 纯文本回答或提醒当下再说`
4. `looksLikeRecordQuestion` 兜底：`/昨天|前天|上周|上月|去年/ → return false` + 动词正则无「午餐/晚饭」类词

## 修复
- 系统提示词：改为「补记过去：用户明确说'记'或'花了'并带具体日期 → 正常调用，如实传入 date，不要拒绝」
- PROMPT_RECORD 开头加「铁律一(补记)」：不论日期今天/昨天/更早，已发生开销+金额就必须调 addExpense；禁止说"过去的事"/"现在记会记到当天"/"当下再告诉我"
- 工具 schema：去掉「过去时不调用」，改为「明确表达记录意图（记/花了/买了/付了/刚XX元/具体日期+金额）时调用」
- 兜底函数：删除过去式关键词拦截；动词正则扩充（午餐/晚饭/充电/会员/充值等）
- 前端 chatController 确认无拦截

## 改动文件
`cloudfunctions/finChat/index.js`

## 验证
9 项断言全过 + `node --check` 通过。

## 部署
**必须重新上传部署 finChat 云函数**（微信开发者工具 → 云开发 → 云函数 → finChat → 右键 → 上传并部署）。不部署则云端仍是旧代码，行为不变。

---

# 2026-09-01 · Bug 修复：账本君返回「已记」但实际未写入数据库

## 问题
用户连续发送三条记账消息，账本君均回复「✓ 已记」，但流水列表中仅午餐存在，购买会员¥140 和电动车充电¥2 实际未写入。

## 根因
云函数 `cloud.getWXContext()` 在极少数请求中可能拿到异常的 `OPENID`（空字符串），导致 `add` resolve 但 `_openid` 写入异常，后续查询过滤条件匹配不上。三条消息并发时，中间请求运气好拿到了正确的 OPENID，前后两条异常。

## 修复
- `executeAddExpense` / `executeAddSalary` 开头增加 `openid` 空值检查，为空直接返回错误。
- `add` 后立即做**写入验证**：按 `_id` 回查确认文档存在且 `_openid` 匹配。
- 验证失败时**回滚删除**脏数据，返回明确失败提示（而非「已记」）。
- `add` 未返回 `_id` 时同样返回失败。

## 改动文件
`cloudfunctions/finChat/index.js`

## 验证
`/tmp/verify_write_guard.js` 12 项断言全过。`node --check` 通过。

---

# 2026-09-01 · Bug 修复：账本君重复检测日期错位 + 再记丢失日期备注

## 问题
用户说「8月31号，晚饭，12」→ 账本君误报「今天已经记过一笔餐饮¥12了」（今天9月1日确实有午饭¥12）→ 点「再记」后记到了今天（9月1日）且丢失「晚饭」备注。

## 根因
1. `checkDuplicate` 固定查「今天」，用户记昨天的消费却被今天的记录误拦。
2. 自动确认提示只要求 AI「取金额与分类」→ AI 再记时丢失 date 和 note。

## 修复
- `checkDuplicate` 增加 `date` 参数，按指定日期查重（不传时兼容旧行为查今天）。
- `executeAddExpense` 传入 `dateStr`，`duplicateInfo` 带回 `dupRecDate`（重复记录实际日期）。
- 防重文案动态显示日期：5分钟内→「刚才」/ 今天→「今天」/ 其他→具体日期。
- 系统提示强制要求 AI 再记时「完整保留 date、note、amount、category」。
- 工具 schema date/note description 加粗标注再记时不能丢失。

## 改动文件
`cloudfunctions/finChat/index.js`

## 验证
`/tmp/verify_dup_fix.js` 15 项断言全过。`node --check` 通过。

---

# 2026-09-01 ·「我的」页：偏好设置加外观主题（跟随系统 / 浅色 / 深色）

## 改动
- 偏好设置新增「外观主题」picker 行：跟随系统（默认）/ 浅色 / 深色
- 新增 `utils/theme.js` 主题管理：mode 存 storage（冷启动立即生效）+ `users.themeMode` 云端持久化（跨设备同步）
- CSS 层手动覆盖：页面根节点挂 `.theme-force-light` / `.theme-force-dark`，子树内重声明全部 48 个 CSS 变量；根视图自绘背景 + `wx.setBackgroundColor` 兜底下拉区
- chrome 跟随生效主题：导航栏 `applyNavBarColor`、tabBar `applyTabBar`（theme.json 只跟系统，手动指定需 JS 覆盖）
- canvas 配色统一取 `app.resolvedTheme()`：首页趋势图、账单饼图、手势锁画布
- 主题变更链路收敛：app 统一 `onThemeChange` + `setThemeMode → notifyPagesThemeChange`，各页实现 `applyTheme()`；删除 index/expenses 两处私有监听

## 改动文件

| 文件 | 变更 |
|------|------|
| `utils/theme.js` | 新增：mode 管理 / resolvedTheme / themeClass / applyToPage |
| `app.js` | +themeMode、resolvedTheme、applyTabBar、setThemeMode、通知链；silentLogin 跨设备同步 |
| `app.wxss` | +`.theme-force-light`/`.theme-force-dark` 变量块（与 page/媒体查询逐值一致）、根视图背景、navbar 反向覆盖 |
| `pages/*/*.wxml` × 7 | 根节点 + `{{themeClass}}` |
| `pages/*/*.js` × 7 | +`themeUtil.applyToPage` / `applyTheme()`；canvas isDark 改用 resolvedTheme |
| `pages/my/my.wxml` / `my.js` | 外观主题 picker 行 + `onThemeModeChange`（本地立即生效 + 云端持久化） |

## 验证
`/tmp/verify_theme.js` 92 项断言全过（mode×系统主题 6 格矩阵、48 变量清单与值逐一比对、chrome 逻辑、7 页接入、my 页 UI）。`node --check` 全部通过。

---

# 2026-09-01 ·「我的」页：副文案改为签名展示 + 可编辑

## 改动
- 去掉头像下方的「账本君会在发薪日主动关心你」副文案，改为 motto 签名展示
- 默认签名：「记录烟火收支，积攒人间安稳」（30 字上限内，温暖不呆板）
- 签名后放小铅笔 icon（✎），点击弹框编辑，保存即 `updateMyUser({motto})` + 本地同步
- 签名编辑弹框复用 sheet 组件，30 字上限（wxml `maxlength="30"`）

## 改动文件

| 文件 | 变更 |
|------|------|
| `pages/my/my.wxml` | 副文案区改为 motto + 铅笔；新增签名编辑 sheet |
| `pages/my/my.js` | data +`formMotto`/`defaultMotto`/`showMottoEdit` 等；+`openMottoEdit`/`closeMottoEdit`/`onMottoEditInput`/`saveMottoEdit` |
| `pages/my/my.wxss` | +`.my-user-motto`/`.motto-text`/`.motto-edit-icon`/`.motto-input` 样式 |

## 验证
`/tmp/verify_motto.js` 4 项断言全过（applyUser 同步 / 默认展示 / 空校验 / 长度约束）。`node --check` 通过。

---

# 账本君亮点：场景化开场白（⑤ 的第一步，聊天内主动提醒）

> ⚠️ **2026-09-01 修复**：开场白气泡从「插在聊天顶部」改为「**追加到消息末尾**」，去重 key 升 `v2`。原设计插顶部 + 打开自动滚到底部 → 提醒被历史消息埋没，且 `markHintShown` 已写入 → 同天再打开被去重永久挡住（体验版更新不清 storage，重装无效）。详见文末「Bug 修复 3」。

> ⚠️ **2026-09-01 修复 4（工资询问断链）**：云函数 `salaryReminder` 把工资询问写到**云端** `users.unreadQuestion`，但前端 `_loadPendingQuestion()` 只读**本地** storage，而本地写入函数 `savePendingQuestion` 全项目**零调用** → 工资询问红点/气泡**从未显示过**。已在 `loadData` 补「云端→本地」同步（未过期且本地空才写；过期顺手清云端）。

## 需求
用户问「⑤ 场景化主动提醒里的『账本君主动说一句』，是打开聊天窗口主动说吗？」——确认落地形态：先做聊天内主动开场白（②），订阅消息推送（①）后续再加。

## 交互设计
用户打开账本君聊天 sheet 时，若**今天有紧急财务场景**，账本君在聊天底部（消息末尾）追加一条主动提醒（纯模板拼接，不走 LLM，零成本）：

```
优先级：还款(逾期 > 今天 > 1-3天) > 预算(已超 > ≥80%)，一次只挑最紧急的一条
去重：同一天同一场景只说一次（chatStorage 按日期存 aiChat_activeHints_v2）
互斥：有未回应的工资询问(pendingQ)时跳过——一次只主动讲一件事；还款逾期/今天(days≤0)例外，紧急优先
```

文案示例：
- 逾期：`⚠️ 你的 招行 卡款已逾期 2 天，¥3,200 还没还。逾期会影响征信，今天赶紧处理吧！`
- 今天还款：`⚠️ 今天有 建行 的卡款要还，¥1,500.50。记得还款，别逾期。`
- 3 天内：`📌 2 天后有 交行 的卡款要还，¥800.00。提前把钱备好，别到时候手忙脚乱。`
- 预算已超：`⚠️ 本月开销 ¥8,000，已超预算 ¥4,000。要不要我帮你看看超在哪、怎么调整？`
- 预算 80%：`📌 本月开销 ¥3,400，已达预算 85%，注意控制。按现在的节奏，今天最多还能花 ¥23.45。`

## 改动清单

| 文件 | 变更 |
|------|------|
| `utils/chatStorage.js` | 新增 `aiChat_activeHints_v2` 去重存储：`loadHints(date)` / `markHintShown(date, key)` / `clearHints()`（v1→v2 见文末修复） |
| `pages/index/index.js` | `data` 加 `repayHint`；`loadData` 算 `repayHint`（还款日 ≤3 天含逾期里最紧急一张，补齐 todoList 只到明天的缺口）；新增 `_buildActiveHint()` 纯模板方法；`goAskAI` 在 pendingQ 之后、欢迎消息之前插入开场白气泡（`source: 'active-hint'`）并去重 |
| `pages/my/my.js` | 重置数据时同步 `chatStorage.clearHints()`，让主动提醒重新生效 |

## 验证
- `/tmp/verify_hint.js`：17 项断言全过（优先级/逾期/今天/1-3天/预算 over/warn/无场景/同场景去重/跨天重置/repayHint 取最紧急/边界 3 天含 4 天不含/已还卡跳过）。
- 三个修改文件语法检查通过。

## 交互细节
- 开场白气泡**追加到消息末尾**（像一条新消息，打开聊天自动滚到底部即可见），`source: 'active-hint'`，wxml 不依赖 source 样式，零样式改动。
- 有开场白时欢迎消息自动跳过（messages.length > 0 且原逻辑仅空聊天时欢迎）；无场景时回到原欢迎逻辑。
- 预算预警只在当月生成（查看历史月无预算场景），还款提醒不受查看月影响——语义合理。

## ⚠️ 已知问题修复：开场白被未回应工资询问永久占位

**现象**：用户反馈「有一张卡后天还，打开账本君没任何反应」。

**根因**：`goAskAI` 里「有 pendingQ（未回应的工资询问）就跳过开场白」的互斥规则没有过期机制——工资询问只要不回应就永久占位，还款/预算提醒永远不出现。

**修复**（`/tmp/verify_pendingq.js` 13 断言全过）：
1. `utils/util.js` 新增 `isPendingQExpired(q)`：询问发出超 48h 未回应视为过期
2. `pages/index/index.js` `_loadPendingQuestion`：加载时过期自动清除（红点/气泡都不显示）
3. `pages/index/index.js` `goAskAI`：开头过期兜底清理；互斥规则放宽——**还款逾期/今天（days≤0，征信风险）比工资询问更紧急，开场白照常插入**（询问气泡保留在下方，两条共存）

**验证场景**：无询问+后天还款→提示 / 询问过期→清除并提示 / 询问未过期+后天→互斥跳过 / 询问未过期+今天/逾期→紧急优先 / 去重。

## ⚠️ 修复 2：goAskAI setData 异步陷阱（过期询问仍误拦开场白）

**现象**：用户确认「无工资询问气泡、当天未看过提示、重新部署云函数后依然无还款提醒」。

**根因（真实 bug）**：`goAskAI` 清除过期询问用的是 `this.setData({ pendingAiQuestion: null })`，但 setData **异步**——下一行 `let pendingQ = this.data.pendingAiQuestion` 拿到的仍是旧值，`if (!pendingQ || repayUrgent)` 误判「有未回应询问」→ 开场白被跳过。`/tmp/verify_repayfix.js` 修复前后对照确认（9/9 过）。

**修复**：`pages/index/index.js` goAskAI 改为先取局部变量 `pendingQ`，过期时**局部变量直接置 null**，不再依赖 setData 的异步更新。

**⚠️ 部署认知（重要，用户已踩坑）**：开场白是**纯前端功能**（`index.js` + `chatStorage.js` + `my.js` 三文件），**云函数零改动**——重新部署云函数对此功能无效。必须在微信开发者工具里**重新编译/上传体验版**。自检：首页能看到「日均可花」卡片（与开场白同一批前端功能）= 前端已是最新版；看不到 = 前端未编译。

## ⚠️ 修复 3：开场白插顶部被历史消息埋没 + 去重锁死（最终根因）

**现象**：前端已是最新版（日均可花卡片可见）、体验版已重发，但打开账本君依然看不到还款提醒。

**根因（设计问题，脚本复现确认）**：
1. 开场白气泡用 `messages = [hint, ...messages]` **插在消息列表最顶部**；
2. 但 `goAskAI` 打开 sheet 时 `_scrollChatToBottom()` **强制滚到底部**（`scroll-into-view: ai-chat-bottom` + `scroll-top: 99999`）；
3. 用户有历史聊天记录 → 提醒气泡在顶部被埋没，打开看到的全是底部历史消息 =「没反应」；
4. **致命闭环**：插入的同时 `markHintShown(today, 'repay')` 已写入「今天提醒过」→ 用户关掉再打开，`!hints.repay` 不成立 → 当天**永久不再出现**；
5. 体验版更新**不清本地 storage** → 重新编译/重发体验版都救不了，只有换 key 或清缓存才生效。

**修复**（`/tmp/verify_hint_position.js` 12 断言全过）：
1. `pages/index/index.js` `goAskAI`：开场白改为 `messages = [...messages, hint]` **追加到消息末尾**——打开自动滚到底部，提醒就是最新一条，天然可见；
2. `utils/chatStorage.js`：去重 key `aiChat_activeHints_v1` → **`v2`**，让用户 storage 里旧版本误写入的「今天已提醒」标记作废，**重新编译后当天立即生效**，无需手动清缓存。

**验证场景**：有历史消息时追加末尾可见 / 旧 v1 标记不影响 v2 / 同天再打开 v2 去重 / 跨天重置 / 空聊天可见 / 工资询问互斥 / 还款紧急优先。

---

## ⚠️ 修复 4：工资询问断链（云端写入但前端从不读取）

**现象**：用户问「工资询问是否能正常看到」——排查发现该功能**从未工作过**。

**根因（断链 bug，比逻辑 bug 更隐蔽——无报错、静默失败）**：
- 云函数 `salaryReminder`（每月 15 号 19:00 / 17 号 10:00 触发）把询问写到**云端** `users.unreadQuestion`（`{text, ts, round}`）+ 推订阅消息；
- 前端 `_loadPendingQuestion()` 只读**本地** `chatStorage.loadPendingQuestion()`（`aiChat_pendingQuestion_v1`）；
- 而本地写入函数 `savePendingQuestion` **全项目零调用方**——「云端 → 本地」同步从未存在；
- 清云端的三处代码（`clearAiChat` / `_chatBeforeSend` / `onDismissPendingQuestion`）都在，但读都没读到。

**修复**（`/tmp/verify_salaryq.js`，9 断言全过）：
- `pages/index/index.js` loadData：拿到 user 后同步——云端 unreadQuestion **未过期且本地为空** → `savePendingQuestion` 写本地；**过期** → 顺手清云端（`updateMyUser({unreadQuestion:null})`）；**本地已有** → 不覆盖
- setData 增加 `pendingAiQuestion` / `aiUnread`（以本地为准），红点 + 气泡随 loadData 一次到位

**验证方法**：
1. **快速验证（推荐）**：云开发控制台 → `users` 集合 → 自己的记录，手动加 `unreadQuestion: { text: '今天工资到账了吗?跟账本君说"发了 12000"就行 ✓', ts: 当前毫秒时间戳, round: 1 }` → 重新编译前端 → 首页账本君入口卡出现红点；打开聊天 sheet 出现询问气泡
2. **真实链路**：等每月 15 号 19:00 云函数触发（前提：已开订阅、本月未记工资、云函数已部署）。⚠️ 体验版联调时 `miniprogramState` 需临时改 `'trial'` 才能收订阅消息——但 unreadQuestion 无论推送成败都会写入，红点/气泡不依赖推送送达

---

# 账本君数据窗口：6 个月 → 12 个月

## 需求
账本君（AI 聊天）此前只能读取近 6 个月数据，用户要求扩到 12 个月。

## 改动清单

| 文件 | 变更 |
|------|------|
| `cloudfunctions/finChat/index.js` | 用户画像聚合窗口 `-5`→`-11`（12 个月）；新增 `queryAll` 分页循环防超 1000 条上限漏数；**月均按有效月数算**（新用户数据不满窗口不被摊稀）；分类历史基线改前 11 个月、分母用「历史窗口内有支出月数」；prompt 与注释口径「近 6 个月」→「近 12 个月」 |
| `pages/index/index.js` | `trendStart`/`trendMonths` 扩到 12 个月（trend 数组全量透传给账本君，`formatDataForLLM` 输出「近12个月趋势」）；**趋势图 canvas 只画最近 6 个月**（`slice(-6)`），避免 12 组柱挤爆；注释同步 |

## 口径细节（关键决策）
- **有效月数均值**：`月均收入 = 收入总和 ÷ 有收入的月份数`（保底 1），而不是 ÷12。用户刚用 3 个月时月均显示真实值，不会被摊稀成 1/4。
- **历史基线不含本月**：「本月 vs 历史」对比的基线是 trend 前 11 个月，本月支出不计入，语义正确。
- **趋势图 vs 数据块分离**：canvas 视觉只画最近 6 个月（柱密可读），账本君拿到完整 12 个月。
- `query_summary`/`query_expenses`/`compare_months` 工具本就支持任意月份范围，未受限，无需改动。

## 验证
- `/tmp/verify_12m.js`：19 项断言全过（12 个月窗口生成、有效月数均值、分类基线分母、trend 切片、queryAll 分页 2300 条、用户真实数字口径）。
- 语法检查通过。

## 部署注意（重要）
- **云函数 `finChat` 必须重新部署才生效**：微信开发者工具中右键 `cloudfunctions/finChat` → 「上传并部署：云端安装依赖」。
- 画像有 **24h 缓存**（`aiProfiles` 集合）：部署后 24h 内对话仍用旧画像。想立刻生效，去云开发控制台删掉 `aiProfiles` 里自己的记录即可。

---

# 账本君亮点：今日指南（日均可花 + 连续记账）

## 需求
用户选定 P0 快赢中的 ① 日均可花卡片 与 ③ 连续记账，且明确要求 ① 必须考虑用户设置的**月预算**。

## 核心算法（utils/util.js 纯函数，可单测）

### calcDailyBudget —— 日均可花（双约束取更紧）
```
余额视角 = 可用余额 ÷ 距下次发薪天数      # 钱要花到下次发薪日
预算视角 = 本月剩余预算 ÷ 本月剩余天数    # 别超用户设的月预算
日均可花 = min(余额视角, 预算视角)
```
- 效果：历史结转的「大余额」不会撑高日均可花（预算兜底）；余额紧张时也不会按预算上限花（余额兜底）。
- 边界：今天发薪日 → 显示「今天是发薪日」；结果为 0/负 → clamp 0 并提示「可用余额不足」或「本月预算已用完」；未设预算 → 只按余额视角。

### calcStreak —— 连续记账（多邻国式留存钩子）
- 今天已记 → 包含今天；今天未记 → 从昨天起算（不打断，今天未结束）。
- 断档日即停止。

## 改动清单

| 文件 | 变更 |
|------|------|
| `utils/util.js` | 新增 `calcDailyBudget` / `calcStreak` 两个纯函数并导出 |
| `pages/index/index.js` | `loadData` 计算 daily/streak（仅当前月）；`_buildAiStmt` 附带 `dailyBudget`/`streakDays` 供账本君回答 |
| `pages/index/index.wxml` | 看板卡下方新增「今日指南」两列卡片（日均可花 + 连续记账），仅当前月显示 |
| `pages/index/index.wxss` | `.daily-card` 系列样式（DIN 数字、金色/红色/中性态、竖分割线） |

## 验证
- `/tmp/verify_daily.js`：15 项断言全过（预算约束/无预算/发薪日/预算超/余额负/月末/跨年 + streak 今天已记/未记/断档/空/去重）。
- 用户真实数据模拟（9/1，可用 ¥13,516.67，预算 ¥4,000）：
  - 9/1 未记账：日均可花 **¥133.33**，副文案「距发薪 14 天 · 预算剩 ¥4,000.00」——预算约束生效，余额大也不虚高
  - 9/5 已花 ¥800：**¥123.08**，「距发薪 10 天 · 预算剩 ¥3,200.00」
  - streak 12 天：显示「已连续记账 12 天」

## 后续注意
- streak 复用 `cumExpenses`（近 36 个月）按最近 90 天过滤，**零额外云函数调用**。
- 查看历史月份时卡片自动隐藏（语义基于「今天」），切回当前月恢复。
- 建议后续：日均可花跌破阈值时让账本君在聊天里主动提醒（可挂到 remind 云函数）。

---

# 结余口径澄清与标签修复

## 问题
用户截图反馈：2026年8月看板「收入才 ¥10,827，可用余额却 ¥13,516」，认为结余算错了。

## 结论
**数字正确，是 UI 标签口径不清导致的误解。**

- 收入/支出两列只展示**当月**数字。
- 可用余额 = 历史结转 + 本月收入 − 本月支出，是**累计值**。
- 截图验算：`9,000 + 10,827.19 − 6,310.52 = 13,516.67`，完全一致。

## 改动

| 文件 | 变更 |
|------|------|
| `pages/index/index.wxml` | 「含上月结转」→「含历史结转」；「收入/支出」→「本月收入/本月支出」 |
| `pages/index/index.js` | `earliestMonth` 保底回溯 36 个月，防止先记支出后记工资时漏算；加 999 条上限 warn |
| `pages/index/index.js` | 分享卡片文案同步改「可用余额」、公式改「结转 + 收入 − 支出 = 可用」 |
| `pages/index/index.js` | `_buildAiStmt` 新增 `available` 字段，供 AI 回答「还剩多少钱」 |

## 后续注意
- 若某月历史结转本身为负（以前超支），会显示「含历史结转 −¥X」，属正常。
- 区间支出查询若接近 1000 条上限，控制台会打 warn，长期重度用户需关注。

---

# 2026-09-01 · 首页加载性能优化（方案A：分阶段加载）

## 问题
每次进入首页等待 2-4 秒。根因：`loadData` 串行 6 次云函数调用——5 个并行（用户/卡片/工资/本月支出/12个月区间）+ 1 个**顺序阻塞**的 36 个月累计支出大查询，首屏被最慢一环卡死。

## 方案
拆成两阶段，最慢的查询移出首屏关键路径：

- **阶段1（首屏，5 查全并行）**：立即渲染看板、待还、预算预警、趋势图、日均可花。可用余额先用 12 个月窗口内的支出近似（收入来自全量工资，精确）。
- **阶段2（后台补查）**：仅当记账起点早于 12 个月窗口时，补查「缺口区间 [earliestMonth, trendStart 前一月]」修正余额——**不与已取回的 12 个月数据重叠**，读流量也降为原来的 2/3 以下。多数用户缺口为空，查询秒回、数字无变化。

配套改动：
- **竞态保护**：`_loadSeq` 序号，切月/下拉刷新并发时丢弃旧轮次晚到的阶段2结果。
- **动画冲突处理**：阶段2修正余额时先取消阶段1的 `animateNumber` 再重放，防止动画帧覆盖修正值。
- **骨架屏**：board 未就绪时显示灰色呼吸条占位，替代空白等待。

## 改动文件

| 文件 | 变更 |
|------|------|
| `pages/index/index.js` | `loadData` 分阶段重构 + `_loadSeq` 竞态保护 + 阶段2补查修正（余额/结转/日均可花联动更新） |
| `pages/index/index.wxml` | 看板卡片加 `wx:if="{{!board}}"` 骨架屏占位 |
| `pages/index/index.wxss` | 骨架屏样式（`sk-pulse` 呼吸动画，深浅主题通用） |

## 验证
`/tmp/verify_staged.js` 同构脚本 21 项断言全过：新旧算法在「支出全在12个月内 / 有13-36个月前支出 / 超长历史 / 查看历史月 / 无工资用户」5 种数据分布下可用余额**完全一致**；缺口区间边界、竞态丢弃、修正方向（只会下修）均验证。

## 预期效果
- 首屏时间 ≈ 5 个并行查询中**最慢一个**的耗时（原来要再叠加一次顺序大查询，约减半）。
- 切 Tab 回来（60s 缓存内）依旧秒开。

## 部署
纯前端改动，**无需部署云函数**，微信开发者工具重编译 + 上传体验版即可生效。

## 后续迭代（未做）
- 方案B：`dbRead` 加 `batchHomeRead` 合并 5 查为 1 次调用，进一步压冷启动开销。
- 方案C：`users` 文档维护累计收支快照字段，彻底消灭区间大查询。

---

# 2026-09-01 · 首页加载优化（方案B：批量读 + 方案C：月度支出快照）

## 背景
方案A（分阶段加载）后仍有优化空间：onShow 每次都 force 重查 → 每次进首页 5 次云函数调用 + 降级时还有阶段2 缺口补查。

## 方案B：云函数批量读
`dbRead` 新增 `batchHomeRead` action：5 查（用户/工资/卡片/本月支出/12月区间支出）在**服务端** Promise.all 并行，客户端 1 次云函数调用拿全。冷启动只发生一次，网络往返从 5 次降为 1 次。

- 前端 `db.js` 新增 `batchHomeRead(month, startMonth, force, reconcile)`：60s 缓存 + **回填 5 个单项缓存**（其他页面随后零额外云调用）
- **优雅降级**：云端未部署新版时（BAD_ACTION）自动退回 5 个单项读，功能不受影响（先发前端也不会白屏）

## 方案C：月度支出快照（users.expAgg）
`users` 文档新增 `expAgg = { 'YYYY-MM': 支出合计 }` 聚合快照：

- **对账**：快照缺失（老用户首次）或 `reconcile=true`（下拉刷新）时，云函数全量扫描 expenses 按月聚合、回写 users；响应始终带上算好的快照
- **增量维护**：所有支出写路径（记一笔/删除/恢复/销毁/固定支出落账/标记已还）在 `db.js` 统一增量 ±快照，日常读写零全量扫描
- **首页精确计算**：`cumExpense = Σ expAgg[月 ≤ 查看月]`——任意历史月精确，**阶段2 缺口大查询彻底消灭**
- **自愈**：增量更新失败仅 warn 不阻塞；首页每次加载做「快照 vs 12个月实拉数据」漂移检测（差 ≥1 分告警）；下拉刷新 = 全量对账修复

## 改动文件

| 文件 | 变更 |
|------|------|
| `cloudfunctions/dbRead/index.js` | 新增 `aggregateAllExpenses`（分页聚合）+ `batchHomeRead`；`_v` 3→4 |
| `utils/db.js` | 新增 `batchHomeRead`（缓存回填+降级）+ `bumpExpAgg`（增量维护）+ `_userSnapRef` 写引用；接入 6 个写路径 |
| `pages/index/index.js` | `loadData(force, reconcile)`：单次批量读；快照精确算累计支出；阶段2 仅降级路径保留；漂移检测 warn |

## 验证
`/tmp/verify_bc.js`：**真实 db.js + 真实 dbRead 云函数代码 + mock 数据库全链路**，52 项断言全过——批量读查询模式、快照对账/回写/失败容忍、1500 条分页聚合、缓存回填零重复调用、降级路径、10 种写路径增量一致性、历史月精确性、漂移阈值。测试还抓出并修复了一个真 bug（降级 fallback 解构顺序错位导致工资/卡片数据对调）。

## 预期效果
- 每次进首页：**1 次云函数调用**（原 5 次）≈ 首屏时间降为单次往返 + 服务端并行查询
- 快照命中后无任何区间大查询；增量维护失败可自愈
- 云开发读额度消耗降为原来的 1/5 左右

## 部署（顺序重要）
1. **先部署云函数**：微信开发者工具 → cloudfunctions/dbRead → 右键「上传并部署：云端安装依赖」
2. 再编译小程序 + 上传体验版（忘了先部署也不会坏：自动降级 + 控制台版本告警提醒）

---

# 2026-09-01 · 分类预算入口迁移 + 账单弹框分类精简

## 问题
分类预算设置藏在记账页「本月账单」弹框的分类行里（点 +预算），入口太深；且账单弹框把全部 7 个分类都列出来，零消费的分类占了一排排空行。

## 改动

### 1. 我的页面：分类预算正式入口
- 「偏好设置」组新增「分类预算」行，右侧显示已设数量（已设 N 项 / 去设置）
- 点击弹**分类预算列表 sheet**：全部 7 个分类（含还款），每行显示本月已花 + 预算 chip（未设虚线引导 / 已设金色 / 超支红色·超）
- 点某分类弹**预算编辑 sheet**（与账单弹框同款交互）：本月已花 · 剩余 + 金额输入 + 清除预算
- 保存走 `dbApi.updateMyUser({ budgets })`，同步 globalData；列表行本地刷新，不重查云（本月已花走 60s 缓存，通常零额外云调用）

### 2. 账单弹框：分类只展示有消费的
`_buildStatementData` 分类列表 `.filter(c => c.amount > 0)`——按金额而非四舍五入的百分比过滤，极小额（占比 <0.5%）不漏。账单内已展示分类的预算 chip 仍可点击修改（顺手入口）；超支判断、AI 解读不受影响。

## 改动文件

| 文件 | 变更 |
|------|------|
| `pages/my/my.wxml` | 偏好设置组入口行 + 分类预算列表 sheet + 单分类编辑 sheet |
| `pages/my/my.js` | `openCatBudgets/_buildCatBudgetRows/onCatRowTap/_updateCatBudget` 等方法组；`catBudgetSetCount` 展示 |
| `pages/my/my.wxss` | 列表行/预算 chip/编辑弹层样式（视觉与账单 sheet 一致） |
| `pages/expenses/expenses.js` | 账单分类过滤 `amount > 0` + 注释更新 |

## 验证
`/tmp/verify_budget_entry.js` 18 项断言全过：过滤规则（含极小额不漏、零消费剔除）、列表行构建（聚合/超支判定/无分类流水归其他）、保存/清除预算（budgets map 增删、已设计数、行内刷新）、编辑弹框剩余金额计算。`node --check` 两个 JS 文件通过。

## 部署
纯前端改动，无需部署云函数——开发者工具重编译 + 上传体验版即可。

---

# 2026-09-01 · 账单弹框结余改为可用余额（累计口径）

## 问题
9月1日打开「本月账单」弹框，本月结余显示 ¥0.00。因为工资15号发，自然月口径下9月收入为0，但8月15日发的工资剩余应结转到9月——和首页看板口径不一致。

## 改动

账单弹框顶部数字从自然月口径改为**滚动结转口径**（与首页看板一致）：
- **可用余额** = 截至查看月末全部收入 − 全部支出
- **累计收入** / **累计支出** / **累计储蓄率**
- 可用余额下方加小字「含历史结转 ¥xxx」（当结转 > 0 时）

**关键设计**：AI 解读（`loadStatement` → 云函数/兜底模板）依赖自然月口径的 `stmt.income/expense/balance`，**不能破坏**。因此累计口径**另起字段**存储：
- `loadData` setData：新增 `_stmtCumIncome` / `_stmtCumExpense` / `_stmtAvailable` / `_stmtCumSavingsRate`
- `_buildStatementData` 返回对象：原始数字（`income`/`expense`/`balance`/`savingsRate`）= 自然月（给 AI）；展示字符串（`incomeText`/`expenseText`/`balanceText`/`savingsRateText`）= 累计（给 WXML）

累计支出来源：`user.expAgg` 快照按月求和（零额外云调用）；快照缺失时降级用本月近似并控制台 warn。

## 改动文件

| 文件 | 变更 |
|------|------|
| `pages/expenses/expenses.js` | `loadData` 增加累计口径计算 + `_monthIncomeNum` 缓存；`_buildStatementData` 自然月/累计口径分离 |
| `pages/expenses/expenses.wxml` | 标签「本月结余」→「可用余额」、「收入」→「累计收入」、「支出」→「累计支出」；加 `carriedOverText` 小字 |
| `pages/expenses/expenses.wxss` | `.stmt-carry-hint` 结转小字样式 |

## 验证
`/tmp/verify_stmt_balance.js` 23 项断言全过：发薪日前结余、历史月查看、无工资用户、多月数据、快照缺失降级、收支相等无结转。

## 部署
纯前端改动，无需部署云函数——开发者工具重编译 + 上传体验版即可。打开记账页 → 查看本月账单，顶部应显示「可用余额」而非「本月结余」，且数字与首页看板一致。

---

# 2026-09-01 · 消费日历 + 固定支出迁移到「我的」页 + 分类占比隐藏

## 问题
记账页流水列表被压到最底部，用户很难发现。根因：页面塞了消费日历、分类占比、固定支出三个非核心模块，把流水挤下去了。

## 改动

### 1. 消费日历 →「我的」页
- **记账页移除**：入口卡片、热力图弹层、单日详情弹层、全部 data 字段、模块级函数（buildHeatmapCells 等）、Page 方法、wxss 样式
- **我的页新增**：入口卡片（资产组之后）、完整弹层（热力图 + 单日）、模块级函数、data 字段、onShow 加载 `_loadHeatmapPreview`、方法组、wxss 样式

### 2. 每月固定支出 →「我的」页
- **记账页移除**：入口卡片、管理弹层、添加表单弹层、管理相关 data（showRecur/showRecurForm/rName 等）、全部 Page 方法、wxss 样式
- **记账页保留**：`recurList` / `recurTotal` / `recurCount`（账单弹框仍需展示固定支出合计）
- **我的页新增**：入口卡片（消费日历之后）、管理弹层、添加表单弹层、data 字段、`loadRecurring` 方法（onShow 调用）、完整方法组、wxss 样式

### 3. 分类占比无消费时隐藏
`expenses.wxml` 分类占比 card 加 `wx:if="{{monthTotal !== '0.00'}}"`——当月完全没有消费时整个模块不展示，避免空行占位。

## 改动文件

| 文件 | 变更 |
|------|------|
| `pages/expenses/expenses.wxml` | 移除消费日历入口/弹层、固定支出入口/弹层；分类占比加条件 |
| `pages/expenses/expenses.js` | 移除热力图模块级函数 + data + 方法；移除固定支出管理 data + 方法；保留 recurList 供账单弹框 |
| `pages/expenses/expenses.wxss` | 移除全部 heatmap + recur 样式 |
| `pages/my/my.wxml` | 新增消费日历入口/弹层、固定支入口/弹层 |
| `pages/my/my.js` | 新增 buildHeatmapCells 等模块级函数、data 字段、loadRecurring、全部管理方法 |
| `pages/my/my.wxss` | 新增 heatmap + recur 完整样式 |

## 验证
`/tmp/verify_migration.js` 35 项断言全过——记账页「不应有」+ 我的页「应有」双重检查；`node --check` 通过。

## 部署
纯前端改动，无需部署云函数——开发者工具重编译 + 上传体验版即可。

## 页面结构变化

**记账页（改造后）**：
1. 月度总览 + 预算进度
2. 分类占比（有消费时才展示）
3. **流水列表**（终于上浮到可见区域）

**我的页（改造后）**：
1. 用户资料卡
2. 资产（信用卡管理）
3. **消费日历**（新增）
4. **每月固定支出**（新增）
5. 提醒（还款提醒、账本君主动询问）
6. 偏好设置（发薪日、预算、分类预算、隐私锁）
7. 数据（回收站、重置）
