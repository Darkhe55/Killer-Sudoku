/**
 * 杀手数独 —— SVG 渲染（任意 N）
 *
 * 棋盘尺寸、格距、字号都按题面实际 width/height 计算：
 * 9×9 保持原来的 52px 格距，12×12 / 16×16 等比缩小以塞进面板。
 * 同时绘制：宫粗线、虚线笼边界、笼角笼和、预填/填写数字。
 */

import {
  cellAtPoint,
  cellCenter,
  cellSizeOf,
  originOf,
  regionBoundarySegments,
  squareMetrics,
} from '../core/board.ts'
import type { BoardMetrics, GameState, HitTarget, Puzzle, ValidationResult } from '../core/types'
import { asSudokuPuzzle, asSudokuState, cageIndexMap, symbolOf, type SudokuResult } from './types.ts'

/** 9×9 的基准像素跨度（与旧版一致的 52×9） */
const BASE_SPAN = 9 * 52

export function metricsFor(puzzle?: Puzzle): BoardMetrics {
  const p = puzzle as { width?: number; height?: number } | undefined
  const w = Math.max(1, Math.min(16, p?.width || 9))
  const h = Math.max(1, Math.min(16, p?.height || 9))
  const span = Math.max(w, h)
  const cell = span <= 9 ? 52 : Math.max(22, Math.min(44, Math.round(BASE_SPAN / span)))
  const pad = span <= 9 ? 20 : Math.max(10, Math.round(cell * 0.6))
  return squareMetrics(w, h, { cell, pad })
}

export function renderBoard(
  puzzle: Puzzle,
  state: GameState,
  result: ValidationResult,
): string {
  const p = asSudokuPuzzle(puzzle)
  const s = asSudokuState(state)
  const r = result as SudokuResult
  const n = Math.max(1, Math.min(16, p.width || 9))
  const m = metricsFor(p)
  const o = originOf(m)
  const { w: cw, h: ch } = cellSizeOf(m)
  const rows = n
  const cols = n
  const span = Math.max(cols, rows)
  const wide = span > 9
  const bad = new Set(r.badCells ?? [])
  const parts: string[] = []
  const fontSize = (m.cell * (wide ? 0.6 : 0.52)).toFixed(2)

  parts.push(
    `<rect class="sd-board-bg" x="${o.x}" y="${o.y}" width="${(cw * cols).toFixed(2)}" height="${(ch * rows).toFixed(2)}" />`,
  )

  for (let x = 0; x <= cols; x++) {
    const px = o.x + x * cw
    parts.push(
      `<line class="sd-grid" x1="${px.toFixed(2)}" y1="${o.y.toFixed(2)}" x2="${px.toFixed(2)}" y2="${(o.y + ch * rows).toFixed(2)}" />`,
    )
  }
  for (let y = 0; y <= rows; y++) {
    const py = o.y + y * ch
    parts.push(
      `<line class="sd-grid" x1="${o.x.toFixed(2)}" y1="${py.toFixed(2)}" x2="${(o.x + cw * cols).toFixed(2)}" y2="${py.toFixed(2)}" />`,
    )
  }

  for (const seg of regionBoundarySegments(m, p.regions ?? [])) {
    parts.push(
      `<line class="sd-region" x1="${seg.x1.toFixed(2)}" y1="${seg.y1.toFixed(2)}" x2="${seg.x2.toFixed(2)}" y2="${seg.y2.toFixed(2)}" />`,
    )
  }

  // 虚线笼边界
  const cages = p.cages ?? []
  const size = n * n
  const cageOf = cageIndexMap(cages, size)
  const x1 = (v: number) => v.toFixed(2)
  for (let i = 0; i < size; i++) {
    const x = i % n
    const y = (i / n) | 0
    const x0 = o.x + x * cw
    const y0 = o.y + y * ch
    const cage = cageOf[i] ?? -1
    if (x === 0 || (cageOf[i - 1] ?? -2) !== cage) {
      parts.push(
        `<line class="sd-cage" x1="${x1(x0)}" y1="${x1(y0)}" x2="${x1(x0)}" y2="${x1(y0 + ch)}" />`,
      )
    }
    if (y === 0 || (cageOf[i - n] ?? -2) !== cage) {
      parts.push(
        `<line class="sd-cage" x1="${x1(x0)}" y1="${x1(y0)}" x2="${x1(x0 + cw)}" y2="${x1(y0)}" />`,
      )
    }
    if (x === n - 1 || (cageOf[i + 1] ?? -2) !== cage) {
      parts.push(
        `<line class="sd-cage" x1="${x1(x0 + cw)}" y1="${x1(y0)}" x2="${x1(x0 + cw)}" y2="${x1(y0 + ch)}" />`,
      )
    }
    if (y === n - 1 || (cageOf[i + n] ?? -2) !== cage) {
      parts.push(
        `<line class="sd-cage" x1="${x1(x0)}" y1="${x1(y0 + ch)}" x2="${x1(x0 + cw)}" y2="${x1(y0 + ch)}" />`,
      )
    }
  }

  // 笼角笼和（取笼内最上、最左格）
  const sumFont = (m.cell * (wide ? 0.19 : 0.22)).toFixed(2)
  for (const cage of cages) {
    if (!cage.cells.length) continue
    let top = cage.cells[0]!
    for (const i of cage.cells) if (i < top) top = i
    const x0 = o.x + (top % n) * cw
    const y0 = o.y + Math.floor(top / n) * ch
    parts.push(
      `<text class="sd-cage-sum" x="${(x0 + 2.5).toFixed(2)}" y="${(y0 + m.cell * 0.2).toFixed(2)}" style="font-size:${sumFont}px">${cage.sum}</text>`,
    )
  }

  for (let i = 0; i < size; i++) {
    const v = s.cells[i] ?? 0
    if (v === 0) continue
    const c = cellCenter(m, i)
    const given = (p.givens?.[i] ?? 0) !== 0
    const cls = `sd-value${given ? ' given' : ''}${bad.has(i) ? ' bad' : ''}`
    parts.push(
      `<text class="${cls}" x="${c.x.toFixed(2)}" y="${(c.y + 1).toFixed(2)}" style="font-size:${fontSize}px">${symbolOf(v)}</text>`,
    )
  }

  // 候选数（笔记）：只画在空格上，3×3 小格；大棋盘改两列小字
  const noteCols = wide ? 2 : 3
  const noteRows = Math.ceil(span / noteCols)
  const noteFont = (m.cell * (wide ? 0.2 : 0.24)).toFixed(2)
  const noteSlotW = cw / noteCols
  const noteSlotH = ch / noteRows
  for (let i = 0; i < size; i++) {
    if ((s.cells[i] ?? 0) !== 0) continue
    const mask = s.notes?.[i] ?? 0
    if (!mask) continue
    const c = cellCenter(m, i)
    for (let v = 1; v <= span; v++) {
      if (Math.floor(mask / 2 ** (v - 1)) % 2 !== 1) continue
      const slot = v - 1
      const col = slot % noteCols
      const row = Math.floor(slot / noteCols)
      const nx = c.x + (col - (noteCols - 1) / 2) * noteSlotW
      const ny = c.y + (row - (noteRows - 1) / 2) * noteSlotH
      parts.push(
        `<text class="sd-note" x="${nx.toFixed(2)}" y="${(ny + 1).toFixed(2)}" style="font-size:${noteFont}px">${symbolOf(v)}</text>`,
      )
    }
  }

  for (let i = 0; i < size; i++) {
    const x = o.x + (i % n) * cw
    const y = o.y + Math.floor(i / n) * ch
    parts.push(
      `<rect class="cell-hit" data-index="${i}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cw.toFixed(2)}" height="${ch.toFixed(2)}" />`,
    )
  }

  const cls = `board-svg sd-board${wide ? ' sd-wide' : ''}`
  return `<svg class="${cls}" viewBox="0 0 ${m.svgWidth} ${m.svgHeight}" width="${m.svgWidth}" height="${m.svgHeight}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`
}

export function hitTest(m: BoardMetrics, puzzle: Puzzle, x: number, y: number): HitTarget | null {
  void puzzle
  const index = cellAtPoint(m, x, y)
  return index === null ? null : { index, kind: 'cell' }
}
