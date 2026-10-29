export interface GridFit {
  cols: number
  rows: number
  width: number
  height: number
}

/**
 * The column count that makes n tiles of the given aspect ratio as large as
 * possible inside width × height.
 */
export function fitGrid(width: number, height: number, n: number, gap: number, aspect: number): GridFit {
  let best: GridFit = { cols: 1, rows: Math.max(1, n), width: 0, height: 0 }
  if (n <= 0 || width <= 0 || height <= 0) return best
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const maxW = (width - gap * (cols - 1)) / cols
    const maxH = (height - gap * (rows - 1)) / rows
    let w = maxW
    let h = w / aspect
    if (h > maxH) {
      h = maxH
      w = h * aspect
    }
    if (w > best.width) best = { cols, rows, width: Math.floor(w), height: Math.floor(h) }
  }
  return best
}

/**
 * Tiles keep 16:9 on landscape screens. On a portrait phone that would leave
 * most of the screen empty, so tiles get taller as there are fewer of them.
 */
export function tileAspect(width: number, height: number, n: number): number {
  if (width >= height) return 16 / 9
  if (n <= 1) return Math.max(0.6, width / height)
  if (n === 2) return Math.max(0.75, Math.min(16 / 9, width / (height / 2)))
  return n <= 6 ? 0.9 : 1
}

/** How many tiles fit before they would get smaller than minWidth. */
export function gridCapacity(width: number, height: number, gap: number, minWidth: number, max = 49): number {
  let capacity = 1
  for (let n = 1; n <= max; n++) {
    const fit = fitGrid(width, height, n, gap, tileAspect(width, height, n))
    if (fit.width < minWidth) break
    capacity = n
  }
  return capacity
}

/**
 * Chooses which of more people than fit get a tile: yourself, then whoever
 * spoke most recently, then raised hands, then everyone else in join order.
 * The chosen ones are shown in join order so tiles don't jump around as the
 * conversation moves.
 */
export function pickVisible<T extends { id: string; joinedAt: number; handRaisedAt: number; self: boolean }>(
  items: T[],
  slots: number,
  recentSpeakers: string[],
): { visible: T[]; hidden: T[] } {
  if (items.length <= slots) return { visible: items, hidden: [] }
  const rank = (item: T) => {
    if (item.self) return -3
    const spoke = recentSpeakers.indexOf(item.id)
    if (spoke >= 0) return -2 + spoke / 1000
    if (item.handRaisedAt) return -1 + item.handRaisedAt / 1e16
    return item.joinedAt / 1e16
  }
  const ranked = [...items].sort((a, b) => rank(a) - rank(b))
  const chosen = new Set(ranked.slice(0, slots).map((i) => i.id))
  return {
    visible: items.filter((i) => chosen.has(i.id)),
    hidden: items.filter((i) => !chosen.has(i.id)),
  }
}
