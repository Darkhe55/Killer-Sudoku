/**
 * 杀手数独（Killer Sudoku）—— 游戏专用类型
 *
 * 规则：N×N 格填 1..N，行/列/宫（标准矩形宫：4→2×2、6→2×3、9→3×3、
 * 12→3×4、16→4×4）内不重复；同一虚线笼内数字也不重复，且笼内数字之和
 * 等于笼角标注的数字。
 *
 * 编码（board 串，三段）：
 *   givens | regions | cageOf:sums
 *   - givens / regions：每格 1 个 36 进制字符（0 = 空 / 宫号 0..35）
 *   - cageOf：每格 1 个 36 进制字符（笼编号 0..35）
 *   - sums：笼和列表，十进制逗号分隔，按笼编号顺序
 *   旧 9×9 题库（givens/regions 都是 '0'..'9' 数字字符）与新格式逐字节一致。
 */

import type { GameState, Puzzle, ValidationResult } from '../core/types'

/** 36 进制字符表 */
export const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** 自定义题板 / 导入题支持的最小边长 */
export const MIN_KILLER_SIZE = 4
/** 支持的最大边长（笼和 / 求解性能上限） */
export const MAX_KILLER_SIZE = 16

export interface Cage {
  cells: number[]
  sum: number
}

export interface SudokuPuzzle extends Puzzle {
  /** 每格所属宫号（0 起，标准矩形宫） */
  regions: number[]
  /** 题面预填：0 = 空，1..N = 数字 */
  givens: number[]
  /** 虚线笼 */
  cages: Cage[]
  solution?: number[]
}

export interface SudokuState extends GameState {
  cells: number[]
  givens: number[]
  /** 每格候选数 bitmask（bit v-1 = 候选 v）；可选，缺省视为 0 */
  notes?: number[]
}

export interface DuplicateIssue {
  kind: 'row' | 'col' | 'region'
  index: number
  value: number
  cells: number[]
}

export interface CageIssue {
  cage: number
  sum: number
  actual: number
  complete: boolean
  duplicate: boolean
}

export interface SudokuResult extends ValidationResult {
  empty: number
  complete: boolean
  duplicateIssues: DuplicateIssue[]
  cageIssues: CageIssue[]
  changedGivens: number[]
  badCells: number[]
}

export function asSudokuPuzzle(p: Puzzle): SudokuPuzzle {
  return p as SudokuPuzzle
}

export function asSudokuState(s: GameState): SudokuState {
  return s as SudokuState
}

/** 1 基数值 → 编码字符；0 或非法值返回空串 */
export function symbolOf(value: number): string {
  if (!Number.isFinite(value)) return ''
  const v = Math.floor(value)
  if (v <= 0) return ''
  return v < BASE36.length ? BASE36[v]! : String(v)
}

/** 编码字符 → 数值；'0' → 0；非法字符 → -1（兼容旧题库的 0-9a-z 笼号） */
export function valueOfSymbol(ch: string): number {
  if (typeof ch !== 'string' || ch.length !== 1) return -1
  return BASE36.indexOf(ch.toUpperCase())
}

/** 面积 → 边长；不是正整数平方返回 0 */
export function squareSize(area: number): number {
  if (!Number.isInteger(area) || area <= 0) return 0
  const n = Math.round(Math.sqrt(area))
  return n > 0 && n * n === area ? n : 0
}

/** 题面棋盘边长（要求正方形，非正方形返回 0） */
export function puzzleSize(p: { width: number; height: number }): number {
  const w = p.width
  const h = p.height
  if (!Number.isInteger(w) || !Number.isInteger(h) || w !== h) return 0
  return w
}

/** 边长 N 是否在支持范围 */
export function isValidKillerSize(n: number): boolean {
  return Number.isInteger(n) && n >= MIN_KILLER_SIZE && n <= MAX_KILLER_SIZE
}

/** N 的标准宫分块尺寸（矩形宫；质数退化为 1×N） */
export function standardBoxDims(n: number): { rows: number; cols: number } {
  const size = Number.isInteger(n) && n > 0 ? n : 9
  for (let r = Math.floor(Math.sqrt(size)); r >= 2; r--) {
    if (size % r === 0) return { rows: r, cols: size / r }
  }
  return { rows: 1, cols: size }
}

/** 标准矩形宫划分（宫数 = N，宫格数 = N） */
export function standardRegionsOf(n: number): number[] {
  const size = Number.isInteger(n) && n > 0 ? n : 9
  const { rows, cols } = standardBoxDims(size)
  const boxesPerRow = Math.max(1, Math.ceil(size / cols))
  const out = new Array<number>(size * size).fill(0)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out[y * size + x] = Math.floor(y / rows) * boxesPerRow + Math.floor(x / cols)
    }
  }
  return out
}

/** 旧接口：9×9 标准九宫 */
export function standardRegions(): number[] {
  return standardRegionsOf(9)
}

/** 笼内最大可能和：N(N+1)/2 */
export function maxCageSum(n: number): number {
  return (n * (n + 1)) / 2
}

/** 题面编码：givens|regions|cageOf:sums */
export function encodeBoard(
  givens: ArrayLike<number>,
  regions: ArrayLike<number>,
  cages: Cage[],
): string {
  const chars = (values: ArrayLike<number>, limit = BASE36.length): string => {
    let out = ''
    for (let i = 0; i < values.length; i++) {
      const v = Math.floor(values[i] ?? 0)
      out += v >= 0 && v < limit ? BASE36[v]! : '0'
    }
    return out
  }
  const cageOf = cageIndexMap(cages, givens.length)
  const sums = cages.map((c) => Math.max(0, Math.floor(c.sum))).join(',')
  return `${chars(givens)}|${chars(regions)}|${chars(cageOf)}:${sums}`
}

/** 题面解码；失败返回 null（旧 9×9 格式天然兼容） */
export function decodeBoard(
  text: string,
  n: number,
): { givens: number[]; regions: number[]; cages: Cage[] } | null {
  const size = n * n
  if (typeof text !== 'string') return null
  const parts = text.split('|')
  if (parts.length !== 3) return null
  const givenText = parts[0]!
  const regionText = parts[1]!
  const cageText = parts[2]!
  if (givenText.length !== size || regionText.length !== size) return null
  const colon = cageText.indexOf(':')
  if (colon !== size) return null
  const idText = cageText.slice(0, colon)
  const sumsText = cageText.slice(colon + 1)

  const givens = new Array<number>(size).fill(0)
  const regions = new Array<number>(size).fill(0)
  const cageOf = new Array<number>(size).fill(0)
  const sums: number[] = []
  let maxCage = -1
  for (let i = 0; i < size; i++) {
    const g = valueOfSymbol(givenText[i]!)
    const r = valueOfSymbol(regionText[i]!)
    const c = valueOfSymbol(idText[i]!)
    if (g < 0 || g > n || r < 0 || r >= 36 || c < 0) return null
    givens[i] = g
    regions[i] = r
    cageOf[i] = c
    if (c > maxCage) maxCage = c
  }
  if (maxCage < 0) return null
  if (sumsText.length === 0) return null
  for (const piece of sumsText.split(',')) {
    const s = Number(piece)
    if (!Number.isInteger(s) || s < 1 || s > maxCageSum(n)) return null
    sums.push(s)
  }
  if (sums.length !== maxCage + 1) return null

  const cages: Cage[] = Array.from({ length: maxCage + 1 }, (_, c) => ({ cells: [], sum: sums[c]! }))
  for (let i = 0; i < size; i++) cages[cageOf[i]!]!.cells.push(i)
  for (const cage of cages) {
    if (cage.cells.length === 0 || cage.cells.length > n) return null
  }
  return { givens, regions, cages }
}

/** 棋盘/参考解编码：每格 1 个 36 进制字符（旧 9×9 为 '0'..'9'） */
export function encodeCells(cells: ArrayLike<number>): string {
  let out = ''
  for (let i = 0; i < cells.length; i++) {
    const v = Math.floor(cells[i] ?? 0)
    out += v > 0 && v < BASE36.length ? BASE36[v]! : '0'
  }
  return out
}

export function decodeCells(text: string, n: number): number[] | null {
  const size = n * n
  if (typeof text !== 'string' || text.length !== size) return null
  const out = new Array<number>(size)
  for (let i = 0; i < size; i++) {
    const v = valueOfSymbol(text[i]!)
    if (v < 0 || v > n) return null
    out[i] = v
  }
  return out
}

/** 每格所属的笼编号 */
export function cageIndexMap(cages: Cage[], size: number): number[] {
  const out = new Array<number>(size).fill(0)
  for (let c = 0; c < cages.length; c++) {
    for (const i of cages[c]!.cells) out[i] = c
  }
  return out
}
