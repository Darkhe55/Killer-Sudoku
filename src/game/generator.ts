/**
 * 杀手数独题库生成器
 *
 * 1. 生成随机拉丁终盘；
 * 2. 用随机哈密顿路径切成 2..maxSize 格的连通虚线段，且每段终盘数字互不相同；
 * 3. 先不加预填，若笼约束不足则逐步揭示数字，直到唯一解。
 */

import type { Difficulty } from '../core/types'
import { encodeBoard, standardRegions, type Cage } from './types.ts'
import { countSolutions } from './solver.ts'

interface GenSpec {
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

function makeSolution(rng: () => number): number[] {
  const base = new Array<number>(81)
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      base[y * 9 + x] = (x * 3 + Math.floor(x / 3) + y) % 9 + 1
    }
  }
  const digits = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9], rng)
  const bands = shuffle([0, 1, 2], rng)
  const stacks = shuffle([0, 1, 2], rng)
  const rows: number[] = []
  const cols: number[] = []
  for (const band of bands) for (const r of shuffle([0, 1, 2], rng)) rows.push(band * 3 + r)
  for (const stack of stacks) for (const c of shuffle([0, 1, 2], rng)) cols.push(stack * 3 + c)
  const out = new Array<number>(81)
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      out[y * 9 + x] = digits[base[rows[y]! * 9 + cols[x]!]! - 1]!
    }
  }
  return out
}

function hamiltonianPath(rng: () => number): number[] | null {
  for (let attempt = 0; attempt < 200; attempt++) {
    const visited = new Uint8Array(81)
    const path: number[] = []
    const start = Math.floor(rng() * 81)
    let steps = 0
    const dfs = (i: number): boolean => {
      if (++steps > 30_000) return false
      visited[i] = 1
      path.push(i)
      if (path.length === 81) return true
      const x = i % 9
      const y = (i / 9) | 0
      const next: Array<[number, number]> = []
      for (const n of [x > 0 ? i - 1 : -1, x < 8 ? i + 1 : -1, y > 0 ? i - 9 : -1, y < 8 ? i + 9 : -1]) {
        if (n < 0 || visited[n]) continue
        const nx = n % 9
        const ny = (n / 9) | 0
        let degree = 0
        for (const q of [
          nx > 0 ? n - 1 : -1,
          nx < 8 ? n + 1 : -1,
          ny > 0 ? n - 9 : -1,
          ny < 8 ? n + 9 : -1,
        ]) {
          if (q >= 0 && !visited[q]) degree++
        }
        next.push([degree + rng() * 0.9, n])
      }
      next.sort((a, b) => a[0] - b[0])
      for (const [, n] of next) if (dfs(n)) return true
      path.pop()
      visited[i] = 0
      return false
    }
    if (dfs(start)) return path
  }
  return null
}

function makeCages(solution: number[], rng: () => number, maxSize: number): Cage[] | null {
  for (let attempt = 0; attempt < 300; attempt++) {
    const path = hamiltonianPath(rng)
    if (!path) continue

    const sizes: number[] = []
    let left = 81
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
    for (const size of sizes) {
      const cells = path.slice(pos, pos + size)
      pos += size
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

const SPECS: GenSpec[] = [
  { seed: 0x4b534401, difficulty: 'easy', name: '初识杀手', series: '入门', maxCage: 3 },
  { seed: 0x4b534402, difficulty: 'easy', name: '笼中九宫', series: '入门', maxCage: 3 },
  { seed: 0x4b534403, difficulty: 'medium', name: '虚线初现', series: '进阶', maxCage: 4 },
  { seed: 0x4b534404, difficulty: 'medium', name: '和为九', series: '进阶', maxCage: 4 },
  { seed: 0x4b534405, difficulty: 'hard', name: '杀手之壁', series: '挑战', maxCage: 4 },
  { seed: 0x4b534406, difficulty: 'hard', name: '终局笼阵', series: '挑战', maxCage: 4 },
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
  const regions = standardRegions()
  const solution = makeSolution(rng)
  const cages = makeCages(solution, rng, spec.maxCage)
  if (!cages) return null

  const givens = new Array<number>(81).fill(0)
  let counted = countSolutions(givens, regions, cages, 2, 800_000)
  if (counted.timedOut) return null
  if (counted.count !== 1) {
    const order = shuffle(
      Array.from({ length: 81 }, (_, i) => i),
      rng,
    )
    for (const i of order) {
      givens[i] = solution[i]!
      counted = countSolutions(givens, regions, cages, 2, 800_000)
      if (counted.timedOut) return null
      if (counted.count === 1) break
    }
  }
  if (counted.count !== 1) return null

  return {
    id: `killer-${spec.seed.toString(36)}`,
    name: spec.name,
    width: 9,
    height: 9,
    difficulty: spec.difficulty,
    series: spec.series,
    board: encodeBoard(givens, regions, cages),
    solution: solution.join(''),
  }
}

export function generatePuzzles(): GeneratedPuzzle[] {
  const out: GeneratedPuzzle[] = []
  for (const spec of SPECS) {
    const t0 = Date.now()
    const rng = mulberry32(spec.seed)
    let made: GeneratedPuzzle | null = null
    for (let tries = 0; tries < 40 && !made; tries++) made = attempt(spec, rng)
    if (!made) throw new Error(`[杀手数独 gen] ${spec.name} 生成失败`)
    const clues = made.board.split('|')[0]!.split('').filter((c) => c !== '0').length
    const cageCount = made.board.split('|')[2]!.split(':')[1]!.split(',').length
    console.log(
      `[杀手数独 gen] ${spec.name}：预填 ${clues}，笼 ${cageCount}，${Date.now() - t0}ms`,
    )
    out.push(made)
  }
  return out
}
