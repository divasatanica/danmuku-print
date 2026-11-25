# 实施计划：跨平台动态标签打印（macOS 开发 / Windows 运行）

## 目标

把后端现有的 `MockPrinter` 扩展成可切换的系统打印机，实现：

```text
PrintJob
  → Canvas 渲染动态内容
  → 1-bit 位图
  → TSPL SIZE/BITMAP/PRINT
  → macOS: lp -o raw
  → Windows: PowerShell + winspool WritePrinter (RAW)
```

macOS 只用于开发和调试，Windows 是最终运行环境。两端发送**完全相同**的 TSPL 字节流，只替换最后的提交方式。

## 范围

### 本计划包含

- 跨平台动态标签渲染：昵称、价格（实际为弹幕正文）、VIP 编号、精确到秒的时间戳、固定免责声明。
- 固定使用 TSPL `BITMAP`，不使用 `TEXT`/`BOX`/`BARCODE` 打印机指令。
- 左右各 2 mm 内边距、内容居中的 40 × 30 mm 版式；边框可选。
- 共享的位图打包与 TSPL 序列化模块。
- macOS 和 Windows 两个 RAW transport。
- `PrintJob` → `Printer` 的后端接入。
- 字体资源复制、构建产物、配置项和调试预览。
- 单元测试、macOS 实机验证、Windows 命令行启动和实机验证清单。

### 本计划不包含

- 不修改弹幕监听、SQLite 表结构、额度、重试和任务队列逻辑。
- 不同时管理多台打印机；一个服务实例只对应一个 `PRINT_QUEUE`。
- 不实现打印机端的中文字体下载或 TSPL `TEXT` 兼容层。
- 不做 Windows GUI/安装包；只约定 Node 服务从命令行启动的运行方式。

## 标签内容与版式

默认 40 × 30 mm、203 dpi，输出 320 × 240 点。

- 左右各留 **2 mm（16 点）**，上下也各留 2 mm，内容区 288 × 208 点，整体居中。
- 边框可选，默认关闭；开启时画在距纸边 1 mm 的位置，不挤压内容区。
- 首行左侧固定品牌文字 `纸纸文创`，右侧显示纯数字观众编号（不带「VIP」字样）。
- 昵称行：昵称单独一行，字号最大；过长时先缩小字号，仍放不下则截断加省略号。
- 价格行：`价格 <content>`，`content` 就是弹幕正文，原样显示，不重新格式化数字；与 VIP 行同号 22 px，超宽按 22/20/18/16 逐级缩小后省略。
- VIP 行：`VIP <viewerNumber>`，位于价格行下方，与价格同号 22 px。
- 时间行：`YYYY-MM-DD HH:mm:ss`，精确到秒，约 18 px；默认使用 `Asia/Shanghai`，可通过 `PRINT_TIME_ZONE` 覆盖。
- 底部固定一行：`纸制品默认微瑕，不退不换`，使用 20 px，保证热敏打印清晰。

时间戳使用 `job.timestamp`（毫秒）转换，显示的是可读本地时间，不是原始 epoch。

## 架构决策

1. **动态内容全部在宿主端栅格化。** 这台 N31D 固件已实测忽略 `TEXT`/`BOX`，驱动也走 `BITMAP`。继续使用 `TEXT` 没有跨平台价值。
2. **渲染层与传输层分离。**
   - `renderLabel(job)` 和 `bitmapToTspl()` 不允许出现平台分支。
   - 只有 `submitRaw()` 根据 `process.platform` 选择 `lp` 或 `winspool`。
3. **使用 `@napi-rs/canvas` + 自带 Noto Sans SC（已确认允许）。**
   - 同一套 Skia 渲染在 macOS arm64 和 Windows x64 上运行。
   - 自带字体避免 PingFang/微软雅黑的 metrics 差异，保证换行位置一致。
   - 字体随包分发，保留 Noto 的 OFL 许可证文件。
4. **字体资源随构建复制。** 字体放在 `backend/assets/fonts/`，构建时复制到 `dist/backend/assets/fonts/`；运行时同时兼容源码路径和构建路径。
5. **默认尺寸 40 × 30 mm，203 dpi。** 输出 320 × 240 点；左右各 2 mm、上下各 2 mm，内容居中。边框由 `PRINT_LABEL_BORDER` 控制，默认关闭。
6. **HPRT 512 字节头做成配置。** macOS 上的 `raster-tspl` 过滤器会写 512 字节零头；Windows RAW 是否必需未知，默认保留，异常时可用环境变量关闭。
7. **默认仍然是 MockPrinter。** 只有显式设置 `PRINT_BACKEND=system` 且提供 `PRINT_QUEUE` 才会真实出纸，避免开发环境误打印。
8. **Windows 按命令行服务运行。** 目标启动方式是 `npm start` 或 `node dist/backend/index.js`，不假设 Windows Service 或 Electron；队列名只通过 `PRINT_QUEUE` 配置。

## 目标文件结构

```text
backend/
  assets/
    fonts/
      NotoSansSC-Regular.ttf
      OFL.txt
  scripts/
    copy-assets.mjs
    preview-label.ts
  src/
    printing/
      bitmap.ts            1-bit 位图类型、RGBA 阈值打包
      layout.ts            文本换行/自动缩放/截断（纯函数）
      render-label.ts      Canvas 动态标签渲染
      tspl.ts              SIZE/BITMAP/PRINT 序列化
      font.ts              字体注册与路径解析
      transport/
        index.ts           平台选择
        macos.ts           lp -o raw
        windows.ts         winspool RAW
    printer.ts             MockPrinter + SystemPrinter + 环境配置
    index.ts               注入实际 Printer
  test/
    label-layout.test.ts
    label-render.test.ts
    tspl.test.ts
    transport-macos.test.ts
    transport-windows.test.ts
    printer-config.test.ts
```

---

## Task 1：安装并验证渲染依赖与字体

**Description:** 在 `backend` workspace 安装已批准的 `@napi-rs/canvas`，加入 Noto Sans SC Regular 字体和 OFL 许可证，写一个 spike 脚本，在 320 × 240 画布上渲染中文、数字、英文并输出 PNG。确认 macOS 可运行，检查 lockfile 中的 Windows 可选二进制包，记录渲染耗时。以该方案为准；仅当 Windows 预编译包不可用时才回到决策。

**Acceptance criteria:**

- [x] `backend/package.json` 和根 `package-lock.json` 记录 `@napi-rs/canvas`。
- [x] `backend/assets/fonts/NotoSansSC-Regular.ttf` 和 `OFL.txt` 存在。
- [x] spike 脚本输出 320 × 240 PNG，中文、数字、英文均清晰可读。
- [x] lockfile 包含 Windows 平台包（如 `@napi-rs/canvas-win32-x64-msvc`）。
- [x] 单次渲染耗时记录在计划或 README 中。

**Verification:**

- [x] `node backend/scripts/spike-render.mjs` 成功生成 PNG。
- [x] 人工查看 PNG，无方框、无乱码。
- [x] `npm run typecheck --workspace backend` 通过。

**Dependencies:** None（已获批准，先做）

**Files likely touched:**
- `backend/package.json`
- `package-lock.json`
- `backend/assets/fonts/NotoSansSC-Regular.ttf`
- `backend/assets/fonts/OFL.txt`
- `backend/scripts/spike-render.mjs`

**Estimated scope:** Medium

---

## Task 2：实现共享的 1-bit 位图与 TSPL 序列化

**Description:** 新建 `bitmap.ts` 与 `tspl.ts`。`pack1Bit(rgba, width, height, threshold)` 把 RGBA 转成 MSB-first、白色为 1、黑色为 0 的位图；宽度不是 8 的倍数时补白。`makeTspl(bitmap, options)` 生成 512 字节头、`SIZE`、`SET TEAR/CUTTER/PEEL`、`CLS`、`BITMAP`、位图数据、`PRINT`，并保证 `BITMAP ... ,1,` 后**没有** CRLF。

**Acceptance criteria:**

- [x] `Bitmap` 类型包含 `width`、`height`、`rowBytes`、`data`。
- [x] 黑色像素打包为 0，白色为 1；非 8 倍数宽度末尾补白。
- [x] `BITMAP` 命令后紧跟二进制数据。
- [x] 输出以 `\r\nPRINT 1,1\r\n` 结尾。
- [x] 512 字节头可配置，默认 512。

**Verification:**

- [x] `node --test backend/test/tspl.test.ts`
- [x] 测试覆盖位极性、补白、头部长度、CRLF 位置、`PRINT` 结尾。

**Dependencies:** None（可与 Task 1 并行）

**Files likely touched:**
- `backend/src/printing/bitmap.ts`
- `backend/src/printing/tspl.ts`
- `backend/test/tspl.test.ts`

**Estimated scope:** Medium

---

## Task 3：实现文本布局与动态标签渲染

**Description:** 拆出纯函数 `layoutText()`，负责按字素换行、自动缩小字号、超长省略号。`renderLabel(job, options)` 使用 Canvas 按既定版式绘制六行：首行左侧固定品牌 `纸纸文创`、右侧纯数字编号；昵称（单独一行、字号最大）；`价格 <content>`；`VIP <viewerNumber>`（位于价格下方，与价格同号）；`YYYY-MM-DD HH:mm:ss`；底部固定 `纸制品默认微瑕，不退不换`。使用左右各 2 mm 的对称内边距并居中，边框由选项控制。

**Acceptance criteria:**

- [x] 左右各 2 mm、上下各 2 mm 内边距；内容区 288 × 208 点（40 × 30 mm）并水平居中。
- [x] 昵称、价格（弹幕正文）、VIP 编号、秒级时间戳、固定免责声明全部出现在标签上。
- [x] 价格字号按 36/32/28/24 依次尝试，仍超宽时截断并加 `...`。
- [x] 昵称过长时缩小或截断；控制字符和多余空白被清理。
- [x] 时间戳默认按 `Asia/Shanghai` 格式化为 `YYYY-MM-DD HH:mm:ss`，可通过 `PRINT_TIME_ZONE` 覆盖。
- [x] `PRINT_LABEL_BORDER` 默认关闭；开启时边框画在距纸边 1 mm 处。
- [x] 输出尺寸与 `widthMm/heightMm` 一致，默认 320 × 240，不依赖 macOS 专有字体或 API。

**Verification:**

- [x] `node --test backend/test/label-layout.test.ts backend/test/label-render.test.ts`
- [x] 用 Task 9 的预览工具查看正常、长昵称、长价格、emoji、空内容五种样例。
- [x] 分别检查边框开启/关闭。
- [x] 固定输入连续渲染两次，位图字节一致。

**Dependencies:** Task 1, Task 2

**Files likely touched:**
- `backend/src/printing/layout.ts`
- `backend/src/printing/render-label.ts`
- `backend/src/printing/font.ts`
- `backend/test/label-layout.test.ts`
- `backend/test/label-render.test.ts`

**Estimated scope:** Medium

---

## Task 4：实现 Windows RAW transport

**Description:** 把 `examples/print-tspl.mjs` 里的 PowerShell/C# RAW 提交逻辑迁到 TypeScript 模块。使用 `-NoProfile -NonInteractive -EncodedCommand`，通过 stdin 传 Buffer，`TSPL_PRINTER_NAME` 环境变量传队列名，解析 stdout 的打印任务号。对队列名、空数据和进程错误做校验。

**Acceptance criteria:**

- [x] 使用 `OpenPrinterW`/`StartDocPrinterW`/`WritePrinter`，datatype 为 `RAW`。
- [x] 打印字节通过 stdin 传递，不经过命令行或临时文件。
- [x] stdout 必须是正整数任务号，否则抛错并带 stderr。
- [x] 队列名拒绝 NUL/换行；空 Buffer 被拒绝。
- [x] `windowsHide: true`。

**Verification:**

- [x] `node --test backend/test/transport-windows.test.ts`
- [x] 用注入的 fake `spawnSync` 断言参数、环境变量、stdin 字节。
- [x] 非零退出码测试失败路径。

**Dependencies:** None（可与 Task 2 并行）

**Files likely touched:**
- `backend/src/printing/transport/windows.ts`
- `backend/test/transport-windows.test.ts`

**Estimated scope:** Medium

---

## Task 5：实现 macOS RAW transport

**Description:** 把现有 `examples/print-tspl-macos.mjs` 的 `lp -o raw` 提交逻辑迁到 TypeScript。写临时文件、调用 `/usr/bin/lp`、解析本地化任务号，并支持等待任务离开队列。为测试注入 `spawnSync` 和轮询依赖。

**Acceptance criteria:**

- [x] 使用 `lp -d <queue> -o raw -n 1 -t <title> -- <file>`。
- [x] 能从中英文 `lp` 输出中解析 `<queue>-<n>`。
- [x] 支持 `wait` 与超时；超时错误包含 `lpstat`/`cancel` 提示。
- [x] 临时目录无论成功失败都被清理。

**Verification:**

- [x] `node --test backend/test/transport-macos.test.ts`
- [x] 在 macOS 上真实打印一张 40 × 30 mm 标签。
- [x] `lpstat -W not-completed -o HPRT_N31D` 无残留。

**Dependencies:** None（可与 Task 2/4 并行）

**Files likely touched:**
- `backend/src/printing/transport/macos.ts`
- `backend/test/transport-macos.test.ts`

**Estimated scope:** Medium

---

## Task 6：增加平台 transport 选择器

**Description:** `transport/index.ts` 暴露 `submitRaw(queue, data, options)`，根据 `process.platform` 调用 macOS 或 Windows 实现；其他平台给出明确错误。平台映射函数可注入以便测试。

**Acceptance criteria:**

- [x] `darwin` → macOS 实现；`win32` → Windows 实现。
- [x] 其他平台抛出不支持错误。
- [x] 不支持的平台不会静默回退到 Mock。

**Verification:**

- [x] `node --test backend/test/transport-selector.test.ts`（或并入 transport 测试）。

**Dependencies:** Task 4, Task 5

**Files likely touched:**
- `backend/src/printing/transport/index.ts`
- `backend/test/transport-selector.test.ts`

**Estimated scope:** Small

---

## Task 7：实现 SystemPrinter 并接入后端

**Description:** 在 `printer.ts` 增加 `SystemPrinter implements Printer`，构造时注入渲染器、TSPL 构建器和 transport。增加 `createPrinterFromEnv(env)`：默认 `mock`，`system` 时必须提供 `PRINT_QUEUE`，并解析标签尺寸、内边距、边框开关、时区、超时、512 字节头等配置。`index.ts` 用工厂替换 `new MockPrinter()`。

**配置项（默认值）：**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PRINT_BACKEND` | `mock` | `mock` 或 `system` |
| `PRINT_QUEUE` | 无 | Windows/macOS 队列名；`system` 时必填 |
| `PRINT_LABEL_WIDTH_MM` | `40` | 标签宽 |
| `PRINT_LABEL_HEIGHT_MM` | `30` | 标签高 |
| `PRINT_LABEL_INSET_MM` | `2` | 左右/上下对称内边距 |
| `PRINT_LABEL_BORDER` | `0` | `1` 开启边框 |
| `PRINT_TIME_ZONE` | `Asia/Shanghai` | 时间戳时区 |
| `PRINT_HPRT_HEADER_BYTES` | `512` | HPRT 头长度，Windows 可设 0 |
| `PRINT_TIMEOUT_MS` | `30000` | macOS 等待队列清空超时 |

**Acceptance criteria:**

- [x] `PRINT_BACKEND=mock` 时行为与现在一致。
- [x] `PRINT_BACKEND=system` 且队列有效时，`print(job)` 完成渲染、序列化、提交。
- [x] 缺少 `PRINT_QUEUE`、非法尺寸/超时时启动即报错。
- [x] 渲染或提交失败会向上抛出，由现有 `Listener` 标记 `failed`。
- [x] 配置项有默认值和文档。

**Verification:**

- [x] `node --test backend/test/printer-config.test.ts`
- [x] `npm test --workspace backend`
- [x] `npm run typecheck --workspace backend`
- [x] macOS 上设置 `PRINT_BACKEND=system` 启动服务，实际打一张。

**Dependencies:** Task 2, Task 3, Task 6

**Files likely touched:**
- `backend/src/printer.ts`
- `backend/src/index.ts`
- `backend/test/printer-config.test.ts`

**Estimated scope:** Medium

---

## Task 8：字体资源构建与运行时路径

**Description:** 让字体在开发（`backend/src/...`）和构建（`dist/backend/...`）两种目录结构下都能加载。新增 `backend/scripts/copy-assets.mjs`，构建时复制 `backend/assets` 到 `dist/backend/assets`；`font.ts` 按候选路径解析，找不到时给出明确错误。

**Acceptance criteria:**

- [x] `npm run build` 后 `dist/backend/assets/fonts/NotoSansSC-Regular.ttf` 存在。
- [x] 开发模式和构建模式都能注册字体。
- [x] 字体缺失时错误信息指出期望路径。

**Verification:**

- [x] `npm run build`
- [x] 用构建产物执行一次离线渲染（不打印），确认字体可用。
- [x] `git status` 确认字体和构建脚本被正确跟踪/忽略。

**Dependencies:** Task 1, Task 3

**Files likely touched:**
- `backend/scripts/copy-assets.mjs`
- `backend/package.json`
- `backend/src/printing/font.ts`

**Estimated scope:** Small

---

## Task 9：增加离线预览工具

**Description:** 新增 `backend/scripts/preview-label.ts`，用样例 `PrintJob` 渲染 PNG，覆盖正常、长昵称、长价格、emoji、空内容，以及边框开启/关闭。提供 npm script，方便不接打印机也能调布局。

**Acceptance criteria:**

- [x] 一个命令输出 320 × 240 PNG。
- [x] 支持通过参数指定输出路径、标签尺寸和边框开关。
- [x] 能输入固定时间戳，便于比对秒级时间显示。
- [x] 不依赖打印机、CUPS 或 Windows spooler。

**Verification:**

- [x] `npm run preview:label --workspace backend -- --out /tmp/label.png`
- [x] 人工查看五种样例，并核对底部免责声明原文。

**Dependencies:** Task 3

**Files likely touched:**
- `backend/scripts/preview-label.ts`
- `backend/package.json`

**Estimated scope:** Small

---

## Task 10：Windows 实机端到端验证

**Description:** 在一台装有 N31D Windows 驱动和打印队列的机器上，从命令行启动后端并连续打印。目标启动方式：

```bat
set PRINT_BACKEND=system
set PRINT_QUEUE=实际队列名
set PRINT_LABEL_WIDTH_MM=40
set PRINT_LABEL_HEIGHT_MM=30
npm ci
npm run build
npm start
```

验证 512 字节头、RAW 提交、队列名配置、纸张尺寸和横向偏移。此任务无法在 macOS 上完成，需在 Windows 机器上执行并记录结果。

**Acceptance criteria:**

- [ ] 只修改 `PRINT_QUEUE` 环境变量即可切换队列，不需要改代码或重新构建。
- [ ] Windows 队列可打印，任务在 spooler 中完成且服务状态为 `succeeded`。
- [ ] 昵称、价格、VIP 编号、秒级时间戳、免责声明均显示正常。
- [ ] 连续 10 张不卡纸、不吞任务、不重复出纸。
- [ ] 若出现空白/乱码，测试 `PRINT_HPRT_HEADER_BYTES=0` 并记录结论。
- [ ] 测量从提交到出纸的时间，确认串行队列不会超时。

**Verification:**

- [ ] Windows 上 `npm ci`
- [ ] Windows 上 `npm test`
- [ ] Windows 上 `npm run typecheck`
- [ ] Windows 上 `npm run build`
- [ ] 从 `cmd.exe` 用环境变量启动并实际打印 10 张。

**Dependencies:** Task 7, Task 8, Task 9

**Files likely touched:** 文档和配置为主；必要时调整 `transport/windows.ts`、`render-label.ts`

**Estimated scope:** Medium（需要 Windows 硬件）

---

## Task 11：更新文档与运维说明

**Description:** 在 README 增加动态标签章节：标签版式与字段、环境变量表、macOS 调试、Windows 命令行启动、字体许可证、40 × 30 mm 与 2 mm 内边距、边框开关、512 字节头排障、离线预览命令。

**Acceptance criteria:**

- [x] 环境变量表包含 `PRINT_BACKEND`、`PRINT_QUEUE`、尺寸、内边距、边框、时区、超时、头长度。
- [x] 明确 macOS 仅开发、Windows 生产，并给出 `cmd.exe` 启动示例。
- [x] 队列名尚未确定时使用占位符，并说明只改 `PRINT_QUEUE`。
- [x] 包含“打印空白/偏移”的排查顺序。
- [x] 说明 `@napi-rs/canvas` 和字体在 Windows 上的安装/复制要求。

**Verification:**

- [ ] 按文档从零配置一次 Windows 环境。
- [x] README 命令可复制执行。

**Dependencies:** Task 10

**Files likely touched:**
- `README.md`
- `backend/assets/fonts/OFL.txt`

**Estimated scope:** Small

---

## 检查点

### Checkpoint A：依赖与字体（Task 1 后）

- [x] spike PNG 中文可读。
- [x] 原生依赖和 Windows 预编译包确认。
- [x] Windows 预编译包不可用时暂停，先决定备选方案。

### Checkpoint B：共享核心（Task 2–3 后）

- [x] 位图打包、TSPL 序列化、文本布局测试全部通过。
- [x] 预览图符合“昵称/价格/VIP/时间/免责声明”版式。
- [x] 长昵称、长价格和 emoji 不崩溃。
- [x] 人工审核布局和 40 × 30 mm 可读性，并确认边框开关效果。

### Checkpoint C：传输层（Task 4–6 后）

- [x] macOS/Windows transport 单元测试通过。
- [x] macOS 实机打印一张完整标签。
- [x] Windows transport 的参数与 stdin 字节有测试覆盖。

### Checkpoint D：后端接入（Task 7–9 后）

- [x] `npm test`、`npm run typecheck`、`npm run build` 全部通过。
- [x] 默认 Mock 模式不触发真实打印。
- [x] `PRINT_BACKEND=system` 在 macOS 上端到端打印成功。
- [x] 构建产物中的字体可加载。

### Checkpoint E：Windows 与交付（Task 10–11 后）

- [ ] Windows 实机连续打印 10 张成功。
- [x] 文档完整，配置可复现。
- [ ] 无待确认的高风险项。

---

## 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `@napi-rs/canvas` 在 Windows Node 24 上没有可用预编译包 | 高 | Task 1 检查 lockfile 的 win32-x64 包；Windows 上 `npm ci` 后先跑离线渲染冒烟测试；不满足时再评估纯 JS/WASM 备选 |
| 字体文件过大（Noto Sans SC 约 10 MB） | 中 | 先随包发布；后续用 `pyftsubset` 按常用字集裁剪，保留生僻字回退策略 |
| Windows RAW 不需要 512 字节头，或需要不同头 | 中 | `PRINT_HPRT_HEADER_BYTES` 可配置；Task 10 分别测试 512/0 |
| 40 × 30 mm 标签太小，价格/昵称过长 | 中 | 价格单行自动缩小到 24 px 后省略；昵称缩小/截断；评估改用 50 × 30 或 60 × 40 标签 |
| 实机横向偏移 2–3 mm，2 mm 对称内边距仍可能裁边 | 中 | 先做标签学习和导轨校准；必要时把 `PRINT_LABEL_INSET_MM` 调到 3；边框默认关闭，减少视觉上的裁切感 |
| 昵称/价格包含控制字符或极长文本 | 低 | 清理控制字符、限制长度；单行省略；位图路径没有 TSPL 注入风险 |
| 中文断行/emoji 拆坏 | 低 | 使用 `Intl.Segmenter` 按字素切分；测试固定样例；emoji 采用字体回退 |
| macOS `lp` 输出本地化，任务号解析失败 | 低 | 按队列名锚定解析；已有测试覆盖中文输出 |
| Windows 打印完成时间不可知 | 低 | 先以 spooler 接受为准；必要时用 `Get-PrintJob` 轮询，不影响 MVP |
| `Listener` 吞掉打印异常，线上难定位 | 中 | 在 `SystemPrinter` 中记录 `eventId`/`queue` 的错误日志，再抛出；不改变任务状态语义 |
| 构建产物缺少字体 | 高 | Task 8 的复制脚本 + 构建后渲染冒烟测试；CI 加检查 |
| Windows 命令行环境变量未生效 | 低 | 文档给出 `cmd.exe` 逐条 `set` 示例；启动时打印生效配置（不打印敏感信息） |

## 并行与顺序

- Task 1 必须最先做，确认渲染依赖和字体在 Windows 上可用。
- Task 2 与 Task 4/5 可并行。
- Task 3 依赖 Task 1/2。
- Task 6 依赖 Task 4/5。
- Task 7 依赖 Task 2/3/6。
- Task 8/9 可在 Task 3 后并行。
- Task 10 必须在 Windows 实机执行，不能由 macOS 单元测试替代。

## 已确定事项

- 使用 `@napi-rs/canvas`，随包携带 Noto Sans SC。
- 动态字段：昵称、价格（弹幕正文）、VIP 编号、`YYYY-MM-DD HH:mm:ss` 时间戳；固定文字：品牌 `纸纸文创`（首行）和免责声明（底部）。
- 左右各 2 mm、上下各 2 mm，内容居中；边框可选，默认关闭。
- Windows 从命令行启动；队列名只通过 `PRINT_QUEUE` 配置。
- 默认 Mock，只有显式启用 `system` 才真实打印。

## 开放问题

1. Windows 实际队列名待驱动安装后填入 `PRINT_QUEUE`；计划中先用占位符，不阻塞实现。
2. 40 × 30 mm 是否为最终标签尺寸；如果价格/昵称经常超长，是否需要改 50 × 30 或 60 × 40。
3. 价格行是否保留“价格”二字，还是只显示数值；当前计划保留“价格”标签。
4. Windows RAW 是否需要 512 字节头，需在 Task 10 实机确认。
5. 默认时区设为 `Asia/Shanghai` 是否符合 Windows 运行环境；可通过 `PRINT_TIME_ZONE` 调整。

## 实施状态（2026-11-24）

已在 macOS 上完成 Task 1–9、11，Windows 实机项（Task 10 和 Checkpoint E 的硬件验证）留待有 N31D Windows 环境的机器执行。

已实测：

- `npm test --workspace backend` 76 项通过，覆盖位图极性、TSPL 结构、布局截断、时区、边框、渲染确定性、两个平台 transport 和配置校验。
- `npm run typecheck`、`npm run build` 通过；`dist/backend/assets/fonts/NotoSansSC-Regular.ttf` 存在，构建产物可离线渲染。
- `PRINT_BACKEND=system PRINT_QUEUE=HPRT_N31D` 在 macOS 实机打印 1 张 40 × 30 mm 标签，提交到离开 CUPS 队列约 0.7 秒，`lpstat -W not-completed` 无残留。
- 默认 mock 模式启动打印 summary，不产生真实打印；system 模式启动即校验配置。
- 320 × 240 单张渲染加 1-bit 打包约 0.6 ms，TSPL 序列化约 0.02 ms；`spike-render` 含 PNG 编码约 18 ms。
- 五种预览样例（正常、长昵称、长价格、emoji、空内容）和边框开关均已人工查看。
- 按实机反馈把底部免责声明从 14 px 放大到 20 px，墨迹高度从约 13 点增加到 19 点，改善 203 dpi 下的笔画清晰度。
- 按实机反馈调整版式为六行：新增首行固定品牌 `纸纸文创`，VIP 与昵称各占一行（昵称放大），价格基准字号从 36 px 降一档，时间行 18 px；六行在 208 点内容区内互不重叠。
- 第三轮版式调整：首行改为左侧品牌、右侧纯数字观众编号（24 px）；VIP 行移到价格下方并与价格统一为 22 px；价格阶梯随之变为 22/20/18/16 px。
- 第四轮调整：昵称基准字号从 28 px 放大到 32 px，缩小阶梯为 32/29/26/22 px，仍是标签上最大的文字。

开放问题状态：

1. Windows 队列名仍待驱动安装后填入 `PRINT_QUEUE`，代码和文档只用占位符。
2. 保留 40 × 30 mm 默认尺寸；长价格会缩到 24 px 并省略，如需更大标签可设 `PRINT_LABEL_WIDTH_MM` / `PRINT_LABEL_HEIGHT_MM`。
3. 价格行保留「价格」二字（已实现）。
4. Windows RAW 是否需要 512 字节头仍未确认，届时用 `PRINT_HPRT_HEADER_BYTES=0` 对比。
5. 默认时区 `Asia/Shanghai` 已实现，可用 `PRINT_TIME_ZONE` 覆盖；Windows 上同样使用 IANA 时区名。
