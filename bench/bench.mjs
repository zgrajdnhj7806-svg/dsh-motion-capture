/**
 * 运动捕捉基准评测：把 bench/scene.mjs 生成的“小游戏”场景喂给插件，按
 * ground truth 打分，并给出调参建议。
 *
 * 用法：
 *   node bench/bench.mjs                 # 生成（如缺）+ 评测全部场景
 *   node bench/bench.mjs --rebuild       # 强制重新生成场景
 *   node bench/bench.mjs single-frame    # 只评某个场景
 *
 * 输出：控制台记分板 + bench/out/report.json（机器可读）
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanVideo, internals } from '../dsh-motion-capture.mjs'
import { SCENES, buildScene, OUT } from './scene.mjs'

const REBUILD = process.argv.includes('--rebuild')
const ONLY = process.argv.slice(2).filter(arg => !arg.startsWith('--'))

/** 评测用的插件参数：默认对齐插件自身默认值，只把 fps/width 固定下来便于横向比较。
 *  可用环境变量 BENCH_OPTS 覆盖（JSON），例如：
 *  BENCH_OPTS='{"fps":6,"width":480}' node bench/bench.mjs speed-ladder
 */
const OVERRIDES = process.env.BENCH_OPTS ? JSON.parse(process.env.BENCH_OPTS) : {}
const PLUGIN_OPTIONS = {
  fps: 4,
  width: 360,
  max_frames: 60,
  max_points: 12,
  max_tracks: 8,
  sensitivity: 0.7,
  dot_size: 3,
  min_area: 3,
  onion: 0.45,
  trail: 2,
  arrows: true,
  ...OVERRIDES,
}

const pct = (value, span) => (span === 0 ? 0 : (value / span) * 100)
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits

/** 在 GT 采样里找 t 时刻（±0.35s）的位置；单帧物体只在自己的那一帧附近有效。 */
function gtPosAt(obj, t, tolerance = 0.35) {
  let best = null
  let bestDt = Infinity
  for (const sample of obj.samples) {
    const dt = Math.abs(sample.t - t)
    if (dt < bestDt) { best = sample; bestDt = dt }
  }
  if (best === null || bestDt > tolerance) return null
  return best
}

/** GT 物体的平均速度（源视频 px/s）；单帧闪现返回 Infinity 表示“瞬时”。 */
function gtSpeed(obj, fps) {
  if (obj.kind === 'blink') return Infinity
  if (obj.samples.length < 2) return 0
  const first = obj.samples[0]
  const last = obj.samples[obj.samples.length - 1]
  const span = last.t - first.t
  if (span <= 0) return 0
  let path = 0
  for (let i = 1; i < obj.samples.length; i++) {
    const a = obj.samples[i - 1]
    const b = obj.samples[i]
    path += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return path / span
}

/** GT 物体的净位移与路径长度（源视频 px），用来判断方向是否可判读。 */
function gtNet(obj) {
  if (obj.samples.length < 2) return { net: 0, path: 0 }
  const first = obj.samples[0]
  const last = obj.samples[obj.samples.length - 1]
  let path = 0
  for (let i = 1; i < obj.samples.length; i++) {
    const a = obj.samples[i - 1]
    const b = obj.samples[i]
    path += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return { net: Math.hypot(last.x - first.x, last.y - first.y), path }
}

/** 把插件的轨迹与 GT 物体配对，返回每个物体命中的轨迹。 */
function matchTracks(result, truth) {
  const diag = Math.hypot(truth.width, truth.height)
  const tracks = result.analysis.tracks
  const moving = truth.objects.filter(obj => gtSpeed(obj, truth.fps) > 12)
  const pairs = []
  for (const track of tracks) {
    const frames = track.frames
    if (frames.length === 0) continue
    let bestObj = null
    let bestErr = Infinity
    for (const obj of moving) {
      let sum = 0
      let count = 0
      for (const frame of frames) {
        const gt = gtPosAt(obj, frame.t)
        if (gt === null) continue
        sum += Math.hypot(frame.x_pct / 100 * truth.width - gt.x, frame.y_pct / 100 * truth.height - gt.y)
        count++
      }
      if (count < Math.max(1, Math.floor(frames.length * 0.5))) continue
      const err = sum / count
      if (err < bestErr) { bestErr = err; bestObj = obj }
    }
    if (bestObj !== null && bestErr <= diag * 0.1) {
      pairs.push({ track, object: bestObj, errorPx: bestErr, errorPct: pct(bestErr, diag) })
    } else {
      pairs.push({ track, object: null, errorPx: bestErr, errorPct: pct(bestErr, diag) })
    }
  }
  return pairs
}

/** 方向一致性：只看主轴的符号（避免依赖插件的方向词表）。 */
function directionSign(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? '右' : '左'
  return dy >= 0 ? '下' : '上'
}

function scoreScene(name, truth, result) {
  const diag = Math.hypot(truth.width, truth.height)
  const pairs = matchTracks(result, truth)
  const matched = pairs.filter(pair => pair.object !== null)
  const falsePositives = pairs.filter(pair => pair.object === null)

  const rows = []
  for (const obj of truth.objects) {
    const speed = gtSpeed(obj, truth.fps)
    if (speed <= 12) {
      rows.push({ id: obj.id, moving: false, recall: null, note: '静止对照（不应报出运动）' })
      continue
    }
    const mine = matched.filter(pair => pair.object.id === obj.id)
    if (mine.length === 0) {
      rows.push({
        id: obj.id, moving: true, recall: false,
        gtSpeed: speed === Infinity ? '瞬时' : round(speed), ids: 0,
        posErrPct: null, speedRatio: null, dirOK: null,
        reason: speed === Infinity ? '单帧闪现，采样帧没抓到' : '未被检测到',
      })
      continue
    }
    const best = mine.reduce((a, b) => (b.track.frames.length > a.track.frames.length ? b : a))
    const track = best.track
    const firstFrame = track.frames[0]
    const lastFrame = track.frames[track.frames.length - 1]
    const gtFirst = gtPosAt(obj, firstFrame.t)
    const gtLast = gtPosAt(obj, lastFrame.t)
    const gtShape = gtNet(obj)
    let dirOK = null
    // 往返/摆动类物体净位移远小于路径长度，方向本来就没有唯一答案，不计分
    const dirJudgeable = gtShape.path > 0 && gtShape.net / gtShape.path >= 0.25
    if (dirJudgeable && gtFirst !== null && gtLast !== null && (gtLast.t - gtFirst.t) > 0.2) {
      const gtDir = directionSign(gtLast.x - gtFirst.x, gtLast.y - gtFirst.y)
      const gotDir = directionSign(track.net.dx_pct, track.net.dy_pct)
      dirOK = gtDir === gotDir
    }
    rows.push({
      id: obj.id,
      moving: true,
      recall: true,
      // 插件轨迹速度就是源视频 px/s，直接用源 GT 对比，不要再乘缩放比
      gtSpeed: speed === Infinity ? '瞬时' : round(speed),
      ids: mine.length,
      posErrPct: round(best.errorPct),
      speedRatio: (speed === Infinity || track.frames.length < 2) ? null : round(track.avg_speed / Math.max(0.001, speed), 2),
      dirOK,
      frames: track.frames.length,
      spanS: round(lastFrame.t - firstFrame.t, 2),
      trackSpeed: track.avg_speed,
      reason: null,
    })
  }

  const movingRows = rows.filter(row => row.moving)
  const recalled = movingRows.filter(row => row.recall)
  const recallPct = movingRows.length === 0 ? 100 : round((recalled.length / movingRows.length) * 100, 0)
  const fragmentation = movingRows.reduce((sum, row) => sum + Math.max(0, (row.ids ?? 0) - 1), 0)
  const worstPos = recalled.reduce((max, row) => Math.max(max, row.posErrPct ?? 0), 0)
  const dirFails = recalled.filter(row => row.dirOK === false).length
  const flashHit = result.flash_frames.length
  const flashExpected = truth.flashWindows.length

  const pass = recallPct === 100 && falsePositives.length === 0 && fragmentation === 0 && worstPos <= 6 && dirFails === 0
  const warn = recallPct >= 60 && worstPos <= 12
  const verdict = pass ? 'PASS' : (warn ? 'WARN' : 'FAIL')

  return {
    name,
    label: truth.label,
    verdict,
    recallPct,
    falsePositives: falsePositives.length,
    fragmentation,
    worstPosPct: round(worstPos),
    dirFails,
    flash: { expected: flashExpected, detected: flashHit },
    rows,
    movers: movingRows.length,
    tracks: result.analysis.tracks.length,
  }
}

/** 按失败模式给调参建议（只建议，不改插件默认值）。 */
function suggestions(score) {
  const tips = []
  for (const row of score.rows) {
    if (!row.moving) continue
    if (row.recall === false) {
      if (row.gtSpeed === '瞬时') {
        tips.push(`${row.id}：只占 1 个编码帧。ffmpeg 的 fps 滤镜默认向下取整，采样点会停在它前面那一帧；把 fps 提到 10+ 或给 fps 滤镜加 round=near/up 才抓得到。`)
      } else if (row.gtSpeed > 200) {
        tips.push(`${row.id}：真值速度 ${row.gtSpeed} px/s，2fps 下每帧位移约 ${Math.round(row.gtSpeed / 2)} px，超过匹配门限。把 fps 提到 6–10（位移 ÷ 2–3）最直接。`)
      } else {
        tips.push(`${row.id}：速度不高仍漏检，先把 sensitivity 提到 0.85、min_area 降到 2；若它旁边还有别的运动物体，也要考虑已被并成同一团块。`)
      }
    } else if ((row.ids ?? 0) > 1) {
      tips.push(`${row.id}：被拆成 ${row.ids} 条轨迹（同物体跨帧断轨，不是同帧团块没合并）。提高 fps 让相邻帧位移变小，或调大 buildTracks 里的匹配门限 baseLimit。`)
    } else if ((row.posErrPct ?? 0) > 4) {
      tips.push(`${row.id}：位置误差 ${row.posErrPct}% 画面对角线，偏高。提高 width（如 480）保留细节最有效。`)
    }
    if (row.dirOK === false) {
      tips.push(`${row.id}：方向判反，通常是采样间隔跨过了反弹点，把 fps 提到 4–6 再对比一次。`)
    }
    if (typeof row.speedRatio === 'number' && (row.speedRatio < 0.75 || row.speedRatio > 1.35)) {
      tips.push(`${row.id}：速度比 ${row.speedRatio}（1.0 为准确），质心抖动或被邻近物体串轨都会造成偏差，先看 analysis.png 里 #编号的历史点是否跑到了别的物体上。`)
    }
  }
  if (score.movers > PLUGIN_OPTIONS.max_tracks) {
    tips.push(`场景有 ${score.movers} 个运动物体，超过本次 max_tracks=${PLUGIN_OPTIONS.max_tracks} —— 超出的必然没有编号。把 max_tracks 提到 ≥ ${score.movers}。`)
  }
  if (score.falsePositives > 0) {
    tips.push(`有 ${score.falsePositives} 条轨迹没对上任何物体：多为背景纹理或压缩噪声，把 sensitivity 降到 0.6、min_area 提到 4。`)
  }
  if (score.flash.expected > 0 && score.flash.detected === 0) {
    tips.push(`爆闪窗口（${score.flash.expected} 个）没被分类：窗口只有 0.1s，抽帧点没落在里面。实测同一录像 fps=10 能命中（ratio=1.0、meanDiff=148），说明判定逻辑没问题，是采样密度不够。`)
  }
  return tips
}

function printScore(score) {
  console.log(`\n── ${score.name} ｜ ${score.label}`)
  console.log(`   结论 ${score.verdict} ｜ 召回 ${score.recallPct}% ｜ 误检 ${score.falsePositives} ｜ 碎片 ${score.fragmentation} ｜ 最大位置误差 ${score.worstPosPct}% ｜ 方向错 ${score.dirFails} ｜ 爆闪 ${score.flash.detected}/${score.flash.expected}`)
  for (const row of score.rows) {
    if (!row.moving) {
      console.log(`   · ${row.id.padEnd(10)} ${row.note}`)
      continue
    }
    if (row.recall === false) {
      console.log(`   ✗ ${row.id.padEnd(10)} 漏检  速度=${row.gtSpeed}  ${row.reason}`)
      continue
    }
    const flags = []
    flags.push(`#${row.ids}`)
    flags.push(`位置误差 ${row.posErrPct}%`)
    flags.push(row.speedRatio === null ? '速度比 —' : `速度比 ${row.speedRatio}`)
    flags.push(row.dirOK === null ? '方向 —' : (row.dirOK ? '方向 ✓' : '方向 ✗'))
    flags.push(`${row.frames}帧/${row.spanS}s`)
    const speedText = row.gtSpeed === '瞬时' ? '真值速度=瞬时' : `真值速度=${row.gtSpeed} px/s`
    console.log(`   ✓ ${row.id.padEnd(10)} ${speedText}  ${flags.join(' ｜ ')}`)
  }
  const tips = suggestions(score)
  if (tips.length > 0) {
    console.log('   建议：')
    for (const tip of tips) console.log(`     – ${tip}`)
  }
}

const runners = ONLY.length > 0 ? ONLY : Object.keys(SCENES)
mkdirSync(OUT, { recursive: true })
const report = { generatedAt: new Date().toISOString(), options: PLUGIN_OPTIONS, scenes: [] }

for (const name of runners) {
  const dir = join(OUT, name)
  let built = { name, video: join(dir, 'scene.mp4'), duration: SCENES[name].duration, truth: null }
  if (REBUILD || !existsSync(built.video)) {
    built = await buildScene(name)
  }
  if (built.truth === null) {
    const truthPath = join(dir, 'ground_truth.json')
    built.truth = JSON.parse(readFileSync(truthPath, 'utf8'))
  }
  const startedAt = Date.now()
  const result = await scanVideo({
    ...PLUGIN_OPTIONS,
    video_path: built.video,
    start_s: 0,
    duration_s: built.duration,
  })
  const score = scoreScene(name, built.truth, result)
  score.elapsedMs = Date.now() - startedAt
  printScore(score)
  console.log(`   插件耗时 ${score.elapsedMs} ms ｜ 运行缓存 ${result.dir}`)
  report.scenes.push(score)
}

const overall = report.scenes.every(scene => scene.verdict === 'PASS') ? 'PASS'
  : (report.scenes.some(scene => scene.verdict === 'FAIL') ? 'FAIL' : 'WARN')
report.overall = overall
writeFileSync(join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`\n总体：${overall} ｜ 报告 ${join(OUT, 'report.json')} ｜ ffmpeg ${internals.findFfmpeg()}`)
