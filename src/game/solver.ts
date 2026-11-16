/**
 * 杀手数独 —— 回溯求解器（任意 N）
 *
 * 每层 DFS 先跑规则传播（行列宫 + 笼和/不重复），再用 MRV（最少候选优先）分支。
 * 候选数用普通数组/Set 计算，4×4 / 6×6 / 9×9 / 12×12 / 16×16 通用。
 */

import type { Puzzle, SolveResult } from '../core/types'
import {
  initialGrid,
  isValidSolution,
  makeUnits,
  propagate,
  solveByRules,
} from './rules.ts'
import {
  cageIndexMap,
  isValidKillerSize,
  puzzleSize,
  squareSize,
  type Cage,
  type SudokuPuzzle,
  type SudokuState,
} from './types.ts'

export interface CountOutcome {
  count: number
  nodes: number
  timedOut: boolean
}

function buildUnitIndex(units: number[][], size: number): number[][] {
  const unitOf: number[][] = Array.from({ length: size }, () => [])
  for (let u = 0; u < units.length; u++) {
    for (const i of units[u]!) if (i >= 0 && i < size) unitOf[i]!.push(u)
  }
  return unitOf
}

function search(
  givens: ArrayLike<number>,
  regions: ArrayLike<number>,
  cages: Cage[],
  n: number,
  limit: number,
  maxNodes: number,
): { solutions: number[][]; nodes: number; timedOut: boolean } {
  const size = n * n
  const grid = initialGrid(givens, n)
  const units = makeUnits(regions, n)
  const unitOf = buildUnitIndex(units, size)
  const cageOf = cageIndexMap(cages, size)
  const solutions: number[][] = []
  let nodes = 0
  let timedOut = false

  const candidatesOf = (i: number): number[] => {
    if (grid[i] !== 0) return []
    const used = new Set<number>()
    for (const u of unitOf[i]!) {
      for (const j of units[u]!) if (grid[j] !== 0) used.add(grid[j]!)
    }
    for (let j = 0; j < size; j++) {
      if (j !== i && cageOf[j] === cageOf[i] && grid[j] !== 0) used.add(grid[j]!)
    }
    const out: number[] = []
    for (let v = 1; v <= n; v++) if (!used.has(v)) out.push(v)
    return out
  }

  const dfs = (): void => {
    if (solutions.length >= limit || timedOut) return
    nodes++
    if (nodes > maxNodes) {
      timedOut = true
      return
    }
    if (!propagate(grid, regions, cages, n)) return

    let choice = -1
    let best = Infinity
    let bestValues: number[] = []
    for (let i = 0; i < size; i++) {
      if (grid[i] !== 0) continue
      const cands = candidatesOf(i)
      if (cands.length === 0) return
      if (cands.length < best) {
        best = cands.length
        choice = i
        bestValues = cands
        if (best === 1) break
      }
    }

    if (choice < 0) {
      if (isValidSolution(grid, regions, cages, n)) solutions.push(Array.from(grid))
      return
    }

    const backup = Array.from(grid)
    for (const v of bestValues) {
      if (solutions.length >= limit || timedOut) return
      grid[choice] = v
      dfs()
      for (let i = 0; i < size; i++) grid[i] = backup[i]!
    }
  }

  dfs()
  return { solutions, nodes, timedOut }
}

export function countSolutions(
  givens: ArrayLike<number>,
  regions: ArrayLike<number>,
  cages: Cage[],
  limit = 2,
  maxNodes = 300_000,
  n = squareSize(givens.length) || 9,
): CountOutcome {
  const out = search(givens, regions, cages, n, limit, maxNodes)
  return { count: out.solutions.length, nodes: out.nodes, timedOut: out.timedOut }
}

export function findSolution(
  givens: ArrayLike<number>,
  regions: ArrayLike<number>,
  cages: Cage[],
  maxNodes = 2_000_000,
  n = squareSize(givens.length) || 9,
): number[] | null {
  const out = search(givens, regions, cages, n, 1, maxNodes)
  return out.solutions[0] ?? null
}

export function solvePuzzle(puzzle: Puzzle, maxNodes = 1_500_000): SolveResult {
  const p = puzzle as SudokuPuzzle
  const n = puzzleSize(p)
  const size = n * n
  if (
    !n ||
    !isValidKillerSize(n) ||
    !p.givens ||
    !p.regions ||
    !p.cages ||
    p.givens.length !== size ||
    p.regions.length !== size
  ) {
    return { solved: false, solution: null, nodes: 0, timedOut: false }
  }
  const byRules = solveByRules(p.givens, p.regions, p.cages, n, true, 200)
  if (byRules.ok && byRules.solution) {
    return { solved: true, solution: makeState(p, byRules.solution), nodes: 0, timedOut: false }
  }
  if (byRules.contradiction) {
    return { solved: false, solution: null, nodes: 0, timedOut: false }
  }
  const out = search(p.givens, p.regions, p.cages, n, 1, maxNodes)
  const solution = out.solutions[0]
  return {
    solved: !!solution,
    solution: solution ? makeState(p, solution) : null,
    nodes: out.nodes,
    timedOut: out.timedOut,
  }
}

export function makeState(puzzle: SudokuPuzzle, cells: number[]): SudokuState {
  return {
    puzzleId: puzzle.id,
    width: puzzle.width,
    height: puzzle.height,
    cells: cells.slice(),
    givens: puzzle.givens.slice(),
  }
}
