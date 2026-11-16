/**
 * 杀手数独 —— 实时校验（任意 N / 任意笼）
 */

import type { GameState, Puzzle, ValidationResult } from '../core/types'
import { isValidSolution, makeUnits } from './rules.ts'
import {
  asSudokuPuzzle,
  asSudokuState,
  puzzleSize,
  squareSize,
  type CageIssue,
  type DuplicateIssue,
  type SudokuResult,
} from './types.ts'

export function validate(state: GameState, puzzle: Puzzle): SudokuResult {
  const s = asSudokuState(state)
  const p = asSudokuPuzzle(puzzle)
  const cells = s.cells
  const regions = p.regions ?? []
  const cages = p.cages ?? []
  const n = puzzleSize(p) || squareSize(regions.length) || squareSize(cells.length) || 9
  const size = n * n
  const count = Math.min(size, cells.length)

  let empty = 0
  const changed = new Set<number>()
  for (let i = 0; i < count; i++) {
    if (cells[i] === 0) empty++
    const given = p.givens?.[i] ?? 0
    if (given !== 0 && cells[i] !== given) changed.add(i)
  }

  const bad = new Set<number>()
  for (const i of changed) bad.add(i)
  const duplicateIssues: DuplicateIssue[] = []
  const units = makeUnits(regions, n)
  const kindOf = (u: number): 'row' | 'col' | 'region' =>
    u < n ? 'row' : u < 2 * n ? 'col' : 'region'
  const indexOf = (u: number): number => (u < n ? u : u < 2 * n ? u - n : u - 2 * n)
  for (let u = 0; u < units.length; u++) {
    const unit = units[u]!
    const map = new Map<number, number[]>()
    for (const i of unit) {
      const v = cells[i]!
      if (v === 0) continue
      const list = map.get(v)
      if (list) list.push(i)
      else map.set(v, [i])
    }
    for (const [value, list] of map) {
      if (list.length > 1) {
        duplicateIssues.push({ kind: kindOf(u), index: indexOf(u), value, cells: list })
        for (const i of list) bad.add(i)
      }
    }
  }

  const cageIssues: CageIssue[] = []
  for (let c = 0; c < cages.length; c++) {
    const cage = cages[c]!
    let sum = 0
    let complete = true
    const seen = new Map<number, number[]>()
    for (const i of cage.cells) {
      const v = cells[i]!
      if (v === 0) {
        complete = false
        continue
      }
      sum += v
      const list = seen.get(v) ?? []
      list.push(i)
      seen.set(v, list)
    }
    let duplicate = false
    for (const [, list] of seen) {
      if (list.length > 1) {
        duplicate = true
        for (const i of list) bad.add(i)
      }
    }
    const mismatch = (complete && sum !== cage.sum) || sum > cage.sum
    if (mismatch || duplicate) {
      cageIssues.push({ cage: c, sum: cage.sum, actual: sum, complete, duplicate })
      if (mismatch) for (const i of cage.cells) bad.add(i)
    }
  }

  const complete = empty === 0 && count === size
  const solved =
    complete &&
    duplicateIssues.length === 0 &&
    cageIssues.length === 0 &&
    changed.size === 0 &&
    isValidSolution(cells, regions, cages, n)

  return {
    solved,
    empty,
    complete,
    duplicateIssues,
    cageIssues,
    changedGivens: Array.from(changed),
    badCells: Array.from(bad),
  }
}

export function statusBits(result: ValidationResult): string[] {
  const r = result as SudokuResult
  if (r.solved) return ['完成']
  const bits: string[] = []
  if (typeof r.empty === 'number' && r.empty > 0) bits.push(`还需填 ${r.empty} 格`)
  if (r.duplicateIssues.length > 0) bits.push(`${r.duplicateIssues.length} 处行列/宫重复`)
  if (r.cageIssues.length > 0) bits.push(`${r.cageIssues.length} 个虚线笼不满足`)
  if (r.changedGivens.length > 0) bits.push('题面预填数字被改动')
  if (bits.length === 0) bits.push('继续填数')
  return bits
}
