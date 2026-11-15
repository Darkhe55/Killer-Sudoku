/**
 * 杀手数独 —— 规则引擎
 *
 * 单元：行 / 列 / 宫；附加虚线笼：数字不重复且和为给定值。
 */

import { cageIndexMap, type Cage } from './types.ts'

export type RuleKind = 'latin' | 'region' | 'cage'

export type SetCallback = (index: number, value: number, rule: RuleKind) => void

const N = 9
const FULL = 0x1ff

export function initialGrid(givens: ArrayLike<number>, size: number): number[] {
  const grid = new Array<number>(size).fill(0)
  for (let i = 0; i < size; i++) {
    const v = givens[i] ?? 0
    if (v >= 1) grid[i] = v
  }
  return grid
}

export function makeUnits(regions: ArrayLike<number>): number[][] {
  const units: number[][] = []
  for (let y = 0; y < N; y++) {
    const row: number[] = []
    for (let x = 0; x < N; x++) row.push(y * N + x)
    units.push(row)
  }
  for (let x = 0; x < N; x++) {
    const col: number[] = []
    for (let y = 0; y < N; y++) col.push(y * N + x)
    units.push(col)
  }
  for (let r = 0; r < N; r++) {
    const cells: number[] = []
    for (let i = 0; i < N * N; i++) if (regions[i] === r) cells.push(i)
    if (cells.length) units.push(cells)
  }
  return units
}

function popcount(x: number): number {
  let n = 0
  while (x) {
    x &= x - 1
    n++
  }
  return n
}

function digitSum(mask: number): number {
  let sum = 0
  let i = 1
  while (i <= N) {
    if (mask & (1 << (i - 1))) sum += i
    i++
  }
  return sum
}

/** 候选：行/列/宫已用数字 + 同笼已用数字 */
function baseMasks(cells: number[], units: number[][], cageOf: ArrayLike<number>, size: number): number[] {
  const masks = new Array<number>(size).fill(0)
  for (let i = 0; i < size; i++) {
    if (cells[i] !== 0) continue
    let used = 0
    for (const unit of units) {
      if (!unit.includes(i)) continue
      for (const j of unit) {
        const v = cells[j]!
        if (v !== 0) used |= 1 << (v - 1)
      }
    }
    for (let j = 0; j < size; j++) {
      if (j !== i && cageOf[j] === cageOf[i] && cells[j] !== 0) used |= 1 << (cells[j]! - 1)
    }
    masks[i] = FULL & ~used
  }
  return masks
}

/**
 * 笼约束过滤：返回 false 表示矛盾；否则把候选掩码收窄。
 */
function filterCages(
  cells: number[],
  cages: Cage[],
  masks: number[],
  size: number,
): boolean {
  for (const cage of cages) {
    let assignedSum = 0
    let used = 0
    const remaining: number[] = []
    for (const i of cage.cells) {
      const v = cells[i]!
      if (v === 0) {
        remaining.push(i)
        continue
      }
      const bit = 1 << (v - 1)
      if (used & bit) return false
      used |= bit
      assignedSum += v
    }
    if (remaining.length === 0) {
      if (assignedSum !== cage.sum) return false
      continue
    }
    const need = cage.sum - assignedSum
    if (need <= 0) return false
    const avail = FULL & ~used
    const k = remaining.length
    let union = 0
    let sub = avail
    while (sub) {
      if (popcount(sub) === k && digitSum(sub) === need) {
        let ok = true
        for (const i of remaining) {
          if ((masks[i]! & sub) === 0) {
            ok = false
            break
          }
        }
        if (ok) {
          for (let d = 1; d <= N && ok; d++) {
            const bit = 1 << (d - 1)
            if (!(sub & bit)) continue
            let place = false
            for (const i of remaining) {
              if (masks[i]! & bit) {
                place = true
                break
              }
            }
            if (!place) ok = false
          }
          if (ok) union |= sub
        }
      }
      sub = (sub - 1) & avail
    }
    if (union === 0) return false
    for (const i of remaining) {
      masks[i] = masks[i]! & union
      if (masks[i] === 0) return false
    }
  }
  void size
  return true
}

export function propagate(
  cells: number[],
  regions: ArrayLike<number>,
  cages: Cage[],
  onSet?: SetCallback,
): boolean {
  const size = N * N
  const units = makeUnits(regions)
  const cageOf = cageIndexMap(cages, size)
  let changed = true

  const set = (i: number, value: number, kind: RuleKind): boolean => {
    if (cells[i] === value) return true
    if (cells[i] !== 0) return false
    cells[i] = value
    onSet?.(i, value, kind)
    changed = true
    return true
  }

  while (changed) {
    changed = false

    for (const unit of units) {
      const seen = new Set<number>()
      for (const i of unit) {
        const v = cells[i]!
        if (v === 0) continue
        if (seen.has(v)) return false
        seen.add(v)
      }
    }

    const masks = baseMasks(cells, units, cageOf, size)
    if (!filterCages(cells, cages, masks, size)) return false

    for (let i = 0; i < size; i++) {
      if (cells[i] !== 0) continue
      const m = masks[i]!
      if (m === 0) return false
      if ((m & (m - 1)) === 0) {
        const v = 31 - Math.clz32(m) + 1
        if (!set(i, v, 'latin')) return false
      }
    }
    if (changed) continue

    for (const unit of units) {
      let has = 0
      for (const i of unit) if (cells[i] !== 0) has |= 1 << (cells[i]! - 1)
      for (let v = 1; v <= N; v++) {
        const bit = 1 << (v - 1)
        if (has & bit) continue
        const spots: number[] = []
        for (const i of unit) {
          if (cells[i] === 0 && masks[i]! & bit) spots.push(i)
        }
        if (spots.length === 0) return false
        if (spots.length === 1 && !set(spots[0]!, v, 'region')) return false
      }
    }
  }

  return true
}

export function isValidSolution(
  cells: ArrayLike<number>,
  regions: ArrayLike<number>,
  cages: Cage[],
): boolean {
  for (let i = 0; i < N * N; i++) {
    if (cells[i]! < 1 || cells[i]! > N) return false
  }
  const units = makeUnits(regions)
  for (const unit of units) {
    const seen = new Set<number>()
    for (const i of unit) {
      const v = cells[i]!
      if (seen.has(v)) return false
      seen.add(v)
    }
  }
  for (const cage of cages) {
    let sum = 0
    const seen = new Set<number>()
    for (const i of cage.cells) {
      const v = cells[i]!
      if (seen.has(v)) return false
      seen.add(v)
      sum += v
    }
    if (sum !== cage.sum) return false
  }
  return true
}

export interface RuleSolveResult {
  ok: boolean
  solution: number[] | null
  contradiction: boolean
  saturated: boolean
  usedProbing: boolean
}

export function solveByRules(
  givens: ArrayLike<number>,
  regions: ArrayLike<number>,
  cages: Cage[],
  probing = true,
  maxRounds = 400,
): RuleSolveResult {
  const size = N * N
  const grid = initialGrid(givens, size)
  let usedProbing = false
  for (let round = 0; round < maxRounds; round++) {
    if (!propagate(grid, regions, cages)) {
      return { ok: false, solution: null, contradiction: true, saturated: false, usedProbing }
    }
    let unknown = -1
    for (let i = 0; i < size; i++) {
      if (grid[i] === 0) {
        unknown = i
        break
      }
    }
    if (unknown < 0) {
      const solution = Array.from(grid)
      const ok = isValidSolution(solution, regions, cages)
      return { ok, solution: ok ? solution : null, contradiction: false, saturated: ok, usedProbing }
    }
    if (!probing) {
      return { ok: false, solution: null, contradiction: false, saturated: false, usedProbing }
    }
    usedProbing = true
    const forced: Array<{ index: number; value: number }> = []
    for (let i = 0; i < size; i++) {
      if (grid[i] !== 0) continue
      const feasible: number[] = []
      for (let v = 1; v <= N; v++) {
        const trial = grid.slice()
        trial[i] = v
        if (propagate(trial, regions, cages)) feasible.push(v)
      }
      if (feasible.length === 0) {
        return { ok: false, solution: null, contradiction: true, saturated: false, usedProbing }
      }
      if (feasible.length === 1) forced.push({ index: i, value: feasible[0]! })
    }
    if (!forced.length) {
      return { ok: false, solution: null, contradiction: false, saturated: false, usedProbing }
    }
    for (const { index, value } of forced) {
      if (grid[index] === 0) grid[index] = value
    }
    if (!propagate(grid, regions, cages)) {
      return { ok: false, solution: null, contradiction: true, saturated: false, usedProbing }
    }
  }
  return { ok: false, solution: null, contradiction: false, saturated: false, usedProbing }
}
