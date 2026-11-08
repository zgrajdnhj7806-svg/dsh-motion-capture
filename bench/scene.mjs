/**
 * 运动捕捉“小游戏”场景生成器（无头、确定性）。
 *
 * 每个场景 = 一局几分钟的模拟游戏画面：若干物体按已知规则移动（巡逻、奔跑、
 * 冲刺、闪现、反弹），可选整屏爆闪。渲染结果写成 mp4，同时输出 ground truth
 * （每个物体在每一编码帧上的真实位置），供 bench.mjs 对比插件识别结果。
 *
 * 用法：
 *   node bench/scene.mjs                 # 生成全部场景
 *   node bench/scene.mjs basic-mixed     # 只生成指定场景
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, openSync, writeSync, closeSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { internals } from '../dsh-motion-capture.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')

/** 场景注册表：坐标与速度都用“源视频像素/秒”。 */
export const SCENES = {
  'basic-mixed': {
    label: '基础混合：巡逻 + 奔跑 + 反弹 + 静止 + 爆闪',
    width: 640,
    height: 360,
    fps: 30,
    duration: 6,
    grid: true,
    objects: [
      // 慢速巡逻：上下摆动，给模型一个“好读”的基准
      { id: 'walker', shape: 'circle', size: 15, color: [90, 220, 130], kind: 'osc', axis: 'y', center: [120, 180], amp: 95, period: 4 },
      // 中速奔跑：横向直线，撞边反弹
      { id: 'runner', shape: 'circle', size: 17, color: [240, 180, 70], kind: 'linear', from: [60, 90], vel: [180, 0], bounce: true },
      // 高速反弹：两个方向同时撞边，用来测方向反转
      { id: 'bouncer', shape: 'box', size: 22, color: [90, 170, 250], kind: 'linear', from: [320, 280], vel: [260, -190], bounce: true },
      // 静止装饰物：不该被报告为运动
      { id: 'statue', shape: 'box', size: 34, color: [120, 120, 130], kind: 'static', from: [560, 60] },
    ],
    flashWindows: [{ start: 4.0, length: 0.1 }],
  },

  'speed-ladder': {
    label: '速度阶梯：同一方向 30/80/160/320/600 px/s',
    width: 640,
    height: 360,
    fps: 60,
    duration: 5,
    grid: true,
    objects: [
      { id: 'v30', shape: 'circle', size: 14, color: [120, 220, 120], kind: 'linear', from: [40, 60], vel: [30, 0], bounce: true },
      { id: 'v80', shape: 'circle', size: 14, color: [220, 220, 90], kind: 'linear', from: [40, 120], vel: [80, 0], bounce: true },
      { id: 'v160', shape: 'circle', size: 14, color: [240, 160, 70], kind: 'linear', from: [40, 180], vel: [160, 0], bounce: true },
      { id: 'v320', shape: 'circle', size: 14, color: [240, 100, 100], kind: 'linear', from: [40, 240], vel: [320, 0], bounce: true },
      { id: 'v600', shape: 'circle', size: 14, color: [200, 110, 240], kind: 'linear', from: [40, 300], vel: [600, 0], bounce: true },
    ],
    flashWindows: [],
  },

  'single-frame': {
    label: '单帧闪现：物体只在 1/60 s 出现，测极限漏检',
    width: 640,
    height: 360,
    fps: 60,
    duration: 6,
    grid: true,
    objects: [
      // 只出现一个编码帧：抽帧到 2fps 时几乎必然漏掉
      { id: 'blink-a', shape: 'box', size: 36, color: [255, 90, 90], kind: 'blink', from: [150, 130, 150, 230], at: 1.5 },
      { id: 'blink-b', shape: 'box', size: 36, color: [90, 200, 255], kind: 'blink', from: [420, 120, 480, 260], at: 3.5 },
      // 对照组：慢速物体，用来确认“不是整段都没检测到”
      { id: 'anchor', shape: 'circle', size: 15, color: [110, 230, 130], kind: 'osc', axis: 'x', center: [320, 300], amp: 110, period: 5 },
    ],
    flashWindows: [],
  },

  // 复现“暗场 + 低对比度 + 细灰尘 + 慢雾 + 噪点”这种最容易 v=0 的现场素材：
  // 物体只比背景亮十几个灰阶、细颗粒在缩到评测宽度后仅 1~2 像素，背景还有整屏噪点与缓慢漂移的雾。
  'dark-ash': {
    label: '暗场细灰烬：低对比度 + 细颗粒 + 慢雾 + 噪点',
    width: 960,
    height: 540,
    fps: 30,
    duration: 6,
    grid: false,
    bg: { base: 9, x: 4, y: 3, line: [15, 15, 18] },
    grain: 1.8,
    haze: { amp: 2.5, speedPx: 6 },
    objects: [
      { id: 'ember-a', shape: 'box', size: 5, color: [21, 21, 23], kind: 'linear', from: [110, 140], vel: [42, 18] },
      { id: 'ember-b', shape: 'box', size: 5, color: [22, 22, 24], kind: 'linear', from: [520, 110], vel: [-36, 26] },
      { id: 'ember-c', shape: 'circle', size: 4, color: [20, 20, 22], kind: 'linear', from: [280, 420], vel: [28, -14] },
      { id: 'drift', shape: 'circle', size: 16, color: [24, 24, 27], kind: 'osc', axis: 'x', center: [720, 400], amp: 60, period: 6 },
      // 静止对照：暗场里也不能把固定物体报成运动
      { id: 'post', shape: 'box', size: 26, color: [30, 28, 24], kind: 'static', from: [880, 80] },
    ],
    flashWindows: [],
    // 暗场里至少要能看到运动，否则就是“整段 v=0”的失败现场
    minMotionRatio: 0.003,
  },
}

/** 双线性背景：深色渐变 + 细网格，保证有静态纹理但不会自己产生运动。 */
function drawBackground(buf, w, h, scene) {
  const bg = scene.bg ?? {}
  const base = bg.base ?? 26
  const gradX = bg.x ?? 10
  const gradY = bg.y ?? 8
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      const shade = base + Math.round((x / w) * gradX) + Math.round((y / h) * gradY)
      buf[i] = shade
      buf[i + 1] = shade + 2
      buf[i + 2] = shade + 6
    }
  }
  if (scene.grid !== true) return
  const line = bg.line ?? [46, 50, 60]
  for (let x = 0; x < w; x += 40) fillRect(buf, w, h, x, 0, 1, h, line)
  for (let y = 0; y < h; y += 40) fillRect(buf, w, h, 0, y, w, 1, line)
}

const clampByte = value => (value < 0 ? 0 : (value > 255 ? 255 : value))

/** 整屏噪点（暗场/高感素材的底色），逐帧不同但幅度固定，用来考验阈值是否够稳。 */
function addGrain(buf, w, h, amount, seed) {
  let state = (seed * 2654435761 + 12345) >>> 0
  for (let i = 0; i < buf.length; i += 3) {
    state = (state * 1103515245 + 12345) >>> 0
    const noise = (((state >>> 16) % 1024) / 1024 - 0.5) * 2 * amount
    const delta = Math.round(noise)
    buf[i] = clampByte(buf[i] + delta)
    buf[i + 1] = clampByte(buf[i + 1] + delta)
    buf[i + 2] = clampByte(buf[i + 2] + delta)
  }
}

/** 缓慢漂移的雾：低频亮度起伏，整屏一起动，但每帧变化极小（模拟暗场里的烟雾）。 */
function addHaze(buf, w, h, haze, t) {
  const amp = haze.amp ?? 2.5
  const speed = haze.speedPx ?? 6
  const phase = t * speed
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      const wave = amp * (Math.sin((x + phase) * 0.007 + y * 0.004) + 0.6 * Math.sin((x - phase * 1.7) * 0.013 - y * 0.009))
      const delta = Math.round(wave)
      buf[i] = clampByte(buf[i] + delta)
      buf[i + 1] = clampByte(buf[i + 1] + delta)
      buf[i + 2] = clampByte(buf[i + 2] + delta)
    }
  }
}

function fillRect(buf, w, h, x, y, rw, rh, rgb) {
  for (let dy = 0; dy < rh; dy++) {
    const py = y + dy
    if (py < 0 || py >= h) continue
    for (let dx = 0; dx < rw; dx++) {
      const px = x + dx
      if (px < 0 || px >= w) continue
      const i = (py * w + px) * 3
      buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2]
    }
  }
}

function fillCircle(buf, w, h, cx, cy, r, rgb) {
  const r2 = r * r
  for (let py = Math.floor(cy - r); py <= Math.ceil(cy + r); py++) {
    if (py < 0 || py >= h) continue
    for (let px = Math.floor(cx - r); px <= Math.ceil(cx + r); px++) {
      if (px < 0 || px >= w) continue
      const dx = px - cx
      const dy = py - cy
      if (dx * dx + dy * dy > r2) continue
      const i = (py * w + px) * 3
      buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2]
    }
  }
}

function drawShape(buf, w, h, shape, cx, cy, size, rgb) {
  if (shape === 'circle') {
    fillCircle(buf, w, h, cx, cy, size, rgb)
  } else {
    fillRect(buf, w, h, Math.round(cx - size / 2), Math.round(cy - size / 2), size, size, rgb)
  }
}

/** 撞边反弹：把线性位置折返到 [margin, span-margin]。 */
function reflect(value, span, margin) {
  const range = Math.max(1, span - margin * 2)
  let pos = (value - margin) % (range * 2)
  if (pos < 0) pos += range * 2
  if (pos > range) pos = range * 2 - pos
  return margin + pos
}

/** 物体在时间 t（秒）的中心位置与可见性。 */
function posAt(obj, t, scene) {
  const margin = 24
  if (obj.kind === 'static') {
    return { x: obj.from[0], y: obj.from[1], visible: true }
  }
  if (obj.kind === 'blink') {
    // 只在 at 之后的一个编码帧内可见
    const visible = t >= obj.at && t < obj.at + 1 / scene.fps
    const x = obj.from[0] + (obj.from[2] - obj.from[0]) * ((t - obj.at) * scene.fps)
    const y = obj.from[1] + (obj.from[3] - obj.from[1]) * ((t - obj.at) * scene.fps)
    return { x, y, visible }
  }
  if (obj.kind === 'osc') {
    const phase = Math.sin((2 * Math.PI * t) / obj.period)
    const x = obj.axis === 'x' ? obj.center[0] + obj.amp * phase : obj.center[0]
    const y = obj.axis === 'y' ? obj.center[1] + obj.amp * phase : obj.center[1]
    return { x, y, visible: true }
  }
  // linear
  let x = obj.from[0] + obj.vel[0] * t
  let y = obj.from[1] + obj.vel[1] * t
  if (obj.bounce) {
    x = obj.vel[0] === 0 ? obj.from[0] : reflect(x, scene.width, margin)
    y = obj.vel[1] === 0 ? obj.from[1] : reflect(y, scene.height, margin)
  }
  return { x, y, visible: true }
}

function runFfmpeg(args, timeoutMs = 120000) {
  const exe = internals.findFfmpeg()
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true })
    let stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('ffmpeg 超时')) }, timeoutMs)
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg 退出码 ${code}：${stderr.slice(-400)}`))
    })
  })
}

/**
 * 渲染一个场景：逐帧写 raw RGB（不占内存），再交给 ffmpeg 编码成 mp4。
 * @returns {Promise<{name:string, video:string, duration:number, truth:object}>}
 */
export async function buildScene(name) {
  const scene = SCENES[name]
  if (scene === undefined) throw new Error(`未知场景：${name}`)
  const dir = join(OUT, name)
  mkdirSync(dir, { recursive: true })
  const { width: W, height: H, fps } = scene
  const frames = Math.round(scene.duration * fps)
  const rawPath = join(dir, 'scene.rgb')
  const videoPath = join(dir, 'scene.mp4')

  const fd = openSync(rawPath, 'w')
  const truth = {
    name,
    label: scene.label,
    width: W,
    height: H,
    fps,
    duration: scene.duration,
    frames,
    flashWindows: scene.flashWindows,
    minMotionRatio: scene.minMotionRatio ?? null,
    objects: scene.objects.map(obj => ({
      id: obj.id,
      kind: obj.kind,
      shape: obj.shape,
      size: obj.size,
      color: obj.color,
      samples: [],
    })),
  }

  for (let f = 0; f < frames; f++) {
    const t = f / fps
    const buf = new Uint8Array(W * H * 3)
    drawBackground(buf, W, H, scene)
    if (scene.haze !== undefined) addHaze(buf, W, H, scene.haze, t)
    for (const obj of scene.objects) {
      const pos = posAt(obj, t, scene)
      if (!pos.visible) continue
      drawShape(buf, W, H, obj.shape, pos.x, pos.y, obj.size, obj.color)
      const record = truth.objects.find(item => item.id === obj.id)
      record.samples.push({ frame: f, t: Math.round(t * 1000) / 1000, x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10 })
    }
    if (scene.grain !== undefined) addGrain(buf, W, H, scene.grain, f)
    const flash = scene.flashWindows.find(win => t >= win.start && t < win.start + win.length)
    if (flash !== undefined) {
      // 爆闪：整屏提亮，模拟爆炸/转场
      for (let i = 0; i < buf.length; i++) buf[i] = Math.min(255, buf[i] + 150)
    }
    writeSync(fd, Buffer.from(buf.buffer, buf.byteOffset, buf.length))
  }
  closeSync(fd)

  try {
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(fps),
      '-i', rawPath,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      videoPath,
    ])
  } catch (error) {
    // 没有 libx264 的精简版 ffmpeg 走 mpeg4，画面质量差一点但能跑
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(fps),
      '-i', rawPath,
      '-c:v', 'mpeg4', '-q:v', '3', '-pix_fmt', 'yuv420p',
      videoPath,
    ])
  }
  rmSync(rawPath, { force: true })

  writeFileSync(join(dir, 'ground_truth.json'), `${JSON.stringify(truth, null, 2)}\n`)
  return { name, video: videoPath, duration: scene.duration, truth }
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const wanted = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(SCENES)
  for (const name of wanted) {
    const built = await buildScene(name)
    console.log(`场景 ${name} → ${built.video}（${built.truth.frames} 帧 @ ${built.truth.fps}fps）`)
  }
}

export { OUT }
