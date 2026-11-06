/**
 * dsh-motion-capture —— DSH 动态物体捕捉（视频抽帧 + 运动红点 + 编号拼图）
 *
 * 设计目标（按需求逐条对齐）：
 *  1. 快速 + 低能耗：单次 ffmpeg 解码（低采样率 fps + 小宽度），帧差在纯 JS 里做，
 *     不依赖 sharp / opencv / canvas，不逐帧重复解码；不做全分辨率计算。
 *  2. 动态采样点：相邻采样帧的网格灰度差 -> 只保留最强的 K 个互不重叠格子，
 *     在画面上画 3×3 纯红像素（尽量小），红点即“这帧相对上一帧在动的位置”。
 *  3. 视频动态帧草稿：每帧左上角烧入递增编号 #0001；再拼成 3×2 的连续大图
 *     （contact sheet，编号放大 3 倍），模型只看编号即可对上时间顺序。
 *  4. 临时缓存：所有 PNG 落在系统临时目录 dsh-motion-capture/<runId>/，
 *     可 list / purge；PNG 由 ffmpeg 编码，插件自身零图片编码依赖。
 *  5. 多模态：本工具只服务于能读图片的多模态模型路由；若当前路由未声明 image 输入，
 *     直接拒绝调用（抛错提示切换视觉模型），不做纯文本降级。
 *
 * 说明：帧编号从 1 开始，时间戳 = 编号-1 / 实际采样fps，编号与文件 f0001.png 一致。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

export const name = 'motion-capture'
export const inject = ['tools']

const VERSION = '0.1.0'
const ROOT = join(tmpdir(), 'dsh-motion-capture')
const DEFAULT_FPS = 2
const DEFAULT_WIDTH = 360
const MAX_FRAMES = 60
const SHEET_COLS = 3
const SHEET_ROWS = 2
const SHEET_GAP = 3
const SHEET_HEADER = 18
const MAX_SHEET_IMAGES = 3

/* ───────────────────────────── ffmpeg 定位 ───────────────────────────── */

let ffmpegCache

function findFfmpeg() {
  if (ffmpegCache) return ffmpegCache
  const candidates = []
  if (typeof process.env.DSH_MOTION_FFMPEG === 'string' && process.env.DSH_MOTION_FFMPEG.length > 0) {
    candidates.push(process.env.DSH_MOTION_FFMPEG)
  }
  candidates.push('ffmpeg')
  // Python 的 imageio_ffmpeg 自带一份 ffmpeg（本机已装，最省事的兜底）
  try {
    const out = spawnSync('python', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], {
      encoding: 'utf8', windowsHide: true, timeout: 20000,
    })
    if (out.status === 0 && typeof out.stdout === 'string' && out.stdout.trim().length > 0) {
      candidates.push(out.stdout.trim())
    }
  } catch { /* 忽略：继续试下一个候选 */ }
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
      if (probe.status === 0) {
        ffmpegCache = candidate
        return candidate
      }
    } catch { /* 继续 */ }
  }
  throw new Error('找不到 ffmpeg：请把 ffmpeg 放进 PATH，或设置环境变量 DSH_MOTION_FFMPEG 指向 ffmpeg.exe')
}

function runFfmpeg(args, signal, timeoutMs = 180000) {
  const bin = findFfmpeg()
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    let stderr = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal !== undefined && signal !== null && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
      fn(value)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 忽略 */ }
      finish(reject, new Error(`ffmpeg 超时（>${timeoutMs}ms）`))
    }, timeoutMs)
    const onAbort = () => {
      try { child.kill('SIGKILL') } catch { /* 忽略 */ }
      finish(reject, new Error('已取消（exec.signal aborted）'))
    }
    if (signal !== undefined && signal !== null && typeof signal.addEventListener === 'function') {
      if (signal.aborted === true) { onAbort(); return }
      signal.addEventListener('abort', onAbort)
    }
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => finish(reject, new Error(`ffmpeg 启动失败：${error.message}`)))
    child.on('close', (code) => {
      if (code === 0) finish(resolvePromise, stderr)
      else finish(reject, new Error(`ffmpeg 退出码 ${code}：${stderr.slice(-600)}`))
    })
  })
}

/* ───────────────────────────── 5×7 点阵字体（无字体依赖） ───────────────────────────── */

const FONT = {
  0: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10010', '10001', '10001'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '01110'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  s: ['00000', '00000', '01111', '10000', '01110', '00001', '11110'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
}

const GLYPH_W = 5
const GLYPH_H = 7

function fillRect(rgb, width, height, x0, y0, w, h, color) {
  const x1 = Math.min(width, x0 + w)
  const y1 = Math.min(height, y0 + h)
  for (let y = Math.max(0, y0); y < y1; y++) {
    let base = (y * width + Math.max(0, x0)) * 3
    for (let x = Math.max(0, x0); x < x1; x++, base += 3) {
      rgb[base] = color[0]
      rgb[base + 1] = color[1]
      rgb[base + 2] = color[2]
    }
  }
}

/** 画一行点阵文字，返回占宽。scale=1 时单字 5×7。 */
function drawText(rgb, width, height, text, x, y, scale, color) {
  let cursor = x
  for (const ch of String(text)) {
    if (ch === ' ') { cursor += 3 * scale; continue }
    const glyph = FONT[ch]
    if (glyph === undefined) { cursor += 5 * scale; continue }
    for (let row = 0; row < GLYPH_H; row++) {
      const bits = glyph[row]
      for (let col = 0; col < GLYPH_W; col++) {
        if (bits[col] !== '1') continue
        fillRect(rgb, width, height, cursor + col * scale, y + row * scale, scale, scale, color)
      }
    }
    cursor += (GLYPH_W + 1) * scale
  }
  return cursor - x
}

function textWidth(text, scale) {
  let w = 0
  for (const ch of String(text)) w += (ch === ' ' ? 3 : GLYPH_W + 1) * scale
  return w
}

/* ───────────────────────────── 帧缓冲与运动分析 ───────────────────────────── */

function bytesToRgb(buffer, width, height, frameCount) {
  const frameBytes = width * height * 3
  const frames = []
  for (let i = 0; i < frameCount; i++) {
    const start = i * frameBytes
    if (start + frameBytes > buffer.length) break
    frames.push(Buffer.from(buffer.subarray(start, start + frameBytes)))
  }
  return frames
}

/** 把 RGB 帧压成 cols×rows 的灰度均值网格（每帧只做一次，成本 ≈ 像素数）。 */
function gridMeans(rgb, width, height, cols, rows) {
  const out = new Float32Array(cols * rows)
  const cw = width / cols
  const ch = height / rows
  for (let cy = 0; cy < rows; cy++) {
    const y0 = Math.floor(cy * ch)
    const y1 = Math.max(y0 + 1, Math.floor((cy + 1) * ch))
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor(cx * cw)
      const x1 = Math.max(x0 + 1, Math.floor((cx + 1) * cw))
      let sum = 0
      let count = 0
      for (let y = y0; y < y1; y++) {
        let base = (y * width + x0) * 3
        for (let x = x0; x < x1; x++, base += 3) {
          sum += 0.299 * rgb[base] + 0.587 * rgb[base + 1] + 0.114 * rgb[base + 2]
          count++
        }
      }
      out[cy * cols + cx] = count > 0 ? sum / count : 0
    }
  }
  return out
}

/**
 * 网格帧差 -> 运动团块 + 采样点。
 * 1) 阈值 = max(最小阈值, 本帧差分中位数 × 2.5)，自适应整体亮度漂移；
 * 2) 8 邻域连通域把运动格子聚成“物体团块”，面积太小的直接丢（压缩噪声/反光噪点）；
 * 3) 采样点在团块内按强度取，互相隔一格，避免挤成一团；
 * 4) 返回团块质心，供下一帧按质心匹配出运动方向（不依赖纹理，避免棋盘格/条纹周期性误匹配）。
 */
function detectMotion(prev, cur, cols, rows, minThreshold, maxPoints, minArea) {
  const total = cols * rows
  const diffs = new Float32Array(total)
  let diffSum = 0
  let bright = 0
  let curSum = 0
  let prevSum = 0
  for (let i = 0; i < total; i++) {
    diffs[i] = Math.abs(cur[i] - prev[i])
    diffSum += diffs[i]
    curSum += cur[i]
    prevSum += prev[i]
    // 固定阈值统计“大幅变化”面积：自适应阈值在整帧爆闪时会失效，这里单独统计
    if (diffs[i] >= 60) bright++
  }
  const meanDiff = diffSum / Math.max(1, total)
  const brightRatio = bright / Math.max(1, total)
  const curMean = curSum / Math.max(1, total)
  const prevMean = prevSum / Math.max(1, total)
  const sorted = Float32Array.from(diffs).sort()
  const median = sorted[Math.floor(total * 0.5)]
  const threshold = Math.max(minThreshold, median * 2.5)

  const mask = new Uint8Array(total)
  let moving = 0
  for (let i = 0; i < total; i++) {
    if (diffs[i] > threshold) { mask[i] = 1; moving++ }
  }

  const visited = new Uint8Array(total)
  const blobs = []
  const stack = []
  for (let start = 0; start < total; start++) {
    if (mask[start] === 0 || visited[start] === 1) continue
    stack.length = 0
    stack.push(start)
    visited[start] = 1
    const cells = []
    let sumX = 0
    let sumY = 0
    let sumDiff = 0
    let x0 = cols
    let y0 = rows
    let x1 = -1
    let y1 = -1
    while (stack.length > 0) {
      const index = stack.pop()
      const cx = index % cols
      const cy = Math.floor(index / cols)
      cells.push(index)
      sumX += cx
      sumY += cy
      sumDiff += diffs[index]
      if (cx < x0) x0 = cx
      if (cy < y0) y0 = cy
      if (cx > x1) x1 = cx
      if (cy > y1) y1 = cy
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy
        if (ny < 0 || ny >= rows) continue
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = cx + dx
          if (nx < 0 || nx >= cols) continue
          const neighbor = ny * cols + nx
          if (mask[neighbor] === 1 && visited[neighbor] === 0) {
            visited[neighbor] = 1
            stack.push(neighbor)
          }
        }
      }
    }
    if (cells.length < minArea) continue
    blobs.push({
      cells,
      area: cells.length,
      cx: sumX / cells.length,
      cy: sumY / cells.length,
      peak: sumDiff / cells.length,
      box: { x0, y0, x1, y1 },
      trail: [],
    })
  }
  blobs.sort((a, b) => b.area - a.area)

  // 采样点只从保留的团块里挑，噪声团块的格子不再产生红点
  const blobOf = new Int16Array(total).fill(-1)
  blobs.forEach((blob, index) => {
    for (const cell of blob.cells) blobOf[cell] = index
  })
  const candidates = []
  for (let i = 0; i < total; i++) {
    if (blobOf[i] === -1) continue
    candidates.push({ cx: i % cols, cy: Math.floor(i / cols), d: diffs[i], blob: blobOf[i] })
  }
  candidates.sort((a, b) => b.d - a.d)

  const points = []
  for (const candidate of candidates) {
    if (points.length >= maxPoints) break
    let tooClose = false
    for (const point of points) {
      if (Math.abs(point.cx - candidate.cx) <= 1 && Math.abs(point.cy - candidate.cy) <= 1) { tooClose = true; break }
    }
    if (!tooClose) points.push(candidate)
  }
  points.sort((a, b) => a.cy - b.cy || a.cx - b.cx)

  const bboxCells = blobs.length === 0 ? null : blobs.reduce((acc, blob) => ({
    x0: Math.min(acc.x0, blob.box.x0),
    y0: Math.min(acc.y0, blob.box.y0),
    x1: Math.max(acc.x1, blob.box.x1),
    y1: Math.max(acc.y1, blob.box.y1),
  }), { x0: cols, y0: rows, x1: -1, y1: -1 })

  return { threshold, moving, ratio: moving / total, meanDiff, brightRatio, curMean, prevMean, blobs, points, bboxCells }
}

/**
 * 单个团块的运动矢量：在上一帧网格上以团块为中心做小范围搜索，
 * 取残差最小的偏移量。这样每个团块（包括刚出现/刚变形的）都能得到方向，
 * 不依赖“上一帧必须存在同一个团块”，箭头数量才够多。
 */
function estimateBlobShift(prev, cur, cols, rows, blob, radius = 3) {
  const x0 = Math.max(0, blob.box.x0 - 1)
  const x1 = Math.min(cols - 1, blob.box.x1 + 1)
  const y0 = Math.max(0, blob.box.y0 - 1)
  const y1 = Math.min(rows - 1, blob.box.y1 + 1)
  let bestDx = 0
  let bestDy = 0
  let bestCost = Infinity
  let zeroCost = 0
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      let sum = 0
      let count = 0
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x - dx
          const py = y - dy
          if (px < 0 || px >= cols || py < 0 || py >= rows) continue
          sum += Math.abs(cur[y * cols + x] - prev[py * cols + px])
          count++
        }
      }
      if (count === 0) continue
      const cost = sum / count
      if (dx === 0 && dy === 0) zeroCost = cost
      if (cost < bestCost) {
        bestCost = cost
        bestDx = dx
        bestDy = dy
      }
    }
  }
  // 最优偏移没有明显优于“不动”，说明这块区域缺乏可分辨结构，宁可不画箭头也不要瞎指
  if (bestCost >= zeroCost * 0.72) return { dx: 0, dy: 0, cost: zeroCost }
  return { dx: bestDx, dy: bestDy, cost: bestCost }
}

/**
 * 团块显著度：团块区域与周围背景的亮度差。
 * 地面反光/边缘噪声这类“和背景亮度差不多”的伪运动，直接跳过不标注，
 * 避免在空地上出现一排乱指的箭头。
 */
function blobSaliency(grid, blob, cols, rows) {
  const x0 = blob.box.x0
  const x1 = blob.box.x1
  const y0 = blob.box.y0
  const y1 = blob.box.y1
  let inside = 0
  let insideCount = 0
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      inside += grid[y * cols + x]
      insideCount++
    }
  }
  if (insideCount === 0) return 0
  const rx0 = Math.max(0, x0 - 2)
  const rx1 = Math.min(cols - 1, x1 + 2)
  const ry0 = Math.max(0, y0 - 2)
  const ry1 = Math.min(rows - 1, y1 + 2)
  let ring = 0
  let ringCount = 0
  for (let y = ry0; y <= ry1; y++) {
    for (let x = rx0; x <= rx1; x++) {
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue
      ring += grid[y * cols + x]
      ringCount++
    }
  }
  if (ringCount === 0) return 255
  return Math.abs(inside / insideCount - ring / ringCount)
}

/* ───────────────────────────── 洋葱皮 / 箭头 / 智能配色 ───────────────────────────── */

/** 半分辨率灰度面：镜头全局位移估计用（比全分辨率便宜 4 倍）。 */
function halfGray(rgb, width, height) {
  const hw = Math.ceil(width / 2)
  const hh = Math.ceil(height / 2)
  const plane = new Float32Array(hw * hh)
  for (let y = 0; y < hh; y++) {
    const y0 = y * 2
    const y1 = Math.min(height, y0 + 2)
    for (let x = 0; x < hw; x++) {
      const x0 = x * 2
      const x1 = Math.min(width, x0 + 2)
      let sum = 0
      let count = 0
      for (let sy = y0; sy < y1; sy++) {
        let base = (sy * width + x0) * 3
        for (let sx = x0; sx < x1; sx++, base += 3) {
          sum += 0.299 * rgb[base] + 0.587 * rgb[base + 1] + 0.114 * rgb[base + 2]
          count++
        }
      }
      plane[y * hw + x] = count > 0 ? sum / count : 0
    }
  }
  return { plane, w: hw, h: hh }
}

/** 洋葱皮：把上一帧以 alpha 叠到当前帧（alpha 越大，残影越明显）。 */
function blendOnto(rgb, ghost, alpha) {
  const keep = 1 - alpha
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = Math.round(rgb[i] * keep + ghost[i] * alpha)
    rgb[i + 1] = Math.round(rgb[i + 1] * keep + ghost[i + 1] * alpha)
    rgb[i + 2] = Math.round(rgb[i + 2] * keep + ghost[i + 2] * alpha)
  }
}

function drawThickLine(rgb, width, height, x0, y0, x1, y1, radius, color) {
  const dx = x1 - x0
  const dy = y1 - y0
  const steps = Math.max(1, Math.max(Math.abs(dx), Math.abs(dy)))
  const size = radius * 2 + 1
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + (dx * i) / steps)
    const y = Math.round(y0 + (dy * i) / steps)
    fillRect(rgb, width, height, x - radius, y - radius, size, size, color)
  }
}

/** 空心圆环：标记“上一帧节点”的残影位置。 */
function drawRing(rgb, width, height, cx, cy, radius, color) {
  const steps = Math.max(12, Math.round(radius * 8))
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2
    fillRect(
      rgb, width, height,
      Math.round(cx + Math.cos(angle) * radius), Math.round(cy + Math.sin(angle) * radius),
      1, 1, color,
    )
  }
}

/** 实心三角形：箭头头部用，比两条细线更容易一眼看出朝向。 */
function fillTriangle(rgb, width, height, ax, ay, bx, by, cx, cy, color) {
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
  const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)))
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)))
  const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)))
  const area = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
  if (Math.abs(area) < 1e-6) return
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const w1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / area
      const w2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / area
      const w3 = 1 - w1 - w2
      if (w1 < -0.02 || w2 < -0.02 || w3 < -0.02) continue
      const base = (y * width + x) * 3
      rgb[base] = color[0]
      rgb[base + 1] = color[1]
      rgb[base + 2] = color[2]
    }
  }
}

/**
 * 洋葱皮箭头：从“上一帧节点”画到“当前节点”，芯线由淡到亮渐变，箭头头端最实。
 * 全程带深色描边，任何背景上都能看清；颜色由调用方按背景智能选择。
 */
function drawMotionArrow(rgb, width, height, x0, y0, x1, y1, color, background) {
  const dx = x1 - x0
  const dy = y1 - y0
  const length = Math.sqrt(dx * dx + dy * dy)
  if (length < 3) return false
  const ux = dx / length
  const uy = dy / length
  const tailX = x0 + ux * 3
  const tailY = y0 + uy * 3
  const tipX = x1 + ux * 6
  const tipY = y1 + uy * 6

  // 芯线 3px 宽（半径 1），由尾到头逐渐变亮；粗一点才在拼图里看得清
  const segments = Math.max(4, Math.round(Math.hypot(tipX - tailX, tipY - tailY) / 4))
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments
    const t1 = (i + 1) / segments
    // 尾段 0.35 → 头段 1.0，形成逐渐变亮的红线
    const amount = 0.35 + 0.65 * t1
    drawThickLine(
      rgb, width, height,
      tailX + (tipX - tailX) * t0, tailY + (tipY - tailY) * t0,
      tailX + (tipX - tailX) * t1, tailY + (tipY - tailY) * t1,
      1, blendColor(color, background, amount),
    )
  }

  // 箭头头部：实心三角（先画大一圈的深色描边，再压上颜色），方向一眼可读
  const headLength = Math.max(5, Math.min(10, Math.round(length * 0.32)))
  const angle = Math.atan2(uy, ux)
  const wing = 0.62
  for (const grow of [1.5, 0]) {
    const size = headLength + grow
    const paint = grow === 0 ? color : [8, 8, 8]
    fillTriangle(
      rgb, width, height,
      tipX + ux * grow, tipY + uy * grow,
      tipX - ux * size + Math.cos(angle + Math.PI / 2) * size * wing,
      tipY - uy * size + Math.sin(angle + Math.PI / 2) * size * wing,
      tipX - ux * size - Math.cos(angle + Math.PI / 2) * size * wing,
      tipY - uy * size - Math.sin(angle + Math.PI / 2) * size * wing,
      paint,
    )
  }
  return true
}

function blendColor(color, background, amount) {
  return [
    Math.round(color[0] * amount + background[0] * (1 - amount)),
    Math.round(color[1] * amount + background[1] * (1 - amount)),
    Math.round(color[2] * amount + background[2] * (1 - amount)),
  ]
}

/** 采样点周围一圈的背景均色（避开中心，防止采到主体本身）。 */
function sampleBackground(rgb, width, height, cx, cy, inner = 7, outer = 17) {
  let r = 0
  let g = 0
  let b = 0
  let count = 0
  for (let dy = -outer; dy <= outer; dy += 2) {
    const y = Math.round(cy) + dy
    if (y < 0 || y >= height) continue
    for (let dx = -outer; dx <= outer; dx += 2) {
      const x = Math.round(cx) + dx
      if (x < 0 || x >= width) continue
      if (dx * dx + dy * dy < inner * inner) continue
      const base = (y * width + x) * 3
      r += rgb[base]
      g += rgb[base + 1]
      b += rgb[base + 2]
      count++
    }
  }
  if (count === 0) return [0, 0, 0]
  return [r / count, g / count, b / count]
}

const ANNOTATION_PALETTE = [
  { rgb: [255, 34, 38] },   // 首选纯红
  { rgb: [0, 234, 255] },   // 青色
  { rgb: [170, 255, 24] },  // 柠檬绿
  { rgb: [255, 0, 226] },   // 品红
]
