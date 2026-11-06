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

/** 颜色与背景的可分辨度：色差 + 亮度差 + 红绿蓝主导性（越低越容易融色）。 */
function contrastScore(color, background) {
  const dr = (color[0] - background[0]) / 255
  const dg = (color[1] - background[1]) / 255
  const db = (color[2] - background[2]) / 255
  const chroma = Math.sqrt(dr * dr + dg * dg + db * db)
  const lumaColor = 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2]
  const lumaBackground = 0.299 * background[0] + 0.587 * background[1] + 0.114 * background[2]
  const lumaGap = Math.abs(lumaColor - lumaBackground) / 255
  return 1.5 * chroma + 0.6 * lumaGap
}

/** 智能取色：默认红；红在该背景上分不清时才换色（不选琥珀，避免与红混淆）。 */
function pickAnnotationColor(background) {
  const red = ANNOTATION_PALETTE[0].rgb
  const dominance = background[0] - Math.max(background[1], background[2])
  // 背景本身偏红（暖色主体 / 红墙）红线会直接糊掉，直接换色
  if (dominance > 30) {
    let best = ANNOTATION_PALETTE[1]
    let bestScore = -Infinity
    for (const candidate of ANNOTATION_PALETTE.slice(1)) {
      const score = contrastScore(candidate.rgb, background)
      if (score > bestScore) { bestScore = score; best = candidate }
    }
    return best.rgb
  }
  if (contrastScore(red, background) >= 0.55) return red
  for (const candidate of ANNOTATION_PALETTE.slice(1)) {
    if (contrastScore(candidate.rgb, background) >= 0.7) return candidate.rgb
  }
  return red
}

/** 位移 -> 八方向字符，供文本摘要给模型一个不依赖颜色的方向标签。 */
function directionLabel(dx, dy) {
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return '·'
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI
  if (angle >= -22.5 && angle < 22.5) return '→'
  if (angle >= 22.5 && angle < 67.5) return '↘'
  if (angle >= 67.5 && angle < 112.5) return '↓'
  if (angle >= 112.5 && angle < 157.5) return '↙'
  if (angle >= 157.5 || angle < -157.5) return '←'
  if (angle >= -157.5 && angle < -112.5) return '↖'
  if (angle >= -112.5 && angle < -67.5) return '↑'
  return '↗'
}

function hexColor(color) {
  return `#${color.map(value => Math.round(value).toString(16).padStart(2, '0')).join('')}`
}

/* ───────────────────────── 跨帧轨迹（给模型读的结构化运动分析） ───────────────────────── */

const TRACK_COLORS = [
  [255, 72, 56],
  [48, 214, 255],
  [255, 224, 64],
  [128, 255, 96],
  [255, 112, 232],
  [176, 156, 255],
]

const DIRECTION_WORD = {
  '→': '向右',
  '←': '向左',
  '↑': '向上',
  '↓': '向下',
  '↗': '右上',
  '↘': '右下',
  '↙': '左下',
  '↖': '左上',
  '·': '静止',
}

function pctOf(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0
  return Math.round((value / total) * 1000) / 10
}

function dimRgb(src, factor) {
  const out = Buffer.alloc(src.length)
  for (let i = 0; i < src.length; i += 3) {
    out[i] = Math.round(src[i] * factor)
    out[i + 1] = Math.round(src[i + 1] * factor)
    out[i + 2] = Math.round(src[i + 2] * factor)
  }
  return out
}

/** 最近邻放大贴图：轨迹总图的底图用它，不需要额外依赖。 */
function blitRgbScaled(dest, destW, destH, src, srcW, srcH, x0, y0, scale) {
  for (let y = 0; y < srcH; y++) {
    const dy = y0 + y * scale
    if (dy < 0 || dy >= destH) continue
    for (let x = 0; x < srcW; x++) {
      const dx = x0 + x * scale
      if (dx < 0 || dx >= destW) continue
      const base = (y * srcW + x) * 3
      fillRect(dest, destW, destH, dx, dy, scale, scale, [src[base], src[base + 1], src[base + 2]])
    }
  }
}

/**
 * 把同一帧里挨得很近的团块并成一个物体：主体常被拆成上半身/腿等多个团块，
 * 不合并的话同一个人会变成好几条轨迹，方向和速度也会来回跳。
 */
function clusterBlobs(blobs, radius) {
  const groups = []
  for (const blob of [...blobs].sort((a, b) => b.area - a.area)) {
    let target = null
    for (const group of groups) {
      if (Math.hypot(group.x - blob.x, group.y - blob.y) <= radius) {
        target = group
        break
      }
    }
    if (target === null) {
      groups.push({ x: blob.x, y: blob.y, area: blob.area, w: blob.w, h: blob.h })
      continue
    }
    const total = target.area + blob.area
    target.x = (target.x * target.area + blob.x * blob.area) / total
    target.y = (target.y * target.area + blob.y * blob.area) / total
    target.area = total
  }
  return groups
}

/**
 * 把逐帧团块串成跨帧轨迹：同一物体始终是同一个编号 #1/#2…
 * 匹配 = “上一位置按速度外推” + 距离门限，避免左右两个物体互串。
 */
function buildTracks(stats, { sourceW, sourceH, fps, maxTracks = 4 }) {
  const diag = Math.hypot(sourceW, sourceH)
  // 同一主体的团块合并半径：约 1/6 对角线，同一人的躯干/四肢会并成一个物体
  const clusterRadius = Math.max(48, diag * 0.16)
  // 匹配门限同样按对角线给：快速运动、或探测器在两帧间锁到主体不同部位时，
  // 质心会跳十几%画面，门限太小就会把同一个人断成好几条轨迹
  const baseLimit = clusterRadius
  const all = []
  let active = []

  const accept = (track, stat, blob, frameIndex, taken) => {
    // 速度用“质心位置差 / 时间差”算，并跨 2 个采样帧做平滑：
    // 团块光流在快速运动时经常给 0，而相邻帧质心又有抖动，两者都会让方向看起来乱跳
    const prev = track.frames.length === 0
      ? null
      : track.frames[Math.max(0, track.frames.length - 2)]
    const dt = prev === null ? 0 : stat.time_s - prev.t
    const vx = dt > 0 ? (blob.x - prev.x) / dt : 0
    const vy = dt > 0 ? (blob.y - prev.y) / dt : 0
    const speed = Math.hypot(vx, vy)
    track.frames.push({
      frame: frameIndex,
      index: stat.index,
      t: stat.time_s,
      x: blob.x,
      y: blob.y,
      speed,
      dir: directionLabel(vx, vy),
      w: blob.w,
      h: blob.h,
    })
    track.lastFrame = frameIndex
    track.lastX = blob.x
    track.lastY = blob.y
    track.lastVx = vx
    track.lastVy = vy
    taken.push({ x: blob.x, y: blob.y })
  }

  for (let frameIndex = 0; frameIndex < stats.length; frameIndex++) {
    const stat = stats[frameIndex]
    if (stat.flash !== null) continue
    const candidates = clusterBlobs(stat.blobs.filter(blob => blob.area >= 2), clusterRadius)
      .sort((a, b) => b.area - a.area)
      .slice(0, 10)
      .map(blob => ({ blob, used: false }))

    const taken = []
    for (const track of [...active].sort((a, b) => b.lastFrame - a.lastFrame)) {
      const gap = frameIndex - track.lastFrame
      if (gap > 3) continue
      const predictedX = track.lastX + (track.lastVx / fps) * gap
      const predictedY = track.lastY + (track.lastVy / fps) * gap
      const limit = baseLimit * Math.min(3, gap)
      let best = null
      let bestDistance = Infinity
      for (const candidate of candidates) {
        if (candidate.used) continue
        const distance = Math.hypot(candidate.blob.x - predictedX, candidate.blob.y - predictedY)
        if (distance <= limit && distance < bestDistance) {
          bestDistance = distance
          best = candidate
        }
      }
      if (best === null) continue
      best.used = true
      accept(track, stat, best.blob, frameIndex, taken)
    }

    // 新物体：贴着已匹配物体的候选不另起轨迹，避免同一个主体被拆成好几条
    for (const candidate of candidates) {
      if (candidate.used) continue
      if (all.length >= 24) break
      if (taken.some(item => Math.hypot(candidate.blob.x - item.x, candidate.blob.y - item.y) < baseLimit * 0.6)) continue
      const track = { frames: [], lastFrame: -1, lastX: 0, lastY: 0, lastVx: 0, lastVy: 0 }
      accept(track, stat, candidate.blob, frameIndex, taken)
      all.push(track)
      active.push(track)
    }
    active = active.filter(track => frameIndex - track.lastFrame <= 3)
  }

  const kept = all
    .filter(track => track.frames.length >= 2 || stats.length === 1)
    .map(track => {
      let path = 0
      for (let i = 1; i < track.frames.length; i++) {
        const a = track.frames[i - 1]
        const b = track.frames[i]
        path += Math.hypot(b.x - a.x, b.y - a.y)
      }
      const first = track.frames[0]
      const last = track.frames[track.frames.length - 1]
      const net = Math.hypot(last.x - first.x, last.y - first.y)
      // 第一帧没有前一帧可比，速度恒为 0，不计入平均
      const speedFrames = track.frames.length > 1 ? track.frames.slice(1) : track.frames
      const avgSpeed = speedFrames.reduce((sum, item) => sum + item.speed, 0) / speedFrames.length
      return { track, path, net, avgSpeed, straightness: path === 0 ? 0 : net / path }
    })
    .sort((a, b) => (b.net / diag + b.track.frames.length / 8) - (a.net / diag + a.track.frames.length / 8))
    .slice(0, maxTracks)

  const assignment = new Map()
  const tracks = kept.map((entry, order) => {
    const id = order + 1
    const rgb = TRACK_COLORS[order % TRACK_COLORS.length]
    const frames = entry.track.frames
    const first = frames[0]
    const last = frames[frames.length - 1]
    const peak = frames.reduce((best, item) => (item.speed > best.speed ? item : best), frames[0])
    const dirs = []
    for (const item of frames.slice(1)) {
      const word = DIRECTION_WORD[item.dir] ?? item.dir
      if (dirs[dirs.length - 1] !== word) dirs.push(word)
    }
    if (dirs.length === 0) dirs.push('静止')
    for (const item of frames) {
      const list = assignment.get(item.frame) ?? []
      list.push({ id, rgb, x: item.x, y: item.y, w: item.w, h: item.h })
      assignment.set(item.frame, list)
    }
    return {
      id,
      color: hexColor(rgb),
      rgb,
      frames: frames.map(item => ({
        frame: item.frame,
        index: item.index,
        t: item.t,
        x: item.x,
        y: item.y,
        x_pct: pctOf(item.x, sourceW),
        y_pct: pctOf(item.y, sourceH),
        v: Math.round(item.speed),
        dir: item.dir,
      })),
      start: { t: first.t, x_pct: pctOf(first.x, sourceW), y_pct: pctOf(first.y, sourceH) },
      end: { t: last.t, x_pct: pctOf(last.x, sourceW), y_pct: pctOf(last.y, sourceH) },
      net: {
        dx_pct: pctOf(last.x - first.x, sourceW),
        dy_pct: pctOf(last.y - first.y, sourceH),
        dir: directionLabel(last.x - first.x, last.y - first.y),
      },
      avg_speed: Math.round(entry.avgSpeed),
      peak_speed: Math.round(peak.speed),
      peak_at_s: peak.t,
      straightness: Math.round(entry.straightness * 100) / 100,
      dirs,
    }
  })

  return { tracks, assignment }
}

/** 在每帧上给已编号的物体打 #N 标签，让拼图与文字报告能对上号。 */
function drawTrackBadges(rgbFrames, assignment, { width, height, sx, sy }) {
  for (const [frameIndex, items] of assignment) {
    const frame = rgbFrames[frameIndex]
    if (frame === undefined) continue
    for (const item of items) {
      const label = `#${item.id}`
      const scale = 2
      const boxW = textWidth(label, scale) + 6
      const boxH = GLYPH_H * scale + 6
      // 放在物体包围盒右侧，别压住主体和箭头
      const x = Math.round(Math.min(width - boxW - 1, Math.max(1, (item.x + item.w / 2) / sx + 4)))
      const y = Math.round(Math.min(height - boxH - 1, Math.max(1, item.y / sy - boxH / 2)))
      fillRect(frame, width, height, x, y, boxW, boxH, [0, 0, 0])
      fillRect(frame, width, height, x, y, 2, boxH, item.rgb)
      drawText(frame, width, height, label, x + 4, y + 3, scale, [255, 255, 255])
    }
  }
}

/** 时间 -> 颜色：早期蓝、后期红，一眼看出“什么时候动在哪里”。 */
function timeColor(ratio) {
  const stops = [
    [42, 120, 255],
    [40, 214, 255],
    [96, 255, 140],
    [255, 222, 64],
    [255, 64, 48],
  ]
  const clamped = Math.min(1, Math.max(0, ratio))
  const scaled = clamped * (stops.length - 1)
  const index = Math.min(stops.length - 2, Math.floor(scaled))
  const frac = scaled - index
  const a = stops[index]
  const b = stops[index + 1]
  return [0, 1, 2].map(channel => Math.round(a[channel] + (b[channel] - a[channel]) * frac))
}

/** 运动总图：暗化首帧 + 时间着色的运动历史（早期蓝→后期红）+ 速度-时间曲线。 */
function buildAnalysisImage({ stats, backdrop, width, height, sx, sy, fps }) {
  const pad = 6
  const zoom = 2
  const panelW = width * zoom
  const panelH = height * zoom
  const headH = 26
  const legendH = 24
  const chartH = 152
  const canvasW = panelW + pad * 2
  const canvasH = pad + headH + panelH + legendH + chartH + pad
  const out = Buffer.alloc(canvasW * canvasH * 3)
  fillRect(out, canvasW, canvasH, 0, 0, canvasW, canvasH, [14, 14, 16])

  const timeStart = stats.length === 0 ? 0 : stats[0].time_s
  const timeEnd = stats.length === 0 ? 0 : stats[stats.length - 1].time_s
  const timeSpan = Math.max(0.2, timeEnd - timeStart)
  const fpsLabel = Math.round(fps * 10) / 10

  const headY = pad + 5
  drawText(out, canvasW, canvasH, 'MOTION HISTORY', pad, headY, 2, [235, 235, 235])
  const span = `T${timeStart}-${timeEnd} F${fpsLabel} N${stats.length}`
  drawText(out, canvasW, canvasH, span, canvasW - pad - textWidth(span, 2), headY, 2, [150, 150, 150])

  const panelY = pad + headH
  if (backdrop === null) fillRect(out, canvasW, canvasH, pad, panelY, panelW, panelH, [24, 24, 26])
  else blitRgbScaled(out, canvasW, canvasH, dimRgb(backdrop, 0.4), width, height, pad, panelY, zoom)

  // 运动历史：每一帧的运动采样点按时间着色，颜色由蓝到红 = 由早到晚
  // 这样不用跟踪也能看出“运动发生在哪片区域、先后顺序是什么”
  for (const stat of stats) {
    if (stat.flash !== null || stat.points.length === 0) continue
    const color = timeColor((stat.time_s - timeStart) / timeSpan)
    for (const point of stat.points) {
      const x = Math.round(pad + (point.x / sx) * zoom)
      const y = Math.round(panelY + (point.y / sy) * zoom)
      fillRect(out, canvasW, canvasH, x - 2, y - 2, 5, 5, color)
    }
  }

  // 时间图例：EARLY(蓝) —— 色条 —— LATE(红)
  const legendY = panelY + panelH + 4
  const barX = pad + textWidth('EARLY', 2) + 8
  const barW = 130
  const barY = legendY + 6
  drawText(out, canvasW, canvasH, 'EARLY', pad, legendY + 3, 2, [200, 200, 200])
  for (let i = 0; i < barW; i++) {
    fillRect(out, canvasW, canvasH, barX + i, barY, 1, 8, timeColor(i / (barW - 1)))
  }
  drawText(out, canvasW, canvasH, 'LATE', barX + barW + 8, legendY + 3, 2, [200, 200, 200])

  const chartTop = legendY + legendH
  fillRect(out, canvasW, canvasH, pad, chartTop, canvasW - pad * 2, chartH - 4, [8, 8, 10])
  drawText(out, canvasW, canvasH, 'V PX S', pad + 4, chartTop + 4, 2, [200, 200, 200])

  const plotX = pad + 32
  const plotW = canvasW - plotX - pad - 10
  const plotY = chartTop + 30
  const plotH = chartH - 54

  let maxV = 20
  for (const stat of stats) maxV = Math.max(maxV, stat.speed_px_s)
  maxV = Math.ceil(maxV / 20) * 20

  // 横向网格 + 速度刻度
  for (const frac of [0, 0.5, 1]) {
    const y = Math.round(plotY + plotH - frac * plotH)
    drawThickLine(out, canvasW, canvasH, plotX, y, plotX + plotW, y, 0, [46, 46, 52])
    const text = String(Math.round(frac * maxV))
    drawText(out, canvasW, canvasH, text, plotX - textWidth(text, 1) - 4, y - 3, 1, [120, 120, 130])
  }
  // 时间刻度（首尾贴边对齐，避免和速度刻度撞在一起）
  for (const frac of [0, 0.5, 1]) {
    const t = timeStart + frac * timeSpan
    const text = `T${Math.round(t * 10) / 10}`
    const labelW = textWidth(text, 1)
    let x = plotX + frac * plotW - labelW / 2
    if (frac === 0) x = plotX
    if (frac === 1) x = plotX + plotW - labelW
    drawText(out, canvasW, canvasH, text, Math.round(x), plotY + plotH + 6, 1, [120, 120, 130])
  }
  // 爆闪帧：竖红条，和文字里的 FLASH 对应
  for (const stat of stats) {
    if (stat.flash === null) continue
    const x = Math.round(plotX + ((stat.time_s - timeStart) / timeSpan) * plotW)
    fillRect(out, canvasW, canvasH, x - 1, plotY, 3, plotH, [150, 30, 34])
  }
  // 整体速度曲线（每帧可见采样点的最快位移）
  let previous = null
  for (const stat of stats) {
    if (stat.flash !== null) {
      previous = null
      continue
    }
    const x = plotX + ((stat.time_s - timeStart) / timeSpan) * plotW
    const y = plotY + plotH - Math.min(1, stat.speed_px_s / maxV) * plotH
    if (previous !== null && stat.index - previous.index === 1) {
      drawThickLine(out, canvasW, canvasH, previous.x, previous.y, x, y, 1, [235, 235, 235])
    }
    fillRect(out, canvasW, canvasH, Math.round(x) - 1, Math.round(y) - 1, 3, 3, [235, 235, 235])
    previous = { index: stat.index, x, y }
  }

  return { buffer: out, width: canvasW, height: canvasH }
}

function trackShapeWord(straightness) {
  if (straightness >= 0.85) return '基本直线'
  if (straightness >= 0.5) return '有弯曲'
  return '往复/绕行'
}

/** 纯文字的运动报告：方向和速度都写成句子，模型不用看图也能答“怎么动的”。 */
function analysisLines({ tracks, stats, sourceW, sourceH, sampling, window }) {
  const lines = []
  lines.push('【运动分析（文字版，直接读这段就能回答“怎么动的”）】')
  lines.push(`窗口 ${window.start}s 起 ${window.length}s；${sampling.fps}fps 共 ${stats.length} 帧；源 ${sourceW}×${sourceH}`)
  const flashes = stats.filter(stat => stat.flash !== null)
  if (flashes.length > 0) {
    lines.push(`爆闪/大面积突变 ${flashes.length} 帧：${flashes.slice(0, 8).map(stat => `#${String(stat.index).padStart(4, '0')}@${stat.time_s}s(${Math.round(stat.flash.ratio * 100)}%)`).join('、')}${flashes.length > 8 ? ' …' : ''}`)
  } else {
    lines.push('没有爆闪/大面积突变帧。')
  }

  if (tracks.length === 0) {
    lines.push('没有稳定的跨帧运动物体：整段基本静止，或运动太碎（可降低 fps 让每帧位移更明显再扫一次）。')
  }

  // 整体概览比逐物体更稳：给出运动发生的画面范围与速度峰值，先建立全局印象
  const allPoints = stats.flatMap(stat => stat.points.map(point => ({
    x_pct: pctOf(point.x, sourceW),
    y_pct: pctOf(point.y, sourceH),
  })))
  if (allPoints.length > 0) {
    const xs = allPoints.map(point => point.x_pct)
    const ys = allPoints.map(point => point.y_pct)
    const peak = stats.reduce((best, stat) => (stat.speed_px_s > best.speed_px_s ? stat : best), stats[0])
    lines.push(`整体：运动区域占画面横向 ${Math.round(Math.min(...xs))}%~${Math.round(Math.max(...xs))}%、纵向 ${Math.round(Math.min(...ys))}%~${Math.round(Math.max(...ys))}%；速度峰值 ${Math.round(peak.speed_px_s)}px/s @ ${peak.time_s}s。`)
  }
  for (const track of tracks) {
    const first = track.frames[0]
    const last = track.frames[track.frames.length - 1]
    const netDir = DIRECTION_WORD[track.net.dir] ?? track.net.dir
    lines.push(`运动区域 #${track.id}（轨迹色 ${track.color}）：${first.t}s → ${last.t}s，共 ${track.frames.length} 帧；起点 (${first.x_pct}%, ${first.y_pct}%) → 终点 (${last.x_pct}%, ${last.y_pct}%)`)
    lines.push(`  净位移：${netDir}（横向 ${track.net.dx_pct}% 画面宽，纵向 ${track.net.dy_pct}% 画面高）；平均 ${track.avg_speed}px/s，最快 ${track.peak_speed}px/s @ ${track.peak_at_s}s；${trackShapeWord(track.straightness)}（直线度 ${track.straightness}）`)
    lines.push(`  方向序列：${track.dirs.join(' → ')}`)
    const path = track.frames.map(item => `${item.t}s(${Math.round(item.x_pct)},${Math.round(item.y_pct)})`)
    lines.push(`  轨迹（时间(x%,y%)）：${path.length > 10 ? `${path.slice(0, 10).join(' → ')} → …` : path.join(' → ')}`)
  }
  if (tracks.length > 0) {
    lines.push('说明：轨迹是“每帧运动区域的质心”连线；同一主体快速迈腿/摆臂时，质心会在躯干与四肢间小幅跳动，方向序列有抖动时以净位移和大方向为准。')
  }

  lines.push('逐帧（x%,y% 为画面百分比；v=该帧该物体速度 px/s；镜头=cam 是整体位移）：')
  const shown = stats.slice(0, 30)
  for (const stat of shown) {
    const tag = `#${String(stat.index).padStart(4, '0')} t=${stat.time_s}s`
    if (stat.flash !== null) {
      lines.push(`${tag} FLASH 面积 ${Math.round(stat.flash.ratio * 100)}%、亮度突变 ${stat.flash.mean_diff}（黑屏/白闪/爆炸/转场）`)
      continue
    }
    const objects = tracks
      .map(track => {
        const item = track.frames.find(frame => frame.index === stat.index)
        if (item === undefined) return null
        return `#${track.id}(${Math.round(item.x_pct)}%,${Math.round(item.y_pct)}%) v${item.v} ${DIRECTION_WORD[item.dir] ?? item.dir}`
      })
      .filter(Boolean)
    const cam = stat.camera !== null && stat.camera.speed >= 2 ? ` 镜头${DIRECTION_WORD[stat.camera.dir] ?? stat.camera.dir}${stat.camera.speed}px` : ''
    if (objects.length === 0) {
      lines.push(`${tag} v=0 无编号物体${cam}`)
    } else {
      lines.push(`${tag} ${objects.join(' | ')}${cam}`)
    }
  }
  if (stats.length > shown.length) lines.push(`…另有 ${stats.length - shown.length} 帧，编号递增。`)
  return lines
}

/** 在灰度面上按网格取均值（用于补偿后的前一帧）。 */
function gridMeansPlane(plane, width, height, cols, rows) {
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
        const row = y * width
        for (let x = x0; x < x1; x++) { sum += plane[row + x]; count++ }
      }
      out[cy * cols + cx] = count > 0 ? sum / count : 0
    }
  }
  return out
}

/**
 * 全局镜头位移估计（半分辨率整数像素）：用行列投影做一维相关，成本只有几 k 次运算。
 * 这是“看不出怎么动”的关键：镜头自己在动时，全部像素都在动，必须先把背景对齐，
 * 剩下的差异才是物体真实的运动方向。
 */
function estimateGlobalShift(prevHalf, curHalf, maxShift = 10) {
  const { plane: a, w, h } = prevHalf
  const { plane: b } = curHalf
  const colA = new Float64Array(w)
  const colB = new Float64Array(w)
  const rowA = new Float64Array(h)
  const rowB = new Float64Array(h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      colA[x] += a[row + x]
      colB[x] += b[row + x]
      rowA[y] += a[row + x]
      rowB[y] += b[row + x]
    }
  }
  const bestShift = (from, to, limit) => {
    const length = from.length
    let best = 0
    let bestCost = Infinity
    for (let shift = -limit; shift <= limit; shift++) {
      let cost = 0
      let count = 0
      for (let i = Math.max(0, shift); i < Math.min(length, length + shift); i++) {
        cost += Math.abs(to[i] - from[i - shift])
        count++
      }
      if (count === 0) continue
      const normalized = cost / count
      if (normalized < bestCost) { bestCost = normalized; best = shift }
    }
    return best
  }
  const dx = bestShift(colA, colB, maxShift)
  const dy = bestShift(rowA, rowB, maxShift)
  return { dx, dy }
}

/** P[y][x] = prev[y-dy][x-dx]：把前一帧平移对齐到当前帧；越界处复制边缘。 */
function shiftPlane(half, dx, dy) {
  const { plane, w, h } = half
  if (dx === 0 && dy === 0) return half
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const sourceY = Math.min(h - 1, Math.max(0, y - dy))
    const sourceRow = sourceY * w
    const targetRow = y * w
    for (let x = 0; x < w; x++) {
      const sourceX = Math.min(w - 1, Math.max(0, x - dx))
      out[targetRow + x] = plane[sourceRow + sourceX]
    }
  }
  return { plane: out, w, h }
}

/* ───────────────────────────── 主流程 ───────────────────────────── */

function parseDuration(stderr) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  if (match === null) return undefined
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

function parseDimensions(stderr) {
  const match = /Video:[\s\S]*?(\d{2,5})x(\d{2,5})/.exec(stderr)
  if (match === null) return undefined
  return { width: Number(match[1]), height: Number(match[2]) }
}

function newRunId(videoPath) {
  const stem = basename(videoPath, extname(videoPath)).replaceAll(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 24)
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-').slice(0, 19)
  // 同一秒内重复扫描同一视频（如分段测试）会撞名覆盖，加 4 位随机后缀保证唯一
  const suffix = Math.random().toString(36).slice(2, 6)
  return `${stem}-${stamp}-${suffix}`
}

function resolveVideo(videoPath) {
  const full = isAbsolute(videoPath) ? videoPath : resolve(process.cwd(), videoPath)
  if (!existsSync(full)) throw new Error(`视频不存在：${full}`)
  const stat = statSync(full)
  if (!stat.isFile()) throw new Error(`不是文件：${full}`)
  const ext = extname(full).toLowerCase()
  if (!['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.ts', '.gif'].includes(ext)) {
    throw new Error(`不支持的视频扩展名：${ext}（支持 mp4/mov/mkv/webm/avi/m4v/ts/gif）`)
  }
  return full
}

/**
 * 扫描一个视频（或视频的一段），产出带编号和红点的帧 + 拼图。
 * @param {object} options - 见 PLUGIN_PARAMETERS。
 * @returns {Promise<object>} 结构化结果（不含 attachment 引用）。
 */
export async function scanVideo(options, signal) {
  const startedAt = Date.now()
  const videoPath = resolveVideo(options.video_path)
  const fpsWanted = clampNumber(options.fps, 0.2, 30, DEFAULT_FPS)
  const maxFrames = Math.round(clampNumber(options.max_frames, 4, MAX_FRAMES, 18))
  const maxPoints = Math.round(clampNumber(options.max_points, 1, 24, 12))
  const sensitivity = clampNumber(options.sensitivity, 0, 1, 0.7)
  const startSeek = clampNumber(options.start_s, 0, 86400, 0)
  const durationWanted = options.duration_s === undefined ? undefined : clampNumber(options.duration_s, 0.2, 3600, 20)
  const dotSize = Math.round(clampNumber(options.dot_size, 1, 7, 3))
  const minArea = Math.round(clampNumber(options.min_area, 1, 40, 3))
  const onion = clampNumber(options.onion, 0, 0.7, 0.45)
  const trailLength = Math.round(clampNumber(options.trail, 0, 3, 2))
  const drawArrows = options.arrows === undefined ? true : options.arrows !== false
  const minThreshold = 4 + (1 - sensitivity) * 16

  // 先探一次元信息（一次轻量解码，几毫秒；也可同时校验文件可读）
  const probeArgs = ['-hide_banner', '-i', videoPath]
  let probeStderr = ''
  try {
    probeStderr = await runFfmpeg(probeArgs, signal, 30000)
  } catch (error) {
    const text = String(error && error.message ? error.message : error)
    if (!/At least one output file/iu.test(text)) throw error
    probeStderr = text
  }
  const source = parseDimensions(probeStderr) ?? { width: undefined, height: undefined }
  const duration = parseDuration(probeStderr)
  const available = duration === undefined
    ? (durationWanted ?? 20)
    : Math.max(0.2, duration - startSeek)
  const window = durationWanted === undefined ? available : Math.min(available, durationWanted)

  // 自适应采样率：总帧数不超过 max_frames，避免长视频变成大工程
  let fps = fpsWanted
  if (window * fps > maxFrames) fps = Math.max(0.2, maxFrames / window)
  const frameCount = Math.max(1, Math.min(maxFrames, Math.round(window * fps)))

  // 输出宽度：竖屏视频按面积守恒缩小，保证拼图不会被附件服务二次降采样（红点才看得见）
  const aspect = source.width !== undefined && source.height !== undefined ? source.height / source.width : 0.5625
  const autoWidth = Math.round(Math.sqrt(97200 / aspect))
  const width = Math.round(clampNumber(options.width, 160, 640, clampNumber(autoWidth, 200, DEFAULT_WIDTH, DEFAULT_WIDTH)) / 2) * 2
  const gridCols = Math.round(clampNumber(options.grid, 8, 48, Math.max(8, Math.round(width / 15))))
  const height = Math.max(2, Math.round((width * aspect) / 2) * 2)

  const runId = newRunId(videoPath)
  const dir = join(ROOT, runId)
  mkdirSync(dir, { recursive: true })
  const rawPath = join(dir, 'raw.rgb')

  const extractArgs = [
    '-hide_banner', '-loglevel', 'info', '-y',
    '-ss', String(startSeek), '-t', String(window),
    '-i', videoPath,
    '-vf', `fps=${fps},scale=${width}:${height}:flags=fast_bilinear`,
    '-pix_fmt', 'rgb24', '-f', 'rawvideo',
    '-frames:v', String(frameCount),
    rawPath,
  ]
  await runFfmpeg(extractArgs, signal)
  if (!existsSync(rawPath)) throw new Error('ffmpeg 没有产出帧数据（视频可能损坏或路径不可读）')

  const raw = readFileSync(rawPath)
  const frameBytes = width * height * 3
  const actualCount = Math.min(frameCount, Math.floor(raw.length / frameBytes))
  if (actualCount === 0) throw new Error('没有解码出任何帧，请检查视频与 -ss/-t 参数')
  let frames = bytesToRgb(raw, width, height, actualCount)
  rmSync(rawPath, { force: true })

  const rows = Math.max(3, Math.round(gridCols * (height / width)))
  const cellW = width / gridCols
  const cellH = height / rows
  const sx = source.width === undefined ? 1 : source.width / width
  const sy = source.height === undefined ? 1 : source.height / height

  const stats = []
  const sheets = []
  let prevHalf = null
  let prevClean = null
  let prevPoints = []
  let prevPointGap = 1
  // 首帧原样备份：轨迹总图拿它当暗化底图
  const backdrop = frames.length > 0 ? Buffer.from(frames[0]) : null

  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index]
    // 保留一份“未标注”副本给下一帧做洋葱皮残影，避免残影里出现上一帧的箭头
    const cleanCopy = index < frames.length - 1 ? Buffer.from(frame) : null
    const half = halfGray(frame, width, height)
    const grid = gridMeans(frame, width, height, gridCols, rows)
    const time = index === 0 ? startSeek : startSeek + index / fps
    let motion = null
    let camera = null
    let compensatedPrev = null
    let alignedGrid = null
    if (index > 0 && prevHalf !== null) {
      // 镜头补偿：先把背景对齐，剩下的差异才是物体自身运动
      const shift = estimateGlobalShift(prevHalf, half)
      camera = { dx: shift.dx * 2, dy: shift.dy * 2 }
      compensatedPrev = shift.dx === 0 && shift.dy === 0 ? prevHalf : shiftPlane(prevHalf, shift.dx, shift.dy)
      alignedGrid = gridMeansPlane(compensatedPrev.plane, compensatedPrev.w, compensatedPrev.h, gridCols, rows)
      motion = detectMotion(alignedGrid, grid, gridCols, rows, minThreshold, maxPoints, minArea)
    }

    const points = []
    const blobs = []
    let dominant = null
    let flash = null
    if (motion !== null) {
      // 爆闪/爆炸/转场这类“大块、整体亮度剧变”的帧单独归类：
      // 不做逐点标注（否则满屏噪点、计算量也大），只留一个外框，单独出图给模型看
      // 只把“变亮”的突变算爆闪；闪光结束变暗的那一帧不算，避免把正常画面误标
      if ((motion.brightRatio >= 0.3 || motion.meanDiff >= 70) && motion.curMean > motion.prevMean + 15) {
        flash = {
          ratio: Math.round(motion.brightRatio * 1000) / 1000,
          mean_diff: Math.round(motion.meanDiff * 10) / 10,
        }
        motion.blobs = []
        motion.points = []
      }

      // 洋葱皮：先把上一帧的残影压到当前帧上，运动位移一眼可见
      if (flash === null && onion > 0 && prevClean !== null) blendOnto(frame, prevClean, onion)

      // 每个团块用“上一帧网格局部搜索”直接估出运动矢量：
      // 刚出现/刚变形的团块也有方向，不受“上一帧必须存在同一个团块”限制
      for (let blobIndex = 0; blobIndex < motion.blobs.length; blobIndex++) {
        // 单帧团块数量上限，防止爆闪/全屏变化时标注与统计规模失控
        if (blobIndex >= 24) break
        const blob = motion.blobs[blobIndex]
        // 和背景亮度几乎一样的团块（地面反光、边缘噪声）不参与标注，防止空地上出现乱箭头
        const saliency = blobSaliency(grid, blob, gridCols, rows)
        if (saliency < 10) {
          blob.skip = true
          continue
        }
        const shift = estimateBlobShift(alignedGrid, grid, gridCols, rows, blob)
        const vx = shift.dx * cellW
        const vy = shift.dy * cellH
        const speed = Math.hypot(vx, vy)
        const matched = shift.dx !== 0 || shift.dy !== 0
        blob.vx = vx
        blob.vy = vy
        blob.matched = matched
        blob.centerX = (blob.cx + 0.5) * cellW
        blob.centerY = (blob.cy + 0.5) * cellH

        // 颜色：取该团块全部采样点周围的平均背景，同一团块的点与箭头统一配色，不会逐点跳色
        const members = motion.points.filter(point => point.blob === blobIndex)
        let background = null
        for (const point of members) {
          const sampled = sampleBackground(frame, width, height, (point.cx + 0.5) * cellW, (point.cy + 0.5) * cellH)
          if (background === null) background = [0, 0, 0]
          background[0] += sampled[0]
          background[1] += sampled[1]
          background[2] += sampled[2]
        }
        background = background === null
          ? sampleBackground(frame, width, height, blob.centerX, blob.centerY)
          : background.map(value => value / members.length)
        blob.color = pickAnnotationColor(background)
        blob.background = background

        blobs.push({
          area: blob.area,
          x: Math.round(blob.centerX * sx),
          y: Math.round(blob.centerY * sy),
          w: Math.round((blob.box.x1 - blob.box.x0 + 1) * cellW * sx),
          h: Math.round((blob.box.y1 - blob.box.y0 + 1) * cellH * sy),
          dx: Math.round(vx * sx),
          dy: Math.round(vy * sy),
          dir: directionLabel(vx, vy),
          speed: Math.round(speed * sx),
          matched,
          color: hexColor(blob.color),
        })
      }

      const main = blobs.find(item => item.speed >= 3) ?? blobs[0]
      if (main !== undefined) {
        dominant = { dx: main.dx, dy: main.dy, dir: main.dir, speed: main.speed, color: main.color }
      }

      // 每个采样点都画一支自己的箭头（不是一整个团块只画一支），多一点才看得清整体运动
      const drawn = []
      for (const cell of motion.points) {
        const cx = (cell.cx + 0.5) * cellW
        const cy = (cell.cy + 0.5) * cellH
        const blob = motion.blobs[cell.blob]
        if (blob !== undefined && blob.skip === true) continue
        const background = blob === undefined
          ? sampleBackground(frame, width, height, cx, cy)
          : blob.background
        const color = blob === undefined ? pickAnnotationColor(background) : blob.color

        // 优先用所在团块的位移；团块没匹配上时退回到“点对点”就近匹配，尽量给出方向
        let vx = blob === undefined ? 0 : blob.vx
        let vy = blob === undefined ? 0 : blob.vy
        let tailX = null
        let tailY = null
        if (blob !== undefined && blob.matched === true) {
          tailX = cx - vx
          tailY = cy - vy
        } else {
          // 点对点兜底：按“上一帧位置 + 该点速度预测”找对应节点，避免挑到一个几乎同位置的邻居而画不出箭头
          const gap = Math.min(3, prevPointGap)
          const maxDistance = Math.min(4.5, 3.2 * gap)
          let best = null
          let bestScore = Infinity
          for (const prev of prevPoints) {
            const dx = cell.cx - prev.cx
            const dy = cell.cy - prev.cy
            const distance = Math.hypot(dx, dy)
            if (distance >= maxDistance) continue
            const score = Math.hypot(cell.cx - (prev.cx + prev.vxC * gap), cell.cy - (prev.cy + prev.vyC * gap)) + distance * 0.3
            if (score < bestScore) {
              bestScore = score
              best = prev
            }
          }
          if (best !== null) {
            vx = (cell.cx - best.cx) * cellW
            vy = (cell.cy - best.cy) * cellH
            tailX = (best.cx + 0.5) * cellW
            tailY = (best.cy + 0.5) * cellH
          }
        }

        // 采样点本体：保持很小（默认 3×3），带 1px 深色底便于压住浅色背景
        const halfDot = Math.floor(dotSize / 2)
        fillRect(frame, width, height, Math.round(cx) - halfDot - 1, Math.round(cy) - halfDot - 1, dotSize + 2, dotSize + 2, [10, 10, 10])
        fillRect(frame, width, height, Math.round(cx) - halfDot, Math.round(cy) - halfDot, dotSize, dotSize, color)

        drawn.push({ cx, cy, vx, vy, tailX, tailY, color, background })
        points.push({
          x: Math.round(cx * sx),
          y: Math.round(cy * sy),
          dx: Math.round(vx * sx),
          dy: Math.round(vy * sy),
          speed: Math.round(Math.hypot(vx, vy) * sx),
          dir: directionLabel(vx, vy),
          blob: cell.blob,
          color: hexColor(color),
          strength: Math.round(cell.d * 10) / 10,
          arrow: tailX !== null && Math.hypot(vx, vy) >= 3,
        })
      }

      // 洋葱皮节点 + 渐变箭头：画在采样点之上，方向标记不会被点盖住
      for (const item of drawn) {
        if (item.tailX === null) continue
        // 上一帧该点的位置：空心圆环，形成“洋葱皮”残影
        if (trailLength > 0) {
          drawRing(frame, width, height, item.tailX, item.tailY, 3, blendColor(item.color, item.background, 0.55))
        }
        // 从上一帧节点指向当前节点：位移就是运动方向，越靠头越亮
        if (drawArrows && Math.hypot(item.vx, item.vy) >= 3) {
          drawMotionArrow(frame, width, height, item.tailX, item.tailY, item.cx, item.cy, item.color, item.background)
        }
      }

      // 记录本帧采样点的格子坐标，供下一帧“点对点”兜底匹配；
      // 某帧没有采样点时保留上一组（最多跨 3 帧），这样下一帧仍然能画出箭头
      if (drawn.length > 0) {
        prevPoints = drawn.map(item => ({
          cx: item.cx / cellW - 0.5,
          cy: item.cy / cellH - 0.5,
          vxC: item.vx / cellW,
          vyC: item.vy / cellH,
        }))
        prevPointGap = 1
      } else {
        prevPointGap = Math.min(3, prevPointGap + 1)
      }

      // 爆闪帧：只画一个红色外框标出突变区域，方便模型直接定位（整帧爆闪时就是整屏边框）
      if (flash !== null) {
        const cells = motion.bboxCells
        const bx0 = cells === null ? 0 : Math.round(cells.x0 * cellW)
        const by0 = cells === null ? 0 : Math.round(cells.y0 * cellH)
        const bx1 = cells === null ? width - 1 : Math.round((cells.x1 + 1) * cellW) - 1
        const by1 = cells === null ? height - 1 : Math.round((cells.y1 + 1) * cellH) - 1
        const box = [255, 34, 38]
        drawThickLine(frame, width, height, bx0, by0, bx1, by0, 1, box)
        drawThickLine(frame, width, height, bx0, by1, bx1, by1, 1, box)
        drawThickLine(frame, width, height, bx0, by0, bx0, by1, 1, box)
        drawThickLine(frame, width, height, bx1, by0, bx1, by1, 1, box)
      }
    }
    // 帧编号（左下角，白字黑底）：模型只需认编号就能对上顺序
    const label = `#${String(index + 1).padStart(4, '0')}`
    const labelScale = 2
    const labelW = textWidth(label, labelScale) + 4
    const labelH = GLYPH_H * labelScale + 4
    const labelY = Math.max(0, height - labelH)
    fillRect(frame, width, height, 0, labelY, labelW, labelH, [0, 0, 0])
    drawText(frame, width, height, label, 2, labelY + 2, labelScale, [255, 255, 255])

    const bbox = motion === null || motion.bboxCells === null ? null : {
      x: Math.round(motion.bboxCells.x0 * cellW * sx),
      y: Math.round(motion.bboxCells.y0 * cellH * sy),
      w: Math.round((motion.bboxCells.x1 - motion.bboxCells.x0 + 1) * cellW * sx),
      h: Math.round((motion.bboxCells.y1 - motion.bboxCells.y0 + 1) * cellH * sy),
    }
    const pointSpeeds = points.map(point => point.speed).filter(value => value >= 3)
    const fastestPointSpeed = pointSpeeds.length === 0 ? 0 : Math.max(...pointSpeeds)
    stats.push({
      index: index + 1,
      time_s: Math.round(time * 100) / 100,
      moving_cells: motion === null ? 0 : motion.moving,
      motion_ratio: motion === null ? 0 : Math.round(motion.ratio * 1000) / 1000,
      points,
      dominant,
      // 每帧速度：取该帧可见采样点的最快位移（源图像素/秒），与画面上箭头长度一致
      speed_px_s: Math.round(fastestPointSpeed * fps),
      flash: flash === null ? null : { ...flash, bbox },
      blobs,
      blob_cells: blobs.reduce((sum, blob) => sum + blob.area, 0),
      camera: camera === null ? null : {
        dx: camera.dx,
        dy: camera.dy,
        dir: directionLabel(camera.dx, camera.dy),
        speed: Math.round(Math.hypot(camera.dx, camera.dy)),
      },
      bbox,
      threshold: motion === null ? null : Math.round(motion.threshold * 10) / 10,
    })
    prevClean = cleanCopy
    prevHalf = half
  }

  // ── 跨帧轨迹：同一物体固定编号，并把编号标回帧上（文字报告与图片用同一套编号） ──
  const sourceW = source.width ?? width
  const sourceH = source.height ?? height
  const { tracks, assignment } = buildTracks(stats, { sourceW, sourceH, fps, maxTracks: 4 })
  drawTrackBadges(frames, assignment, { width, height, sx, sy })

  // ── 把带标注的帧写成 PNG（一次 ffmpeg 调用，rawvideo -> image2） ──
  const annotatedRaw = join(dir, 'annotated.rgb')
  writeFileSync(annotatedRaw, Buffer.concat(frames))
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-r', String(fps),
    '-i', annotatedRaw,
    '-c:v', 'png', '-pix_fmt', 'rgb24', '-start_number', '1',
    join(dir, 'f%04d.png'),
  ], signal)
  rmSync(annotatedRaw, { force: true })

  // ── 拼图：3×2，标题 = 编号 + 时间 + 点数 + 箭头数 + 速度(px/s)；爆闪帧单独出图 ──
  const perSheet = SHEET_COLS * SHEET_ROWS
  const sheetW = SHEET_COLS * width + (SHEET_COLS + 1) * SHEET_GAP
  const sheetH = SHEET_ROWS * (height + SHEET_HEADER) + (SHEET_ROWS + 1) * SHEET_GAP

  const normalEntries = []
  const flashEntries = []
  stats.forEach((stat, frameIndex) => {
    if (stat.flash === null) normalEntries.push({ stat, frameIndex })
    else flashEntries.push({ stat, frameIndex })
  })

  const buildSheets = async (entries, prefix, rawName) => {
    const count = Math.ceil(entries.length / perSheet)
    if (count === 0) return []
    const buffers = []
    const result = []
    for (let sheet = 0; sheet < count; sheet++) {
      const buffer = Buffer.alloc(sheetW * sheetH * 3, 18)
      const first = sheet * perSheet
      for (let slot = 0; slot < perSheet; slot++) {
        const entry = entries[first + slot]
        if (entry === undefined) break
        const col = slot % SHEET_COLS
        const row = Math.floor(slot / SHEET_COLS)
        const tileX = SHEET_GAP + col * (width + SHEET_GAP)
        const tileY = SHEET_GAP + row * (height + SHEET_HEADER + SHEET_GAP)
        const stat = entry.stat
        fillRect(buffer, sheetW, sheetH, tileX, tileY, width, SHEET_HEADER, [0, 0, 0])
        const caption = stat.flash === null
          ? `#${String(stat.index).padStart(4, '0')} T${stat.time_s} N${stat.points.length} A${stat.points.filter(point => point.arrow).length} V${stat.speed_px_s}`
          : `#${String(stat.index).padStart(4, '0')} T${stat.time_s} FLASH ${Math.round(stat.flash.ratio * 100)}`
        drawText(buffer, sheetW, sheetH, caption, tileX + 3, tileY + 2, 2, [255, 255, 255])
        blitRgb(buffer, sheetW, sheetH, frames[entry.frameIndex], width, height, tileX, tileY + SHEET_HEADER)
      }
      buffers.push(buffer)
      result.push({
        index: sheet + 1,
        path: join(dir, `${prefix}${sheet + 1}.png`),
        frames: entries.slice(first, first + perSheet).map(entry => entry.stat.index),
        width: sheetW,
        height: sheetH,
      })
    }
    const rawPath = join(dir, rawName)
    writeFileSync(rawPath, Buffer.concat(buffers))
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${sheetW}x${sheetH}`,
      '-i', rawPath,
      '-c:v', 'png', '-pix_fmt', 'rgb24', '-start_number', '1',
      join(dir, `${prefix}%d.png`),
    ], signal)
    rmSync(rawPath, { force: true })
    return result
  }

  const builtSheets = await buildSheets(normalEntries, 'sheet', 'sheets.rgb')
  const flashSheets = await buildSheets(flashEntries, 'flash', 'flash.rgb')
  sheets.push(...builtSheets)

  // ── 运动总图：暗化首帧 + 时间着色运动历史 + 速度曲线，一张图读完整个动态过程 ──
  const analysisPng = join(dir, 'analysis.png')
  const analysisImage = buildAnalysisImage({ stats, backdrop, width, height, sx, sy, fps })
  const analysisRaw = join(dir, 'analysis.rgb')
  writeFileSync(analysisRaw, analysisImage.buffer)
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${analysisImage.width}x${analysisImage.height}`,
    '-i', analysisRaw, '-frames:v', '1', '-c:v', 'png', '-pix_fmt', 'rgb24',
    analysisPng,
  ], signal)
  rmSync(analysisRaw, { force: true })

  const perFrameAnalysis = stats.map(stat => ({
    index: stat.index,
    time_s: stat.time_s,
    speed_px_s: stat.speed_px_s,
    moving_cells: stat.moving_cells,
    camera: stat.camera,
    flash: stat.flash === null ? null : { ratio: stat.flash.ratio, mean_diff: stat.flash.mean_diff },
    objects: tracks
      .map(track => {
        const item = track.frames.find(frame => frame.index === stat.index)
        return item === undefined ? null : { id: track.id, x_pct: item.x_pct, y_pct: item.y_pct, v: item.v, dir: item.dir }
      })
      .filter(Boolean),
  }))
  const analysisText = analysisLines({
    tracks,
    stats,
    sourceW,
    sourceH,
    sampling: { fps: Math.round(fps * 100) / 100 },
    window: { start: startSeek, length: Math.round(window * 100) / 100 },
  }).join('\n')
  const analysisJson = join(dir, 'analysis.json')
  writeFileSync(join(dir, 'analysis.txt'), `${analysisText}\n`)
  writeFileSync(analysisJson, `${JSON.stringify({ tracks, per_frame: perFrameAnalysis }, null, 2)}\n`)
  frames = null

  const movingFrames = stats.filter(item => item.moving_cells > 0).length
  const flashFrames = flashEntries.map(entry => ({
    index: entry.stat.index,
    time_s: entry.stat.time_s,
    file: join(dir, `f${String(entry.stat.index).padStart(4, '0')}.png`),
    ratio: entry.stat.flash.ratio,
    mean_diff: entry.stat.flash.mean_diff,
    bbox: entry.stat.flash.bbox,
  }))
  const meta = {
    version: VERSION,
    runId,
    dir,
    video: videoPath,
    source,
    duration_s: duration,
    window: { start: startSeek, length: Math.round(window * 100) / 100 },
    sampling: { fps: Math.round(fps * 100) / 100, requested_fps: fpsWanted, frames: stats.length },
    display: { width, height, grid: [gridCols, rows], dot_size: dotSize, sensitivity, onion, trail: trailLength, arrows: drawArrows, min_area: minArea },
    moving_frames: movingFrames,
    flash_frames: flashFrames,
    flash_sheets: flashSheets,
    analysis: {
      png: analysisPng,
      txt: join(dir, 'analysis.txt'),
      json: analysisJson,
      tracks,
      per_frame: perFrameAnalysis,
    },
    stats,
    sheets,
    elapsed_ms: Date.now() - startedAt,
    createdAt: Date.now(),
  }
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)

  return {
    runId,
    dir,
    video: videoPath,
    source,
    window: meta.window,
    sampling: meta.sampling,
    display: meta.display,
    moving_frames: movingFrames,
    flash_frames: flashFrames,
    flash_sheets: flashSheets,
    analysis: meta.analysis,
    analysis_text: analysisText,
    stats,
    sheets,
    elapsed_ms: meta.elapsed_ms,
    note: '先读 analysis_text（文字版运动分析：物体编号、轨迹、方向、速度都是句子），再对照 analysis.png（暗化首帧上的运动历史：蓝=早、红=晚，下方是速度曲线）。红点=运动采样点；编号 #0001 起与 f0001.png 一一对应，时间 = (编号-1)/fps。爆闪/大面积突变帧单独放在 flash1.png。',
  }
}

/* ───────────────────────────── 拼图辅助 ───────────────────────────── */

function blitRgb(dest, destW, destH, src, srcW, srcH, x0, y0) {
  for (let y = 0; y < srcH; y++) {
    const dy = y0 + y
    if (dy < 0 || dy >= destH) continue
    const destStart = (dy * destW + x0) * 3
    const srcStart = y * srcW * 3
    const copyLen = Math.min(srcW, destW - x0) * 3
    if (copyLen <= 0) continue
    dest.set(src.subarray(srcStart, srcStart + copyLen), destStart)
  }
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/* ───────────────────────────── 读取帧 / 管理临时缓存 ───────────────────────────── */

function runDirOf(runId) {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(runId)) {
    throw new Error('run_id 不合法：只允许字母、数字、下划线与连字符')
  }
  const dir = join(ROOT, runId)
  if (!existsSync(dir)) throw new Error(`找不到运行记录：${runId}（先用 action=runs 列出）`)
  return dir
}

export function loadRun(runId) {
  const dir = runDirOf(runId)
  const metaPath = join(dir, 'meta.json')
  if (!existsSync(metaPath)) throw new Error(`运行记录缺少 meta.json：${dir}`)
  return JSON.parse(readFileSync(metaPath, 'utf8'))
}

export function parseIndexList(text, total) {
  if (typeof text !== 'string' || text.trim().length === 0) return [1]
  const values = []
  for (const part of text.split(',')) {
    const token = part.trim()
    if (token.length === 0) continue
    const range = /^(\d+)(?:-|~)(\d+)$/u.exec(token)
    if (range !== null) {
      const from = Number(range[1])
      const to = Number(range[2])
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) values.push(i)
    } else if (/^\d+$/u.test(token)) values.push(Number(token))
  }
  const unique = [...new Set(values)].filter(value => value >= 1 && value <= total)
  return unique.length > 0 ? unique : [1]
}

export function frameFiles(runId, indices) {
  const meta = loadRun(runId)
  return indices.map((index) => ({
    index,
    path: join(meta.dir, `f${String(index).padStart(4, '0')}.png`),
    time_s: meta.stats.find(item => item.index === index)?.time_s,
  }))
}

export function listRuns() {
  if (!existsSync(ROOT)) return []
  return readdirSync(ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map((entry) => {
      const dir = join(ROOT, entry.name)
      const metaPath = join(dir, 'meta.json')
      const stat = statSync(dir)
      let summary = null
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
          summary = {
            video: meta.video,
            frames: meta.sampling?.frames,
            fps: meta.sampling?.fps,
            moving_frames: meta.moving_frames,
            created: meta.createdAt,
          }
        } catch { /* 坏记录忽略 */ }
      }
      let bytes = 0
      try {
        for (const file of readdirSync(dir)) bytes += statSync(join(dir, file)).size
      } catch { /* 忽略 */ }
      return { runId: entry.name, dir, bytes, modified: stat.mtimeMs, ...summary }
    })
    .sort((a, b) => b.modified - a.modified)
}

export function purgeRuns(options) {
  const removed = []
  const keepHours = clampNumber(options.ttl_h, 0, 720, 12)
  const cutoff = Date.now() - keepHours * 3600 * 1000
  if (!existsSync(ROOT)) return { removed, others: [] }
  const entries = readdirSync(ROOT, { withFileTypes: true }).filter(entry => entry.isDirectory())
  for (const entry of entries) {
    const dir = join(ROOT, entry.name)
    const only = typeof options.run_id === 'string' && options.run_id.length > 0
    if (only && entry.name !== options.run_id) continue
    if (!only) {
      const stat = statSync(dir)
      if (stat.mtimeMs > cutoff) continue
    }
    rmSync(dir, { recursive: true, force: true })
    removed.push(entry.name)
  }
  return { removed }
}

/* ───────────────────────────── 工具注册 ───────────────────────────── */

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['scan', 'frames', 'runs', 'purge'],
      description: 'scan：扫描视频并产出编号帧 + 红点拼图；frames：读取某次运行的指定编号帧；runs：列出临时缓存；purge：清理临时缓存。',
    },
    video_path: { type: 'string', description: 'scan 必填：视频绝对路径（mp4/mov/mkv/webm/avi/m4v/ts/gif）。' },
    fps: { type: 'number', description: '每秒抽几帧，默认 2；帧数超过 max_frames 会自动降低。' },
    width: { type: 'number', description: '输出画面宽度像素，默认 360（越小越快越省 token）。' },
    max_frames: { type: 'number', description: '本次最多抽多少帧，默认 18，上限 60。' },
    max_points: { type: 'number', description: '每帧最多几个红点/箭头，默认 12，上限 24；每个点都会带一支自己的方向箭头。' },
    sensitivity: { type: 'number', description: '运动灵敏度 0~1，默认 0.7；越大越灵敏（红点/箭头更多、更容易被噪声触发）。' },
    grid: { type: 'number', description: '运动网格列数，默认按宽度自动（约每 15 像素一格）。' },
    start_s: { type: 'number', description: '从视频第几秒开始，默认 0。' },
    duration_s: { type: 'number', description: '只处理多长的一段（秒）；省略则尽量铺满整段（受 max_frames 限制）。' },
    dot_size: { type: 'number', description: '红点边长像素，默认 3（尽量小），最大 7。' },
    min_area: { type: 'number', description: '运动团块最小格数，默认 3；调大可滤掉更多小噪声，调小可保留远处小物体。' },
    onion: { type: 'number', description: '洋葱皮强度 0~0.7，默认 0.45：0 关闭，越大上一帧残影越明显。' },
    trail: { type: 'number', description: '洋葱皮节点数 0~3，默认 2：在上一帧/上上帧位置画空心圆环，串起运动路径。' },
    arrows: { type: 'boolean', description: '是否画方向箭头，默认 true；箭头从上一帧节点指向当前节点、尾淡头亮，颜色按背景自动取高对比色。' },
    run_id: { type: 'string', description: 'frames/purge 用的运行 id。' },
    indices: { type: 'string', description: 'frames 要取哪些编号，如 "1,3,5-8"；默认 1。' },
    max_images: { type: 'number', description: '本次最多回传几张图片（拼图或帧），默认 3，上限 6。' },
    ttl_h: { type: 'number', description: 'purge 保留小时数，默认 12；给 run_id 时忽略此项。' },
  },
  required: ['action'],
}

function textBlock(text) {
  return { type: 'text', text }
}

function summarizeScan(value) {
  const lines = []
  lines.push(`动态捕捉完成：${value.runId}`)
  lines.push(`视频：${value.video}`)
  const src = value.source ?? {}
  lines.push(`源尺寸 ${src.width ?? '?'}×${src.height ?? '?'}；窗口 ${value.window.start}s 起 ${value.window.length}s；采样 ${value.sampling.fps}fps × ${value.sampling.frames} 帧（显示宽 ${value.display?.width ?? '?'}）`)
  lines.push(`有运动的帧：${value.moving_frames}/${value.stats.length}；耗时 ${value.elapsed_ms}ms`)
  lines.push(`运动总图：${value.analysis.png}（暗化首帧上叠运动历史：蓝=早、红=晚，看时间先后；下半部是每帧速度曲线，竖红条=爆闪帧）`)
  lines.push(`结构化数据：${value.analysis.json}；纯文字报告：${value.analysis.txt}`)
  lines.push('')
  lines.push(value.analysis_text)
  lines.push('')

  // 爆闪/大面积突变单独归类：不进运动拼图，但仍然缓存成图片，给模型单独分析
  if (value.flash_frames.length > 0) {
    lines.push(`爆闪/大面积突变帧 ${value.flash_frames.length} 帧（整帧变化 ≥30% 或平均亮度突变 ≥70，已从运动拼图中剔除）：`)
    for (const item of value.flash_frames.slice(0, 8)) {
      lines.push(`  #${String(item.index).padStart(4, '0')} t=${item.time_s}s 面积=${Math.round(item.ratio * 100)}% 亮度突变=${item.mean_diff} 文件=${item.file}`)
    }
    if (value.flash_frames.length > 8) lines.push(`  …另有 ${value.flash_frames.length - 8} 帧`)
    if (value.flash_sheets.length > 0) {
      lines.push(`爆闪帧拼图：${value.flash_sheets.map(sheet => sheet.path).join('、')}（判断闪光/爆炸/转场就看这些图，里面只有红色外框、没有运动点）`)
    }
  }
  lines.push(`图片缓存目录：${value.dir}`)
  return lines
}

function summaryOfRuns(runs) {
  if (runs.length === 0) return ['临时缓存为空（目录 ' + ROOT + '）']
  return runs.map(run => `- ${run.runId}｜${run.frames ?? '?'} 帧｜动帧 ${run.moving_frames ?? '?'}｜${(run.bytes / 1024 / 1024).toFixed(1)}MB｜${new Date(run.modified).toLocaleString('zh-CN')}`)
}

/** 读取当前路由模型是否声明 image 输入；拿不到就当作不支持。 */
async function routeAcceptsImages(ctx, exec) {
  try {
    const config = exec?.agent?.session?.requestHeader?.()?.config
    const provider = config?.provider ?? exec?.agent?.options?.provider
    const model = config?.model ?? exec?.agent?.options?.model
    const llm = ctx.get('llm')
    if (provider === undefined || model === undefined || llm === undefined) return false
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
  } catch {
    return false
  }
}

/** 本工具只给能读图片的多模态模型用：路由不支持 image 输入时直接拒绝，不做纯文本降级。 */
async function requireImageModel(ctx, exec) {
  const capable = await routeAcceptsImages(ctx, exec)
  if (!capable) {
    throw new Error('motion-capture 只提供给能读图片的多模态模型：当前路由未声明 image 输入。请切换到支持图像输入的模型（视觉路由）后再调用；本工具不提供纯文本模式。')
  }
  return true
}

function imageBlockFromRef(ref) {
  return {
    type: 'image',
    attachment: {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...ref.name === undefined ? {} : { name: ref.name },
    },
  }
}

async function attachPng(ctx, filePath) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return undefined
  try {
    const data = readFileSync(filePath)
    const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: basename(filePath) })
    return ref
  } catch {
    return undefined
  }
}

export function apply(ctx) {
  const registered = []
  try {
    registered.push(ctx.tools.register({
      name: 'motion_capture',
      description: [
        '【动态物体捕捉 · 结构化运动分析】只提供给能读图片的多模态模型：当前路由未声明 image 输入时直接拒绝调用，不做纯文本降级。',
        '给一个视频路径，返回三层结果，按这个顺序读最省力：',
        '1) 文字运动分析（analysis_text）：每个跨帧物体一个固定编号 #1/#2…，给出起点/终点（画面百分比）、净位移方向、',
        '   平均与最快速度（源像素/秒）、方向序列、逐帧位置——只读文字就能回答“谁在动、往哪动、多快”。',
        '2) 运动总图 analysis.png：暗化首帧上叠“运动历史”——每个采样点按时间着色（蓝=早、红=晚），',
        '   一眼看出哪片区域在动、先后顺序；下半部是逐帧速度曲线，竖红条=爆闪帧。',
        '3) 帧拼图 sheet1.png：每帧原图带编号 #0001、运动红点与渐变箭头，运动物体上另有 #N 标签；',
        '   FLASH 帧单独进 flash1.png（只有红色外框，没有运动点）。',
        '文字与图片共用同一套编号，互相能对上；红点=帧间运动采样点，箭头=上一帧到当前帧的位移（尾淡头亮），',
        '标注颜色按局部背景自动取高对比色（默认红，背景偏红时转青/绿/品红）。',
        '帧标题：T=时间秒、N=点数、A=箭头数、V=该帧最快位移（px/s）。',
        '爆闪/爆炸/转场这类大块亮度剧变会单独归类，不画运动点（防满屏噪点、防计算量失控）。',
        '所有帧、轨迹图、analysis.json 都在临时缓存目录，可用 action=runs / purge 查看或清理。',
        '',
        'action=scan：给 video_path，返回结构化轨迹 + 文字分析 + 拼图/轨迹图。',
        'action=frames：run_id + indices（如 "1,3,5-8"）取单帧原图，用于放大看细节。',
        'action=runs / purge：查看或清理临时图片缓存。',
        '',
        '设计与成本：低采样率（默认 2fps）+ 小宽度（默认 360）单趟解码，帧差在纯 JS 网格上做，耗时/能耗远低于逐帧全分辨率分析；',
        '若当前模型路由未声明 image 输入，scan/frames 会直接报错并提示切换视觉模型（不降级成纯文本）。',
        '镜头整体位移会被自动估计并补偿：文字里的“镜头”是镜头自身位移，轨迹只表示相对背景的物体真实运动。',
        '看不清运动方向时：降低 fps 让每帧位移更大，或调高 onion（残影更明显）、trail 设 3。',
      ].join('\n'),
      parameters: PARAMETERS,
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            action: { type: 'string' },
            runId: { type: 'string' },
            dir: { type: 'string' },
            source: { type: 'object', additionalProperties: true },
            window: { type: 'object', additionalProperties: true },
            sampling: { type: 'object', additionalProperties: true },
            display: { type: 'object', additionalProperties: true },
            moving_frames: { type: 'number' },
            flash_frames: { type: 'array', items: { type: 'object', additionalProperties: true } },
            flash_sheets: { type: 'array', items: { type: 'object', additionalProperties: true } },
            analysis: { type: 'object', additionalProperties: true },
            analysis_text: { type: 'string' },
            frames: { type: 'array', items: { type: 'object', additionalProperties: true } },
            blobs: { type: 'array', items: { type: 'object', additionalProperties: true } },
            sheets: { type: 'array', items: { type: 'object', additionalProperties: true } },
            images: { type: 'array', items: { type: 'object', additionalProperties: true } },
            runs: { type: 'array', items: { type: 'object', additionalProperties: true } },
            removed: { type: 'array', items: { type: 'string' } },
            image_capable: { type: 'boolean' },
            hint: { type: 'string' },
            elapsed_ms: { type: 'number' },
            text: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const blocks = [textBlock(value.text ?? '（无输出）')]
          if (Array.isArray(value.images)) {
            for (const image of value.images) blocks.push(imageBlockFromRef(image))
          }
          return blocks
        },
      },
      presentCall: (args) => ({
        card: 'generic',
        title: args.action === 'scan'
          ? `动态捕捉 ${args.video_path ?? ''}`
          : `动态捕捉 · ${args.action}`,
        kind: 'read',
      }),
      async execute(args, exec) {
        const startedAt = Date.now()
        const action = args.action
        if (action === 'scan') {
          if (typeof args.video_path !== 'string' || args.video_path.trim().length === 0) {
            throw new Error('scan 需要 video_path（视频绝对路径）')
          }
          // 先检查模型能力：不能读图就直接拒绝，避免白跑一遍抽帧
          const capable = await requireImageModel(ctx, exec)
          const value = await scanVideo(args, exec.signal)
          const maxImages = Math.round(clampNumber(args.max_images, 1, 6, MAX_SHEET_IMAGES))
          const images = []
          {
            // 第 1 张永远是运动总图，其余按容量给帧拼图，最后补一张爆闪拼图
            const queue = []
            if (existsSync(value.analysis.png)) queue.push({ path: value.analysis.png, sheet: null })
            for (const sheet of value.sheets.slice(0, Math.max(1, maxImages - 1))) queue.push({ path: sheet.path, sheet })
            if (value.flash_sheets.length > 0 && queue.length < 6) queue.push({ path: value.flash_sheets[0].path, sheet: value.flash_sheets[0] })
            for (const item of queue) {
              const ref = await attachPng(ctx, item.path)
              if (ref === undefined) continue
              images.push({
                attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes,
                width: ref.width, height: ref.height, name: ref.name,
              })
              if (item.sheet !== null) item.sheet.attached = true
            }
          }
          const lines = summarizeScan(value)
          lines.push(`已把 ${images.length} 张图作为图片输入回传：第 1 张是运动总图 analysis.png，其余是帧拼图（每张最多 ${SHEET_COLS * SHEET_ROWS} 帧，按编号顺序；有爆闪时它排在最后）。`)
          return {
            action,
            runId: value.runId,
            dir: value.dir,
            source: value.source,
            window: value.window,
            sampling: value.sampling,
            display: value.display,
            moving_frames: value.moving_frames,
            flash_frames: value.flash_frames,
            flash_sheets: value.flash_sheets,
            analysis: value.analysis,
            analysis_text: value.analysis_text,
            frames: value.stats,
            sheets: value.sheets,
            images,
            image_capable: capable,
            elapsed_ms: Date.now() - startedAt,
            text: lines.join('\n'),
            hint: '需要看某一帧细节：action=frames 配 run_id + indices。',
          }
        }

        if (action === 'frames') {
          if (typeof args.run_id !== 'string' || args.run_id.length === 0) throw new Error('frames 需要 run_id（先 scan 或用 action=runs 查）')
          const capable = await requireImageModel(ctx, exec)
          const meta = loadRun(args.run_id)
          const indices = parseIndexList(args.indices, meta.stats.length)
          const files = frameFiles(args.run_id, indices)
          const maxImages = Math.round(clampNumber(args.max_images, 1, 6, 4))
          const images = []
          for (const file of files.slice(0, maxImages)) {
            if (!existsSync(file.path)) continue
            const ref = await attachPng(ctx, file.path)
            if (ref !== undefined) {
              images.push({ attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, name: ref.name })
            }
          }
          const chosen = files.slice(0, maxImages)
          const lines = [`读取 ${meta.runId} 的帧：${chosen.map(file => `#${String(file.index).padStart(4, '0')}`).join(' ')}`]
          for (const file of files) {
            const stat = meta.stats.find(item => item.index === file.index)
            if (stat === undefined) continue
            lines.push(`#${String(stat.index).padStart(4, '0')} t=${stat.time_s}s N=${stat.points.length} cells=${stat.moving_cells} v=${stat.speed_px_s}px/s${stat.flash === null ? '' : ` FLASH ${Math.round(stat.flash.ratio * 100)}%`} 文件=${file.path}`)
          }
          return {
            action,
            runId: meta.runId,
            dir: meta.dir,
            frames: files.map(file => ({ index: file.index, path: file.path, time_s: file.time_s })),
            images,
            image_capable: capable,
            elapsed_ms: Date.now() - startedAt,
            text: lines.join('\n'),
          }
        }

        if (action === 'runs') {
          const runs = listRuns()
          return { action, runs, text: summaryOfRuns(runs).join('\n'), elapsed_ms: Date.now() - startedAt }
        }

        if (action === 'purge') {
          const result = purgeRuns(args)
          return {
            action,
            removed: result.removed,
            text: result.removed.length === 0
              ? `没有需要清理的运行（保留 ${clampNumber(args.ttl_h, 0, 720, 12)} 小时）。`
              : `已清理 ${result.removed.length} 个运行：${result.removed.join(', ')}`,
            elapsed_ms: Date.now() - startedAt,
          }
        }

        throw new Error(`未知 action：${String(action)}`)
      },
    }))
  } catch (error) {
    ctx.logger?.warn?.(new Error(`motion-capture: 工具注册失败：${String(error)}`