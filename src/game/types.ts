/**
 * 杀手数独（Killer Sudoku）—— 游戏专用类型
 *
 * 规则：标准数独（行/列/宫 1..9 不重复）+ 虚线笼内数字不重复且和为笼角数字。
 */

import type { GameState, Puzzle, ValidationResult } from '../core/types'

export interface Cage {
  cells: number[]
  sum: number
}

export interface SudokuPuzzle extends Puzzle {
  /** 每格所属区域（宫）0..8 */
  regions: number[]
  /** 题面预填：0 = 空，1..9 = 数字 */
  givens: number[]
  /** 虚线笼 */
  cages: Cage[]
  solution?: number[]
}

export interface SudokuState extends GameState {
  cells: number[]
  givens: number[]
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

function toBase36(n: number): string {
  return n.toString(36)
}

function fromBase36(ch: string): number {
  const code = ch.charCodeAt(0)
  if (code >= 48 && code <= 57) return code - 48
  if (code >= 97 && code <= 122) return code - 87
  if (code >= 65 && code <= 90) return code - 29
  return -1
}

export function encodeBoard(
  givens: ArrayLike<number>,
  regions: ArrayLike<number>,
  cages: Cage[],
): string {
  let out = ''
  for (let i = 0; i < givens.length; i++) out += String(givens[i]! | 0)
  out += '|'
  for (let i = 0; i < regions.length; i++) out += String(regions[i]! | 0)
  out += '|'
  const cageOf = new Array<number>(givens.length).fill(0)
  for (let c = 0; c < cages.length; c++) {
    for (const i of cages[c]!.cells) cageOf[i] = c
  }
  for (let i = 0; i < cageOf.length; i++) out += toBase36(cageOf[i]!)
  out += ':' + cages.map((c) => c.sum).join(',')
  return out
}

export function decodeBoard(
  text: string,
  expected: number,
): { givens: number[]; regions: number[]; cages: Cage[] } | null {
  if (typeof text !== 'string') return null
  const parts = text.split('|')
  if (parts.length !== 3) return null
  const givenText = parts[0]!
  const regionText = parts[1]!
  const cageText = parts[2]!
  if (givenText.length !== expected || regionText.length !== expected) return null
  const colon = cageText.indexOf(':')
  if (colon !== expected) return null
  const idText = cageText.slice(0, colon)
  const sumsText = cageText.slice(colon + 1)

  const givens = new Array<number>(expected).fill(0)
  const regions = new Array<number>(expected).fill(0)
  const cageOf = new Array<number>(expected).fill(0)
  let maxCage = -1
  for (let i = 0; i < expected; i++) {
    const g = givenText.charCodeAt(i) - 48
    const r = regionText.charCodeAt(i) - 48
    const c = fromBase36(idText[i]!)
    if (g < 0 || g > 9 || r < 0 || r > 8 || c < 0) return null
    givens[i] = g
    regions[i] = r
    cageOf[i] = c
    if (c > maxCage) maxCage = c
  }
  if (maxCage < 0) return null
  const sums = sumsText.split(',').map((s) => Number(s))
  if (sums.length !== maxCage + 1) return null
  for (const s of sums) if (!Number.isInteger(s) || s < 1 || s > 45) return null

  const cages: Cage[] = Array.from({ length: maxCage + 1 }, (_, c) => ({ cells: [], sum: sums[c]! }))
  for (let i = 0; i < expected; i++) cages[cageOf[i]!]!.cells.push(i)
  for (const cage of cages) if (cage.cells.length === 0) return null
  return { givens, regions, cages }
}

export function encodeCells(cells: ArrayLike<number>): string {
  let out = ''
  for (let i = 0; i < cells.length; i++) out += String(cells[i]! | 0)
  return out
}

export function decodeCells(text: string, expected: number): number[] | null {
  if (typeof text !== 'string' || text.length !== expected) return null
  const out = new Array<number>(expected)
  for (let i = 0; i < expected; i++) {
    const v = text.charCodeAt(i) - 48
    if (v < 0 || v > 9) return null
    out[i] = v
  }
  return out
}

/** 标准数独的九宫区域 */
export function standardRegions(): number[] {
  const out = new Array<number>(81).fill(0)
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      out[y * 9 + x] = Math.floor(y / 3) * 3 + Math.floor(x / 3)
    }
  }
  return out
}

/** 每格所属的笼编号 */
export function cageIndexMap(cages: Cage[], size = 81): number[] {
  const out = new Array<number>(size).fill(0)
  for (let c = 0; c < cages.length; c++) {
    for (const i of cages[c]!.cells) out[i] = c
  }
  return out
}
