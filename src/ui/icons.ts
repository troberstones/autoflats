// Tool icons, from two pixel-art sets:
//
//   Pixelarticons by halfmage (MIT)          https://pixelarticons.com
//   Streamline Pixel by Streamline (CC BY 4.0)
//     https://icon-sets.iconify.design/streamline-pixel/
//     https://creativecommons.org/licenses/by/4.0/
//
// Pixelarticons wherever it has the tool; Streamline for the three it does not
// draw -- the paint can, the rubber and the magnet. They sit on different
// grids (24 and 32), so each icon carries its own viewBox and the browser is
// left to scale whole pixels rather than us resampling one onto the other.
//
// Vendored rather than fetched: the app is a single static page, and an icon
// that arrives over the network is an icon that is missing when the network is.
//
// These replaced emoji. Emoji are a typeface -- they render at the whim of the
// OS, they carry their own colour, and a hand or a bucket set by Apple sits at
// a different weight and size from one set by anyone else.
//
// Paths use currentColor, so the button decides the colour.

interface Icon { grid: number; body: string }

const ICONS: Record<string, Icon> = {
  // an open hand: drag the drawing about
  pan: { grid: 24, body: /* pixelarticons/hand */
    '<path fill="currentColor" d="M21 7h2v5h-2zm-4-2h2v7h-2zm-4-2h2v8h-2zM9 3h2v8H9zM5 5h2v8H5zm14 0h2v2h-2zm-4-2h2v2h-2zm-4-2h2v2h-2zM7 3h2v2H7zm-4 8h2v2H3zm-2 2h2v2H1zm0 2h2v2H1zm2 2h2v2H3zm2 2h2v2H5zm2 2h12v2H7zm12-2h2v2h-2zm2-7h2v7h-2zM5 13h2v2H5zm2 2h2v2H7z"/>' },
  // the paint can, tipped and pouring
  fill: { grid: 32, body: /* streamline-pixel/design-color-bucket */
    '<path fill="currentColor" d="M27.425 12.19h-1.52v-6.1h-1.52v1.53h-3.05V6.09h-10.67v1.53h-3.05V6.09h-1.52v4.57h1.52v1.53h1.53v1.52h9.14v1.53H7.615v1.52h12.19v4.57h3.05v-3.05h1.53v-1.52h1.52v-3.05h1.52v13.72h1.53V4.57h-1.53zm-1.52 15.24h1.52v1.52h-1.52Zm0-24.38h1.52v1.52h-1.52Zm-1.52 25.9h1.52v1.52h-1.52Zm0-27.43h1.52v1.53h-1.52Z"/><path fill="currentColor" d="M22.855 4.57h1.53v1.52h-1.53Zm-15.24 25.9h16.77V32H7.615Zm6.1-7.62h1.52v3.05h-1.52Zm-3.05-1.52h1.53v6.1h-1.53ZM9.145 3.05h13.71v1.52H9.145ZM7.615 0h16.77v1.52H7.615Zm0 19.81h1.53v6.09h-1.53Zm0-15.24h1.53v1.52h-1.53Zm-1.52 24.38h1.52v1.52h-1.52Zm0-15.24h1.52v1.53h-1.52Zm0-12.19h1.52v1.53h-1.52Zm-1.52 25.91h1.52v1.52h-1.52Zm0-24.38h1.52v1.52h-1.52Z"/><path fill="currentColor" d="M4.575 13.71h1.52v-1.52h-1.52V4.57h-1.53v22.86h1.53z"/>' },
  // a pencil: barriers are drawn, not computed
  barrier: { grid: 24, body: /* pixelarticons/pencil */
    '<path fill="currentColor" d="M4 16h2v2h2v2h2v2H2v-8h2zm8 4h-2v-2h2zm2-2h-2v-2h2zm-4-2H8v-2h2zm6 0h-2v-2h2zM6 14H4v-2h2zm6 0h-2v-2h2zm6 0h-2v-2h2zM8 12H6v-2h2zm6 0h-2v-2h2zm6 0h-2v-2h2zm-10-2H8V8h2zm8 0h-2V8h2zm4 0h-2V8h2zM12 8h-2V6h2zm4 0h-2V6h2zm4 0h-2V6h2zm-6-2h-2V4h2zm4 0h-2V4h2zm-2-2h-2V2h2z"/>' },
  // a rubber, mid-stroke, with the crumbs it leaves
  eraser: { grid: 32, body: /* streamline-pixel/interface-essential-eraser */
    '<path fill="currentColor" d="M30.47 29.72H32v1.52h-1.53Zm-3.05-3.05h1.53v1.52h-1.53Zm0-15.24h1.53v3.05h-1.53Zm-1.52 3.05h1.52V16H25.9Zm0-4.57h1.52v1.52H25.9Zm-1.52 19.81h1.52v1.52h-1.52Zm0-13.72h1.52v1.53h-1.52Zm0-7.62h1.52v1.53h-1.52Zm-1.53 18.29h1.53v1.52h-1.53Zm0-9.14h1.53v1.52h-1.53Zm0-10.67h1.53v1.52h-1.53Zm-1.52 12.19h1.52v1.52h-1.52Zm0-13.72h1.52v1.53h-1.52ZM19.8 28.19h1.53v1.53H19.8Zm0-7.62h1.53v1.53H19.8Zm0-16.76h1.53v1.52H19.8ZM18.28 22.1h1.52v1.52h-1.52Zm0-10.67h1.52v1.52h-1.52Zm0-9.14h1.52v1.52h-1.52Zm-1.52 21.33h1.52v1.52h-1.52ZM15.23.76h3.05v1.53h-3.05Zm0 24.38h1.53v1.53h-1.53Zm0-10.66h3.05V16h-3.05Zm0-6.1h1.53v1.53h-1.53Zm-1.52 15.24h1.52v1.52h-1.52Zm0-10.67h1.52v1.53h-1.52Zm0-10.66h1.52v1.52h-1.52Zm-1.52 22.85h1.52v1.53h-1.52Zm0-3.04h1.52v1.52h-1.52Zm0-12.19h1.52v3.04h-1.52Zm0-6.1h1.52v1.52h-1.52Zm-1.53 16.76h1.53v1.53h-1.53Zm0-15.24h1.53v1.53h-1.53Z"/><path fill="currentColor" d="M6.09 29.72h1.52v1.52h10.67v-1.52h-3.05v-1.53h-3.04v-1.52h-6.1v1.52H1.52v1.53H0v1.52h6.09zm3.05-10.67h1.52v1.52H9.14Zm0-12.19h1.52v1.52H9.14ZM7.61 17.53h1.53v1.52H7.61Zm0-9.15h1.53v1.53H7.61ZM6.09 16h1.52v1.53H6.09Zm0-6.09h1.52v1.52H6.09Z"/><path fill="currentColor" d="M4.57 25.14h1.52v1.53H4.57Zm0-10.66h1.52V16H4.57Zm0-3.05h1.52v1.52H4.57ZM3.04 23.62h1.53v1.52H3.04Zm0-7.62h1.53v1.53H3.04Zm0-3.05h1.53v1.53H3.04ZM1.52 22.1h1.52v1.52H1.52Zm0-4.57h1.52v1.52H1.52ZM0 19.05h1.52v3.05H0Z"/>' },
  // two squares overlapping: two fills become one
  merge: { grid: 24, body: /* pixelarticons/copy */
    '<path fill="currentColor" d="M8 6h12v2H8zM4 2h12v2H4zm2 6h2v12H6zM2 4h2v12H2zm6 16h12v2H8zM20 8h2v12h-2zm-4-4h2v2h-2zM4 16h2v2H4z"/>' },
  // a magnet: everything the stroke crosses is drawn in
  dmerge: { grid: 32, body: /* streamline-pixel/interface-essential-magnet */
    '<path fill="currentColor" d="M22.09 16.76h4.58v7.62h1.52V10.67h-7.62v13.71h1.52z"/><path fill="currentColor" d="M25.14 24.38h1.53v3.05h-1.53Zm-1.52 3.05h1.52v1.52h-1.52Zm0-27.43h1.52v1.52h-1.52Zm-1.53 6.1h1.53v1.52h-1.53Zm0-4.58v1.53h-1.52v1.52h3.05V6.1h1.52V4.57h1.53V3.05h-3.05V1.52zm-1.52 27.43h3.05v1.53h-3.05Zm-9.14 1.53h9.14V32h-9.14Zm0-6.1h9.14v1.52h-9.14Zm-3.05 4.57h3.05v1.53H8.38Zm-1.52-1.52h1.52v1.52H6.86ZM6.86 0h1.52v1.52H6.86ZM5.33 24.38h1.53v3.05H5.33Zm0-18.28h1.53v1.52H5.33Zm0-4.58v1.53H3.81v1.52h3.05V6.1h1.52V4.57H9.9V3.05H6.86V1.52zM3.81 24.38h1.52v-7.62H9.9v7.62h1.53V10.67H3.81z"/>' },
  // the bin
  delfill: { grid: 24, body: /* pixelarticons/trash */
    '<path fill="currentColor" d="M18 22H6v-2h12zM9 6h6V4h2v2h5v2h-2v12h-2V8H6v12H4V8H2V6h5V4h2zm6-2H9V2h6z"/>' },
  // a chain: fills that travel together
  group: { grid: 24, body: /* pixelarticons/link */
    '<path fill="currentColor" d="M4 6h7v2H4zm0 10h7v2H4zM2 8h2v8H2zm18-2h-7v2h7zm0 10h-7v2h7zm2-8h-2v8h2zM7 11h10v2H7z"/>' },
  // a shape drawn by hand rather than found
  shape: { grid: 24, body: /* pixelarticons/shapes */
    '<path fill="currentColor" d="M2 13h9v2H2zm0 2h2v5H2zm0 5h9v2H2zm7-5h2v5H9zm6-2h5v2h-5zm-2 2h2v5h-2zm2 5h5v2h-5zm5-5h2v5h-2zM7 9h10v2H7zm0-2h2v2H7zm2-3h2v3H9zm2-2h2v2h-2zm2 2h2v3h-2zm2 3h2v2h-2z"/>' },
  // a swatch off the palette
  recolor: { grid: 24, body: /* pixelarticons/colors-swatch */
    '<path fill="currentColor" d="M14 2h6v2h-6zm0 18h6v2h-6zM4 20h10v2H4zm8-16h2v16h-2zm8 0h2v16h-2zM2 16h2v4H2zm2-2h8v2H4zm12 2h2v2h-2zM6 12h2v2H6zM4 8h2v4H4zm2-2h4v2H6zm4 2h2v2h-2z"/>' },
  // an arrow inside a marquee
  pick: { grid: 24, body: /* pixelarticons/square-dashed-cursor */
    '<path fill="currentColor" d="M12 10h2v12h-2zm2 0h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm-6 4h2v2h-2zm2-2h6v2h-6zM2 16h2v4H2zm2 4h2v2H4zm4 0h2v2H8zM2 10h2v4H2zm0-6h2v4H2zm2-2h2v2H4zm4 0h4v2H8zm6 0h4v2h-4zm6 2h2v4h-2zm0 6h2v2h-2z"/>' },
}

// crispEdges so a non-integer scale never blurs the grid into mush.
export function iconSvg(name: string, px = 22): string {
  const ic = ICONS[name]
  if (!ic) return ''
  return `<svg width="${px}" height="${px}" viewBox="0 0 ${ic.grid} ${ic.grid}" ` +
         `shape-rendering="crispEdges" aria-hidden="true">${ic.body}</svg>`
}

export const ICON_NAMES = Object.keys(ICONS)
