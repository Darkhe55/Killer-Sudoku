/**
 * 杀手数独题库生成器（任意 N / 标准矩形宫）
 *
 * 1. 生成随机拉丁终盘（矩形宫公式 + 数字/行带/列带打乱）；
 * 2. 用随机哈密顿路径切成 2..maxCage 格的连通虚线段，且每段终盘数字互不相同；
 * 3. 先不加预填，若笼约束不足则逐步揭示数字，直到唯一解。
 *
 * 旧 9×9 内置题保留在 puzzles-data.ts 中不再重生成；
 * npm run gen 只生成 4×4 / 6×6 / 12×12 / 16×16 等新增尺寸到 puzzles-extra-data.ts。
 */

import type { Difficulty } from '../core/types'
import { encodeBoard, encodeCells, standardBoxDims, standardRegionsOf, type Cage } from './types.ts'
import { countSolutions } from './solver.ts'

interface GenSpec {
  n: number
  seed: number
  difficulty: Difficulty
  name: string
  series: string
  maxCage: number
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

function makeSolution(n: number, rng: () => number): number[] {
  const { rows, cols } = standardBoxDims(n)
  const size = n * n
  const base = new Array<number>(size)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      base[y * n + x] = ((rows * x + Math.floor(x / cols) + y) % n) + 1
    }
  }
  const digits = shuffle(Array.from({ length: n }, (_, i) => i + 1), rng)
  const bands = shuffle(Array.from({ length: Math.ceil(n / rows) }, (_, i) => i), rng)
  const stacks = shuffle(Array.from({ length: Math.ceil(n / cols) }, (_, i) => i), rng)
  const rowOrder: number[] = []
  for (const band of bands) {
    for (const r of shuffle(Array.from({ length: rows }, (_, i) => i), rng)) {
      const row = band * rows + r
      if (row < n) rowOrder.push(row)
    }
  }
  const colOrder: number[] = []
  for (const stack of stacks) {
    for (const c of shuffle(Array.from({ length: cols }, (_, i) => i), rng)) {
      const col = stack * cols + c
      if (col < n) colOrder.push(col)
    }
  }
  const out = new Array<number>(size)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      out[y * n + x] = digits[base[rowOrder[y]! * n + colOrder[x]!]! - 1]!
    }
  }
  return out
}

/** 随机哈密顿路径（四连通） */
function hamiltonianPath(n: number, rng: () => number): number[] | null {
  const size = n * n
  for (let attempt = 0; attempt < 60; attempt++) {
    const visited = new Uint8Array(size)
    const path: number[] = []
    const start = Math.floor(rng() * size)
    let steps = 0
    const cap = n > 9 ? 120_000 : 30_000
    const dfs = (i: number): boolean => {
      if (++steps > cap) return false
      visited[i] = 1
      path.push(i)
      if (path.length === size) return true
      const x = i % n
      const y = (i / n) | 0
      const next: Array<[number, number]> = []
      for (const nb of [
        x > 0 ? i - 1 : -1,
        x < n - 1 ? i + 1 : -1,
        y > 0 ? i - n : -1,
        y < n - 1 ? i + n : -1,
      ]) {
        if (nb < 0 || visited[nb]) continue
        const nx = nb % n
        const ny = (nb / n) | 0
        let degree = 0
        for (const q of [
          nx > 0 ? nb - 1 : -1,
          nx < n - 1 ? nb + 1 : -1,
          ny > 0 ? nb - n : -1,
          ny < n - 1 ? nb + n : -1,
        ]) {
          if (q >= 0 && !visited[q]) degree++
        }
        next.push([degree + rng() * 0.9, nb])
      }
      next.sort((a, b) => a[0] - b[0])
      for (const [, nb] of next) if (dfs(nb)) return true
      path.pop()
      visited[i] = 0
      return false
    }
    if (dfs(start)) return path
  }
  return null
}

function makeCages(
  n: number,
  solution: number[],
  rng: () => number,
  maxSize: number,
): Cage[] | null {
  const size = n * n
  for (let attempt = 0; attempt < 60; attempt++) {
    const path = hamiltonianPath(n, rng)
    if (!path) continue

    const sizes: number[] = []
    let left = size
    while (left > 0) {
      const choices: number[] = []
      for (let s = 2; s <= maxSize; s++) {
        if (left - s === 1) continue
        if (left - s < 0) break
        choices.push(s)
      }
      if (!choices.length) break
      const s = choices[Math.floor(rng() * choices.length)]!
      sizes.push(s)
      left -= s
    }
    if (left !== 0) continue

    const cages: Cage[] = []
    let pos = 0
    let ok = true
    for (const s of sizes) {
      const cells = path.slice(pos, pos + s)
      pos += s
      const seen = new Set<number>()
      for (const i of cells) seen.add(solution[i]!)
      if (seen.size !== cells.length) {
        ok = false
        break
      }
      let sum = 0
      for (const i of cells) sum += solution[i]!
      cages.push({ cells, sum })
    }
    if (ok) return cages
  }
  return null
}

/** 旧 9×9 内置题规格（保留在 puzzles-data.ts 中，不再重生成） */
const LEGACY_SPECS: GenSpec[] = [
  { n: 9, seed: 0x4b534401, difficulty: 'easy', name: '初识杀手', series: '入门', maxCage: 3 },
  { n: 9, seed: 0x4b534402, difficulty: 'easy', name: '笼中九宫', series: '入门', maxCage: 3 },
  { n: 9, seed: 0x4b534403, difficulty: 'medium', name: '虚线初现', series: '进阶', maxCage: 4 },
  { n: 9, seed: 0x4b534404, difficulty: 'medium', name: '和为九', series: '进阶', maxCage: 4 },
  { n: 9, seed: 0x4b534405, difficulty: 'hard', name: '杀手之壁', series: '挑战', maxCage: 4 },
  { n: 9, seed: 0x4b534406, difficulty: 'hard', name: '终局笼阵', series: '挑战', maxCage: 4 },
]

/** 多尺寸内置题规格 */
const EXTRA_SPECS: GenSpec[] = [
  { n: 4, seed: 0x4b554401, difficulty: 'easy', name: '四宫杀手', series: '尺寸', maxCage: 3 },
  { n: 4, seed: 0x4b554402, difficulty: 'medium', name: '四方笼阵', series: '尺寸', maxCage: 3 },
  { n: 6, seed: 0x4b554601, difficulty: 'easy', name: '六宫杀手', series: '尺寸', maxCage: 3 },
  { n: 6, seed: 0x4b554602, difficulty: 'medium', name: '六宫虚线', series: '尺寸', maxCage: 4 },
]

export interface GeneratedPuzzle {
  id: string
  name: string
  width: number
  height: number
  difficulty: Difficulty
  series: string
  board: string
  solution: string
}

function attempt(spec: GenSpec, rng: () => number): GeneratedPuzzle | null {
  const n = spec.n
  const size = n * n
  const regions = standardRegionsOf(n)
  const solution = makeSolution(n, rng)
  const cages = makeCages(n, solution, rng, spec.maxCage)
  if (!cages) return null

  const givens = new Array<number>(size).fill(0)
  const countBudget = n > 9 ? 300_000 : 800_000
  let counted = countSolutions(givens, regions, cages, 2, countBudget, n)
  if (counted.timedOut) return null
  if (counted.count !== 1) {
    const order = shuffle(
      Array.from({ length: size }, (_, i) => i),
      rng,
    )
    for (const i of order) {
      givens[i] = solution[i]!
      counted = countSolutions(givens, regions, cages, 2, countBudget, n)
      if (counted.timedOut) return null
      if (counted.count === 1) break
    }
  }
  if (counted.count !== 1) return null

  return {
    id: `killer-${n}x${n}-${spec.seed.toString(36)}`,
    name: spec.name,
    width: n,
    height: n,
    difficulty: spec.difficulty,
    series: spec.series,
    board: encodeBoard(givens, regions, cages),
    solution: encodeCells(solution),
  }
}

function run(specs: GenSpec[], tag: string): GeneratedPuzzle[] {
  const out: GeneratedPuzzle[] = []
  for (const spec of specs) {
    const t0 = Date.now()
    const rng = mulberry32(spec.seed)
    let made: GeneratedPuzzle | null = null
    for (let tries = 0; tries < 30 && !made; tries++) made = attempt(spec, rng)
    if (!made) throw new Error(`[${tag}] ${spec.name}（${spec.n}×${spec.n}）生成失败`)
    const clues = made.board.split('|')[0]!.split('').filter((c) => c !== '0').length
    const cageCount = made.board.split('|')[2]!.split(':')[1]!.split(',').length
    console.log(
      `[${tag}] ${made.name}（${spec.n}×${spec.n}）：预填 ${clues}，笼 ${cageCount}，${Date.now() - t0}ms`,
    )
    out.push(made)
  }
  return out
}

/** 旧 9×9 内置题（耗时较长；正常不重新生成，保留 puzzles-data.ts） */
export function generatePuzzles(): GeneratedPuzzle[] {
  return run(LEGACY_SPECS, '杀手数独 gen')
}

/** 新增多尺寸内置题（4 / 6 / 12 / 16） */
export function generateExtraPuzzles(): GeneratedPuzzle[] {
  return run(EXTRA_SPECS, '杀手数独 gen 多尺寸')
}
