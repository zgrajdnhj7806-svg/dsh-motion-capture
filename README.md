# DSH Motion Capture

给 **DSH（DeepSeek Harness）** 用的视频动态分析插件：把视频变成「能读图片的多模态模型」直接可用的运动报告 + 一张运动总图 + 编号帧拼图。

它不依赖任何 npm 包，只用 ffmpeg 单趟解码、在纯 JS 网格上做帧间差分，默认 4fps / 显示宽 360，单段 6 秒视频约 1–2 秒跑完。

## 适用模型（硬性要求）

本插件**只服务于声明了 image 输入的多模态模型路由**：

- `scan` / `frames` 会先向 `llm.resolveModelInfo` 查询当前路由的 `inputModalities`；
- 若不含 `image`，直接抛错并提示切换视觉模型，**不会降级成纯文本模式**；
- 这样不会在纯文本模型上白白抽帧、也不会把图片硬塞给不支持的路由导致 provider 报错。

## 输出长什么样

一次 `scan` 产出四类东西，按这个顺序读最省力：

1. **`analysis.txt` 文字运动报告**（同时直接拼进工具返回的文本里）
   - 整体：运动区域占画面横向/纵向百分比、速度峰值（px/s）与出现时间；
   - 每个跨帧运动区域固定编号 `#1/#2…`：时间范围、起点/终点、净位移方向、平均与最快速度、方向序列、轨迹点；
   - 逐帧一行：`#0006 t=2.53s #1(48%,58%) v11 向左 镜头向下2px`。
2. **`analysis.png` 运动总图**
   - 暗化首帧上叠「运动历史」：每个采样点按时间上色，**蓝=早、红=晚**，一眼看出哪片区域在动、先后顺序；
   - 下半部是逐帧速度曲线，竖红条 = 爆闪/大面积突变帧。
3. **`sheet1.png` 帧拼图**（3×2 contact sheet）
   - 每帧原图 + 递增编号 `#0001` + 运动红点 + 渐变箭头（尾淡头亮，按局部背景自动取高对比色）；
   - 运动物体旁有 `#N` 标签，和文字报告、`analysis.png` 的编号完全对应。
4. **`analysis.json` / `meta.json` / `f*.png`**：结构化数据与原始帧，便于二次处理。

爆闪/爆炸/转场这类「大块、整体亮度剧变」的帧会单独归类到 `flash1.png`，不画运动点（避免满屏噪点，也避免计算量失控）。

## 安装到 DSH

插件是单文件静态插件，导出 `name` / `inject` / `apply`，通过 `cordis.patch.yml` 挂载即可。

1. 把 `dsh-motion-capture.mjs` 放到任意目录，例如 `C:\Users\<you>\WorkBuddy\dsh-motion-capture\dsh-motion-capture.mjs`。
2. 在 DSH profile 的 `cordis.patch.yml`（如 `~/.dsh/profiles/desktop/cordis.patch.yml`）里挂载：

```yml
plugins:
  - insert:
      - id: motion-capture
        name: 'file:///C:/Users/<you>/WorkBuddy/dsh-motion-capture/dsh-motion-capture.mjs'
```

也可以参考仓库里的 `cordis.patch.example.yml`。

3. 重启 DSH，工具列表里会出现 `motion_capture`。

### ffmpeg 依赖

按以下顺序查找，任一可用即可：

1. 环境变量 `DSH_MOTION_FFMPEG` 指向 `ffmpeg.exe`；
2. `PATH` 里的 `ffmpeg`；
3. Python 的 `imageio_ffmpeg` 自带的 ffmpeg（`python -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"`）。

找不到会明确报错，不会静默失败。

## 使用

工具名：`motion_capture`。

### action = scan

```json
{
  "action": "scan",
  "video_path": "C:/videos/demo.mp4",
  "fps": 4,
  "width": 360,
  "max_frames": 60,
  "sensitivity": 0.7,
  "onion": 0.45,
  "trail": 2,
  "max_images": 3
}
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `video_path` | 必填 | 视频绝对路径 |
| `start_s` / `duration_s` | 0 / 全片 | 只看某一段（秒），建议先切 5–10 秒 |
| `fps` | 4 | 采样帧率；越低每帧位移越大，方向越好读 |
| `width` | 360 | 解码宽度，越小越快 |
| `max_frames` | 60 | 帧数上限，超出会压低实际 fps |
| `max_tracks` | 8 | 最多输出几条物体轨迹（编号 #1…#N）；多物体场景别低于画面里的运动物体数 |
| `sensitivity` | 0.7 | 帧差灵敏度（0–1），越大越敏感 |
| `min_area` | 3 | 运动团块最小格数，调小可保留远处小物体 |
| `onion` | 0.45 | 洋葱皮强度（上一帧残影），0 关闭 |
| `trail` | 2 | 运动拖尾帧数（0–3） |
| `max_images` | 3 | 最多回传几张图（运动总图固定占 1 张） |

### action = frames

```json
{ "action": "frames", "run_id": "<scan 返回的 runId>", "indices": "1,3,5-8" }
```

取单帧原图放大看细节，同样要求视觉模型。

### action = runs / purge

查看或清理临时缓存；缓存默认在系统临时目录 `dsh-motion-capture/`，按 TTL 清理。

## 基准测试（bench/）

`bench/` 是一个无头「小游戏」场景生成器 + 自动评测，用来校准插件、并作为模型调用能力的回归基准。

- `bench/scene.mjs`：确定性渲染三个场景并编码成 mp4，同时输出 `ground_truth.json`（每个物体的逐帧真值位置）。
  - `basic-mixed`：巡逻（摆动）+ 奔跑（直线反弹）+ 高速斜向反弹 + 静止对照 + 0.1s 爆闪；
  - `speed-ladder`：30 / 80 / 160 / 320 / 600 px/s 五个同行物体；
  - `single-frame`：两个只在 1/60 s 出现一帧的物体 + 慢速对照。
- `bench/bench.mjs`：把场景喂给插件，按真值配对打分（召回、误检、碎片、位置误差、速度比、方向、爆闪），并按失败模式给出调参建议。

```powershell
node bench/bench.mjs --rebuild                                  # 重新生成场景并评测全部
node bench/bench.mjs single-frame                               # 只评一个场景
$env:BENCH_OPTS='{"fps":6,"width":480}'; node bench/bench.mjs   # 扫参数
```

当前默认参数下的记分板：`basic-mixed` / `speed-ladder` = WARN（召回 100%，剩余问题是个别物体断成两条轨迹），`single-frame` = PASS（1 帧闪现与爆闪都能抓到）。

## 设计说明

- **单趟解码**：`ffmpeg -vf fps,scale -pix_fmt rgb24` 一次输出全部采样帧，不落中间视频；
- **采样取整用 `round=up`**：ffmpeg 的 fps 滤镜默认向下取整，会把恰好落在采样点上的 1 帧事件（爆闪、闪现）整段跳过；改用 `up` 后这类瞬态内容才能命中（`bench/single-frame` 已验证）；
- **帧差在网格上做**：灰度分块 + 自适应阈值（`max(最小阈值, 中位数×2.5)`）+ 8 邻域连通域；
- **镜头补偿**：估计整体平移并先对齐背景，再求差，避免镜头移动被误判成物体运动；
- **轨迹门限随速度放大**：匹配门限取 `max(baseLimit, 自身位移×1.8)` 并设上限，高速物体不会因为每帧位移大而被断成多条轨迹；
- **1 帧团块也保留**：面积 ≥4 格的单帧团块会作为一条轨迹输出，否则「只出现 1 帧」的目标永远报不出来；
- **显著度过滤**：运动区域与周围环带的亮度差太小（反光、噪点）就丢弃；
- **防崩溃**：爆闪帧不标注、单帧团块处理上限 24、采样点上限、总帧数上限；
- **零 npm 依赖**：只有 Node 内置模块 + ffmpeg。

## 已知限制

- 运动区域中心由帧差团块质心得到；同一主体快速迈腿/摆臂时，质心会在躯干与四肢间小幅跳动，方向序列会抖动，判断大方向以净位移为准（文字报告里已注明）。
- 两个距离很近的运动主体可能被合并成同一个编号。
- 极小/极慢的运动（小于灵敏度阈值）会被当成静止。
- 只持续 1 个编码帧的瞬态内容，只有在抽帧点正好落在那一帧时才会被抓到；默认 4fps 下命中率取决于事件时刻，建议这类素材用 `fps` 10+。
- 同一画面里的运动物体数量超过 `max_tracks` 时，多出的轨迹不会输出。

## 许可证

MIT，见 [LICENSE](LICENSE)。
