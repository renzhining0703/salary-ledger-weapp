// 分类/类型图标网格选择器（设计稿：记账页分类选择器设计稿.html 图标网格版）
// 4 列网格：emoji 图标（80×80rpx 圆角底）+ 分类名；选中态金色高亮 + 右上角勾标。
// 用法：<cat-grid items="{{categories}}" value="{{formCategory}}" bindchange="onCategoryTap" />
//   items 支持两种形态：字符串数组（如 CATEGORIES）或 { value, label } 对象数组（如 INCOME_SOURCES）
//   change 事件 detail = { value }，由父页面 setData 驱动选中态（受控组件）

/** 已知分类/收入类型的图标与色调映射；未收录的项回退 🏷️ + 中性灰底 */
const ICON_MAP = {
  // 支出分类
  '餐饮': { icon: '🍜', tone: 'gold' },
  '交通': { icon: '🚇', tone: 'navy' },
  '购物': { icon: '🛍️', tone: 'danger' },
  '孩子': { icon: '🧸', tone: 'success' },
  '居住': { icon: '🏠', tone: 'warn' },
  '还款': { icon: '💳', tone: 'danger' },
  '其他': { icon: '📦', tone: 'text' },
  // 收入类型
  '主业': { icon: '💼', tone: 'gold' },
  '副业': { icon: '🚀', tone: 'navy' },
  '年终奖/奖金': { icon: '🏆', tone: 'warn' },
  '红包/礼金': { icon: '🧧', tone: 'danger' },
  '理财收益': { icon: '📈', tone: 'success' },
  '其他收入': { icon: '💰', tone: 'text' }
}

Component({
  properties: {
    /** 选项列表：['餐饮', ...] 或 [{ value: 'main', label: '主业' }, ...] */
    items: {
      type: Array,
      value: []
    },
    /** 当前选中值（受控：父页面 change 后 setData 回写） */
    value: {
      type: String,
      value: ''
    }
  },

  data: {
    rows: [] // [{ value, label, icon, tone }]
  },

  observers: {
    items(list) {
      const rows = (list || []).map((it) => {
        const isObj = !!it && typeof it === 'object'
        const label = isObj ? (it.label || it.value) : it
        const value = isObj ? (it.value || it.label) : it
        const meta = ICON_MAP[label] || ICON_MAP[value] || {}
        return {
          value,
          label,
          icon: meta.icon || '🏷️',
          tone: meta.tone || 'text'
        }
      })
      this.setData({ rows })
    }
  },

  methods: {
    onTap(e) {
      const value = e.currentTarget.dataset.value
      if (value === this.data.value) return
      this.triggerEvent('change', { value })
    }
  }
})
