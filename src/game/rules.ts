/**
 * 杀手数独 —— 规则引擎（任意 N）
 *
 * 单元：N 行 / N 列 / 所有宫；附加虚线笼：数字不重复且和为给定值。
 * 位掩码计算，N ≤ 25 时安全（本游戏支持 4..16，custom 上限 16）。
 */

import { cageIndexMap, type Cage } from './types.ts'

export type RuleKind = 'latin' | 'region' | 'cage'

export type SetCallback = (index: number, value: number, rule: RuleKind) => void

/** 根号面积 → N（用于旧调用） */
export function sizeOf(cells: ArrayLike<number>, fallback = 9): number {
  const area = cells.length
  const n = Math.round(Math.sqrt(area))
  return n > 0 && n * n === area ? n : fallback
}

export function initialGrid(givens: ArrayLike<number>, n: number): number[] {
  const size = n * n
  const grid = new Array<number>(size).fill(0)
  for (let i = 0; i < size; i++) {
    const v = givens[i] ?? 0
    if (v >= 1 && v <= n) grid[i] = v
  }
  return grid
}

/** 生成全部单位：N 行 + N 列 + 所有宫（按宫号分组） */
export function makeUnits(regions: ArrayLike<number>, n: number): number[][] {
  const size = n * n
  const units: number[][] = []
  for (let y = 0; y < n; y++) {
    const row: number[] = []
    for (let x = 0; x < n; x++) row.push(y * n + x)
    units.push(row)
  }
  for (let x = 0; x < n; x++) {
    const col: number[] = []
    for (let y = 0; y < n; y++) col.push(y * n + x)
    units.push(col)
  }
  const byRegion = new Map<number, number[]>()
  for (let i = 0; i < size; i++) {
    const r = regions[i] ?? 0
    const list = byRegion.get(r)
    if (list) list.push(i)
    else byRegion.set(r, [i])
  }
  for (const cells of byRegion.values()) units.push(cells)
  return units
}

function buildUnitIndex(units: number[][], size: number): number[][] {
  const unitOf: number[][] = Array.from({ length: size }, () => [])
  for (let u = 0; u < units.length; u++) {
    for (const i of units[u]!) if (i >= 0 && i < size) unitOf[i]!.push(u)
  }
  return unitOf
}

function popcount(x: number): number {
  let n = 0
  while (x) {
    x &= x - 1
    n++
  }
  return n
}

/**
 * 枚举 avail 中大小恰为 k、和恰为 need 的数字集合，回调每个可行集合的掩码。
 * 用升序 DFS + 最小/最大和剪枝，避免全子集枚举（大 N / 大笼会慢）。
 */
function forEachDigitSet(
  avail: number,
  k: number,
  need: number,
  cb: (mask: number) => void,
): void {
  if (k <= 0) return
  // 可用的数字列表（升序）
  const digits: number[] = []
  for (let d = 1; d <= 25; d++) if (avail & (1 << (d - 1))) digits.push(d)
  if (digits.length < k) return

  const walk = (start: number, left: number, sum: number, mask: number): void => {
    if (left === 0) {
      if (sum === need) cb(mask)
      return
    }
    if (start >= digits.length) return
    // 剩余可选数字数量不足
    if (digits.length - start < left) return
    // 剪枝：接下来 left 个最小/最大可能和
    let minSum = sum
    for (let i = start; i < start + left && i < digits.length; i++) minSum += digits[i]!
    if (minSum > need) return
    let maxSum = sum
    for (let i = digits.length - left; i < digits.length; i++) maxSum += digits[i]!
    if (maxSum < need) return
    for (let i = start; i <= digits.length - left; i++) {
      const d = digits[i]!
      const bit = 1 << (d - 1)
      const next = sum + d
      if (next > need) break
      walk(i + 1, left - 1, next, mask | bit)
    }
  }
  walk(0, k, 0, 0)
}

/** 候选：行/列/宫已用数字 + 同笼已用数字 */
function baseMasks(
  cells: number[],
  unitOf: number[][],
  units: number[][],
  cageOf: ArrayLike<number>,
  n: number,
): number[] {
  const size = n * n
  const full = ((1 << n) - 1) >>> 0
  const masks = new Array<number>(size).fill(0)
  for (let i = 0; i < size; i++) {
    if (cells[i] !== 0) continue
    let used = 0
    for (const u of unitOf[i]!) {
      for (const j of units[u]!) {
        const v = cells[j]!
        if (v !== 0) used |= 1 << (v - 1)
      }
    }
    for (let j = 0; j < size; j++) {
      if (j !== i && cageOf[j] === cageOf[i] && cells[j] !== 0) used |= 1 << (cells[j]! - 1)
    }
    masks[i] = full & ~used
  }
  return masks
}

/** 笼约束过滤：返回 false 表示矛盾；否则把候选掩码收窄 */
function filterCages(cells: number[], cages: Cage[], masks: number[]): boolean {
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
    // 可用数字：所有 remaining 格的候选并集，去掉笼内已用
    let avail = 0
    for (const i of remaining) avail |= masks[i]!
    avail &= ~used
    if (popcount(avail) < remaining.length) return false

    let union = 0
    forEachDigitSet(avail, remaining.length, need, (set) => {
      // 每个 remaining 格都必须至少能放集合里的一个数字
      let ok = true
      for (const i of remaining) {
        if ((masks[i]! & set) === 0) {
          ok = false
          break
        }
      }
      if (!ok) return
      // 集合里每个数字都必须有格子可放
      for (let d = 1; d <= 25; d++) {
        const bit = 1 << (d - 1)
        if (!(set & bit)) continue
        let place = false
        for (const i of remaining) {
          if (masks[i]! & bit) {
            place = true
            break
          }
        }
        if (!place) return
      }
      union |= set
    })
    if (union === 0) return false
    for (const i of remaining) {
      masks[i] = masks[i]! & union
      if (masks[i] === 0) return false
    }
  }
  return true
}

export function propagate(
  cells: number[],
  regions: ArrayLike<number>,
  cages: Cage[],
  n = sizeOf(cells),
  onSet?: SetCallback,
): boolean {
  const size = n * n
  const units = makeUnits(regions, n)
  const unitOf = buildUnitIndex(units, size)
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

    const masks = baseMasks(cells, unitOf, units, cageOf, n)
    if (!filterCages(cells, cages, masks)) return false

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
      for (let v = 1; v <= n; v++) {
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
  n = sizeOf(cells),
): boolean {
  const size = n * n
  for (let i = 0; i < size; i++) {
    const v = cells[i]!
    if (v < 1 || v > n) return false
  }
  const units = makeUnits(regions, n)
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
  n = sizeOf(givens),
  probing = true,
  maxRounds = 400,
  budgetMs = n > 9 ? 4_000 : 60_000,
): RuleSolveResult {
  const size = n * n
  const grid = initialGrid(givens, n)
  const deadline = Date.now() + budgetMs
  let usedProbing = false
  const out = (partial: Partial<RuleSolveResult>): RuleSolveResult => ({
    ok: false,
    solution: null,
    contradiction: false,
    saturated: false,
    usedProbing,
    ...partial,
  })

  for (let round = 0; round < maxRounds; round++) {
    if (Date.now() > deadline) return out({})
    if (!propagate(grid, regions, cages, n)) return out({ contradiction: true })
    let unknown = -1
    for (let i = 0; i < size; i++) {
      if (grid[i] === 0) {
        unknown = i
        break
      }
    }
    if (unknown < 0) {
      const solution = Array.from(grid)
      const ok = isValidSolution(solution, regions, cages, n)
      return { ok, solution: ok ? solution : null, contradiction: false, saturated: ok, usedProbing }
    }
    if (!probing) return out({})
    usedProbing = true
    const forced: Array<{ index: number; value: number }> = []
    for (let i = 0; i < size; i++) {
      if (grid[i] !== 0) continue
      if (Date.now() > deadline) return out({})
      const feasible: number[] = []
      for (let v = 1; v <= n; v++) {
        const trial = grid.slice()
        trial[i] = v
        if (propagate(trial, regions, cages, n)) feasible.push(v)
      }
      if (feasible.length === 0) return out({ contradiction: true })
      if (feasible.length === 1) forced.push({ index: i, value: feasible[0]! })
    }
    if (!forced.length) return out({})
    for (const { index, value } of forced) {
      if (grid[index] === 0) grid[index] = value
    }
    if (!propagate(grid, regions, cages, n)) return out({ contradiction: true })
  }
  return out({})
}
