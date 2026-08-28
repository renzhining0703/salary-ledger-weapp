const dbApi = require('../../utils/db')

const NAVY = '#14304F'
const GOLD = '#C8A04D'
const GRID = '#D8DFE7'
const ERR = '#C94040'

Page({
  data: {
    mode: 'verify',        // verify: 解锁 | set: 设置新图案
    lockType: 'none',      // gesture | finger | none
    setStepTitle: '绘制解锁图案',
    fingerTip: '请验证设备指纹'
  },

  /* 手势状态（非渲染数据，存实例上） */
  // _canvas / _ctx / _size: 画布
  // _centers: 9 个圆心 [{x, y}]
  // _selected: 已选点索引
  // _touching: 是否按下
  // _setFirst: 设置模式第一次绘制的图案

  onLoad(options) {
    this._mode = options.mode || 'verify'
    this.setData({ mode: this._mode })
    this.init()
  },

  async init() {
    const app = getApp()
    await app.ready()
    const user = await dbApi.getMyUser()

    if (this._mode === 'set') {
      // 设置流程固定用手势
      this.setData({ lockType: 'gesture', setStepTitle: '绘制解锁图案' })
      this.initGesture()
      return
    }

    const type = (user && user.privacyLock) || 'off'
    if (type === 'off') {
      // 未启用（或配置丢失），直接回首页
      wx.switchTab({ url: '/pages/index/index' })
      return
    }
    if (type === 'finger') {
      this.setData({ lockType: 'finger' })
      // 进入即自动拉起一次指纹验证
      setTimeout(() => this.startFingerAuth(), 300)
      return
    }
    this.setData({ lockType: 'gesture' })
    this.initGesture()
  },

  /* ---------------- 手势锁 ---------------- */

  async initGesture() {
    // 等画布节点就绪
    await new Promise((r) => setTimeout(r, 50))
    const query = this.createSelectorQuery()
    const res = await new Promise((resolve) => query.select('#gestureCanvas').fields({ node: true, size: true }).exec(resolve))
    if (!res[0] || !res[0].node) return
    const canvas = res[0].node
    const W = res[0].width
    const dpr = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).pixelRatio || 2
    canvas.width = W * dpr
    canvas.height = W * dpr
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    this._canvas = canvas
    this._ctx = ctx
    this._size = W
    this._selected = []
    this._touching = false
    // 3x3 圆心
    this._centers = []
    const cell = W / 3
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        this._centers.push({ x: cell * c + cell / 2, y: cell * r + cell / 2 })
      }
    }
    this._rect = null
    this.drawGesture(null)
  },

  /** 绘制：选中点深蓝、线金色；touchPos 为当前触点（画跟随虚线） */
  drawGesture(touchPos, errMode) {
    const ctx = this._ctx
    const size = this._size
    if (!ctx) return
    ctx.clearRect(0, 0, size, size)
    const lineColor = errMode ? ERR : GOLD
    const dotColor = errMode ? ERR : NAVY

    // 连线（含触点跟随）
    const sel = this._selected || []
    if (sel.length) {
      ctx.strokeStyle = lineColor
      ctx.lineWidth = 4
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      let started = false
      sel.forEach((idx) => {
        const p = this._centers[idx]
        if (!started) { ctx.moveTo(p.x, p.y); started = true } else ctx.lineTo(p.x, p.y)
      })
      if (touchPos && this._touching) ctx.lineTo(touchPos.x, touchPos.y)
      ctx.stroke()
    }

    // 圆点
    this._centers.forEach((p, i) => {
      const isSel = sel.indexOf(i) >= 0
      ctx.beginPath()
      ctx.arc(p.x, p.y, isSel ? 14 : 10, 0, Math.PI * 2)
      if (isSel) {
        ctx.fillStyle = dotColor
        ctx.fill()
        ctx.strokeStyle = lineColor
        ctx.lineWidth = 3
        ctx.stroke()
      } else {
        ctx.fillStyle = GRID
        ctx.fill()
      }
    })
  },

  async onTouchStart(e) {
    if (!this._ctx) await this.initGesture()
    if (!this._ctx) return
    // 记录画布在页面中的位置（touch 坐标是页面级）
    if (!this._rect) {
      const q = this.createSelectorQuery()
      const r = await new Promise((resolve) => q.select('#gestureCanvas').boundingClientRect(resolve))
      if (r) this._rect = r
    }
    this._selected = []
    this._touching = true
    this.hitTest(e)
  },

  onTouchMove(e) {
    if (!this._touching) return
    this.hitTest(e)
  },

  async onTouchEnd() {
    if (!this._touching) return
    this._touching = false
    this.drawGesture(null)
    const pattern = this._selected || []
    if (pattern.length < 4) {
      if (pattern.length) {
        wx.showToast({ title: '至少连接 4 个点', icon: 'none' })
        await this.flashError()
      }
      this._selected = []
      this.drawGesture(null)
      return
    }
    if (this.data.mode === 'set') {
      this.handleSetStep(pattern)
    } else {
      this.handleVerify(pattern)
    }
  },

  /** 触点 → 画布坐标 → 命中测试 */
  hitTest(e) {
    const t = e.touches && e.touches[0]
    if (!t || !this._rect) return
    const x = t.clientX - this._rect.left
    const y = t.clientY - this._rect.top
    const R = this._size / 6 // 命中半径 = 六分之一画布宽
    let hit = -1
    let minD = R
    this._centers.forEach((p, i) => {
      const d = Math.sqrt((p.x - x) * (p.x - x) + (p.y - y) * (p.y - y))
      if (d < minD) { minD = d; hit = i }
    })
    if (hit >= 0 && this._selected.indexOf(hit) < 0) {
      this._selected.push(hit)
    }
    this.drawGesture({ x, y })
  },

  /** 校验模式：与已存图案比较 */
  async handleVerify(pattern) {
    const app = getApp()
    const user = app.globalData.user || await dbApi.getMyUser()
    const saved = (user && user.gesturePattern) || []
    const same = saved.length === pattern.length && saved.every((v, i) => v === pattern[i])
    if (same) {
      wx.showToast({ title: '解锁成功', icon: 'success', duration: 400 })
      setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 350)
    } else {
      wx.showToast({ title: '图案不正确', icon: 'none' })
      await this.flashError()
      this._selected = []
      this.drawGesture(null)
    }
  },

  /** 设置模式：画两次确认 */
  async handleSetStep(pattern) {
    if (!this._setFirst) {
      this._setFirst = pattern
      this.setData({ setStepTitle: '再次绘制确认' })
      this._selected = []
      this.drawGesture(null)
      return
    }
    const same = this._setFirst.length === pattern.length && this._setFirst.every((v, i) => v === pattern[i])
    if (!same) {
      wx.showToast({ title: '两次不一致，请重新绘制', icon: 'none' })
      this._setFirst = null
      this.setData({ setStepTitle: '绘制解锁图案' })
      await this.flashError()
      this._selected = []
      this.drawGesture(null)
      return
    }
    // 保存：开启手势锁
    try {
      await dbApi.updateMyUser({ privacyLock: 'gesture', gesturePattern: this._setFirst })
      const app = getApp()
      if (app.globalData.user) {
        app.globalData.user = { ...app.globalData.user, privacyLock: 'gesture', gesturePattern: this._setFirst }
      }
      wx.showToast({ title: '隐私锁已开启', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 500)
    } catch (e) {
      console.error('保存隐私锁失败', e)
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
      this._setFirst = null
      this.setData({ setStepTitle: '绘制解锁图案' })
      this._selected = []
      this.drawGesture(null)
    }
  },

  /** 重绘（设置模式重新开始） */
  resetSet() {
    this._setFirst = null
    this._selected = []
    this.setData({ setStepTitle: '绘制解锁图案' })
    this.drawGesture(null)
  },

  /** 错误红闪 400ms 后清空 */
  flashError() {
    this.drawGesture(null, true)
    return new Promise((resolve) => setTimeout(resolve, 400))
  },

  /* ---------------- 指纹锁 ---------------- */

  startFingerAuth() {
    this.setData({ fingerTip: '请验证设备指纹' })
    const finish = (ok, msg) => {
      if (ok) {
        wx.showToast({ title: '解锁成功', icon: 'success', duration: 400 })
        setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 350)
      } else {
        this.setData({ fingerTip: msg || '验证失败，请重试' })
      }
    }
    if (!wx.checkIsSoterEnrolledInDevice || !wx.startSoterAuthentication) {
      finish(false, '当前微信版本不支持指纹验证，请升级微信')
      return
    }
    wx.checkIsSoterEnrolledInDevice({
      checkAuthMode: 'fingerprint',
      success: (res) => {
        if (!res.isEnrolled) {
          finish(false, '本机未录入指纹，请在手机系统设置中录入后重试')
          return
        }
        wx.startSoterAuthentication({
          requestAuthModes: ['fingerprint'],
          challenge: String(Date.now()),
          authContent: '解锁薪账本',
          success: () => finish(true),
          fail: (err) => {
            console.error('指纹验证失败', err)
            finish(false, '验证失败，请重试')
          }
        })
      },
      fail: () => finish(false, '本机不支持指纹验证，请在系统设置中录入后重试')
    })
  },

  quitLock() {
    // eslint-disable-next-line no-undef
    if (wx.exitMiniProgram) wx.exitMiniProgram({ fail: () => {} })
  }
})
