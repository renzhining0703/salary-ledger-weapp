# 2026-09-01 · 架构评审 5 项修复

依据《薪账本架构评审报告.md》修复 5 个问题，31 项静态断言全过（`scripts/verify-arch-fixes.js`），6 个改动文件语法全绿。

## 1. P0-1｜AI 记账导致历史月余额漂移（expAgg 双写同步）

- **finChat `executeAddExpense`**：写库 + 验证通过后，新增 `bumpExpAgg(openid, month, amount)`——子文档路径 `expAgg.YYYY-MM` + `_.inc` 原子自增；快照未回填（从未对账）时跳过，交给下拉刷新 reconcile 全量修复，语义与前端完全一致
- **前端 `utils/db.js bumpExpAgg`**：从「读本地快照 → 整表覆盖写」同步改为 `_.inc` 原子自增——原写法会把云端 AI 记账刚加的增量抹掉，这是双路径竞态的另一半根因
- `addSalary` 不维护 expAgg（该快照只聚合支出）；撤销链路走前端 `removeExpense`，已有 `_.inc(-amount)` 扣减

## 2. 会话服务端持久化（chatLogs 云集合）

- **存储**：每用户一条文档 `{ _openid, logs: [{ q≤80字, a≤200字, ts, mode }] }`，LRU 上限 40 条（约 20 轮），每次问答仅 1 次 update，控写入量
- **写入**：finChat 成功回答后（普通问答 + 工具记账两条路径）`saveChatLog` 落摘要
- **恢复**：前端本地 lastSession 为空（换设备/清缓存）时，云端 `loadCloudLastSession` 取最近 8 条摘要还原为【上次对话结尾】→ AI 跨设备不失忆
- **清空**：`action='clearChatLogs'` 动作分支；组件「清空会话」经 `aiChat.clearCloudSession()` 同步清云端，AI 也不再"记得"已删对话

## 3. formatQueryAnswer 模板感 → 低成本润色

新增 `polishAnswer(rawText, openid, budget)`，查询/对比工具拼出确定性答案后追加一次 LLM 润色。安全阀（504003 红线内）：

- system prompt 钉死「所有数字原样保留、不得新增信息」
- max_tokens 260、temperature 0.7、**4.5s 硬超时**
- 润色结果比原文膨胀 30 字以上（复读/加戏）→ 回退模板
- 当日 token 已用超预算 80% → 跳过润色（熔断让路）
- 任何失败/超时 → 原样返回模板答案，绝不拖垮主链路

最坏耗时账：LLM1 10s + 查库 5s + 润色 4.5s ≈ 20s < 云函数 30s 超时。

## 4. LLM 成本熔断（日 token 计数 + 超限降级）

- **集合**：`finChatCounters` 每用户一条 `{ _openid, date, tokens }`，date 跨天自动重置（无需定时任务）
- **计数**：`callDeepSeek` 增加 openid 参数，所有 LLM 调用（主调用/记账兜底重试/失败语/润色）的 `usage.total_tokens` 经 `trackTokens` 用 `_.inc` 累计
- **熔断**：入口 `checkTokenBudget`，超 `LLM_DAILY_TOKEN_LIMIT`（默认 120k，环境变量可覆盖）返回 `COST_LIMIT`
- **降级**：前端 aiChat.js 收到 COST_LIMIT 走 finTemplate 本地模板（与 NO_KEY/超时同兜底），次日自动恢复
- 集合未创建/计数失败一律静默放行，熔断永不阻塞主流程

## 5. 首页 onShow 脏标记（省云调用）

- `db.js invalidate()`（所有写操作的必经入口）置 `globalData.dataDirty = true`
- 首页 onShow 改为 `loadData(dirty)`：**仅脏时 force 全量重查，否则吃 60s TTL 缓存**（命中时 0 云调用）——切 tab 回首页不再每次重查
- 脏标记先复位再加载：加载失败时缓存已被 invalidate 清空，下次 onShow 缓存 miss 自然重查，不会卡旧数据
- 两个例外保持显式 force：chat refresh 事件（AI 云端写库不经 dbApi）、下拉刷新（force + reconcile 对账）

## 改动文件

| 文件 | 改动 |
|---|---|
| `cloudfunctions/finChat/index.js` | P0-1 bump、chatLogs 读写/清空、polishAnswer、token 熔断全套 |
| `utils/db.js` | invalidate 置脏标记；bumpExpAgg 改 `_.inc` 原子自增 |
| `utils/aiChat.js` | COST_LIMIT 降级分支；clearCloudSession 导出 |
| `components/ai-chat-sheet/ai-chat-sheet.js` | 清空会话同步清云端 |
| `pages/index/index.js` | onShow 脏标记条件 force |
| `scripts/verify-arch-fixes.js` | 新增，31 项断言 |

## 部署清单（3 步）

1. 微信开发者工具重新上传部署 `cloudfunctions/finChat`
2. 云开发控制台创建集合 **`chatLogs`**、**`finChatCounters`**，权限均设「仅创建者可读写」（未创建时对应功能静默跳过，不报错）
3. 小程序重新编译（体验版重新上传）

## 遗留提醒

- 集合创建后建议观察 1-2 天：chatLogs 单文档体积（40 条摘要远小于 512KB 限制，安全）、finChatCounters 日均 token 消耗，再决定是否收紧 120k 预算
- 旧的 `scripts/verify-chat-sheet.js` / `verify-feed-c89.js` 校验旧结构，仍是待删状态
