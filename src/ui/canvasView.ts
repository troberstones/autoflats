export type Tool = 'pan' | 'fill' | 'barrier' | 'eraser' | 'merge' | 'dmerge' | 'delfill' | 'group' | 'shape' | 'pick'
// Press-to-release travel, in client px, below which a drag still counts as a
// click rather than a stroke or a box-select.
const MOVE_SLOP = 6
const STROKE_TOOLS: Tool[] = ['barrier', 'eraser', 'dmerge', 'group', 'shape']
const STROKE_COLORS: Record<string, string> = { barrier: '#39f', eraser: '#f66', dmerge: '#4f4', group: '#fc0', shape: '#fff' }

// A remembered edit, drawn back on the canvas so it can be picked and removed.
// Colours match the tool that made it, so the overlay reads as "here is the
// stroke you drew" rather than as a new kind of annotation.
export interface EditDraw { kind: 'merge' | 'delete' | 'group' | 'closure'; pts: number[]; selected: boolean }
// 'closure' is draw-only: an auto-sealed gap is not a user edit, so it is shown
// but never picked. Magenta, and NOT teal: the ridge overlay owns cyan, the two
// are routinely on together, and a colour that close made auto-closures and
// open ridges impossible to tell apart.
const EDIT_COLORS: Record<EditDraw['kind'], string> = { merge: '#4f4', delete: '#f66', group: '#fc0', closure: '#f2f' }

export class CanvasView {
  ctx: CanvasRenderingContext2D
  scale = 1
  ox = 0
  oy = 0
  rot = 0   // radians, applied about the image origin before the translation
  tool: Tool = 'pan'
  fills: HTMLCanvasElement | null = null
  lineCv: HTMLCanvasElement | null = null
  barrierCv: HTMLCanvasElement | null = null
  sagCv: HTMLCanvasElement | null = null
  ridgeCv: HTMLCanvasElement | null = null
  lineOpacity = 1
  showLines = false
  showSag = false
  showRidges = false
  showBarriers = true
  paths: number[][] = [] // gap-bridge suggestions, each a polyline [x0,y0,x1,y1,...]
  segFocus = -1
  edits: EditDraw[] = []
  showEdits = false
  imgW = 0
  imgH = 0
  onClick: ((x: number, y: number, e: PointerEvent) => void) | null = null
  onStroke: ((pts: number[]) => void) | null = null
  onBox: ((x0: number, y0: number, x1: number, y1: number, additive: boolean) => void) | null = null
  onCancel: (() => void) | null = null
  // The merge tool's first click, in image space, and the live cursor: drawn as
  // a rubber band so a half-finished merge is visible rather than being invisible
  // state you find out about by clicking somewhere unrelated.
  mergeAnchor: [number, number] | null = null
  shapePreview = 'rgba(255,255,255,0.35)'  // the colour a shape fill would land in
  private mergeCursor: [number, number] | null = null

  private space = false
  private panning = false
  private stroke: number[] | null = null
  private box: number[] | null = null // [x0,y0,x1,y1] in image space, pick tool
  private lx = 0
  private ly = 0
  private moved = false
  private autoFit = true // keep re-fitting on resize until the user zooms/pans
  // Touch navigates, it never draws (see the pointerdown handler). Live touches
  // are tracked so two of them can pinch; a pen or mouse never lands here.
  private touches = new Map<number, { x: number; y: number }>()
  private pinch: { d: number; a: number; cx: number; cy: number } | null = null

  constructor(public canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!
    const resize = () => {
      canvas.width = canvas.clientWidth * devicePixelRatio
      canvas.height = canvas.clientHeight * devicePixelRatio
      // A canvas starts at 300x150 and ResizeObserver fires asynchronously, so
      // an image opened before the first callback would be fitted to that
      // placeholder size and render as a stamp in the corner. Re-fit until the
      // user has actually zoomed or panned.
      if (this.autoFit) this.fit(); else this.render()
    }
    new ResizeObserver(resize).observe(canvas)

    canvas.addEventListener('wheel', e => {
      e.preventDefault()
      this.autoFit = false
      const f = Math.exp(-e.deltaY * 0.0015)
      const ns = Math.min(32, Math.max(0.03, this.scale * f))
      const r = canvas.getBoundingClientRect()
      const cx = (e.clientX - r.left) * devicePixelRatio, cy = (e.clientY - r.top) * devicePixelRatio
      this.ox = cx - (cx - this.ox) * (ns / this.scale)
      this.oy = cy - (cy - this.oy) * (ns / this.scale)
      this.scale = ns
      this.render()
    }, { passive: false })

    canvas.addEventListener('pointerdown', e => {
      // Before the capture: a right-click cancels what is half-finished and is
      // over immediately, so there is nothing to capture the pointer for.
      if (e.button === 2) { this.cancelPending(); return }
      // Capture is an optimisation -- it keeps a drag alive when the cursor
      // leaves the canvas -- and it throws for a pointer the browser does not
      // consider active. Unguarded, that throw took the whole handler with it
      // and the input stopped working entirely, so it must not be able to.
      try { canvas.setPointerCapture(e.pointerId) } catch { /* not capturable */ }
      this.moved = false
      this.lx = e.clientX; this.ly = e.clientY
      // Touch is navigation only: one finger pans, two pinch, and no tool ever
      // fires. A finger is far too imprecise to place a barrier or a merge, and
      // a tablet user has a pen for that -- which arrives as 'pen' and takes the
      // ordinary path below.
      if (e.pointerType === 'touch') {
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
        this.stroke = null; this.box = null
        if (this.touches.size >= 2) { this.panning = false; this.pinch = this.pinchState() }
        else this.panning = true
        return
      }
      if (e.button === 1 || this.space || this.tool === 'pan') { this.panning = true; return }
      if (this.tool === 'pick') {
        const [x, y] = this.toImage(e)
        this.box = [x, y, x, y] // a drag box-selects; a click falls through to onClick
        return
      }
      if (STROKE_TOOLS.includes(this.tool)) {
        const [x, y] = this.toImage(e)
        this.stroke = [x, y]
        this.render()
      }
    })
    canvas.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') {
        if (!this.touches.has(e.pointerId)) return
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (this.touches.size >= 2) { this.applyPinch(); return }
      }
      const dx = e.clientX - this.lx, dy = e.clientY - this.ly
      // 2px was too tight to click through: an ordinary hand tremor between
      // press and release passed it, `moved` latched, and the click was silently
      // dropped -- which is what made the merge tool feel like it ignored you.
      if (Math.abs(dx) + Math.abs(dy) > MOVE_SLOP) this.moved = true
      if (this.mergeAnchor && !this.panning) {
        this.mergeCursor = this.toImage(e)
        this.render()
      }
      if (this.panning) {
        this.autoFit = false
        this.ox += dx * devicePixelRatio
        this.oy += dy * devicePixelRatio
        this.lx = e.clientX; this.ly = e.clientY
        this.render()
      } else if (this.stroke) {
        const [x, y] = this.toImage(e)
        this.stroke.push(x, y)
        this.render()
      } else if (this.box) {
        const [x, y] = this.toImage(e)
        this.box[2] = x; this.box[3] = y
        this.render()
      }
    })
    const endTouch = (e: PointerEvent) => {
      if (!this.touches.delete(e.pointerId)) return false
      this.pinch = this.touches.size >= 2 ? this.pinchState() : null
      // Dropping to one finger resumes panning from where that finger is, so a
      // pinch that ends unevenly does not jump the image.
      const last = [...this.touches.values()][0]
      if (last) { this.panning = true; this.lx = last.x; this.ly = last.y }
      else this.panning = false
      return true
    }
    canvas.addEventListener('pointercancel', e => { endTouch(e) })
    canvas.addEventListener('pointerup', e => {
      if (e.pointerType === 'touch') { endTouch(e); return }
      if (this.panning) { this.panning = false; return }
      if (this.stroke) {
        const s = this.stroke
        this.stroke = null
        this.onStroke?.(s)
        return
      }
      if (this.box) {
        const b = this.box
        this.box = null
        this.render()
        if (this.moved) {
          this.onBox?.(Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3]), e.shiftKey)
          return
        }
        // barely moved: treat as an individual pick, handled by onClick below
      }
      // The merge tool tracks a rubber band between two clicks, so its second
      // click arrives after real cursor travel by design -- and a press-drag-
      // release onto the target has to land too.
      if ((!this.moved || this.tool === 'merge') && this.onClick) {
        const [x, y] = this.toImage(e)
        this.onClick(x, y, e)
      }
    })
    // Right-click is a cancel gesture here, so never let the browser menu eat it.
    canvas.addEventListener('contextmenu', e => e.preventDefault())
    // Clicking anywhere outside the canvas abandons a half-finished merge: the
    // rubber band would otherwise still be armed when you came back.
    addEventListener('pointerdown', e => {
      if (this.mergeAnchor && e.target !== canvas) this.cancelPending()
    }, true)
    addEventListener('keydown', e => { if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) { this.space = true; e.preventDefault() } })
    addEventListener('keyup', e => { if (e.code === 'Space') this.space = false })
  }

  // Cancel anything half-finished: an armed merge, a stroke, a selection box.
  cancelPending() {
    const had = !!(this.mergeAnchor || this.stroke || this.box)
    this.mergeAnchor = this.mergeCursor = null
    this.stroke = null
    this.box = null
    if (had) { this.render(); this.onCancel?.() }
  }

  private pinchState() {
    const [a, b] = [...this.touches.values()]
    const dx = b.x - a.x, dy = b.y - a.y
    return { d: Math.hypot(dx, dy) || 1, a: Math.atan2(dy, dx), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }
  }

  // Two fingers do all three at once: the separation sets the scale, the angle
  // between them sets the rotation, and the midpoint sets the position. Rather
  // than composing three transforms, take the image point currently under the
  // midpoint, apply the new scale and angle, then place that same image point
  // back under the midpoint's new position -- so the drawing stays stuck to the
  // fingers no matter which of the three the user is actually doing.
  private applyPinch() {
    const now = this.pinchState()
    const was = this.pinch
    this.pinch = now
    if (!was) return
    this.autoFit = false
    const r = this.canvas.getBoundingClientRect()
    const anchor = this.toImagePx((was.cx - r.left) * devicePixelRatio, (was.cy - r.top) * devicePixelRatio)
    this.scale = Math.min(32, Math.max(0.03, this.scale * (now.d / was.d)))
    // atan2 wraps at +-pi; normalise the delta so crossing that seam does not
    // spin the image half a turn.
    let da = now.a - was.a
    if (da > Math.PI) da -= 2 * Math.PI
    if (da < -Math.PI) da += 2 * Math.PI
    this.rot += da
    const nx = (now.cx - r.left) * devicePixelRatio, ny = (now.cy - r.top) * devicePixelRatio
    const c = Math.cos(this.rot) * this.scale, s = Math.sin(this.rot) * this.scale
    this.ox = nx - (anchor[0] * c - anchor[1] * s)
    this.oy = ny - (anchor[0] * s + anchor[1] * c)
    this.render()
  }

  toImage(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect()
    return this.toImagePx((e.clientX - r.left) * devicePixelRatio, (e.clientY - r.top) * devicePixelRatio)
  }

  // Canvas device pixels -> image space. Inverse of the render transform, which
  // is a rotation and a uniform scale, so the inverse is the transpose over s.
  private toImagePx(cx: number, cy: number): [number, number] {
    const dx = cx - this.ox, dy = cy - this.oy
    const c = Math.cos(this.rot), s = Math.sin(this.rot)
    return [(dx * c + dy * s) / this.scale, (-dx * s + dy * c) / this.scale]
  }

  // Put an image point in the middle of the viewport, whatever the rotation.
  centerOn(x: number, y: number) {
    this.autoFit = false
    const c = Math.cos(this.rot) * this.scale, s = Math.sin(this.rot) * this.scale
    this.ox = this.canvas.width / 2 - (x * c - y * s)
    this.oy = this.canvas.height / 2 - (x * s + y * c)
  }

  fit() {
    this.autoFit = true
    if (!this.imgW) return
    this.rot = 0 // fitting is a reset: an unexpected tilt is never what fit means
    const s = Math.min(this.canvas.width / this.imgW, this.canvas.height / this.imgH) * 0.95
    this.scale = s
    this.ox = (this.canvas.width - this.imgW * s) / 2
    this.oy = (this.canvas.height - this.imgH * s) / 2
    this.render()
  }

  render() {
    const { ctx, canvas } = this
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (!this.imgW) return
    const rc = Math.cos(this.rot) * this.scale, rs = Math.sin(this.rot) * this.scale
    ctx.setTransform(rc, rs, -rs, rc, this.ox, this.oy)
    ctx.imageSmoothingEnabled = this.scale < 1
    // checker
    ctx.fillStyle = '#3a3a3a'
    ctx.fillRect(0, 0, this.imgW, this.imgH)
    if (this.showLines) {
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, this.imgW, this.imgH)
      if (this.lineCv) ctx.drawImage(this.lineCv, 0, 0)
    } else if (this.showSag && this.sagCv) {
      // the height field replaces the fills; the art stays faintly on top so
      // you can see which valley belongs to what
      ctx.drawImage(this.sagCv, 0, 0)
      if (this.lineCv) {
        ctx.globalAlpha = 0.4 * this.lineOpacity
        ctx.drawImage(this.lineCv, 0, 0)
        ctx.globalAlpha = 1
      }
    } else {
      if (this.fills) ctx.drawImage(this.fills, 0, 0, this.imgW, this.imgH)
      if (this.lineCv) {
        ctx.globalAlpha = this.lineOpacity
        ctx.drawImage(this.lineCv, 0, 0)
        ctx.globalAlpha = 1
      }
    }
    if (this.ridgeCv && this.showRidges) ctx.drawImage(this.ridgeCv, 0, 0)
    if (this.barrierCv && this.showBarriers) {
      ctx.globalAlpha = 0.7
      ctx.drawImage(this.barrierCv, 0, 0)
      ctx.globalAlpha = 1
    }
    // Remembered edits, under the live stroke and the gap suggestions. Widths
    // are divided by the scale so they stay constant on screen at any zoom.
    if (this.showEdits && this.edits.length) {
      ctx.lineCap = ctx.lineJoin = 'round'
      for (const h of this.edits) {
        const col = EDIT_COLORS[h.kind]
        if (h.kind === 'delete') {
          const r = 7 / this.scale, x = h.pts[0], y = h.pts[1]
          ctx.beginPath()
          ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r)
          ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r)
          ctx.arc(x, y, r * 1.6, 0, 7)
          if (h.selected) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 6 / this.scale; ctx.stroke() }
          ctx.strokeStyle = col
          ctx.lineWidth = (h.selected ? 3 : 2) / this.scale
          ctx.stroke()
          continue
        }
        ctx.beginPath()
        ctx.moveTo(h.pts[0], h.pts[1])
        for (let i = 2; i < h.pts.length; i += 2) ctx.lineTo(h.pts[i], h.pts[i + 1])
        if (h.kind === 'group') {
          ctx.closePath()
          ctx.fillStyle = h.selected ? 'rgba(255,204,0,0.28)' : 'rgba(255,204,0,0.12)'
          ctx.fill()
        }
        if (h.selected) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 6 / this.scale; ctx.stroke() }
        ctx.strokeStyle = col
        ctx.lineWidth = (h.selected ? 3 : 2) / this.scale
        ctx.stroke()
      }
    }
    if (this.box) {
      const [x0, y0, x1, y1] = this.box
      ctx.setLineDash([6 / this.scale, 4 / this.scale])
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1.5 / this.scale
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
      ctx.setLineDash([])
    }
    if (this.stroke && this.stroke.length >= 2) {
      ctx.strokeStyle = STROKE_COLORS[this.tool] ?? '#39f'
      ctx.lineWidth = (this.tool === 'eraser' ? 12 : 3)
      ctx.lineCap = ctx.lineJoin = 'round'
      ctx.beginPath()
      ctx.moveTo(this.stroke[0], this.stroke[1])
      for (let i = 2; i < this.stroke.length; i += 2) ctx.lineTo(this.stroke[i], this.stroke[i + 1])
      if (this.tool === 'group' || this.tool === 'shape') {
        // both close on release: show the closing edge and the area they will
        // capture while the user is still drawing
        ctx.closePath()
        ctx.fillStyle = this.tool === 'shape' ? this.shapePreview : 'rgba(255,204,0,0.18)'
        ctx.fill()
      }
      ctx.stroke()
    }
    // Merge rubber band: anchored on the first click, following the cursor, in
    // the same green the finished merge is drawn in.
    if (this.mergeAnchor) {
      const [ax, ay] = this.mergeAnchor
      const [bx, by] = this.mergeCursor ?? this.mergeAnchor
      const r = 5 / this.scale
      ctx.setLineDash([7 / this.scale, 5 / this.scale])
      ctx.strokeStyle = '#4f4'
      ctx.lineWidth = 2 / this.scale
      ctx.beginPath()
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.arc(ax, ay, r, 0, 7)
      ctx.stroke()
    }
    // gap suggestions: white halo + orange curve, constant screen-space width
    if (this.paths.length) {
      ctx.lineCap = ctx.lineJoin = 'round'
      const rr = 5 / this.scale
      for (let pi = 0; pi < this.paths.length; pi++) {
        const p = this.paths[pi]
        const focused = pi === this.segFocus
        const poly = () => {
          ctx.beginPath()
          ctx.moveTo(p[0], p[1])
          for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1])
          ctx.stroke()
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.95)'
        ctx.lineWidth = (focused ? 9 : 7) / this.scale
        poly()
        ctx.strokeStyle = focused ? '#ff2d55' : '#ff8800'
        ctx.lineWidth = (focused ? 4.5 : 3) / this.scale
        poly()
        ctx.fillStyle = ctx.strokeStyle
        for (const [x, y] of [[p[0], p[1]], [p[p.length - 2], p[p.length - 1]]]) {
          ctx.beginPath()
          ctx.arc(x, y, rr, 0, 7)
          ctx.fill()
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 1.5 / this.scale
          ctx.stroke()
          ctx.strokeStyle = focused ? '#ff2d55' : '#ff8800'
        }
      }
    }
  }
}
