/**
 * 杀手数独 —— 规则引擎（任意 N）
 *
 * 单元：N 行 / N 列 / 所有宫；附加虚线笼：数字不重复且和为给定值。
 * 位掩码计算，N ≤ 25 时安全（本游戏支持 4..16，custom 上限 16）。
 *
 * 逻辑定式（全部为可证明的候选消除 / 落子，不依赖对内置题硬编码）：
 *   基础：唯一候选（latin）、单元内唯一位置（region）、笼和组合（cage）
 *   高级：宫-行/列交叉（pointing / claiming）、显性/隐性数对与三数组（subset）、
 *         X-Wing / Swordfish（fish）、XY-Wing（wing）、
 *         45 法则 / innies-outies / 笼分割（sum45）
 * 反证/回溯仍由 solveByRules / logic 兜底。
 *
 * 注意：唯一矩形依赖「交换两数字仍满足全部约束」，笼和会被交换破坏，
 * 因此杀手数独不启用唯一矩形（其余高级定式都与笼约束正交，仍然成立）。
 */

import { cageIndexMap, type Cage } from './types.ts'

/** 落子依据：基础规则 + 高级定式 */
export type RuleKind =
  | 'latin'
  | 'region'
  | 'cage'
  | 'pointing'
  | 'claiming'
  | 'subset'
  | 'fish'
  | 'wing'
  | 'sum45'

export type SetCallback = (index: number, value: number, rule: RuleKind) => void

/** 高级定式选项 */
export interface PropagateOptions {
  /** 启用高级定式的最大边长（更大的棋盘只跑基础传播，避免拖慢回溯） */
  maxAdvancedN?: number
}

/** 高级定式内部用于提前退出（候选集被删空 / 无可行组合 = 矛盾） */
class Contradiction extends Error {}

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

const bitOf = (v: number): number => 1 << (v - 1)

export function popcount(x: number): number {
  let n = 0
  while (x) {
    x &= x - 1
    n++
  }
  return n
}

/** 单比特掩码 → 数字（1 基） */
export function lowValue(x: number): number {
  return 31 - Math.clz32(x) + 1
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
  const digits: number[] = []
  for (let d = 1; d <= 25; d++) if (avail & bitOf(d)) digits.push(d)
  if (digits.length < k) return

  const walk = (start: number, left: number, sum: number, mask: number): void => {
    if (left === 0) {
      if (sum === need) cb(mask)
      return
    }
    if (start >= digits.length) return
    if (digits.length - start < left) return
    let minSum = sum
    for (let i = start; i < start + left && i < digits.length; i++) minSum += digits[i]!
    if (minSum > need) return
    let maxSum = sum
    for (let i = digits.length - left; i < digits.length; i++) maxSum += digits[i]!
    if (maxSum < need) return
    for (let i = start; i <= digits.length - left; i++) {
      const d = digits[i]!
      const next = sum + d
      if (next > need) break
      walk(i + 1, left - 1, next, mask | bitOf(d))
    }
  }
  walk(0, k, 0, 0)
}

interface Units {
  all: number[][]
  rows: number[][]
  cols: number[][]
  boxes: number[][]
  unitOf: number[][]
  rowOf: number[]
  colOf: number[]
  /** 每格所属宫在 boxes 数组中的下标（-1 = 无宫） */
  boxOf: number[]
}

function buildUnits(regions: ArrayLike<number>, n: number): Units {
  const size = n * n
  const rows: number[][] = []
  const cols: number[][] = []
  for (let y = 0; y < n; y++) {
    const row: number[] = []
    for (let x = 0; x < n; x++) row.push(y * n + x)
    rows.push(row)
  }
  for (let x = 0; x < n; x++) {
    const col: number[] = []
    for (let y = 0; y < n; y++) col.push(y * n + x)
    cols.push(col)
  }
  const boxMap = new Map<number, number[]>()
  for (let i = 0; i < size; i++) {
    const r = regions[i] ?? 0
    const list = boxMap.get(r)
    if (list) list.push(i)
    else boxMap.set(r, [i])
  }
  const boxes = Array.from(boxMap.values())
  const rowOf = new Array<number>(size)
  const colOf = new Array<number>(size)
  for (let i = 0; i < size; i++) {
    rowOf[i] = Math.floor(i / n)
    colOf[i] = i % n
  }
  const boxOf = new Array<number>(size).fill(-1)
  for (let b = 0; b < boxes.length; b++) for (const i of boxes[b]!) boxOf[i] = b
  const all = [...rows, ...cols, ...boxes]
  return { all, rows, cols, boxes, unitOf: buildUnitIndex(all, size), rowOf, colOf, boxOf }
}

/** 每格与哪些格共享单位（行/列/宫/笼）——XY-Wing 用 */
function buildPeerSets(units: Units, cageCellList: number[][], size: number): number[][] {
  const sets: Array<Set<number>> = Array.from({ length: size }, () => new Set<number>())
  for (const unit of units.all) {
    for (const i of unit) {
      for (const j of unit) if (i !== j) sets[i]!.add(j)
    }
  }
  for (const cells of cageCellList) {
    for (const i of cells) {
      for (const j of cells) if (i !== j) sets[i]!.add(j)
    }
  }
  return sets.map((s) => Array.from(s))
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
      const bit = bitOf(v)
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
    let avail = 0
    for (const i of remaining) avail |= masks[i]!
    avail &= ~used
    if (popcount(avail) < remaining.length) return false

    let union = 0
    forEachDigitSet(avail, remaining.length, need, (set) => {
      for (const i of remaining) {
        if ((masks[i]! & set) === 0) return
      }
      for (let d = 1; d <= 25; d++) {
        const bit = bitOf(d)
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
  options: PropagateOptions = {},
): boolean {
  const size = n * n
  const units = buildUnits(regions, n)
  const full = n >= 31 ? 0x7fffffff : ((1 << n) - 1) >>> 0
  const cageOf = cageIndexMap(cages, size)
  const cageCellList: number[][] = Array.from({ length: cages.length }, () => [])
  for (let i = 0; i < size; i++) {
    const c = cageOf[i]!
    if (c >= 0 && c < cageCellList.length) cageCellList[c]!.push(i)
  }
  const advancedAllowed = n <= (options.maxAdvancedN ?? 16)
  const peers = advancedAllowed ? buildPeerSets(units, cageCellList, size) : null
  const unitSum = (n * (n + 1)) / 2

  /** 被高级定式排除掉的候选（在同一次 propagate 内持续有效：逻辑上不可逆） */
  const banned = new Array<number>(size).fill(0)
  const masks = new Array<number>(size).fill(0)
  let pending = new Map<number, RuleKind>()

  const set = (i: number, value: number, kind: RuleKind): boolean => {
    if (cells[i] === value) return true
    if (cells[i] !== 0) return false
    cells[i] = value
    onSet?.(i, value, kind)
    return true
  }

  /** 依据「行/列/宫 + 同笼已用数字 + 已排除候选」重算全部候选掩码，并跑笼和过滤 */
  const refreshMasks = (): boolean => {
    const cageUsed = new Array<number>(cages.length).fill(0)
    for (let i = 0; i < size; i++) {
      const v = cells[i]!
      if (v !== 0) {
        const c = cageOf[i]!
        if (c >= 0) cageUsed[c]! |= bitOf(v)
      }
    }
    for (let i = 0; i < size; i++) {
      if (cells[i] !== 0) {
        masks[i] = 0
        continue
      }
      let used = 0
      for (const u of units.unitOf[i]!) {
        for (const j of units.all[u]!) {
          const v = cells[j]!
          if (v !== 0) used |= bitOf(v)
        }
      }
      const c = cageOf[i]!
      if (c >= 0) used |= cageUsed[c]!
      masks[i] = full & ~used & ~banned[i]!
    }
    for (let i = 0; i < size; i++) if (cells[i] === 0 && masks[i] === 0) return false
    if (!filterCages(cells, cages, masks)) return false
    return true
  }

  /** 从 i 的候选中删掉一组数字；返回是否真的删掉了 */
  const eliminate = (i: number, remove: number, kind: RuleKind): boolean => {
    if (cells[i] !== 0) return false
    const cur = masks[i]!
    if (cur === 0) return false
    const next = cur & ~remove
    if (next === cur) return false
    banned[i]! |= cur & ~next
    masks[i] = next
    if (next === 0) throw new Contradiction()
    if ((next & (next - 1)) === 0) pending.set(i, kind)
    return true
  }

  // —— 高级定式 —— //

  /** 宫-行/列交叉（指向）：宫内某数字只出现在同一行/列 → 该行/列其余格不能放它 */
  const pointingPass = (): boolean => {
    let eliminated = false
    for (let b = 0; b < units.boxes.length; b++) {
      const box = units.boxes[b]!
      for (let v = 1; v <= n; v++) {
        const bit = bitOf(v)
        let count = 0
        let row = -1
        let col = -1
        let sameRow = true
        let sameCol = true
        for (const i of box) {
          if (cells[i] !== 0 || !(masks[i]! & bit)) continue
          if (count === 0) {
            row = units.rowOf[i]!
            col = units.colOf[i]!
          } else {
            if (units.rowOf[i] !== row) sameRow = false
            if (units.colOf[i] !== col) sameCol = false
          }
          count++
        }
        if (count < 2) continue
        if (sameRow && row >= 0) {
          for (const i of units.rows[row]!) {
            if (units.boxOf[i] === b) continue
            if (eliminate(i, bit, 'pointing')) eliminated = true
          }
        }
        if (sameCol && col >= 0) {
          for (const i of units.cols[col]!) {
            if (units.boxOf[i] === b) continue
            if (eliminate(i, bit, 'pointing')) eliminated = true
          }
        }
      }
    }
    return eliminated
  }

  /** 行/列-宫交叉（占位）：行/列内某数字只出现在同一宫 → 该宫其余格不能放它 */
  const claimingPass = (): boolean => {
    let eliminated = false
    const lines: Array<{ cells: number[]; index: number; isRow: boolean }> = []
    for (let r = 0; r < n; r++) lines.push({ cells: units.rows[r]!, index: r, isRow: true })
    for (let c = 0; c < n; c++) lines.push({ cells: units.cols[c]!, index: c, isRow: false })
    for (const line of lines) {
      for (let v = 1; v <= n; v++) {
        const bit = bitOf(v)
        let box = -1
        let count = 0
        let mixed = false
        for (const i of line.cells) {
          if (cells[i] !== 0 || !(masks[i]! & bit)) continue
          const b = units.boxOf[i]!
          if (b < 0 || (box >= 0 && b !== box)) {
            mixed = true
            break
          }
          box = b
          count++
        }
        if (mixed || count < 2 || box < 0) continue
        for (const i of units.boxes[box]!) {
          if (line.isRow ? units.rowOf[i] === line.index : units.colOf[i] === line.index) continue
          if (eliminate(i, bit, 'claiming')) eliminated = true
        }
      }
    }
    return eliminated
  }

  /** 显性数对 / 三数组：k 格候选并集恰为 k 个数字 → 该单元其余格不能放这些数字 */
  const nakedSubsetPass = (): boolean => {
    let eliminated = false
    for (const unit of units.all) {
      const spots: number[] = []
      for (const i of unit) if (cells[i] === 0 && popcount(masks[i]!) >= 2) spots.push(i)
      const m = spots.length
      if (m < 2) continue
      for (let a = 0; a < m - 1; a++) {
        const ia = spots[a]!
        const ma = masks[ia]!
        if (popcount(ma) > 3) continue
        for (let b = a + 1; b < m; b++) {
          const ib = spots[b]!
          const pairUnion = ma | masks[ib]!
          const pc = popcount(pairUnion)
          if (pc === 2) {
            for (const i of unit) {
              if (i !== ia && i !== ib && eliminate(i, pairUnion, 'subset')) eliminated = true
            }
            continue
          }
          if (pc > 3) continue
          for (let c = b + 1; c < m; c++) {
            const ic = spots[c]!
            const tripleUnion = pairUnion | masks[ic]!
            if (popcount(tripleUnion) !== 3) continue
            for (const i of unit) {
              if (i !== ia && i !== ib && i !== ic && eliminate(i, tripleUnion, 'subset')) eliminated = true
            }
          }
        }
      }
    }
    return eliminated
  }

  /** 隐性数对 / 三数组：k 个数字只能落在同一单元的 k 格里 → 这 k 格不能再放别的数字 */
  const hiddenSubsetPass = (): boolean => {
    let eliminated = false
    for (const unit of units.all) {
      const posOfDigit: number[][] = Array.from({ length: n + 1 }, () => [])
      for (const i of unit) {
        if (cells[i] !== 0) continue
        const m = masks[i]!
        for (let v = 1; v <= n; v++) if (m & bitOf(v)) posOfDigit[v]!.push(i)
      }
      const active: number[] = []
      for (let v = 1; v <= n; v++) {
        const len = posOfDigit[v]!.length
        if (len >= 2 && len <= 3) active.push(v)
      }
      for (let a = 0; a < active.length - 1; a++) {
        const va = active[a]!
        const pa = posOfDigit[va]!
        for (let b = a + 1; b < active.length; b++) {
          const vb = active[b]!
          const pairSet = new Set<number>([...pa, ...posOfDigit[vb]!])
          if (pairSet.size === 2) {
            const digits = bitOf(va) | bitOf(vb)
            for (const i of pairSet) if (eliminate(i, full & ~digits, 'subset')) eliminated = true
            continue
          }
          if (pairSet.size !== 3) continue
          for (let c = b + 1; c < active.length; c++) {
            const vc = active[c]!
            const tripleSet = new Set<number>([...pa, ...posOfDigit[vb]!, ...posOfDigit[vc]!])
            if (tripleSet.size !== 3) continue
            const digits = bitOf(va) | bitOf(vb) | bitOf(vc)
            for (const i of tripleSet) if (eliminate(i, full & ~digits, 'subset')) eliminated = true
          }
        }
      }
    }
    return eliminated
  }

  /** X-Wing：某个数字在两行中都只出现在同样两列 → 这两列的其余行不能放它（列同理） */
  const xWingPass = (): boolean => {
    let eliminated = false
    for (let v = 1; v <= n; v++) {
      const bit = bitOf(v)
      const rowSpots: number[][] = []
      for (let r = 0; r < n; r++) {
        const spots: number[] = []
        for (const i of units.rows[r]!) if (cells[i] === 0 && masks[i]! & bit) spots.push(i)
        rowSpots.push(spots)
      }
      for (let r1 = 0; r1 < n - 1; r1++) {
        const s1 = rowSpots[r1]!
        if (s1.length !== 2) continue
        const c1 = units.colOf[s1[0]!]!
        const c2 = units.colOf[s1[1]!]!
        for (let r2 = r1 + 1; r2 < n; r2++) {
          const s2 = rowSpots[r2]!
          if (s2.length !== 2) continue
          if (units.colOf[s2[0]!] !== c1 || units.colOf[s2[1]!] !== c2) continue
          for (let r = 0; r < n; r++) {
            if (r === r1 || r === r2) continue
            for (const i of units.rows[r]!) {
              const c = units.colOf[i]!
              if (c !== c1 && c !== c2) continue
              if (eliminate(i, bit, 'fish')) eliminated = true
            }
          }
        }
      }
      const colSpots: number[][] = []
      for (let c = 0; c < n; c++) {
        const spots: number[] = []
        for (const i of units.cols[c]!) if (cells[i] === 0 && masks[i]! & bit) spots.push(i)
        colSpots.push(spots)
      }
      for (let c1 = 0; c1 < n - 1; c1++) {
        const s1 = colSpots[c1]!
        if (s1.length !== 2) continue
        const r1 = units.rowOf[s1[0]!]!
        const r2 = units.rowOf[s1[1]!]!
        for (let c2 = c1 + 1; c2 < n; c2++) {
          const s2 = colSpots[c2]!
          if (s2.length !== 2) continue
          if (units.rowOf[s2[0]!] !== r1 || units.rowOf[s2[1]!] !== r2) continue
          for (let c = 0; c < n; c++) {
            if (c === c1 || c === c2) continue
            for (const i of units.cols[c]!) {
              const r = units.rowOf[i]!
              if (r !== r1 && r !== r2) continue
              if (eliminate(i, bit, 'fish')) eliminated = true
            }
          }
        }
      }
    }
    return eliminated
  }

  /** Swordfish：某个数字在三行中只落在三列内 → 这三列的其余行不能放它（列同理） */
  const swordfishPass = (): boolean => {
    let eliminated = false
    for (let v = 1; v <= n; v++) {
      const bit = bitOf(v)
      const rowSpots: number[][] = []
      for (let r = 0; r < n; r++) {
        const spots: number[] = []
        for (const i of units.rows[r]!) if (cells[i] === 0 && masks[i]! & bit) spots.push(i)
        rowSpots.push(spots)
      }
      for (let r1 = 0; r1 < n - 2; r1++) {
        const s1 = rowSpots[r1]!
        if (s1.length < 2 || s1.length > 3) continue
        for (let r2 = r1 + 1; r2 < n - 1; r2++) {
          const s2 = rowSpots[r2]!
          if (s2.length < 2 || s2.length > 3) continue
          for (let r3 = r2 + 1; r3 < n; r3++) {
            const s3 = rowSpots[r3]!
            if (s3.length < 2 || s3.length > 3) continue
            const colSet = new Set<number>()
            let tooWide = false
            for (const i of s1) {
              colSet.add(units.colOf[i]!)
              if (colSet.size > 3) tooWide = true
            }
            for (const i of s2) {
              colSet.add(units.colOf[i]!)
              if (colSet.size > 3) tooWide = true
            }
            for (const i of s3) {
              colSet.add(units.colOf[i]!)
              if (colSet.size > 3) tooWide = true
            }
            if (tooWide || colSet.size !== 3) continue
            const cols = Array.from(colSet)
            for (let r = 0; r < n; r++) {
              if (r === r1 || r === r2 || r === r3) continue
              for (const i of units.rows[r]!) {
                if (!cols.includes(units.colOf[i]!)) continue
                if (eliminate(i, bit, 'fish')) eliminated = true
              }
            }
          }
        }
      }
      const colSpots: number[][] = []
      for (let c = 0; c < n; c++) {
        const spots: number[] = []
        for (const i of units.cols[c]!) if (cells[i] === 0 && masks[i]! & bit) spots.push(i)
        colSpots.push(spots)
      }
      for (let c1 = 0; c1 < n - 2; c1++) {
        const s1 = colSpots[c1]!
        if (s1.length < 2 || s1.length > 3) continue
        for (let c2 = c1 + 1; c2 < n - 1; c2++) {
          const s2 = colSpots[c2]!
          if (s2.length < 2 || s2.length > 3) continue
          for (let c3 = c2 + 1; c3 < n; c3++) {
            const s3 = colSpots[c3]!
            if (s3.length < 2 || s3.length > 3) continue
            const rowSet = new Set<number>()
            let tooWide = false
            for (const i of s1) {
              rowSet.add(units.rowOf[i]!)
              if (rowSet.size > 3) tooWide = true
            }
            for (const i of s2) {
              rowSet.add(units.rowOf[i]!)
              if (rowSet.size > 3) tooWide = true
            }
            for (const i of s3) {
              rowSet.add(units.rowOf[i]!)
              if (rowSet.size > 3) tooWide = true
            }
            if (tooWide || rowSet.size !== 3) continue
            const rows = Array.from(rowSet)
            for (let c = 0; c < n; c++) {
              if (c === c1 || c === c2 || c === c3) continue
              for (const i of units.cols[c]!) {
                if (!rows.includes(units.rowOf[i]!)) continue
                if (eliminate(i, bit, 'fish')) eliminated = true
              }
            }
          }
        }
      }
    }
    return eliminated
  }

  /** XY-Wing：支点 {a,b}，两翼 {a,c} / {b,c} → 同时看见两翼的格子不能放 c */
  const xyWingPass = (): boolean => {
    if (!peers) return false
    let eliminated = false
    for (let p = 0; p < size; p++) {
      if (cells[p] !== 0) continue
      const mp = masks[p]!
      if (popcount(mp) !== 2) continue
      const a = lowValue(mp & -mp)
      const b = lowValue(mp & (mp - 1))
      const wingsA: number[] = []
      const wingsB: number[] = []
      for (const j of peers[p]!) {
        if (cells[j] !== 0) continue
        const mj = masks[j]!
        if (popcount(mj) !== 2) continue
        if (mj & bitOf(a)) {
          if (mj & bitOf(b)) continue
          wingsA.push(j)
        } else if (mj & bitOf(b)) {
          wingsB.push(j)
        }
      }
      for (const wa of wingsA) {
        const c = lowValue(masks[wa]! & ~bitOf(a))
        if (!c || c === b || c === a) continue
        for (const wb of wingsB) {
          if (!(masks[wb]! & bitOf(b)) || !(masks[wb]! & bitOf(c))) continue
          const common: number[] = []
          for (const j of peers[wa]!) {
            if (j === p || j === wa || j === wb) continue
            if (peers[wb]!.includes(j)) common.push(j)
          }
          for (const j of common) if (eliminate(j, bitOf(c), 'wing')) eliminated = true
        }
      }
    }
    return eliminated
  }

  /**
   * 按给定和收窄一组格子的候选（数字互不重复）。
   * ok=false 表示无可行组合（矛盾）；changed 表示候选确实被收窄。
   */
  const restrictBySum = (group: number[], need: number): { ok: boolean; changed: boolean } => {
    let avail = 0
    for (const i of group) avail |= masks[i]!
    let union = 0
    forEachDigitSet(avail, group.length, need, (digitSet) => {
      for (const i of group) if ((masks[i]! & digitSet) === 0) return
      for (let d = 1; d <= n; d++) {
        const bit = bitOf(d)
        if (!(digitSet & bit)) continue
        let place = false
        for (const i of group) {
          if (masks[i]! & bit) {
            place = true
            break
          }
        }
        if (!place) return
      }
      union |= digitSet
    })
    if (union === 0) return { ok: false, changed: false }
    let changed = false
    for (const i of group) {
      const m = masks[i]! & union
      if (m === 0) return { ok: false, changed }
      if (m !== masks[i]) {
        banned[i]! |= masks[i]! & ~m
        masks[i] = m
        changed = true
        if ((m & (m - 1)) === 0) pending.set(i, 'sum45')
      }
    }
    return { ok: true, changed }
  }

  /**
   * 45 法则 / innies-outies / 笼分割。
   *
   * 任取一个「总和已知」的格集（一行/一列/一宫 = N(N+1)/2；连续 k 行/列 = k 倍）：
   * 完全落在其中的笼已知其和，剩下未覆盖的格子 U 的总和 = 总和 - 已知笼和。
   *   - |U| = 1：该格直接落子（innie）；
   *   - U 全在同一个笼里：U 的数字互不重复，按这个和枚举组合收窄候选（笼分割）。
   */
  const sum45Pass = (): boolean => {
    let eliminated = false
    const groups: Array<{ cells: number[]; sum: number }> = []
    for (let a = 0; a < n; a++) {
      for (let b = a; b < n; b++) {
        const rows: number[] = []
        const cols: number[] = []
        for (let t = a; t <= b; t++) {
          for (let u = 0; u < n; u++) {
            rows.push(t * n + u)
            cols.push(u * n + t)
          }
        }
        groups.push({ cells: rows, sum: (b - a + 1) * unitSum })
        groups.push({ cells: cols, sum: (b - a + 1) * unitSum })
      }
    }
    for (const unit of units.boxes) if (unit.length === n) groups.push({ cells: unit, sum: unitSum })

    for (const group of groups) {
      const inGroup = new Set<number>(group.cells)
      let knownSum = 0
      const covered = new Set<number>()
      for (const cage of cages) {
        let all = true
        for (const i of cage.cells) {
          if (!inGroup.has(i)) {
            all = false
            break
          }
        }
        if (!all) continue
        knownSum += cage.sum
        for (const i of cage.cells) covered.add(i)
      }
      const rest: number[] = []
      let filledSum = 0
      const emptyRest: number[] = []
      for (const i of group.cells) {
        if (covered.has(i)) continue
        rest.push(i)
        if (cells[i] !== 0) filledSum += cells[i]!
        else emptyRest.push(i)
      }
      if (emptyRest.length === 0) {
        if (rest.length === 0 && knownSum !== group.sum) throw new Contradiction()
        if (rest.length > 0 && group.sum - knownSum - filledSum !== 0) throw new Contradiction()
        continue
      }
      const needSum = group.sum - knownSum - filledSum
      if (needSum <= 0) throw new Contradiction()
      if (emptyRest.length === 1) {
        const i = emptyRest[0]!
        if (needSum < 1 || needSum > n) throw new Contradiction()
        if (!(masks[i]! & bitOf(needSum))) throw new Contradiction()
        if (!set(i, needSum, 'sum45')) throw new Contradiction()
        pending.set(i, 'sum45')
        return eliminated
      }
      // 未覆盖的空格必须全在同一个笼里，才能用「数字互不重复」的和组合
      let cageId = -1
      let same = true
      for (const i of emptyRest) {
        const c = cageOf[i]!
        if (cageId < 0) cageId = c
        else if (c !== cageId) {
          same = false
          break
        }
      }
      if (!same || cageId < 0) continue
      const narrowed = restrictBySum(emptyRest, needSum)
      if (!narrowed.ok) throw new Contradiction()
      if (narrowed.changed) eliminated = true
      if (pending.size) return eliminated
    }
    return eliminated
  }

  /** 笼和组合收窄（refreshMasks 已做过一次；高级消除后候选更窄，需要再跑） */
  const cagePass = (): boolean => {
    const before = masks.slice()
    if (!filterCages(cells, cages, masks)) throw new Contradiction()
    let changed = false
    for (let i = 0; i < size; i++) {
      if (cells[i] !== 0) continue
      if (masks[i] !== before[i]) {
        changed = true
        if (masks[i] === 0) throw new Contradiction()
        if ((masks[i]! & (masks[i]! - 1)) === 0) pending.set(i, 'cage')
      }
    }
    return changed
  }

  /** 依次跑全部高级定式；一旦出现「候选变唯一」的落子就提前返回 */
  const runTechniques = (): { contradiction: boolean; eliminated: boolean } => {
    let eliminated = false
    try {
      for (const pass of [
        cagePass,
        pointingPass,
        claimingPass,
        nakedSubsetPass,
        hiddenSubsetPass,
        xWingPass,
        swordfishPass,
        xyWingPass,
        sum45Pass,
      ]) {
        if (pass()) eliminated = true
        if (pending.size) return { contradiction: false, eliminated }
      }
    } catch (e) {
      if (e instanceof Contradiction) return { contradiction: true, eliminated }
      throw e
    }
    return { contradiction: false, eliminated }
  }

  // —— 主循环：基础传播到不动点，再跑高级定式；任何落子后从基础传播重来 —— //
  for (;;) {
    for (const unit of units.all) {
      const seen = new Set<number>()
      for (const i of unit) {
        const v = cells[i]!
        if (v === 0) continue
        if (seen.has(v)) return false
        seen.add(v)
      }
    }

    if (!refreshMasks()) return false

    // 唯一候选
    let placed = false
    for (let i = 0; i < size; i++) {
      if (cells[i] !== 0) continue
      const m = masks[i]!
      if ((m & (m - 1)) === 0) {
        if (!set(i, lowValue(m), 'latin')) return false
        placed = true
      }
    }
    if (placed) continue

    // 单元内唯一位置（隐性唯一）；先收集再统一落子
    const hidden: Array<{ index: number; value: number }> = []
    for (const unit of units.all) {
      for (let v = 1; v <= n; v++) {
        const bit = bitOf(v)
        let spot = -1
        let count = 0
        let placedHere = false
        for (const i of unit) {
          if (cells[i] === 0 && masks[i]! & bit) {
            spot = i
            count++
          } else if (cells[i] === v) placedHere = true
        }
        if (count === 0) {
          if (!placedHere) return false
          continue
        }
        if (count === 1) hidden.push({ index: spot, value: v })
      }
    }
    if (hidden.length) {
      for (const { index, value } of hidden) {
        if (cells[index] !== 0) continue
        if (!set(index, value, 'region')) return false
      }
      continue
    }

    if (!advancedAllowed) return true

    // 高级定式：反复消除直到不动点；一旦出现落子就从基础传播重来
    let restart = false
    for (;;) {
      pending = new Map<number, RuleKind>()
      const res = runTechniques()
      if (res.contradiction) return false
      if (pending.size) {
        for (const [i, kind] of pending) {
          if (cells[i] !== 0) continue
          if (!set(i, lowValue(masks[i]!), kind)) return false
        }
        restart = true
        break
      }
      if (!res.eliminated) return true
    }
    if (restart) continue
    return true
  }
}

export function isValidSolution(
  cells: ArrayLike<number>,
  regions: ArrayLike<number>,
  cages: Cage[],
  n = sizeOf(cells),
): boolean {
  const size = n * n
  if (cells.length < size) return false
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
  options: PropagateOptions = {},
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
    if (!propagate(grid, regions, cages, n, undefined, options)) return out({ contradiction: true })
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
        if (propagate(trial, regions, cages, n, undefined, options)) feasible.push(v)
      }
      if (feasible.length === 0) return out({ contradiction: true })
      if (feasible.length === 1) forced.push({ index: i, value: feasible[0]! })
    }
    if (!forced.length) return out({})
    for (const { index, value } of forced) {
      if (grid[index] === 0) grid[index] = value
    }
    if (!propagate(grid, regions, cages, n, undefined, options)) return out({ contradiction: true })
  }
  return out({})
}
