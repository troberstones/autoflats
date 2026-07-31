export type Tool = 'pan' | 'fill' | 'barrier' | 'eraser' | 'merge' | 'dmerge'
const STROKE_TOOLS: Tool[] = ['barrier', 'eraser', 'dmerge']
const STROKE_COLORS: Record<string, string> = { barrier: '#39f', eraser: '#f66', dmerge: '#4f4' }

export class CanvasView {
  ctx: CanvasRenderingContext2D
  scale = 1
  ox = 0
  oy = 0
  tool: Tool = 'pan'
  fills: HTMLCanvasElement | null = null
  lineCv: HTMLCanvasElement | null = null
  barrierCv: HTMLCanvasElement | null = null
  lineOpacity = 1
  showLines = false
  showBarriers = true
  paths: number[][] = [] // gap-bridge suggestions, each a polyline [x0,y0,x1,y1,...]
  segFocus = -1
  imgW = 0
  imgH = 0
  onClick: ((x: number, y: number, e: PointerEvent) => void) | null = null
  onStroke: ((pts: number[]) => void) | null = null

  private space = false
  private panning = false
  private stroke: number[] | null = null
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
    } else {
      if (this.fills) ctx.drawImage(this.fills, 0, 0, this.imgW, this.imgH)
      if (this.lineCv) {
        ctx.globalAlpha = this.lineOpacity
        ctx.drawImage(this.lineCv, 0, 0)
        ctx.globalAlpha = 1
      }
    }
    if (this.barrierCv && this.showBarriers) {
      ctx.globalAlpha = 0.7
      ctx.drawImage(this.barrierCv, 0, 0)
      ctx.globalAlpha = 1
    }
    if (this.stroke && this.stroke.length >= 2) {
      ctx.strokeStyle = STROKE_COLORS[this.tool] ?? '#39f'
      ctx.lineWidth = (this.tool === 'eraser' ? 12 : 3)
      ctx.lineCap = ctx.lineJoin = 'round'
      ctx.beginPath()
      ctx.moveTo(this.stroke[0], this.stroke[1])
      for (let i = 2; i < this.stroke.length; i += 2) ctx.lineTo(this.stroke[i], this.stroke[i + 1])
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
