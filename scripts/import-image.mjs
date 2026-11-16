/**
 * 杀手数独题面图片导入（全自动识图版）
 *
 * 用法：
 *   node scripts/import-image.mjs <图片路径> [--size N] [--name 名称] [--series 识图]
 *                                  [--append] [--verify] [--json 输出.json]
 *                                  [--map "x,y=字符,..."] [--dry]
 *
 * 流程：
 *   1. Playwright + Edge 打开图片到 canvas，取灰度像素；
 *   2. 投影暗像素找竖/横网格线，取等距最长序列自动判定 N；
 *   3. 笼边界检测：每条内部格线取格线中心像素序列，统计多阈值下的明暗翻转
 *      次数（虚线笼界会在 96/191 或 54/96 之间交替），自动判出虚线段；
 *   4. 按非笼界边四连通洪泛得到笼子；每笼取行优先最小格（游戏渲染和数位置），
 *      在该格左上角做连通域字形识别得到笼和；格中心的连通域识别预填数字；
 *   5. 预览题面/笼矩阵；--verify 调项目 solver 验证唯一解并求参考解；
 *   6. --append 写入 src/game/puzzles-data.ts（只支持当前题库的 9×9）。
 *
 * 说明：--map 可人工覆盖预填数字（坐标 0 基，列,行），例如 --map "3,4=5"；
 *       笼和暂不支持人工覆盖，识别异常时请用更清晰/更大的截图重试。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

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

const valueFlags = new Set(['--size', '--name', '--series', '--json', '--map'])
const imageArg = args.find((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1]))
if (!imageArg) {
  console.error(
    '用法：node scripts/import-image.mjs <图片路径> [--size N] [--name 名称] [--series 识图] [--append] [--verify] [--json out.json] [--map "x,y=字符,..."] [--dry]',
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
const append = has('--append')
const verify = has('--verify')
const dry = has('--dry')

const manual = new Map()
const mapArg = argEq('--map') ?? arg('--map')
if (mapArg) {
  // 支持 "x,y=字符" 连写，多组之间可用空格/分号/逗号分隔；坐标本身含逗号，故用全局匹配
  const re = /(\d+)\s*,\s*(\d+)\s*=\s*([^\s,;]+)/g
  let matched = 0
  let m
  while ((m = re.exec(mapArg)) !== null) {
    manual.set(Number(m[2]) * 10000 + Number(m[1]), m[3])
    matched++
  }
  const residue = mapArg.replace(re, '').replace(/[\s,;]+/g, '')
  if (!matched || residue) {
    console.error(`--map 格式错误：${mapArg}（应为 x,y=字符，多组用空格或分号分隔）`)
    process.exit(1)
  }
}

// ───────────────────────── 浏览器端识图 ─────────────────────────
const dataUrl = `data:image/png;base64,${readFileSync(IMAGE).toString('base64')}`
const browser = await chromium.launch({ headless: true, executablePath: edgePath() })
const page = await browser.newPage()
await page.setContent('<canvas id="c"></canvas>')

const analysis = await page.evaluate(
  async ({ dataUrl, sizeOpt }) => {
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

    // 1) 网格线：投影 + 等距最长序列
    const linesOf = (axis) => {
      const counts = new Int32Array(axis === 'x' ? W : H)
      const len = axis === 'x' ? H : W
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (gray(x, y) >= 230) continue
          counts[axis === 'x' ? x : y]++
        }
      }
      const threshold = len * 0.38
      const res = []
      let start = -1
      for (let i = 0; i < counts.length; i++) {
        const on = counts[i] >= threshold
        if (on && start < 0) start = i
        if (!on && start >= 0) {
          res.push((start + i - 1) / 2)
          start = -1
        }
      }
      if (start >= 0) res.push((start + counts.length - 1) / 2)
      return res
    }
    const runs = (lines) => {
      const out = []
      for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
          const step = (lines[j] - lines[i]) / (j - i)
          if (step < 8) continue
          let end = i
          for (let k = i + 1; k < lines.length; k++) {
            if (Math.abs(lines[k] - (lines[i] + step * (k - i))) > step * 0.15) break
            end = k
          }
          if (end - i >= 1) out.push({ start: i, end, step, count: end - i + 1 })
        }
      }
      out.sort((a, b) => b.count - a.count || a.step - b.step)
      return out
    }
    const xsAll = linesOf('x')
    const ysAll = linesOf('y')
    if (!xsAll.length || !ysAll.length) throw new Error('图片里没有找到网格线')
    const pickRun = (list) => {
      if (sizeOpt >= 4) {
        for (const r of list) if (r.count - 1 === sizeOpt) return r
      }
      return list[0] ?? null
    }
    const xr = pickRun(runs(xsAll))
    const yr = pickRun(runs(ysAll))
    if (!xr || !yr) throw new Error('无法确定网格线')
    let xLines = xsAll.slice(xr.start, xr.end + 1)
    let yLines = ysAll.slice(yr.start, yr.end + 1)
    let N = Math.min(xLines.length, yLines.length) - 1
    if (xLines.length !== yLines.length) {
      const n2 = Math.min(xLines.length, yLines.length)
      xLines = xLines.slice(0, n2)
      yLines = yLines.slice(0, n2)
      N = n2 - 1
    }
    if (N < 4) throw new Error(`识别到的网格太小：${N}`)
    if (sizeOpt >= 4 && N !== sizeOpt) {
      throw new Error(`网格尺寸不匹配：识别到 ${N}×${N}，--size ${sizeOpt}`)
    }
    const cellX = (xLines[N] - xLines[0]) / N
    const cellY = (yLines[N] - yLines[0]) / N

    // 2) 笼界（虚线）检测：格线中心像素灰度序列的明暗翻转次数
    const edgeInfo = (vertical, lineIdx, cellIdx) => {
      const M = 96
      const vals = []
      for (let s = 0; s < M; s++) {
        const t = (s + 0.5) / M
        if (vertical) {
          vals.push(gray(Math.round(xLines[lineIdx]), Math.round(yLines[cellIdx] + cellY * t)))
        } else {
          vals.push(gray(Math.round(xLines[cellIdx] + cellX * t), Math.round(yLines[lineIdx])))
        }
      }
      const runsAt = (thr) => {
        let runs = 0
        let cur = 0
        for (const v of vals) {
          if (v < thr) cur++
          else {
            if (cur >= 2) runs++
            cur = 0
          }
        }
        if (cur >= 2) runs++
        return runs
      }
      // 覆盖：普通虚线（96↔191）、压粗宫线的虚线（54↔96）
      const THRS = [68, 78, 90, 105, 125, 150, 172]
      const transitions = THRS.map((t) => runsAt(t))
      return {
        maxRuns: Math.max(...transitions),
        darkFrac: vals.filter((v) => v < 170).length / vals.length,
        minVal: Math.min(...vals),
        maxVal: Math.max(...vals),
      }
    }
    const vWalls = Array.from({ length: N + 1 }, () => new Uint8Array(N))
    const hWalls = Array.from({ length: N + 1 }, () => new Uint8Array(N))
    let cageEdgeCount = 0
    for (let line = 1; line < N; line++) {
      for (let c = 0; c < N; c++) {
        const info = edgeInfo(true, line, c)
        if (info.maxRuns >= 4) {
          vWalls[line][c] = 1
          cageEdgeCount++
        }
      }
    }
    for (let line = 1; line < N; line++) {
      for (let c = 0; c < N; c++) {
        const info = edgeInfo(false, line, c)
        if (info.maxRuns >= 4) {
          hWalls[line][c] = 1
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

    // 3) 字形模板（数字 0-9，多字体多字重）
    const DIGITS = '0123456789'
    const NS = 24
    const SRC = 40
    const fonts = [
      '700 84px Arial',
      '400 84px Arial',
      '700 84px "Segoe UI"',
      '400 84px "Segoe UI"',
      '700 84px Verdana',
      '700 84px Tahoma',
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
      let x0 = SRC, y0 = SRC, x1 = -1, y1 = -1, ink = 0
      const m = new Uint8Array(SRC * SRC)
      for (let j = 0; j < SRC; j++) {
        for (let i = 0; i < SRC; i++) {
          if (raw[j * SRC + i] >= T) continue
          m[j * SRC + i] = 1
          ink++
          if (i < x0) x0 = i
          if (i > x1) x1 = i
          if (j < y0) y0 = j
          if (j > y1) y1 = j
        }
      }
      if (!ink) return null
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
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
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
          let union = 0
          for (let j = 0; j < NS; j++) {
            const bj = j + dy
            for (let i = 0; i < NS; i++) {
              const av = a[j * NS + i]
              const bi = i + dx
              const bv = bj >= 0 && bj < NS && bi >= 0 && bi < NS ? b[bj * NS + bi] : 0
              if (av && bv) inter++
              if (av || bv) union++
            }
          }
          const s = union ? inter / union : 0
          if (s > best) best = s
        }
      }
      return best
    }
    const templates = {}
    for (const ch of DIGITS) templates[ch] = []
    for (const font of fonts) {
      for (const ch of DIGITS) {
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
    const classify = (bits) => {
      const holes = holesOf(bits)
      const ranked = DIGITS.split('')
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
      return ranked
    }

    // 4) 每格连通域 → 字形：中心大字形=预填数字；左上角小字形=笼和
    const cellInfo = []
    for (let row = 0; row < N; row++) {
      for (let col = 0; col < N; col++) {
        const x0 = xLines[col] + cellX * 0.04
        const y0 = yLines[row] + cellY * 0.04
        const w = cellX * 0.92
        const h = cellY * 0.92
        const pw = Math.max(8, Math.round(w))
        const ph = Math.max(8, Math.round(h))
        const ox = Math.round(x0)
        const oy = Math.round(y0)
        const bins = new Uint8Array(pw * ph)
        for (let j = 0; j < ph; j++) {
          for (let i = 0; i < pw; i++) bins[j * pw + i] = gray(ox + i, oy + j) < 185 ? 1 : 0
        }
        const seen = new Uint8Array(pw * ph)
        const comps = []
        for (let j = 0; j < ph; j++) {
          for (let i = 0; i < pw; i++) {
            const k = j * pw + i
            if (!bins[k] || seen[k]) continue
            const stack = [[i, j]]
            seen[k] = 1
            let minX = i, maxX = i, minY = j, maxY = j, n = 0
            while (stack.length) {
              const [x, y] = stack.pop()
              n++
              if (x < minX) minX = x
              if (x > maxX) maxX = x
              if (y < minY) minY = y
              if (y > maxY) maxY = y
              for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nx = x + dx
                const ny = y + dy
                if (nx < 0 || ny < 0 || nx >= pw || ny >= ph) continue
                const nk = ny * pw + nx
                if (seen[nk] || !bins[nk]) continue
                seen[nk] = 1
                stack.push([nx, ny])
              }
            }
            if (n < 6) continue
            comps.push({ minX, maxX, minY, maxY, n })
          }
        }
        // 去掉被更大连通域包围的小块（如 Cascadia Code 带点的 0 中间的点）
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
          const bw = c.maxX - c.minX + 1
          const bh = c.maxY - c.minY + 1
          if (bh < 3 || bw < 1) continue
          const rawGlyph = new Float32Array(SRC * SRC)
          for (let j = 0; j < SRC; j++) {
            for (let i = 0; i < SRC; i++) {
              const sx = c.minX + Math.min(bw - 1, Math.floor((bw * i) / SRC))
              const sy = c.minY + Math.min(bh - 1, Math.floor((bh * j) / SRC))
              rawGlyph[j * SRC + i] = bins[sy * pw + sx] ? 0 : 255
            }
          }
          const bits = normBit(rawGlyph, 128)
          if (!bits) continue
          // 宽扁的可能是两个数字粘连：按列墨迹切分
          const parts = []
          if (bw > bh * 1.45) {
            const colInk = new Array(bw).fill(0)
            for (let x = 0; x < bw; x++) {
              for (let y = 0; y < bh; y++) if (bins[(c.minY + y) * pw + c.minX + x]) colInk[x]++
            }
            let cut = -1
            for (let x = Math.floor(bw * 0.3); x < Math.ceil(bw * 0.7); x++) {
              if (colInk[x] === 0) {
                cut = x
                break
              }
              if (cut < 0 && colInk[x] <= 1) cut = x
            }
            if (cut > 0) parts.push([0, cut], [cut + 1, bw - 1])
          }
          if (parts.length) {
            for (const [a, b] of parts) {
              const sbw = b - a + 1
              const raw2 = new Float32Array(SRC * SRC)
              for (let j = 0; j < SRC; j++) {
                for (let i = 0; i < SRC; i++) {
                  const sx = c.minX + a + Math.min(sbw - 1, Math.floor((sbw * i) / SRC))
                  const sy = c.minY + Math.min(bh - 1, Math.floor((bh * j) / SRC))
                  raw2[j * SRC + i] = bins[sy * pw + sx] ? 0 : 255
                }
              }
              const b2 = normBit(raw2, 128)
              if (b2) glyphs.push({ bw: sbw, bh, minX: c.minX + a, minY: c.minY, ranked: classify(b2) })
            }
          } else {
            glyphs.push({ bw, bh, minX: c.minX, minY: c.minY, ranked: classify(bits) })
          }
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
          .filter((g) => g !== given && g.minY < ph * 0.45 && g.bw < pw * 0.5 && g.bh <= ph * 0.32)
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
      cageOf,
      cageSizes,
      cageCount,
      cageTop,
      cageEdgeCount,
      cells: cellInfo,
    }
  },
  { dataUrl, sizeOpt },
)

await browser.close()

const N = analysis.N
const warnings = []

// ───────────────────────── 预填数字 + 人工覆盖 ─────────────────────────
let givens = analysis.cells.map((c) => (c.given ? c.given.ch : null))
for (const cell of analysis.cells) {
  if (cell.given && cell.given.score < 0.55) {
    warnings.push(
      `格 (${cell.col},${cell.row}) 预填数字置信度低（${cell.given.ch} ${cell.given.score}，候选 ${cell.given.ranked.join('/')}）`,
    )
  }
}
for (const [key, ch] of manual) {
  const x = key % 10000
  const y = Math.floor(key / 10000)
  if (x >= N || y >= N) {
    console.error(`--map 坐标越界：${x},${y}`)
    process.exit(1)
  }
  if (!/^[1-9]$/.test(ch)) {
    console.error(`--map 值必须是 1-9：${ch}`)
    process.exit(1)
  }
  givens[y * N + x] = ch
  console.log(`[import] 人工覆盖 (${x},${y}) = ${ch}`)
}

// ───────────────────────── 笼 + 和 ─────────────────────────
const cages = []
for (let ci = 0; ci < analysis.cageCount; ci++) {
  const cells = []
  for (let i = 0; i < N * N; i++) if (analysis.cageOf[i] === ci) cells.push(i)
  const top = analysis.cageTop[ci]
  const info = analysis.cells[top]
  let sum = null
  if (info.sums.length) {
    const text = info.sums.join('')
    if (/^\d{1,2}$/.test(text)) sum = Number(text)
  }
  cages.push({ id: ci, cells, sum, top, sumSource: info })
  if (sum == null) {
    warnings.push(`笼 ${ci}（左上格 ${top % N},${(top / N) | 0}）未识别出和数`)
  } else {
    const k = cells.length
    const minSum = (k * (k + 1)) / 2
    const maxSum = k * 9 - (k * (k - 1)) / 2
    if (sum < minSum || sum > maxSum || sum < 1 || sum > 45) {
      warnings.push(`笼 ${ci} 的和 ${sum} 超出 ${k} 格可能范围 ${minSum}..${maxSum}`)
    }
    if (info.sumScores.some((s) => s < 0.6)) {
      warnings.push(`笼 ${ci} 的和 ${sum} 有低置信度数字（${info.sumRanked.map((r) => r.join('/')).join(' ')}）`)
    }
  }
}

// 标准 3×3 宫
const regions = new Array(N * N)
const box = N === 9 ? 3 : 4
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    regions[y * N + x] = Math.floor(y / box) * Math.ceil(N / box) + Math.floor(x / box)
  }
}

function encodeCageBoard(givensArr, regionsArr, cageList) {
  let out = givensArr.join('') + '|' + regionsArr.join('') + '|'
  const cageOf = new Array(givensArr.length).fill(0)
  cageList.forEach((c, ci) => c.cells.forEach((i) => (cageOf[i] = ci)))
  for (const c of cageOf) out += c.toString(36)
  out += ':' + cageList.map((c) => c.sum).join(',')
  return out
}

// ───────────────────────── 预览 ─────────────────────────
const clues = givens.filter(Boolean).length
console.log(
  `[import] ${path.basename(IMAGE)}：${analysis.W}×${analysis.H}px，识别网格 ${N}×${N}，` +
    `格距 ${analysis.cellX}×${analysis.cellY}px，笼界边 ${analysis.cageEdgeCount}`,
)
console.log(
  `[import] 预填 ${clues}/${N * N}，笼 ${cages.length} 个（和 ${cages.map((c) => c.sum ?? '?').join(',')}）`,
)
console.log('[import] 识别结果：')
for (let y = 0; y < N; y++) {
  let line = ''
  for (let x = 0; x < N; x++) {
    const ch = givens[y * N + x] ?? '.'
    const sep = x > 0 && x % 3 === 0 ? ' | ' : ' '
    line += (x === 0 ? '' : sep) + ch
  }
  console.log('  ' + String(y).padStart(2) + ' ' + line)
}
console.log('[import] 笼矩阵：')
const cw = String(cages.length - 1).length
for (let y = 0; y < N; y++) {
  console.log(
    '  ' +
      String(y).padStart(2) +
      ' ' +
      analysis.cageOf
        .slice(y * N, y * N + N)
        .map((c) => String(c).padStart(cw))
        .join(' '),
  )
}
const badSizes = cages.filter((c) => c.sum == null)
if (warnings.length) {
  console.log(`[import] 注意 ${warnings.length} 条：`)
  for (const w of warnings.slice(0, 30)) console.log('  - ' + w)
  if (warnings.length > 30) console.log(`  … 其余 ${warnings.length - 30} 条略`)
}

// ───────────────────────── 校验 ─────────────────────────
let solution = null
let unique = false
const givensArr = givens.map((ch) => (ch ? Number(ch) : 0))
const sumsValid = cages.every((c) => Number.isInteger(c.sum) && c.sum >= 1 && c.sum <= 45)
if (verify || append) {
  if (N !== 9) {
    console.warn(`[import] 项目 solver 只支持 9×9，跳过校验（识别到 ${N}×${N}）`)
  } else if (!sumsValid) {
    console.warn('[import] 有笼和未识别或超出范围，跳过校验；请用更清晰的截图重试')
  } else {
    const { countSolutions, solvePuzzle } = await import('../src/game/solver.ts')
    const cageList = cages.map((c) => ({ cells: c.cells, sum: c.sum }))
    const t0 = Date.now()
    const counted = countSolutions(givensArr, regions, cageList, 2, 800000)
    if (counted.timedOut) {
      console.warn(`[import] 唯一性检查超时（${counted.nodes} 节点），仅警告`)
    } else if (counted.count !== 1) {
      console.warn(`[import] 解不唯一：找到 ${counted.count} 个（可能笼界/和数识别有误）`)
    } else {
      unique = true
      const puzzle = {
        id: 'import-temp',
        name: 'import-temp',
        width: 9,
        height: 9,
        difficulty: 'hard',
        givens: givensArr,
        regions,
        cages: cageList,
      }
      const solved = solvePuzzle(puzzle, 1500000)
      if (solved.solution) solution = solved.solution.cells.slice()
      console.log(`[import] 项目 solver 校验：唯一解 ✓（${Date.now() - t0}ms，${counted.nodes} 节点）`)
    }
  }
}
if (solution) {
  console.log('[import] 参考解：')
  for (let y = 0; y < N; y++) console.log('  ' + solution.slice(y * N, y * N + N).join(''))
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
        givens: givens.map((ch) => ch ?? '.'),
        regions,
        cages: cages.map((c) => ({ cells: c.cells, sum: c.sum })),
        solution: solution ? solution.join('') : null,
        unique,
        source: path.basename(IMAGE),
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`[import] 已导出 JSON：${file}`)
}

if (append) {
  if (dry) {
    console.log('[import] --dry：跳过写入')
  } else if (N !== 9) {
    console.error(`[import] 当前题库只支持 9×9，无法写入 ${N}×${N}`)
    process.exitCode = 2
  } else if (!sumsValid) {
    console.error('[import] 有笼和未识别或非法，拒绝写入；请用更清晰的截图重试')
    process.exitCode = 2
  } else if (cages.length > 36) {
    console.error(`[import] 笼数 ${cages.length} 超过编码上限 36`)
    process.exitCode = 2
  } else {
    const board = encodeCageBoard(givensArr, regions, cages)
    const solutionText = solution ? solution.join('') : ''
    if (!unique) {
      console.warn('[import] 未确认唯一解，条目的参考解留空（可能导致 npm run check 报错）')
    }
    const entry =
      `  { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, width: 9, height: 9, ` +
      `difficulty: 'custom', series: ${JSON.stringify(series)}, board: ${JSON.stringify(board)}, ` +
      `solution: ${JSON.stringify(solutionText)} },\n`
    const dataFile = path.resolve('src/game/puzzles-data.ts')
    let text = readFileSync(dataFile, 'utf8').replace(/\r\n/g, '\n')
    const marker = text.lastIndexOf('\n]')
    if (marker < 0) throw new Error('puzzles-data.ts 格式异常：找不到结尾 ]')
    text = text.slice(0, marker + 1) + entry + text.slice(marker + 1)
    writeFileSync(dataFile, text)
    console.log(`[import] 已写入 ${dataFile}：${id} ${name}`)
    console.log('[import] 提示：npm run gen 会重新生成题库（覆盖本次写入），导入题请先备份。')
  }
} else {
  console.log('[import] 预览模式（未写入）。加 --append 写入 src/game/puzzles-data.ts。')
}
