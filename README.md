# 独立的 DyHub 弹幕打印服务

打印服务通过 DyHub 的 `/ws?roomId=…&types=chat` 接收弹幕。控制台关闭后，监听和打印由服务进程继续执行。

## 安装与启动

需要 Node.js 24.13 或更高版本。DyHub 的启动方式见[项目 README](../README.md)。从本目录运行以下命令。根目录的 `package-lock.json` 锁定两个 npm workspace 的依赖：`frontend/` 是 React 控制台，`backend/` 是打印 API。

```sh
npm ci
npm run dev       # 同时启动 React 开发服务器和打印 API
```

开发时打开 [React 控制台](http://127.0.0.1:5173)。Vite 将 `/api/` 转发到打印 API。前端热更新，后端改动触发重启。需要分开启动时，分别运行 `npm run dev:web` 和 `npm run dev:api`。覆盖端口时，两端使用相同的环境变量。

```sh
npm run build     # 构建后端和 React 页面
npm start         # 在同一端口提供页面和 API
```

构建产物分别写入 `dist/frontend/` 和 `dist/backend/`。生产模式打开 [打印控制台](http://127.0.0.1:8758)。

### 启动并打开页面

`npm run dev` 和 `npm start` 都只起服务，不打开浏览器。仓库根目录的两个脚本会启动服务、等待 Web 端口就绪，再用对应平台的方式打开页面：

```sh
./scripts/dev-open.sh          # macOS / Linux，开发模式
./scripts/dev-open.sh --prod   # 先构建，再以生产模式启动
```

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\dev-open.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\dev-open.ps1 -Prod
```

开发模式打开 `PRINT_WEB_PORT`（默认 5173），生产模式打开 `PRINT_PORT`（默认 8758）。脚本用 Vite 的 `/@vite/client` 判断开发服务器就绪，因此占用同一端口的其他服务不会被误认成这个项目；依赖没装（缺 `node_modules`）时会直接提示先运行 `npm ci`。Ctrl+C 停止服务，脚本退出时一并结束它启动的进程。

Windows 上如果提示执行策略限制（脚本没有数字签名），用上面的 `-ExecutionPolicy Bypass` 调用即可，或先执行一次 `Set-ExecutionPolicy -Scope Process Bypass`，再运行 `.\scripts\dev-open.ps1`。

`npm ci` 会按当前平台安装 `@napi-rs/canvas` 的原生二进制（macOS arm64 和 Windows x64 都有预编译包），标签字体随仓库分发，不依赖系统安装的中文字体。构建时 `backend/scripts/copy-assets.mjs` 会把字体复制到 `dist/backend/assets/fonts/`。

| 环境变量 | 开发默认值 | 生产默认值 |
| --- | --- | --- |
| `DYHUB_URL` | `http://127.0.0.1:8757` | `http://127.0.0.1:8757` |
| `PRINT_PORT` | `8759` | `8758` |
| `PRINT_WEB_PORT` | `5173` | — |
| `PRINT_DB` | `backend/data/viewers.dev.sqlite` | `backend/data/viewers.sqlite` |

数据库默认路径和相对的 `PRINT_DB` 均以 workspace 根目录为基准。DyHub 改端口时，设置 `DYHUB_URL` 指向对应地址。

## 使用

1. 输入数字直播间号，点击「开始监听」。每场默认不限量。关键词留空时，服务去掉弹幕中所有空白字符（包括全角空格和制表符），只匹配整条都是十进制整数或小数的弹幕。例如 `1 2 . 5` 和 `-12` 会匹配，`12 元` 和 `1e3` 不会。填写关键词后，改为匹配任一关键词子串，忽略空白和英文字母大小写；关键词用逗号或换行分隔。打印保留弹幕原文。
   监听过程中可以直接修改关键词，点击「更新关键词」立即生效，不需要断开重连。新关键词只作用于之后的弹幕；已经排队或打印的任务、剩余额度都不会变化。直播间号仍然只能在停止后更改。
2. 监听期间可设置正整数上限，或点击「清除限制」。每次设限从之后收到的弹幕重新计数。失败的打印占用额度，排队数为等待处理的任务数。
3. 点击「停止监听」后，打印服务断开订阅并继续处理已经排队的任务，处理完即可开始下一场。DyHub 管理台可以管理房间采集。
4. SQLite 按字符串 UID 保存全局观众编号，并在同一数据库的 `print_jobs` 表保存每条打印任务。服务先保存任务，再扣减额度，最后按任务 ID 顺序逐条打印。新任务的 `created_at` 记录 UTC 入库时间，升级前的任务在该字段保留 `NULL`。
5. 重启后会自动续打等待中的任务。继续接收新弹幕需要手动开始监听。每个 `PRINT_DB` 文件由一个打印服务实例使用。
6. 如果服务在打印过程中退出，该任务保留为 `printing`，启动时会提示待确认，`GET /api/status` 的 `unconfirmed` 字段也会报告数量。确认实际出纸情况后再决定是否补打，服务会跳过这类任务以免重复出纸。成功和失败的记录都保留在表中。

默认的模拟适配器（`PRINT_BACKEND=mock`）把每次打印写成一行 JSON 到终端，不驱动任何打印机。显式设置 `PRINT_BACKEND=system` 并提供 `PRINT_QUEUE` 后才会真实出纸，配置见下文「[动态标签打印](#动态标签打印)」。

控制台右侧的「打印任务」列表与左侧的监听控制台在同一页面（窄屏时自动改为上下排列），按编号从新到旧展示任务，展开弹幕可查看原文、观众、直播间和来源任务。排队中的任务可以取消，已经开始打印的任务会继续执行。已完成、失败、已取消或待确认的任务可以重新运行。每条任务最多生成一条关联的重跑记录，如需再次重跑，可对最新记录操作。手动重跑不消耗监听额度，取消也不会返还已扣除的额度。

页面与打印服务之间是短轮询：`/api/status` 每 1 秒、`/api/jobs` 每 2 秒请求一次。页面只是查看和操作入口，关闭页面不影响服务端监听与打印；服务端与 DyHub 之间才使用 WebSocket 长连接，前端没有使用 SSE 或 WebSocket。

## 动态标签打印

服务把每条匹配弹幕渲染成一张 40 × 30 mm 的动态标签。macOS 只用于开发和调试，Windows 是最终运行环境；两端发送完全相同的 TSPL 字节流，只有最后的提交方式不同。

### 标签版式

默认 40 × 30 mm、203 dpi，输出 320 × 240 点；左右上下各留 2 mm（16 点），内容区 288 × 208 点居中。

| 位置 | 内容 |
| --- | --- |
| 首行 | 左侧固定品牌 `纸纸文创`，右侧是纯数字观众编号（不带「VIP」字样） |
| 昵称行 | 昵称单独一行，32 px，是标签上最大的文字；过长先按 32/29/26/22 px 缩小，仍放不下则截断并加 `...` |
| 价格行 | `价格 <弹幕正文>`，与下面 VIP 行同号 22 px；超宽按 22/20/18/16 px 逐级缩小后截断 |
| VIP 行 | `VIP <观众编号>`，在价格下面，与价格同号 22 px |
| 时间行 | `YYYY-MM-DD HH:mm:ss`，精确到秒，约 18 px，按 `PRINT_TIME_ZONE` 格式化，默认 `Asia/Shanghai` |
| 底部 | 固定免责声明 `纸制品默认微瑕，不退不换`，20 px 小字 |

边框默认关闭；`PRINT_LABEL_BORDER=1` 时画在距纸边 1 mm 处，不挤压内容区。所有动态内容都在宿主端栅格化成 1-bit 位图，再以 TSPL `SIZE`/`BITMAP`/`PRINT` 发送；不使用 `TEXT`/`BOX`，因为 N31D 固件会忽略这些矢量指令。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PRINT_BACKEND` | `mock` | `mock` 只写终端；`system` 真实出纸 |
| `PRINT_QUEUE` | 无 | 打印机队列名；`system` 时必填 |
| `PRINT_LABEL_WIDTH_MM` | `40` | 标签宽度 |
| `PRINT_LABEL_HEIGHT_MM` | `30` | 标签高度 |
| `PRINT_LABEL_INSET_MM` | `2` | 左右、上下对称内边距 |
| `PRINT_LABEL_BORDER` | `0` | `1` 开启距纸边 1 mm 的边框 |
| `PRINT_TIME_ZONE` | `Asia/Shanghai` | 时间戳时区，填 IANA 时区名 |
| `PRINT_HPRT_HEADER_BYTES` | `512` | HPRT 前置零字节头长度；Windows 上可设 `0` |
| `PRINT_TIMEOUT_MS` | `30000` | macOS 等待任务离开队列的超时 |

DPI 固定 203。尺寸、内边距、边框、时区、头部长度或超时非法时，服务启动即报错，不会等到第一条弹幕。

### macOS 调试

```sh
npm run build
npm run preview:label --workspace backend -- --all --out /tmp/labels   # 五种样例，不接打印机
lpstat -e                                                             # 列出 CUPS 队列
PRINT_BACKEND=system PRINT_QUEUE=HPRT_N31D npm run dev
```

需要不启动服务、只打一张自检标签时，先构建，再用构建产物提交一条固定内容：

```sh
PRINT_BACKEND=system PRINT_QUEUE=HPRT_N31D node --input-type=module -e "
import { createPrinterFromEnv } from './dist/backend/printer.js';
const { printer } = createPrinterFromEnv();
await printer.print({ viewerNumber: 1, nickname: '自检', content: '12.5', roomId: '0', eventId: 'selftest', timestamp: Date.now() });
"
```

macOS 的 transport 用 `lp -d <queue> -o raw -n 1 -t <title> -- <file>` 提交临时文件，让 CUPS 跳过厂商栅格滤镜，但仍使用驱动安装好的队列和 USB 后端。提交后轮询 `lpstat -W not-completed -o <queue>`，确认任务离开队列（最多 `PRINT_TIMEOUT_MS`），无论成功失败都会清理临时文件。队列里卡住的任务可用 `cancel <任务号>` 取消。

### Windows 生产环境

要求：装好 N31D 的 Windows 驱动并创建打印队列，安装 Node.js 24.13 或更高版本。`npm ci` 会安装 `@napi-rs/canvas` 的 win32-x64 原生包，`npm run build` 会把字体复制到 `dist/backend/assets/fonts/`。从 `cmd.exe` 启动：

```bat
set PRINT_BACKEND=system
set PRINT_QUEUE=<队列名>
set PRINT_LABEL_WIDTH_MM=40
set PRINT_LABEL_HEIGHT_MM=30
npm ci
npm run build
npm start
```

队列名确定后填入 `<队列名>`；之后换队列只改 `PRINT_QUEUE`，不需要改代码或重新构建。Windows 通过 PowerShell 调用 `winspool.drv` 的 `OpenPrinterW`/`StartDocPrinterW`/`WritePrinter`（datatype 为 `RAW`），TSPL 字节通过 stdin 传入，不经过命令行，也不落临时文件。服务是命令行进程，不提供 Windows Service 或安装包。

### 打印空白或偏移怎么排查

1. 完全空白：确认 `PRINT_BACKEND=system`、`PRINT_QUEUE` 与 spooler 里的队列名完全一致；再试 `PRINT_HPRT_HEADER_BYTES=0`（部分 Windows 驱动不需要这 512 字节头）；确认热敏纸正面朝向打印头。
2. 有内容但横向偏移或被裁边：先做一次标签学习，并让纸张靠紧导轨；仍偏移时把 `PRINT_LABEL_INSET_MM` 从 `2` 调到 `3`，同时保持边框关闭。
3. 中文显示成方块、英文正常：字体资源缺失。重新执行 `npm run build`，确认 `dist/backend/assets/fonts/NotoSansSC-Regular.ttf` 存在。
4. 任务不进队列：macOS 用 `lpstat -p <queue>` 和 `lpstat -W not-completed -o <queue>` 查看；Windows 在「打印机和扫描仪」里确认队列没有暂停、缺纸或脱机。
5. 时间不对：用 `PRINT_TIME_ZONE` 指定正确的 IANA 时区。
6. 想先确认版式不进纸：用下面的离线预览，不需要打印机、CUPS 或 spooler。

### 离线预览

`renderLabel` 只依赖 Canvas，可以把样例 `PrintJob` 直接渲染成 PNG：

```sh
npm run preview:label --workspace backend -- --out /tmp/label.png
npm run preview:label --workspace backend -- --sample long-price --out /tmp/long.png
npm run preview:label --workspace backend -- --sample emoji --border --out /tmp/emoji.png
npm run preview:label --workspace backend -- --all --out /tmp/labels
npm run preview:label --workspace backend -- --time 2026-11-24T15:24:11+08:00 --out /tmp/fixed.png
```

`--sample` 可选 `normal`、`long-nickname`、`long-price`、`emoji`、`empty`；`--width`、`--height`、`--inset` 覆盖尺寸和内边距，`--time` 固定时间戳便于核对秒级显示。

### 字体与许可

标签使用随包携带的 **Noto Sans SC Regular**（`backend/assets/fonts/NotoSansSC-Regular.ttf`，版本 2.004-H2，SIL Open Font License 1.1），许可证见同目录的 `OFL.txt`。自带字体保证 macOS 与 Windows 的断行和截断位置一致，不依赖 PingFang 或微软雅黑。运行时按构建目录、源码目录和 `backend/assets/...` 依次查找字体，找不到时会列出全部候选路径。

渲染开销：Apple Silicon 上单张 320 × 240 的渲染加 1-bit 打包约 0.6 ms，TSPL 序列化约 0.02 ms；`node backend/scripts/spike-render.mjs` 会输出包含 PNG 编码的总耗时（约 18 ms）。实测从提交到任务离开 CUPS 队列约 0.7 秒。

## API

状态可通过 `GET /api/status` 读取。以下 POST 请求使用 `application/json`，成功时返回最新任务状态。

| 路径 | 请求体 |
| --- | --- |
| `/api/start` | `{"roomId":"123"}` 默认匹配纯数字；可传 `"keywords":"关键词,hello"` 启用关键词匹配 |
| `/api/keywords` | `{"keywords":"新关键词"}`。监听中更换关键词，立即对之后的弹幕生效；传空串回到纯数字匹配 |
| `/api/limit` | `{"limit":10}`。传 `null` 清除限制 |
| `/api/stop` | `{}` |

打印任务接口：

| 请求 | 用途 |
| --- | --- |
| `GET /api/jobs` | 每页返回最多 25 条任务，包含 `jobs` 和 `nextBefore`。下一页传 `?before=<nextBefore>`，直到 `nextBefore` 为 `null` |
| `POST /api/jobs/:id/cancel` | 传 `{}`，取消排队任务，返回 `200` 和 `{id}` |
| `POST /api/jobs/:id/retry` | 传 `{}`，创建关联任务并加入队尾，返回 `201` 和新任务的 `{id}` |

任务不存在时返回 `404`，当前状态不允许操作时返回 `409`。

打印适配器在 `backend/src/printer.ts` 实现 `Printer.print(job): Promise<void>`：`MockPrinter` 只写终端，`SystemPrinter` 依次完成渲染、TSPL 序列化和平台 RAW 提交。`backend/src/index.ts` 通过 `createPrinterFromEnv()` 注入。

## macOS 测试打印

安装 N31D 的 macOS 驱动后，系统会创建一个 CUPS 队列（本机为 `HPRT_N31D`）。`examples/print-tspl-macos.mjs` 用 `lp -o raw` 把 TSPL 字节直接交给该队列：CUPS 跳过驱动的栅格滤镜，但仍使用驱动安装好的队列和 USB 后端。

N31D 的固件不执行 `TEXT`、`BOX` 这类矢量指令，直接发送会得到空白标签；驱动本身也是把整页栅格化成 `BITMAP`。因此脚本自带了 5×7 点阵字体和 Code 39 编码，把标题、边框、条码和时间画进一张 1-bit 位图，再以 TSPL `BITMAP` 指令发送，并在前面补上 HPRT 驱动固定的 512 字节头。默认标签尺寸是 **40 × 30 mm**。

![40 × 30 mm 测试模板](print-tspl-macos-preview.png)

```sh
lpstat -e                                          # 列出队列
node examples/print-tspl-macos.mjs                 # 打印到 CUPS 默认队列
node examples/print-tspl-macos.mjs HPRT_N31D       # 指定队列
node examples/print-tspl-macos.mjs --width 50 --height 30
node examples/print-tspl-macos.mjs --dry-run --out /tmp/tspl-test.bin
node examples/print-tspl-macos.mjs HPRT_N31D --no-wait
```

不传队列时依次使用参数、`TSPL_PRINTER` 环境变量和 CUPS 默认队列。脚本默认等待任务离开队列（最多 30 秒，可用 `--timeout` 调整）；队列暂停时会超时并提示检查或取消任务。

模板右侧预留了约 4 mm 空白，可容忍本机实测的 2–3 mm 横向偏移。如果边框仍明显偏移或被裁切，先检查标签纸是否靠紧导轨，并执行一次标签学习；也可以把 `SIZE` 和 `--width` 调整到实际纸宽。

`examples/` 里的脚本是纯点阵模板和硬件自检工具。服务运行时的动态标签走 `backend/src/printing/`，版式和配置见上文「[动态标签打印](#动态标签打印)」。

## 验证

```sh
npm test
npm run typecheck
npm run build
node --test examples/*.test.mjs   # TSPL 模板字节、任务号解析
```

自动测试使用回环 WebSocket 和临时 SQLite，覆盖订阅过滤、观众编号、纯数字和关键词匹配、监听中更换关键词、额度重设与清除、断线重连、串行打印、失败计数、重启续打和待确认任务保留。打印相关用例覆盖 1-bit 位图极性、TSPL 头部与 `BITMAP`/`PRINT` 结构、字号缩小与截断、时区格式化、边框开关、渲染确定性、两个平台 transport 的参数与错误路径，以及环境变量配置校验。

不需要打印机即可核对版式：

```sh
npm run preview:label --workspace backend -- --all --out /tmp/labels
```

打印集成用例各自创建一个 SQLite 文件，直接查询 `viewers` 和 `print_jobs` 核对观众编号、任务内容、入队顺序及状态。默认在测试结束后删除文件。需要手动复查时，可保留数据库并从测试输出获取各用例的文件路径。

```sh
KEEP_TEST_DB=1 node --test backend/test/listener-sqlite.test.ts
sqlite3 /path/to/test.sqlite 'SELECT event_id, content, state FROM print_jobs ORDER BY id;'
```
