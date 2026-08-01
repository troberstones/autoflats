export type Tool = 'pan' | 'fill' | 'barrier' | 'eraser' | 'merge' | 'dmerge' | 'delfill' | 'group' | 'pick'
const STROKE_TOOLS: Tool[] = ['barrier', 'eraser', 'dmerge', 'group']
const STROKE_COLORS: Record<string, string> = { barrier: '#39f', eraser: '#f66', dmerge: '#4f4', group: '#fc0' }

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

  private space = false
  private panning = false
  private stroke: number[] | null = null
  private box: number[] | null = null // [x0,y0,x1,y1] in image space, pick tool
  private lx = 0
  private ly = 0
  private moved = false
  private autoFit = true // keep re-fitting on resize until the user zooms/pans

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
      canvas.setPointerCapture(e.pointerId)
      this.moved = false
      this.lx = e.clientX; this.ly = e.clientY
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
      const dx = e.clientX - this.lx, dy = e.clientY - this.ly
      if (Math.abs(dx) + Math.abs(dy) > 2) this.moved = true
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
    canvas.addEventListener('pointerup', e => {
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
      if (!this.moved && this.onClick) {
        const [x, y] = this.toImage(e)
        this.onClick(x, y, e)
      }
    })
    addEventListener('keydown', e => { if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) { this.space = true; e.preventDefault() } })
    addEventListener('keyup', e => { if (e.code === 'Space') this.space = false })
  }

  toImage(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect()
    const cx = (e.clientX - r.left) * devicePixelRatio, cy = (e.clientY - r.top) * devicePixelRatio
    return [(cx - this.ox) / this.scale, (cy - this.oy) / this.scale]
  }

  fit() {
    this.autoFit = true
    if (!this.imgW) return
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
    ctx.setTransform(this.scale, 0, 0, this.scale, this.ox, this.oy)
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
      if (this.tool === 'group') {
        // the lasso closes on release: show the closing edge and the area it
        // will capture while the user is still drawing
        ctx.closePath()
        ctx.fillStyle = 'rgba(255,204,0,0.18)'
        ctx.fill()
      }
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
