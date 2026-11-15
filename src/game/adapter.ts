/**
 * ════════════════════════════════════════════════════════════════════
 *  杀手数独（Killer Sudoku）—— 游戏适配器
 * ════════════════════════════════════════════════════════════════════
 *
 * 状态：0 = 未填，1..9 = 数字。
 */

import { playDrop, playPluck } from '../core/audio'
import type { CustomSupport, GameAdapter, Move, Puzzle, SolveResult } from '../core/types'
import { planLogicSolve } from './logic'
import { builtinPuzzles, getReferenceSolution } from './puzzles'
import { hitTest, metricsFor, renderBoard } from './render'
import { solvePuzzle } from './solver'
import {
  applyMove,
  cloneState,
  createEmptyState,
  cycleValue,
  deserializeState,
  firstHintMove,
  invertMove,
  rightClickValue,
  serializeState,
  valueAt,
} from './state'
import { statusBits, validate } from './validate'
import { encodeBoard, standardRegions, type SudokuPuzzle } from './types'

const meta = {
  title: '杀手数独',
  tagline: '9×9 填数 —— 数独规则 + 虚线笼求和',
  footerNote:
    '规则：在 9×9 格中填入 1..9，每行、每列、每个 3×3 宫不重复；同一虚线笼内数字也不能重复，且笼内数字之和等于笼角标注的数字。题面预填数字不能修改。',
  storageKeyPrefix: 'killer-sudoku',
  customIdPrefix: 'killer-sudoku-custom-',
  customMinW: 9,
  customMinH: 9,
  customMaxW: 9,
  customMaxH: 9,
  targetKind: 'cell' as const,
}

const VALUE_CYCLE: Array<number | null> = [null, 1, 2, 3, 4, 5, 6, 7, 8, 9]

const custom: CustomSupport = {
  mode: 'none',
  valueCycle: VALUE_CYCLE,
  keyForDigit: (digit) => {
    if (digit === 0) return null
    if (digit >= 1 && digit <= 9) return digit
    return undefined
  },
  cellLabel: (v) => (v == null ? '' : String(v)),
  cellClass: (v) => (v == null ? '' : `n${v}`),
  hint: '杀手数独暂不支持自定义题板。',
  makePuzzle: (_w, _h, _grid, existingId) => ({
    id: existingId ?? `${meta.customIdPrefix}${Date.now()}`,
    name: '自定义 · 杀手数独',
    width: 9,
    height: 9,
    difficulty: 'custom',
    regions: standardRegions(),
    givens: new Array<number>(81).fill(0),
    cages: [],
  }),
  encodePuzzle: (p) => {
    const sp = p as SudokuPuzzle
    return {
      board: encodeBoard(sp.givens ?? [], sp.regions ?? standardRegions(), sp.cages ?? []),
    }
  },
  decodePuzzle: () => null,
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
