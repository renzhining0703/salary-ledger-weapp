# 固定支出弹框文字遮挡修复（v2）

## 问题

用户反馈：我的 → 每月固定支出弹框中，文字仍只显示一半，底部留有大片空白。

## 第一轮根因（已修复但不彻底）

滚动穿透修复时把固定支出列表包进了原生 `scroll-view.sheet-scroll`，但 `.sheet-scroll` 只设了 `max-height: 56vh`，没有给出确定高度；于是先做了一轮 flex 布局改造。

## 第二轮真因（本轮修复）

用无头 Chrome 复刻弹框 DOM 后发现：**微信 WebView 里的 `scroll-view` 竖向滚动要求父级给出「固定高度」**。`flex:1 + max-height:56vh` 不能让内部滚动容器拿到确定高度——内部容器被内容撑到 1769px，被外层 `overflow:hidden` 裁掉，于是文字只能露一半且滚不动。

复现结果（iPhone X 375×812 视口，6 条固定支出）：

| 方案 | 外层高度 | 内部滚动容器高度 | 可滚动？ |
|---|---|---|---|
| A 现状 `flex:1 + max-height` | 432px | 1769px（未裁剪） | ❌ |
| B `flex:1 1 auto` | 432px | 1769px | ❌ |
| C 外包 wrapper | — | 1769px | ❌ |
| D **定高 `height:56vh`** | 432px | 432px | ✅ |

只有 **D 方案** 让内部滚动容器高度等于外层高度，并且 `scrollable=true`。

## 修复

### 1. `app.wxss`

```css
.sheet-scroll {
  /* 必须给 scroll-view 固定高度；max-height / flex 分配值
     不能让内部滚动容器拿到确定高度，会导致内容被裁且不能滚 */
  height: 56vh;
}
```

保留：
- `.sheet` 为 `display: flex; flex-direction: column; overflow: hidden;`
- `.sheet-title` / `.sheet-actions` 为 `flex-shrink: 0`

### 2. `pages/expenses/expenses.wxss`

记一笔弹框的 `.form-scroll` 也是同样结构，同步改成固定高度：

```css
.form-scroll {
  height: 62vh;
}
```

## 验证

- `scripts/verify-scroll-lock.js` 60 项断言全过：
  - 34 个弹层 `catchtouchmove` 拦截完整
  - 固定支出/当日明细使用 `.sheet-scroll`
  - 记一笔使用 `.form-scroll`
  - `.sheet-scroll` 为 `height: 56vh`
  - `.form-scroll` 为 `height: 62vh`
- 无头 Chrome 复现对比截图：`scripts/sheet-compare.png`

## 部署

前端重编译，并**重新上传体验版**（或真机预览）才能生效。

## 影响

- 固定支出弹框、当日明细弹框、记一笔弹框，在内容较少时会出现固定高度的空白区域（如只有 1-2 项时）；但可以保证文字不被遮挡、可滚动。
- 后续若想按内容自适应高度，需要改成 JS 测量内容后动态设置 `scroll-view` 的 `height`。

## 新增/修改文件

- `app.wxss`：`.sheet-scroll` 改为固定高度 `56vh`
- `pages/expenses/expenses.wxss`：`.form-scroll` 改为固定高度 `62vh`
- `scripts/verify-scroll-lock.js`：断言改为检查固定高度
- `scripts/tmp-sheet-test.html` / `tmp-sheet-test.js` / `tmp-sheet-compare.png`：复现对比用临时文件（可删）
- `.workbuddy/memory/2026-09-02.md`：修复记录
