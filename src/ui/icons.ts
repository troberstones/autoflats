// Tool icons, drawn the way they were drawn in 1994: a 16x16 grid, placed one
// pixel at a time, in three colours plus transparent. Emoji were standing in
// for these, and emoji are a typeface -- they render at the whim of the OS,
// they carry their own colour, and a hand or a bucket rendered by Apple sits
// at a different weight and size from one rendered by anyone else. A bitmap
// is the same picture everywhere, and at this size a hand-set pixel reads
// better than any amount of vector detail.
//
//   X  ink            #000
//   w  highlight      #fff
//   g  shadow         #808080
//   .  transparent

const ICONS: Record<string, string[]> = {
  // an open hand, fingers up
  pan: [
    '................',
    '.....XX.........',
    '....XwwX........',
    '....XwwX.XX.....',
    '....XwwXXwwX....',
    '.XX.XwwXXwwX.XX.',
    'XwwXXwwXXwwXXwwX',
    'XwwXXwwwwwwwXwwX',
    'XwwwwwwwwwwwwwwX',
    'XwwwwwwwwwwwwwwX',
    '.XwwwwwwwwwwwwwX',
    '.XwwwwwwwwwwwwX.',
    '..XwwwwwwwwwwX..',
    '...XwwwwwwwwX...',
    '....XXXXXXXX....',
    '................',
  ],
  // paint bucket, tipped, with a drop coming off it
  fill: [
    '................',
    '....XXXXXX......',
    '...X......X.....',
    '...X......X.....',
    '..XXXXXXXXXX....',
    '..XwwwwwwwwX....',
    '..XwwwwwwwwX....',
    '..XwwggggwwX....',
    '...XwggggwX.....',
    '...XwwggwwX.....',
    '....XwwwwX......',
    '....XXXXXX......',
    '.............X..',
    '............XwX.',
    '...........XwwX.',
    '............XX..',
  ],
  // brush, loaded, on the diagonal
  recolor: [
    '.............XX.',
    '............XwwX',
    '...........XwwX.',
    '..........XwwX..',
    '.........XwwX...',
    '........XwwX....',
    '.......XwwX.....',
    '......XXXX......',
    '.....XwwwwX.....',
    '....XwggggX.....',
    '...XwggggX......',
    '...XwgggX.......',
    '..XwggX.........',
    '..XwgX..........',
    '..XXX...........',
    '................',
  ],
  // pencil, sharpened, point down-left. The shaft is shaded down one side and
  // the last three rows go solid: without the dark point it read as a stick.
  barrier: [
    '............XX..',
    '...........XwwX.',
    '..........XwwgX.',
    '.........XwwgX..',
    '........XwwgX...',
    '.......XwwgX....',
    '......XwwgX.....',
    '.....XwwgX......',
    '....XwwgX.......',
    '...XwwgX........',
    '..XwwgX.........',
    '..XwgX..........',
    '..XXX...........',
    '..XX............',
    '..X.............',
    '................',
  ],
  // eraser block, on the same diagonal as the pencil
  eraser: [
    '................',
    '.........XXXX...',
    '........XwwwwXX.',
    '.......XwwwwXwX.',
    '......XwwwwXwwX.',
    '.....XwwwwXwwX..',
    '....XwwwwXwwX...',
    '...XXXXXXwwX....',
    '..XwwwwwXwX.....',
    '..XwggggXX......',
    '...XwgggX.......',
    '....XwggX.......',
    '.....XwgX.......',
    '......XXX.......',
    '................',
    '................',
  ],
  // two panes, overlapping: the second one merges into the first
  merge: [
    '................',
    '..XXXXXXXX......',
    '..XwwwwwwX......',
    '..XwwwwwwX......',
    '..XwwXXXXXXXX...',
    '..XwwXggggggX...',
    '..XwwXggggggX...',
    '..XXXXggggggX...',
    '.....XggggggX...',
    '.....XggggggX...',
    '.....XggggggX...',
    '.....XXXXXXXX...',
    '................',
    '................',
    '................',
    '................',
  ],
  // horseshoe magnet: drag it through fills and they come with it
  dmerge: [
    '................',
    '.....XXXXXX.....',
    '...XXwwwwwwXX...',
    '..XwwXXXXXXwwX..',
    '..XwwX....XwwX..',
    '.XwwX......XwwX.',
    '.XwwX......XwwX.',
    '.XwwX......XwwX.',
    '.XwwX......XwwX.',
    '.XwwX......XwwX.',
    '.XXXX......XXXX.',
    '.XggX......XggX.',
    '.XggX......XggX.',
    '.XggX......XggX.',
    '.XXXX......XXXX.',
    '................',
  ],
  // waste basket
  delfill: [
    '................',
    '......XXXX......',
    '.....XwwwwX.....',
    '..XXXXXXXXXXXX..',
    '..XwwwwwwwwwwX..',
    '..XXXXXXXXXXXX..',
    '...XwXwwXwwXwX..',
    '...XwXwwXwwXwX..',
    '...XwXwwXwwXwX..',
    '...XwXwwXwwXwX..',
    '...XwXwwXwwXwX..',
    '...XwXwwXwwXwX..',
    '...XwXwwXwwXwX..',
    '...XwwwwwwwwwX..',
    '....XXXXXXXXX...',
    '................',
  ],
  // lasso, with its tail hanging
  group: [
    '.....XXXX.......',
    '...XXwwwwXX.....',
    '..XwwXXXXwwX....',
    '.Xww......wwX...',
    '.Xw........wX...',
    '.Xw........wX...',
    '.Xww......wwX...',
    '..XwwXXXXwwX....',
    '...XXwwwwXX.....',
    '.....XwwX.......',
    '......XwX.......',
    '......XwX.......',
    '.......XwX......',
    '........XwX.....',
    '.........XX.....',
    '................',
  ],
  // the polygon you draw by hand
  shape: [
    '................',
    '.......XX.......',
    '......XwwX......',
    '.....XwwwwX.....',
    '....XwwwwwwX....',
    '...XwwggggwwX...',
    '..XwwggggggwwX..',
    '.XwwggggggggwwX.',
    '.XwggggggggggwX.',
    '..XwggggggggwX..',
    '...XwggggggwX...',
    '....XwggggwX....',
    '.....XwggwX.....',
    '......XwwX......',
    '.......XX.......',
    '................',
  ],
  // marching ants: the dashes have to sit on an even beat all the way round,
  // or the rectangle reads as a broken line rather than a selection
  pick: [
    '................',
    '................',
    '..XX.XX.XX..XX..',
    '..X..........X..',
    '..X..........X..',
    '................',
    '..X..........X..',
    '..X..........X..',
    '................',
    '..X..........X..',
    '..X..........X..',
    '................',
    '..X..........X..',
    '..XX.XX.XX..XX..',
    '................',
    '................',
  ],
}

const INK: Record<string, string> = { X: '#000', w: '#fff', g: '#808080' }

// One <rect> per horizontal run rather than per pixel: a 16x16 icon is 256
// pixels and eleven of those in the DOM is a lot of nodes for no gain.
export function iconSvg(name: string, px = 16): string {
  const rows = ICONS[name]
  if (!rows) return ''
  let out = ''
  rows.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const c = row[x]
      let w = 1
      while (x + w < row.length && row[x + w] === c) w++
      if (INK[c]) out += `<rect x="${x}" y="${y}" width="${w}" height="1" fill="${INK[c]}"/>`
      x += w
    }
  })
  // crispEdges so a non-integer scale never blurs the grid into mush
  return `<svg width="${px}" height="${px}" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">${out}</svg>`
}

export const ICON_NAMES = Object.keys(ICONS)
