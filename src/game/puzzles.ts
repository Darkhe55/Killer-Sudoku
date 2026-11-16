/**
 * 杀手数独 —— 题库加载（任意 N）
 *
 * 题库由三部分组成：
 *   - RAW_PUZZLES：旧 9×9 内置题（puzzles-data.ts，保持稳定）
 *   - EXTRA_PUZZLES：npm run gen 生成的多尺寸内置题（puzzles-extra-data.ts：4/6/12/16 等）
 *   - IMPORTED_PUZZLES：scripts/import-image.mjs --append 写入的识图题
 *
 * board 编码：givens|regions|cageOf:sums（见 types.ts）。
 */

import type { Difficulty, GameState, Puzzle } from '../core/types'
import { RAW_PUZZLES } from './puzzles-data.ts'
import { EXTRA_PUZZLES } from './puzzles-extra-data.ts'
import { IMPORTED_PUZZLES } from './imported-puzzles.ts'
import {
  cageIndexMap,
  decodeBoard,
  decodeCells,
  isValidKillerSize,
  puzzleSize,
  type SudokuPuzzle,
  type SudokuState,
} from './types.ts'

export interface RawPuzzle {
  id: string
  name: string
  width: number
  height: number
  difficulty: Difficulty
  series?: string
  board: string
  solution?: string
}

/** 内置题 + 识图导入题 */
export const ALL_RAW_PUZZLES: RawPuzzle[] = [
  ...(RAW_PUZZLES as RawPuzzle[]),
  ...(EXTRA_PUZZLES as RawPuzzle[]),
  ...(IMPORTED_PUZZLES as RawPuzzle[]),
]

export function decodePuzzle(raw: RawPuzzle, editable = true): SudokuPuzzle | null {
  const n = puzzleSize(raw)
  if (!isValidKillerSize(n)) return null
  const decoded = decodeBoard(raw.board, n)
  if (!decoded) return null
  const size = n * n
  const cageOf = cageIndexMap(decoded.cages, size)
  for (let i = 0; i < size; i++) if (cageOf[i] === undefined) return null
  return {
    id: raw.id,
    name: raw.name,
    width: n,
    height: n,
    difficulty: raw.difficulty,
    regions: decoded.regions,
    givens: decoded.givens,
    cages: decoded.cages,
    editable,
  }
}

export const builtinPuzzles: Puzzle[] = [
  ...(RAW_PUZZLES as RawPuzzle[]).map((raw) => decodePuzzle(raw, false)),
  ...(EXTRA_PUZZLES as RawPuzzle[]).map((raw) => decodePuzzle(raw, false)),
  ...(IMPORTED_PUZZLES as RawPuzzle[]).map((raw) => decodePuzzle(raw, false)),
].filter((p): p is SudokuPuzzle => p !== null)

export function getReferenceSolution(id: string): GameState | null {
  const raw = ALL_RAW_PUZZLES.find((p) => p.id === id)
  if (!raw || typeof raw.solution !== 'string' || !raw.solution) return null
  const puzzle = decodePuzzle(raw)
  if (!puzzle) return null
  const cells = decodeCells(raw.solution, puzzle.width)
  if (!cells) return null
  const state: SudokuState = {
    puzzleId: puzzle.id,
    width: puzzle.width,
    height: puzzle.height,
    cells,
    givens: puzzle.givens.slice(),
  }
  return state
}
