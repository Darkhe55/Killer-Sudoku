/**
 * 杀手数独题面图片导入（自动识图 + 人工修正）
 *
 * 用法：
 *   node scripts/import-image.mjs <图片路径> [选项]
 *
 *   选项：
 *     --size N            指定网格边长（识别多组等距线时优先选它）
 *     --name 名称         题名（默认「识图 · N×N 杀手」）
 *     --series 名称       系列名（默认「识图」）
 *     --json out.json     额外导出识别结果 JSON
 *     --map "x,y=字符"    人工覆盖预填数字（坐标 0 基，列,行；多组用空格/分号分隔）
 *     --sum "x,y=和"      人工覆盖笼和（坐标 0 基，写该笼左上格；多组用空格/分号分隔）
 *     --regions auto|standard  宫/区域来源：auto=按粗线自动识别（默认），standard=强制标准矩形宫
 *     --dry               只预览，即使同时给了 --append 也不写文件
 *     --verify            调项目 solver 校验唯一解并求参考解（超时只警告）
 *     --append            追加写入 src/game/imported-puzzles.ts（不会覆盖内置题库）
 *     --debug             打印网格线/粗线/虚线检测的中间统计
 *
 * 识图流程：
 *   1. Playwright + Edge 打开图片到 canvas，取灰度像素；
 *   2. 网格线：按「最长连续深色行程」找贯穿全图的实线（排除虚线/底纹），
 *      在多组候选里选等距最长序列自动判定 N 与格距；
 *   3. 宫/区域：逐条内部格线测量线宽，细线（普通格线）与粗线（宫/区域线）聚类分开，
 *      粗线即区域边界，四连通得到区域；数量/尺寸不符时回退标准矩形宫并警告；
 *   4. 笼界：虚线笼的虚线通常画在格线内侧（少量题图画在格线中心），
 *      在格线两侧多条平行采样线上统计「中等灰度」覆盖率，覆盖率在虚线区间即判为笼界；
 *   5. 笼和 / 预填：每格连通域字形识别（多字体模板 + IoU），左上角字形拼成笼和，
 *      居中字形为预填数字；
 *   6. 预览题面/区域/笼矩阵；--verify 用项目 solver 校验唯一解并求参考解；
 *   7. --append 写入识图题库文件 src/game/imported-puzzles.ts（4..16 尺寸通用）。
 *
 * 人工修正：--map 覆盖预填数字，--sum 覆盖笼和，--regions standard 强制标准宫。
 * 说明：区域形状不支持逐格手改；若粗线识别失败会自动回退标准宫并给出警告。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import {
  MAX_KILLER_SIZE,
  MIN_KILLER_SIZE,
  encodeBoard,
  encodeCells,
  standardRegionsOf,
} from '../src/game/types.ts'

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

function edgePath() {
  for (const c of EDGE_CANDIDATES) {
    if (c && existsSync(c)) return c
  }
  throw new Error('找不到 Edge 可执行文件，请用 EDGE_PATH 指定')
}

const args = process.argv.slice(2)
function has(flag) {
  return args.includes(flag)
}
function arg(flag, fallback = '') {
  const i = args.indexOf(flag)
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback
}
function argEq(flag) {
  for (const a of args) if (a.startsWith(flag + '=')) return a.slice(flag.length + 1)
  return null
}

const valueFlags = new Set(['--size', '--name', '--series', '--json', '--map', '--sum', '--regions'])
const imageArg = args.find((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1]))
if (!imageArg) {
  console.error(
    '用法：node scripts/import-image.mjs <图片路径> [--size N] [--name 名称] [--series 识图] ' +
      '[--append] [--dry] [--verify] [--json out.json] [--map "x,y=字符"] [--sum "x,y=和"] ' +
      '[--regions auto|standard] [--debug]',
  )
  process.exit(1)
}
const IMAGE = path.resolve(imageArg)
if (!existsSync(IMAGE)) {
  console.error('找不到图片:', IMAGE)
  process.exit(1)
}

const sizeOpt = Number(arg('--size', '0')) || 0
const nameOpt = arg('--name')
const series = arg('--series', '识图')
const jsonOut = arg('--json')
const regionsOpt = arg('--regions', 'auto')
const append = has('--append')
const verify = has('--verify')
const dry = has('--dry')
const debug = has('--debug')

if (regionsOpt !== 'auto' && regionsOpt !== 'standard') {
  console.error(`--regions 只能是 auto 或 standard：${regionsOpt}`)
  process.exit(1)
}

/** 解析 "x,y=值" 形式的覆盖表；valueRe 为值部分正则 */
function parseOverrides(mapArg, flag, valueRe, validate) {
  if (!mapArg) return new Map()
  const out = new Map()
  const re = new RegExp(`(\\d+)\\s*,\\s*(\\d+)\\s*=\\s*(${valueRe})`, 'g')
  let matched = 0
  let m
  while ((m = re.exec(mapArg)) !== null) {
    const x = Number(m[1])
    const y = Number(m[2])
    const raw = m[3]
    if (!validate(raw)) {
      console.error(`${flag} 值非法：${x},${y}=${raw}`)
      process.exit(1)
    }
    out.set(y * 10000 + x, raw)
    matched++
  }
  const residue = mapArg.replace(re, '').replace(/[\s,;]+/g, '')
  if (!matched || residue) {
    console.error(`${flag} 格式错误：${mapArg}`)
    process.exit(1)
  }
  return out
}

const manualGivens = parseOverrides(
  argEq('--map') ?? arg('--map'),
  '--map',
  '[0-9A-Za-z]',
  (v) => /^[0-9A-Za-z]$/.test(v),
)
const manualSums = parseOverrides(
  argEq('--sum') ?? arg('--sum'),
  '--sum',
  '\\d{1,3}',
  (v) => /^\d{1,3}$/.test(v) && Number(v) > 0,
)

// ───────────────────────── 浏览器端识图 ─────────────────────────
const dataUrl = `data:image/png;base64,${readFileSync(IMAGE).toString('base64')}`
const browser = await chromium.launch({ headless: true, executablePath: edgePath() })
const page = await browser.newPage()
await page.setContent('<canvas id="c"></canvas>')

const analysis = await page.evaluate(
  async ({ dataUrl, sizeOpt, minSize, maxSize, regionsOpt }) => {
    const standardRegionsOf = (n) => {
      let rows = 1
      let cols = n
      for (let r = Math.floor(Math.sqrt(n)); r >= 2; r--) {
        if (n % r === 0) { rows = r; cols = n / r; break }
      }
      const boxesPerRow = Math.max(1, Math.ceil(n / cols))
      const out = new Array(n * n).fill(0)
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = Math.floor(y / rows) * boxesPerRow + Math.floor(x / cols)
      return out
    }
    const img = new Image()
    img.src = dataUrl
    await img.decode()
    const W = img.naturalWidth
    const H = img.naturalHeight
    const cv = document.createElement('canvas')
    cv.width = W
    cv.height = H
    const ctx = cv.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0)
    const px = ctx.getImageData(0, 0, W, H).data
    const gray = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return 255
      const i = (y * W + x) * 4
      return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
    }

    const INK = 235 // 任意非白像素（网格线/虚线/文字）
    const LINE = 200 // 较深像素（测量线宽用，避开浅灰底纹）
    const TEXT = 110 // 字形像素

    const ink = new Uint8Array(W * H)
    const lineMask = new Uint8Array(W * H)
    const textMask = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const v = gray(x, y)
        if (v < INK) ink[i] = 1
        if (v < LINE) lineMask[i] = 1
        if (v < TEXT) textMask[i] = 1
      }
    }

    // ── 1) 网格线：最长连续深色行程（虚线段、底纹块都远短于贯穿线） ──
    const longestRuns = (alongX) => {
      const n = alongX ? W : H
      const m = alongX ? H : W
      const out = new Int32Array(n)
      let max = 0
      for (let i = 0; i < n; i++) {
        let best = 0
        let cur = 0
        for (let j = 0; j < m; j++) {
          const on = alongX ? ink[j * W + i] : ink[i * W + j]
          if (on) {
            cur++
            if (cur > best) best = cur
          } else cur = 0
        }
        out[i] = best
        if (best > max) max = best
      }
      return { runs: out, max }
    }
    const groupLines = (runs, max, label) => {
      const threshold = Math.max(16, max * 0.55)
      const list = []
      let start = -1
      for (let i = 0; i <= runs.length; i++) {
        const on = i < runs.length && runs[i] >= threshold
        if (on && start < 0) start = i
        if (!on && start >= 0) {
          const width = i - start
          // 过宽的黑色条带不是格线
          if (width <= Math.max(6, max * 0.25)) {
            list.push({ center: (start + i - 1) / 2, width })
          }
          start = -1
        }
      }
      if (!list.length) throw new Error(`图片里没有找到${label}格线`)
      return list
    }
    const groupY = (alongX) => {
      const g = longestRuns(alongX)
      return groupLines(g.runs, g.max, alongX ? '竖' : '横')
    }
    const xsCand = groupY(true)
    const ysCand = groupY(false)

    // 在候选线里找等距最长序列
    const pickRuns = (lines) => {
      const out = []
      for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
          const step = (lines[j].center - lines[i].center) / (j - i)
          if (step < 10) continue
          let end = i
          for (let k = i + 1; k < lines.length; k++) {
            const expected = lines[i].center + step * (k - i)
            if (Math.abs(lines[k].center - expected) > step * 0.18) break
            end = k
          }
          const count = end - i + 1
          if (count >= 5) out.push({ start: i, end, step, count })
        }
      }
      out.sort((a, b) => b.count - a.count || a.step - b.step)
      return out
    }
    const xRuns = pickRuns(xsCand)
    const yRuns = pickRuns(ysCand)
    if (!xRuns.length || !yRuns.length) throw new Error('无法确定网格线')

    let chosen = null
    let maxLineCount = 0
    for (const xr of xRuns) {
      for (const yr of yRuns) {
        if (xr.count !== yr.count) continue
        if (xr.count > maxLineCount) maxLineCount = xr.count
        if (sizeOpt >= minSize && xr.count - 1 !== sizeOpt) continue
        if (!chosen || xr.count > chosen.xr.count) chosen = { xr, yr }
      }
    }
    let sizeHintWarning = ''
    if (sizeOpt >= minSize && maxLineCount - 1 > sizeOpt) {
      sizeHintWarning =
        `图片里有更长的等距线序列（${maxLineCount - 1}×${maxLineCount - 1}），` +
        `--size ${sizeOpt} 只取前 ${sizeOpt} 格；如非有意裁切请去掉 --size`
    }
    if (!chosen) {
      // 两轴线数不一致时退而求其次：各自取最长，再截成同样长度
      chosen = { xr: xRuns[0], yr: yRuns[0] }
    }
    let xLines = xsCand.slice(chosen.xr.start, chosen.xr.end + 1).map((l) => l.center)
    let yLines = ysCand.slice(chosen.yr.start, chosen.yr.end + 1).map((l) => l.center)
    let N = Math.min(xLines.length, yLines.length) - 1
    if (xLines.length !== yLines.length) {
      xLines = xLines.slice(0, N + 1)
      yLines = yLines.slice(0, N + 1)
    }
    if (N < minSize) throw new Error(`识别到的网格太小：${N}`)
    if (N > maxSize) throw new Error(`识别到的网格太大：${N}（上限 ${maxSize}）`)
    if (sizeOpt >= minSize && N !== sizeOpt) {
      throw new Error(`网格尺寸不匹配：识别到 ${N}×${N}，--size ${sizeOpt}`)
    }
    const cellX = (xLines[N] - xLines[0]) / N
    const cellY = (yLines[N] - yLines[0]) / N
    const warnings = []
    if (sizeHintWarning) warnings.push(sizeHintWarning)
    if (Math.abs(cellX - cellY) / Math.max(cellX, cellY) > 0.18) {
      warnings.push(`横向格距 ${cellX.toFixed(1)}px 与纵向 ${cellY.toFixed(1)}px 差异较大，可能有透视/裁切`)
    }
    const lineWidths = [
      ...xsCand.slice(chosen.xr.start, chosen.xr.end + 1).map((l) => l.width),
      ...ysCand.slice(chosen.yr.start, chosen.yr.end + 1).map((l) => l.width),
    ]
    const baseLineWidth = Math.max(1, Math.min(...lineWidths))

    // ── 2) 宫/区域：粗线（线宽约为普通格线 1.4 倍以上） ──
    const percentile = (arr, p) => {
      if (!arr.length) return 0
      const s = arr.slice().sort((a, b) => a - b)
      const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))
      return s[idx]
    }
    const median = (arr) => {
      const s = arr.slice().sort((a, b) => a - b)
      return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
    }
    const hitWidth = (y, xc, wMax) => {
      // 行 y 上包含 xc 附近较深像素的连续行程宽度
      let x = -1
      for (let d = 0; d <= 4 && x < 0; d++) {
        if (xLine(xc + d, y)) x = xc + d
        else if (xLine(xc - d, y)) x = xc - d
      }
      if (x < 0) return 0
      const inLine = (xx) => xx >= 0 && xx < W && lineMask[y * W + xx]
      let s = x
      let e = x
      while (s > 0 && inLine(s - 1) && x - s < wMax) s--
      while (e < W - 1 && inLine(e + 1) && e - x < wMax) e++
      return e - s + 1
    }
    const xLine = (x, y) => x >= 0 && x < W && y >= 0 && y < H && lineMask[y * W + x] === 1
    const hitHeight = (x, yc, hMax) => {
      let y = -1
      for (let d = 0; d <= 4 && y < 0; d++) {
        if (yLine(x, yc + d)) y = yc + d
        else if (yLine(x, yc - d)) y = yc - d
      }
      if (y < 0) return 0
      const inLine = (yy) => yy >= 0 && yy < H && lineMask[yy * W + x]
      let s = y
      let e = y
      while (s > 0 && inLine(s - 1) && y - s < hMax) s--
      while (e < H - 1 && inLine(e + 1) && e - y < hMax) e++
      return e - s + 1
    }
    const yLine = (x, y) => x >= 0 && x < W && y >= 0 && y < H && lineMask[y * W + x] === 1

    const vMed = Array.from({ length: N + 1 }, () => new Array(N).fill(0))
    const hMed = Array.from({ length: N + 1 }, () => new Array(N).fill(0))
    const sampleT = (k, total = 15) => 0.3 + (0.4 * k) / (total - 1) // 中央 40%，避开左上角笼和文字
    for (let line = 1; line < N; line++) {
      const xc = Math.round(xLines[line])
      for (let row = 0; row < N; row++) {
        const wMax = Math.round(cellX * 0.3)
        const ws = []
        for (let k = 0; k < 15; k++) {
          const y = Math.round(yLines[row] + (yLines[row + 1] - yLines[row]) * sampleT(k))
          const w = hitWidth(y, xc, wMax)
          if (w > 0) ws.push(w)
        }
        vMed[line][row] = ws.length >= 8 ? median(ws) : 0
      }
    }
    for (let line = 1; line < N; line++) {
      const yc = Math.round(yLines[line])
      for (let col = 0; col < N; col++) {
        const hMax = Math.round(cellY * 0.3)
        const hs = []
        for (let k = 0; k < 15; k++) {
          const x = Math.round(xLines[col] + (xLines[col + 1] - xLines[col]) * sampleT(k))
          const h = hitHeight(x, yc, hMax)
          if (h > 0) hs.push(h)
        }
        hMed[line][col] = hs.length >= 8 ? median(hs) : 0
      }
    }
    const allMed = [...vMed.slice(1).flat(), ...hMed.slice(1).flat()].filter((v) => v > 0)
    let regionMode = 'standard'
    let regions = null
    let thickThreshold = 0
    if (allMed.length) {
      const thinEst = Math.max(baseLineWidth, percentile(allMed, 20))
      const thickEst = percentile(allMed, 90)
      const hasThick = regionsOpt !== 'standard' && thickEst >= thinEst * 1.4 && thickEst >= thinEst + 2
      if (hasThick) {
        thickThreshold = (thinEst + thickEst) / 2
        const vWall = Array.from({ length: N + 1 }, () => new Uint8Array(N))
        const hWall = Array.from({ length: N + 1 }, () => new Uint8Array(N))
        for (let line = 1; line < N; line++) {
          for (let row = 0; row < N; row++) {
            if (vMed[line][row] >= thickThreshold) vWall[line][row] = 1
          }
        }
        for (let line = 1; line < N; line++) {
          for (let col = 0; col < N; col++) {
            if (hMed[line][col] >= thickThreshold) hWall[line][col] = 1
          }
        }
        // 四连通
        const parent = new Int32Array(N * N)
        for (let i = 0; i < N * N; i++) parent[i] = i
        const find = (a) => {
          while (parent[a] !== a) {
            parent[a] = parent[parent[a]]
            a = parent[a]
          }
          return a
        }
        const union = (a, b) => {
          const ra = find(a)
          const rb = find(b)
          if (ra !== rb) parent[rb] = ra
        }
        for (let row = 0; row < N; row++) {
          for (let col = 0; col < N; col++) {
            const i = row * N + col
            if (col + 1 < N && !vWall[col + 1][row]) union(i, i + 1)
            if (row + 1 < N && !hWall[row + 1][col]) union(i, i + N)
          }
        }
        const groups = new Map()
        for (let i = 0; i < N * N; i++) {
          const r = find(i)
          if (!groups.has(r)) groups.set(r, [])
          groups.get(r).push(i)
        }
        const shapes = Array.from(groups.values()).sort((a, b) => Math.min(...a) - Math.min(...b))
        const valid = shapes.length === N && shapes.every((g) => g.length === N)
        if (valid) {
          regions = new Array(N * N).fill(0)
          shapes.forEach((cells, id) => cells.forEach((i) => (regions[i] = id)))
          const std = standardRegionsOf(N)
          regionMode = regions.every((v, i) => v === std[i]) ? 'standard' : 'jigsaw'
        } else {
          warnings.push(
            `粗线识别出 ${shapes.length} 个区域（尺寸 ${shapes.map((g) => g.length).join('/')}），` +
              `不符合 ${N} 个各 ${N} 格，已回退标准矩形宫`,
          )
        }
      }
    }
    if (!regions) {
      regions = standardRegionsOf(N)
      regionMode = 'standard'
    }

    // ── 3) 笼界：格线两侧（或格线中心）的虚线 ──
    const midGray = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) {
      const v = px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114
      if (v >= 90 && v <= 215) midGray[i] = 1
    }
    const sampleAlong = (fixedCoord, vertical, from, to) => {
      // 沿格线方向取 40 个采样点，返回中等灰度覆盖率
      let hit = 0
      let total = 0
      for (let k = 0; k <= 40; k++) {
        const t = 0.24 + 0.52 * (k / 40)
        const coord = Math.round(from + (to - from) * t)
        const x = vertical ? fixedCoord : coord
        const y = vertical ? coord : fixedCoord
        if (x < 0 || y < 0 || x >= W || y >= H) continue
        total++
        if (midGray[y * W + x]) hit++
      }
      return total ? hit / total : 0
    }
    const dashCoverage = (vertical, lineIdx, cellIdx) => {
      // 在格线附近 ±0.22 格距内逐像素偏移，取覆盖率落在虚线区间的最佳值
      const cellSpan = vertical ? cellX : cellY
      const center = vertical ? xLines[lineIdx] : yLines[lineIdx]
      const from = vertical ? yLines[cellIdx] : xLines[cellIdx]
      const to = vertical ? yLines[cellIdx + 1] : xLines[cellIdx + 1]
      const maxOff = Math.max(3, Math.round(cellSpan * 0.22))
      let best = 0
      for (let off = -maxOff; off <= maxOff; off++) {
        const cov = sampleAlong(Math.round(center + off), vertical, from, to)
        if (cov >= 0.2 && cov <= 0.95 && cov > best) best = cov
      }
      return best
    }
    const vWalls = Array.from({ length: N + 1 }, () => new Uint8Array(N))
    const hWalls = Array.from({ length: N + 1 }, () => new Uint8Array(N))
    let cageEdgeCount = 0
    const dashScores = []
    for (let line = 1; line < N; line++) {
      for (let row = 0; row < N; row++) {
        const cov = dashCoverage(true, line, row)
        if (cov > 0) dashScores.push(Number(cov.toFixed(2)))
        if (cov >= 0.2) {
          vWalls[line][row] = 1
          cageEdgeCount++
        }
      }
    }
    for (let line = 1; line < N; line++) {
      for (let col = 0; col < N; col++) {
        const cov = dashCoverage(false, line, col)
        if (cov > 0) dashScores.push(Number(cov.toFixed(2)))
        if (cov >= 0.2) {
          hWalls[line][col] = 1
          cageEdgeCount++
        }
      }
    }
    const cageOf = new Array(N * N).fill(-1)
    let cageCount = 0
    for (let start = 0; start < N * N; start++) {
      if (cageOf[start] !== -1) continue
      const id = cageCount++
      cageOf[start] = id
      const stack = [start]
      while (stack.length) {
        const i = stack.pop()
        const x = i % N
        const y = (i / N) | 0
        const push = (j) => {
          if (j >= 0 && j < N * N && cageOf[j] === -1) {
            cageOf[j] = id
            stack.push(j)
          }
        }
        if (x > 0 && !vWalls[x][y]) push(i - 1)
        if (x + 1 < N && !vWalls[x + 1][y]) push(i + 1)
        if (y > 0 && !hWalls[y][x]) push(i - N)
        if (y + 1 < N && !hWalls[y + 1][x]) push(i + N)
      }
    }
    const cageSizes = new Array(cageCount).fill(0)
    for (const c of cageOf) cageSizes[c]++
    const cageTop = new Array(cageCount).fill(-1)
    for (let i = 0; i < N * N; i++) {
      const c = cageOf[i]
      if (cageTop[c] < 0 || i < cageTop[c]) cageTop[c] = i
    }

    // ── 4) 字形模板（数字 0-9，多字体多字重） ──
    const DIGITS = '0123456789'
    const LETTERS = 'ABCDEFG' // N>9 时 10..16
    const NS = 24
    const SRC = 40
    const fonts = [
      '700 84px Arial',
      '400 84px Arial',
      '700 84px "Segoe UI"',
      '400 84px "Segoe UI"',
      '700 84px Verdana',
      '400 84px Verdana',
      '700 84px Tahoma',
      '400 84px Tahoma',
      '700 84px Consolas',
      '400 84px Consolas',
      '600 84px "Cascadia Code"',
      '400 84px "Cascadia Code"',
      '700 84px "Microsoft YaHei"',
      '400 84px "Microsoft YaHei"',
    ]
    const tc = document.createElement('canvas')
    tc.width = 120
    tc.height = 120
    const tg = tc.getContext('2d', { willReadFrequently: true })
    const normBit = (raw, T) => {
      let x0 = SRC
      let y0 = SRC
      let x1 = -1
      let y1 = -1
      let n = 0
      const m = new Uint8Array(SRC * SRC)
      for (let j = 0; j < SRC; j++) {
        for (let i = 0; i < SRC; i++) {
          if (raw[j * SRC + i] >= T) continue
          m[j * SRC + i] = 1
          n++
          if (i < x0) x0 = i
          if (i > x1) x1 = i
          if (j < y0) y0 = j
          if (j > y1) y1 = j
        }
      }
      if (!n) return null
      const bw = x1 - x0 + 1
      const bh = y1 - y0 + 1
      const out = new Uint8Array(NS * NS)
      for (let j = 0; j < NS; j++) {
        for (let i = 0; i < NS; i++) {
          out[j * NS + i] = m[(y0 + Math.floor((bh * j) / NS)) * SRC + (x0 + Math.floor((bw * i) / NS))] ? 1 : 0
        }
      }
      return out
    }
    const holesOf = (m) => {
      const seen = new Uint8Array(NS * NS)
      let holes = 0
      for (let j = 0; j < NS; j++) {
        for (let i = 0; i < NS; i++) {
          if (m[j * NS + i] || seen[j * NS + i]) continue
          let touches = false
          const st = [[i, j]]
          seen[j * NS + i] = 1
          while (st.length) {
            const [x, y] = st.pop()
            if (x === 0 || y === 0 || x === NS - 1 || y === NS - 1) touches = true
            for (const [dx, dy] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ]) {
              const nx = x + dx
              const ny = y + dy
              if (nx < 0 || ny < 0 || nx >= NS || ny >= NS) continue
              if (seen[ny * NS + nx] || m[ny * NS + nx]) continue
              seen[ny * NS + nx] = 1
              st.push([nx, ny])
            }
          }
          if (!touches) holes++
        }
      }
      return holes
    }
    const simShift = (a, b) => {
      let best = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          let inter = 0
          let uni = 0
          for (let j = 0; j < NS; j++) {
            const bj = j + dy
            for (let i = 0; i < NS; i++) {
              const av = a[j * NS + i]
              const bi = i + dx
              const bv = bj >= 0 && bj < NS && bi >= 0 && bi < NS ? b[bj * NS + bi] : 0
              if (av && bv) inter++
              if (av || bv) uni++
            }
          }
          const s = uni ? inter / uni : 0
          if (s > best) best = s
        }
      }
      return best
    }
    const templates = {}
    for (const ch of DIGITS + LETTERS) templates[ch] = []
    for (const font of fonts) {
      for (const ch of DIGITS + LETTERS) {
        tg.fillStyle = '#fff'
        tg.fillRect(0, 0, 120, 120)
        tg.fillStyle = '#000'
        tg.font = font
        tg.textAlign = 'center'
        tg.textBaseline = 'middle'
        tg.fillText(ch, 60, 60)
        const data = tg.getImageData(0, 0, 120, 120).data
        const raw = new Float32Array(SRC * SRC)
        for (let j = 0; j < SRC; j++) {
          for (let i = 0; i < SRC; i++) {
            raw[j * SRC + i] = data[(Math.floor((j * 120) / SRC) * 120 + Math.floor((i * 120) / SRC)) * 4]
          }
        }
        const m = normBit(raw, 128)
        if (m) templates[ch].push({ m, holes: holesOf(m) })
      }
    }
    const classify = (bits, chars) => {
      const holes = holesOf(bits)
      return chars
        .split('')
        .map((ch) => {
          let best = 0
          for (const t of templates[ch]) {
            let s = simShift(bits, t.m)
            if (t.holes === holes) s += 0.1
            else if (Math.abs(t.holes - holes) >= 2) s -= 0.12
            if (s > best) best = s
          }
          return { ch, score: best }
        })
        .sort((a, b) => b.score - a.score)
    }
    const givenChars = N > 9 ? DIGITS + LETTERS : DIGITS

    // ── 5) 每格连通域 → 字形：中心大字形 = 预填数字；左上角字形 = 笼和 ──
    const maxLineWidth = Math.max(baseLineWidth, ...lineWidths)
    const inset = Math.min(Math.round(cellX * 0.12), Math.max(4, Math.ceil(maxLineWidth / 2) + 1))
    const cellInfo = []
    for (let row = 0; row < N; row++) {
      for (let col = 0; col < N; col++) {
        const ox = Math.round(xLines[col] + inset)
        const oy = Math.round(yLines[row] + inset)
        const pw = Math.round(xLines[col + 1] - xLines[col] - inset * 2)
        const ph = Math.round(yLines[row + 1] - yLines[row] - inset * 2)
        const bins = new Uint8Array(pw * ph)
        for (let j = 0; j < ph; j++) {
          for (let i = 0; i < pw; i++) {
            const x = ox + i
            const y = oy + j
            bins[j * pw + i] = x >= 0 && y >= 0 && x < W && y < H && textMask[y * W + x] ? 1 : 0
          }
        }
        const seen = new Uint8Array(pw * ph)
        const comps = []
        for (let j = 0; j < ph; j++) {
          for (let i = 0; i < pw; i++) {
            const k = j * pw + i
            if (!bins[k] || seen[k]) continue
            const stack = [[i, j]]
            seen[k] = 1
            let minX = i
            let maxX = i
            let minY = j
            let maxY = j
            let n = 0
            while (stack.length) {
              const [x, y] = stack.pop()
              n++
              if (x < minX) minX = x
              if (x > maxX) maxX = x
              if (y < minY) minY = y
              if (y > maxY) maxY = y
              for (const [dx, dy] of [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1],
                [1, 1],
                [1, -1],
                [-1, 1],
                [-1, -1],
              ]) {
                const nx = x + dx
                const ny = y + dy
                if (nx < 0 || ny < 0 || nx >= pw || ny >= ph) continue
                const nk = ny * pw + nx
                if (seen[nk] || !bins[nk]) continue
                seen[nk] = 1
                stack.push([nx, ny])
              }
            }
            if (n < Math.max(6, Math.round(pw * ph * 0.0015))) continue
            const bw = maxX - minX + 1
            const bh = maxY - minY + 1
            if (bh < Math.max(4, Math.round(cellY * 0.09)) || bw < 2) continue
            // 排除细长的虚线/格线残片
            if (bw > bh * 2.6 && bh < cellY * 0.16) continue
            comps.push({ minX, maxX, minY, maxY, n, bw, bh })
          }
        }
        comps.sort((a, b) => b.n - a.n)
        const kept = []
        for (const c of comps) {
          const covered = kept.some(
            (k) => c.minX >= k.minX - 1 && c.maxX <= k.maxX + 1 && c.minY >= k.minY - 1 && c.maxY <= k.maxY + 1,
          )
          if (!covered) kept.push(c)
        }
        kept.sort((a, b) => a.minY - b.minY || a.minX - b.minX)
        const glyphs = []
        for (const c of kept) {
          const rawGlyph = new Float32Array(SRC * SRC)
          for (let j = 0; j < SRC; j++) {
            for (let i = 0; i < SRC; i++) {
              const sx = c.minX + Math.min(c.bw - 1, Math.floor((c.bw * i) / SRC))
              const sy = c.minY + Math.min(c.bh - 1, Math.floor((c.bh * j) / SRC))
              rawGlyph[j * SRC + i] = bins[sy * pw + sx] ? 0 : 255
            }
          }
          const bits = normBit(rawGlyph, 128)
          if (!bits) continue
          glyphs.push({ bw: c.bw, bh: c.bh, minX: c.minX, minY: c.minY, ranked: classify(bits, givenChars) })
        }
        const ccx = pw / 2
        const ccy = ph / 2
        const given = glyphs
          .filter(
            (g) =>
              g.bh >= ph * 0.3 &&
              Math.abs(g.minX + g.bw / 2 - ccx) < pw * 0.32 &&
              Math.abs(g.minY + g.bh / 2 - ccy) < ph * 0.32,
          )
          .sort((a, b) => b.ranked[0].score - a.ranked[0].score)[0]
        const sumGlyphs = glyphs
          .filter(
            (g) =>
              g !== given &&
              g.minY < ph * 0.5 &&
              g.bh <= ph * 0.45 &&
              g.bw < pw * 0.65 &&
              g.minX < pw * 0.8,
          )
          .sort((a, b) => a.minX - b.minX)
        cellInfo.push({
          row,
          col,
          given: given
            ? {
                ch: given.ranked[0].ch,
                score: Number(given.ranked[0].score.toFixed(2)),
                ranked: given.ranked.slice(0, 3).map((r) => `${r.ch}:${r.score.toFixed(2)}`),
              }
            : null,
          sums: sumGlyphs.map((g) => g.ranked[0].ch),
          sumScores: sumGlyphs.map((g) => Number(g.ranked[0].score.toFixed(2))),
          sumRanked: sumGlyphs.map((g) => g.ranked.slice(0, 2).map((r) => `${r.ch}:${r.score.toFixed(2)}`)),
        })
      }
    }

    return {
      W,
      H,
      N,
      xLines: xLines.map((v) => Number(v.toFixed(1))),
      yLines: yLines.map((v) => Number(v.toFixed(1))),
      cellX: Number(cellX.toFixed(2)),
      cellY: Number(cellY.toFixed(2)),
      lineWidths,
      baseLineWidth,
      thickThreshold: Number(thickThreshold.toFixed(2)),
      regions,
      regionMode,
      cageOf,
      cageSizes,
      cageCount,
      cageTop,
      cageEdgeCount,
      dashSample: dashScores.slice(0, 24),
      warnings,
      cells: cellInfo,
    }
  },
  {
    dataUrl,
    sizeOpt,
    regionsOpt,
    minSize: MIN_KILLER_SIZE,
    maxSize: MAX_KILLER_SIZE,
  },
)

await browser.close()

const N = analysis.N
const warnings = [...analysis.warnings]
const regions = analysis.regions
const regionMode = analysis.regionMode

// ───────────────────────── 预填数字 + 人工覆盖 ─────────────────────────
const valueOfChar = (ch) => {
  if (/^[1-9]$/.test(ch)) return Number(ch)
  const up = ch.toUpperCase()
  const idx = 'ABCDEFG'.indexOf(up)
  return idx >= 0 ? idx + 10 : -1
}
const givens = analysis.cells.map((c) => (c.given ? Math.max(0, valueOfChar(c.given.ch)) : 0))
for (const cell of analysis.cells) {
  if (cell.given && cell.given.score < 0.55) {
    warnings.push(
      `格 (${cell.col},${cell.row}) 预填数字置信度低（${cell.given.ch} ${cell.given.score}，候选 ${cell.given.ranked.join('/')}）`,
    )
  }
}
for (const [key, ch] of manualGivens) {
  const x = key % 10000
  const y = Math.floor(key / 10000)
  if (x >= N || y >= N) {
    console.error(`--map 坐标越界：${x},${y}（网格 ${N}×${N}）`)
    process.exit(1)
  }
  const v = valueOfChar(ch)
  if (v < 1 || v > N) {
    console.error(`--map 值必须是 1..${N}（大于 9 用 A..${String.fromCharCode(55 + Math.min(N, 16))}）：${ch}`)
    process.exit(1)
  }
  givens[y * N + x] = v
  console.log(`[import] 人工覆盖预填 (${x},${y}) = ${ch}`)
}

if (debug) {
  for (const c of analysis.cells) {
    if (!c.sums.length) continue
    console.log(
      `[debug] 笼和字形 (${c.col},${c.row}) = ${c.sums.join('')} 分数 ${c.sumScores.join('/')} 候选 ` +
        c.sumRanked.map((r) => r.join('|')).join(' '),
    )
  }
}

// ───────────────────────── 笼 + 和 ─────────────────────────
const maxCageSum = (N * (N + 1)) / 2
const cages = []
for (let ci = 0; ci < analysis.cageCount; ci++) {
  const cells = []
  for (let i = 0; i < N * N; i++) if (analysis.cageOf[i] === ci) cells.push(i)
  const top = analysis.cageTop[ci]
  const info = analysis.cells[top]
  let sum = null
  if (info.sums.length) {
    const text = info.sums.join('')
    if (/^\d{1,3}$/.test(text)) sum = Number(text)
  }
  cages.push({ id: ci, cells, sum, top, sumScores: info.sumScores, sumRanked: info.sumRanked })
}
for (const [key, raw] of manualSums) {
  const x = key % 10000
  const y = Math.floor(key / 10000)
  if (x >= N || y >= N) {
    console.error(`--sum 坐标越界：${x},${y}（网格 ${N}×${N}）`)
    process.exit(1)
  }
  const idx = y * N + x
  const cage = cages.find((c) => c.top === idx)
  if (!cage) {
    console.error(`--sum 坐标 (${x},${y}) 不是任何笼的左上格`)
    process.exit(1)
  }
  cage.sum = Number(raw)
  console.log(`[import] 人工覆盖笼和 (${x},${y}) = ${raw}`)
}

for (const cage of cages) {
  const k = cage.cells.length
  const minSum = (k * (k + 1)) / 2
  const maxSum = k * N - (k * (k - 1)) / 2
  if (cage.sum == null) {
    warnings.push(
      `笼 ${cage.id}（左上格 ${cage.top % N},${(cage.top / N) | 0}）未识别出和数，可用 --sum "${cage.top % N},${(cage.top / N) | 0}=和" 修正`,
    )
    continue
  }
  if (cage.sum < minSum || cage.sum > Math.min(maxSum, maxCageSum)) {
    warnings.push(`笼 ${cage.id} 的和 ${cage.sum} 超出 ${k} 格可能范围 ${minSum}..${Math.min(maxSum, maxCageSum)}`)
  }
  if (cage.sumScores.some((s) => s < 0.6)) {
    warnings.push(
      `笼 ${cage.id} 的和 ${cage.sum} 有低置信度数字（${cage.sumRanked.map((r) => r.join('/')).join(' ')}）`,
    )
  }
}

// 按左上格顺序编号，便于人读/比对
const orderedCages = cages.slice().sort((a, b) => a.top - b.top)
const finalCages = orderedCages.map((c, i) => ({ ...c, id: i }))
const cageOfCell = new Array(N * N).fill(-1)
finalCages.forEach((c) => c.cells.forEach((i) => (cageOfCell[i] = c.id)))

// ───────────────────────── 预览 ─────────────────────────
const clues = givens.filter((v) => v !== 0).length
const sumsValid = finalCages.every((c) => Number.isInteger(c.sum) && c.sum >= 1 && c.sum <= maxCageSum)
const cagesValid = finalCages.every((c) => c.cells.length >= 1 && c.cells.length <= N)
const sumRangesValid = finalCages.every((c) => {
  const k = c.cells.length
  const minSum = (k * (k + 1)) / 2
  const maxSum = Math.min(k * N - (k * (k - 1)) / 2, maxCageSum)
  return Number.isInteger(c.sum) && c.sum >= Math.max(1, minSum) && c.sum <= maxSum
})
const regionsValid =
  regions.length === N * N &&
  new Set(regions).size === N &&
  finalCages.length > 0 &&
  finalCages.every((c) => c.cells.length <= N)

console.log(
  `[import] ${path.basename(IMAGE)}：${analysis.W}×${analysis.H}px，识别网格 ${N}×${N}，` +
    `格距 ${analysis.cellX}×${analysis.cellY}px，笼界边 ${analysis.cageEdgeCount}`,
)
console.log(
  `[import] 区域：${
    regionMode === 'jigsaw' ? `不规则宫（粗线识别 ${new Set(regions).size} 个区域）` : '标准矩形宫'
  }；线宽（普通/粗线阈值）：${analysis.baseLineWidth}px / ${analysis.thickThreshold || '无粗线'}`,
)
console.log(
  `[import] 预填 ${clues}/${N * N}，笼 ${finalCages.length} 个（和 ${finalCages.map((c) => c.sum ?? '?').join(',')}）`,
)
if (debug) {
  console.log(
    `[debug] 网格线 x=${JSON.stringify(analysis.xLines)} y=${JSON.stringify(analysis.yLines)}`,
  )
  console.log(`[debug] 虚线覆盖率样本：${JSON.stringify(analysis.dashSample)}`)
}
console.log('[import] 识别结果：')
const cellChar = (v) => (v ? (v <= 9 ? String(v) : String.fromCharCode(55 + v)) : '.')
for (let y = 0; y < N; y++) {
  let line = ''
  for (let x = 0; x < N; x++) {
    const ch = cellChar(givens[y * N + x])
    const sep = x > 0 && x % 3 === 0 ? ' | ' : ' '
    line += (x === 0 ? '' : sep) + ch
  }
  console.log('  ' + String(y).padStart(2) + ' ' + line)
}
console.log('[import] 笼矩阵：')
const cw = String(finalCages.length - 1).length
for (let y = 0; y < N; y++) {
  console.log(
    '  ' +
      String(y).padStart(2) +
      ' ' +
      cageOfCell
        .slice(y * N, y * N + N)
        .map((c) => String(c).padStart(cw))
        .join(' '),
  )
}
if (regionMode === 'jigsaw') {
  console.log('[import] 区域矩阵：')
  const rw = String(new Set(regions).size - 1).length
  for (let y = 0; y < N; y++) {
    console.log(
      '  ' +
        String(y).padStart(2) +
        ' ' +
        regions
          .slice(y * N, y * N + N)
          .map((r) => String(r).padStart(rw))
          .join(' '),
    )
  }
}
if (warnings.length) {
  console.log(`[import] 注意 ${warnings.length} 条：`)
  for (const w of warnings.slice(0, 40)) console.log('  - ' + w)
  if (warnings.length > 40) console.log(`  … 其余 ${warnings.length - 40} 条略`)
}

// ───────────────────────── 校验（--verify / --append 都会做） ─────────────────────────
let solution = null
let unique = false
let verifyTimedOut = false
if (verify || append) {
  if (!sumsValid) {
    console.warn('[import] 有笼和未识别或超出范围，跳过编译器校验；请用 --sum 修正后重试')
  } else if (!regionsValid) {
    console.warn('[import] 区域/笼结构不合法，跳过校验')
  } else {
    const { countSolutions, findSolution } = await import('../src/game/solver.ts')
    const { isValidSolution } = await import('../src/game/rules.ts')
    const cageList = finalCages.map((c) => ({ cells: c.cells, sum: c.sum }))
    const gens = givens.slice()
    const maxNodes = Number(process.env.IMPORT_MAX_NODES) || (N > 9 ? 300_000 : 800_000)
    const t0 = Date.now()
    const counted = countSolutions(gens, regions, cageList, 2, maxNodes, N)
    if (counted.timedOut) {
      verifyTimedOut = true
      console.warn(
        `[import] 唯一性检查超时（${counted.nodes} 节点，超过 ${maxNodes}），无法确认唯一解；` +
          '可加 --size/--sum 修正或人工复核，或直接 --append（参考解留空）',
      )
    } else if (counted.count === 0) {
      console.warn('[import] 无解：笼界/和数/区域可能识别有误，请用 --map/--sum 修正或检查 --regions')
    } else if (counted.count !== 1) {
      console.warn(`[import] 解不唯一：至少 ${counted.count} 个（可能笼界/和数识别有误）`)
    } else {
      unique = true
      const sol = findSolution(gens, regions, cageList, maxNodes, N)
      if (sol && isValidSolution(sol, regions, cageList, N)) {
        solution = sol
        for (let i = 0; i < N * N; i++) {
          if (givens[i] !== 0 && givens[i] !== sol[i]) {
            warnings.push(`预填 (${i % N},${(i / N) | 0}) = ${givens[i]} 与参考解 ${sol[i]} 冲突`)
          }
        }
      }
      console.log(`[import] 项目 solver 校验：唯一解 ✓（${Date.now() - t0}ms，${counted.nodes} 节点）`)
    }
  }
}
if (solution) {
  console.log('[import] 参考解：')
  for (let y = 0; y < N; y++) console.log('  ' + solution.slice(y * N, y * N + N).map(cellChar).join(''))
}

// ───────────────────────── 导出 / 写入 ─────────────────────────
const id = `killer-import-${Date.now().toString(36)}`
const name = nameOpt || `识图 · ${N}×${N} 杀手`
if (jsonOut) {
  const file = path.resolve(jsonOut)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify(
      {
        width: N,
        height: N,
        regionMode,
        givens: givens.map((v) => (v ? cellChar(v) : '.')),
        regions,
        cages: finalCages.map((c) => ({ cells: c.cells, sum: c.sum })),
        solution: solution ? solution.join('') : null,
        unique,
        verifyTimedOut,
        warnings,
        source: path.basename(IMAGE),
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`[import] 已导出 JSON：${file}`)
}

const canWrite =
  sumsValid &&
  sumRangesValid &&
  regionsValid &&
  N >= MIN_KILLER_SIZE &&
  N <= MAX_KILLER_SIZE &&
  cagesValid &&
  finalCages.length <= 36

if (append) {
  if (dry) {
    console.log('[import] --dry：跳过写入')
  } else if (!canWrite) {
    console.error('[import] 识别结果不完整（笼和/区域/笼数不合法），拒绝写入；请用 --map/--sum 修正后重试')
    process.exitCode = 2
  } else if (verifyTimedOut) {
    console.warn('[import] 唯一性校验超时，仍写入（参考解留空，npm run check 可能给超时警告）')
    writeImportedEntry('')
  } else if (!unique) {
    console.error('[import] 未确认唯一解，拒绝写入；请修正识别结果后重试')
    process.exitCode = 2
  } else {
    writeImportedEntry(solution ? encodeCells(solution) : '')
  }
} else {
  console.log('[import] 预览模式（未写入）。加 --append 写入 src/game/imported-puzzles.ts。')
}

function writeImportedEntry(solutionText) {
  const board = encodeBoard(givens, regions, finalCages.map((c) => ({ cells: c.cells, sum: c.sum })))
  const entry =
    `  { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, width: ${N}, height: ${N}, ` +
    `difficulty: 'custom', series: ${JSON.stringify(series)}, board: ${JSON.stringify(board)}, ` +
    `solution: ${JSON.stringify(solutionText)} },\n`
  const dataFile = path.resolve('src/game/imported-puzzles.ts')
  if (!existsSync(dataFile)) {
    console.error(`[import] 找不到识图题库文件：${dataFile}`)
    process.exitCode = 2
    return
  }
  let text = readFileSync(dataFile, 'utf8').replace(/\r\n/g, '\n')
  const marker = 'export const IMPORTED_PUZZLES: RawPuzzle[] = ['
  const idx = text.indexOf(marker)
  if (idx < 0) {
    console.error('[import] imported-puzzles.ts 格式异常：找不到 IMPORTED_PUZZLES 定义')
    process.exitCode = 2
    return
  }
  const insertAt = idx + marker.length
  const rest = text.slice(insertAt)
  const close = /^\s*\]/.exec(rest)
  if (close) {
    const closeAt = insertAt + close[0].length - 1
    text = text.slice(0, insertAt) + '\n' + entry + ']' + text.slice(closeAt + 1)
  } else {
    text = text.slice(0, insertAt) + '\n' + entry + text.slice(insertAt).replace(/^\n/, '')
  }
  writeFileSync(dataFile, text)
  console.log(`[import] 已写入 ${dataFile}：${id} ${name}`)
  console.log('[import] 提示：npm run gen 只重写 puzzles-data.ts / puzzles-extra-data.ts，不会覆盖本文件。')
}

