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

| 环境变量 | 开发默认值 | 生产默认值 |
| --- | --- | --- |
| `DYHUB_URL` | `http://127.0.0.1:8757` | `http://127.0.0.1:8757` |
| `PRINT_PORT` | `8759` | `8758` |
| `PRINT_WEB_PORT` | `5173` | — |
| `PRINT_DB` | `backend/data/viewers.dev.sqlite` | `backend/data/viewers.sqlite` |

数据库默认路径和相对的 `PRINT_DB` 均以 workspace 根目录为基准。DyHub 改端口时，设置 `DYHUB_URL` 指向对应地址。

## 使用

1. 输入数字直播间号，点击「开始监听」。每场默认不限量。关键词留空时，服务去掉弹幕中所有空白字符（包括全角空格和制表符），只匹配整条都是十进制整数或小数的弹幕。例如 `1 2 . 5` 和 `-12` 会匹配，`12 元` 和 `1e3` 不会。填写关键词后，改为匹配任一关键词子串，忽略空白和英文字母大小写；关键词用逗号或换行分隔。打印保留弹幕原文。
2. 监听期间可设置正整数上限，或点击「清除限制」。每次设限从之后收到的弹幕重新计数。失败的打印占用额度，排队数为等待处理的任务数。
3. 点击「停止监听」后，打印服务断开订阅并继续处理已经排队的任务，处理完即可开始下一场。DyHub 管理台可以管理房间采集。
4. SQLite 按字符串 UID 保存全局观众编号，并在同一数据库的 `print_jobs` 表保存每条打印任务。服务先保存任务，再扣减额度，最后按任务 ID 顺序逐条打印。新任务的 `created_at` 记录 UTC 入库时间，升级前的任务在该字段保留 `NULL`。
5. 重启后会自动续打等待中的任务。继续接收新弹幕需要手动开始监听。每个 `PRINT_DB` 文件由一个打印服务实例使用。
6. 如果服务在打印过程中退出，该任务保留为 `printing`，启动时会提示待确认，`GET /api/status` 的 `unconfirmed` 字段也会报告数量。确认实际出纸情况后再决定是否补打，服务会跳过这类任务以免重复出纸。成功和失败的记录都保留在表中。

模拟适配器将每次打印写成一行 JSON 到终端。

控制台的「打印任务」页（`/jobs`）按编号从新到旧展示任务，展开弹幕可查看原文、观众、直播间和来源任务。排队中的任务可以取消，已经开始打印的任务会继续执行。已完成、失败、已取消或待确认的任务可以重新运行。每条任务最多生成一条关联的重跑记录，如需再次重跑，可对最新记录操作。手动重跑不消耗监听额度，取消也不会返还已扣除的额度。

## API

状态可通过 `GET /api/status` 读取。以下 POST 请求使用 `application/json`，成功时返回最新任务状态。

| 路径 | 请求体 |
| --- | --- |
| `/api/start` | `{"roomId":"123"}` 默认匹配纯数字；可传 `"keywords":"关键词,hello"` 启用关键词匹配 |
| `/api/limit` | `{"limit":10}`。传 `null` 清除限制 |
| `/api/stop` | `{}` |

打印任务接口：

| 请求 | 用途 |
| --- | --- |
| `GET /api/jobs` | 每页返回最多 25 条任务，包含 `jobs` 和 `nextBefore`。下一页传 `?before=<nextBefore>`，直到 `nextBefore` 为 `null` |
| `POST /api/jobs/:id/cancel` | 传 `{}`，取消排队任务，返回 `200` 和 `{id}` |
| `POST /api/jobs/:id/retry` | 传 `{}`，创建关联任务并加入队尾，返回 `201` 和新任务的 `{id}` |

任务不存在时返回 `404`，当前状态不允许操作时返回 `409`。

打印适配器在 `backend/src/printer.ts` 实现 `Printer.print(job): Promise<void>`，在 `backend/src/index.ts` 注入。

## 验证

```sh
npm test
npm run typecheck
npm run build
```

自动测试使用回环 WebSocket 和临时 SQLite，覆盖订阅过滤、观众编号、纯数字和关键词匹配、额度重设与清除、断线重连、串行打印、失败计数、重启续打和待确认任务保留。

打印集成用例各自创建一个 SQLite 文件，直接查询 `viewers` 和 `print_jobs` 核对观众编号、任务内容、入队顺序及状态。默认在测试结束后删除文件。需要手动复查时，可保留数据库并从测试输出获取各用例的文件路径。

```sh
KEEP_TEST_DB=1 node --test backend/test/listener-sqlite.test.ts
sqlite3 /path/to/test.sqlite 'SELECT event_id, content, state FROM print_jobs ORDER BY id;'
```
