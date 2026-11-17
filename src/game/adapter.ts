/**
 * ════════════════════════════════════════════════════════════════════
 *  杀手数独（Killer Sudoku）—— 游戏适配器
 * ════════════════════════════════════════════════════════════════════
 *
 * 尺寸：任意 N×N（4..16；内置 4/6/9/12/16，识图可导入 4..16 等）。
 * 宫：标准矩形宫（4→2×2、6→2×3、9→3×3、12→3×4、16→4×4）。
 * 状态：0 = 未填，1..N = 数字（N>9 时 10..36 用 A..Z 显示）。
 */

import { playDrop, playPluck } from '../core/audio'
import type { CustomSupport, GameAdapter, Move, Puzzle, SolveResult } from '../core/types'
import { planLogicSolve } from './logic.ts'
import { builtinPuzzles, getReferenceSolution } from './puzzles.ts'
import { hitTest, metricsFor, renderBoard } from './render.ts'
import { solvePuzzle } from './solver.ts'
import {
  applyMove,
  cloneState,
  createEmptyState,
  cycleValue,
  deserializeState,
  firstHintMove,
  invertMove,
  noteMaskAt,
  rightClickValue,
  serializeState,
  valueAt,
} from './state.ts'
import { statusBits, validate } from './validate.ts'
import {
  decodeBoard,
  encodeBoard,
  isValidKillerSize,
  MAX_KILLER_SIZE,
  MIN_KILLER_SIZE,
  puzzleSize,
  standardRegionsOf,
  valueOfSymbol,
  type SudokuPuzzle,
} from './types.ts'

const meta = {
  title: '杀手数独',
  tagline:
    'N×N 填数 —— 数独规则 + 虚线笼求和（内置 4/6/9/12/16 宫，识图可导入 4..16）',
  footerNote:
    '规则：在 N×N 格中填入 1..N（超过 9 用 A..Z 表示 10..16），每行、每列、每个宫（4×4 为 2×2 宫、6×6 为 2×3 宫、9×9 为 3×3 宫、12×12 为 3×4 宫、16×16 为 4×4 宫）不重复；同一虚线笼内数字也不能重复，且笼内数字之和等于笼角标注的数字。题面预填数字不能修改。',
  storageKeyPrefix: 'killer-sudoku',
  customIdPrefix: 'killer-sudoku-custom-',
  customMinW: MIN_KILLER_SIZE,
  customMinH: MIN_KILLER_SIZE,
  customMaxW: MAX_KILLER_SIZE,
  customMaxH: MAX_KILLER_SIZE,
  targetKind: 'cell' as const,
}

const VALUE_CYCLE: Array<number | null> = [null, ...Array.from({ length: 16 }, (_, i) => i + 1)]

const custom: CustomSupport = {
  // 虚线笼需要在题面里画出来并标注笼和，通用「填数字」编辑器无法表达；
  // 本题型请用内置题或图片导入。
  mode: 'none',
  valueCycle: VALUE_CYCLE,
  valueCycleFor: (w, h) => {
    const n = Math.max(MIN_KILLER_SIZE, Math.min(MAX_KILLER_SIZE, Math.max(w, h)))
    return [null, ...Array.from({ length: n }, (_, i) => i + 1)]
  },
  keyForDigit: (digit) => {
    if (digit === 0) return null
    if (digit >= 1 && digit <= 9) return digit
    return undefined
  },
  keyForChar: (ch, maxValue) => {
    const v = valueOfSymbol(ch)
    if (v >= 10 && v <= Math.min(36, Math.max(9, maxValue))) return v
    return undefined
  },
  cellLabel: (v) => (v == null ? '' : v <= 9 ? String(v) : String.fromCharCode(55 + v)),
  cellClass: (v) => (v == null ? '' : `n${v}`),
  hint: '杀手数独暂不支持自定义题板（虚线笼需要在图片里画好并标注笼和，请用图片导入）。',
  makePuzzle: (w, h, grid, existingId) => {
    const n = Math.max(MIN_KILLER_SIZE, Math.min(MAX_KILLER_SIZE, Math.max(w, h)))
    const size = n * n
    const givens = new Array<number>(size).fill(0)
    for (let i = 0; i < size; i++) {
      const v = grid[i]
      givens[i] = typeof v === 'number' && v >= 1 && v <= n ? v : 0
    }
    return {
      id: existingId ?? `${meta.customIdPrefix}${Date.now()}`,
      name: `自定义 · 杀手数独 ${n}×${n}`,
      width: n,
      height: n,
      difficulty: 'custom',
      regions: standardRegionsOf(n),
      givens,
      cages: [],
    } satisfies SudokuPuzzle
  },
  encodePuzzle: (p) => {
    const sp = p as SudokuPuzzle
    const n = puzzleSize(sp) || 9
    return {
      board: encodeBoard(sp.givens ?? [], sp.regions ?? standardRegionsOf(n), sp.cages ?? []),
    }
  },
  decodePuzzle: (record) => {
    if (typeof record.id !== 'string' || typeof record.board !== 'string') return null
    const n = puzzleSize({ width: Number(record.width), height: Number(record.height) })
    if (!isValidKillerSize(n)) return null
    const decoded = decodeBoard(record.board, n)
    if (!decoded) return null
    return {
      id: record.id,
      name: typeof record.name === 'string' ? record.name : `自定义 · 杀手数独 ${n}×${n}`,
      width: n,
      height: n,
      difficulty: 'custom',
      regions: decoded.regions,
      givens: decoded.givens,
      cages: decoded.cages,
    } satisfies SudokuPuzzle
  },
  toGrid: (p) => {
    const sp = p as SudokuPuzzle
    const n = puzzleSize(sp)
    if (!n || !Array.isArray(sp.givens) || sp.givens.length !== n * n) return null
    return {
      width: n,
      height: n,
      grid: sp.givens.map((v) => (v >= 1 && v <= n ? v : null)),
    }
  },
}

function playForMove(move: Move, streak: number): void {
  if (move.from === 0) playPluck(streak, 1)
  else playDrop(streak)
}

export const adapter: GameAdapter = {
  meta,
  builtinPuzzles,
  getReferenceSolution,
  createEmptyState,
  cloneState,
  cycleValue,
  rightClickValue,
  applyMove,
  invertMove,
  valueAt,
  noteMaskAt,
  serializeState,
  deserializeState,
  validate,
  statusBits,
  metricsFor,
  renderBoard,
  hitTest,
  planLogicSolve,
  solvePuzzle: (puzzle: Puzzle, maxNodes?: number): SolveResult => solvePuzzle(puzzle, maxNodes),
  firstHintMove,
  custom,
  playForMove,
}
