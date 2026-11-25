# 动态标签打印任务清单

完整设计、验收细节和风险见 [plan.md](plan.md)。

## 阶段 1：依赖与字体

- [x] Task 1：安装并验证 `@napi-rs/canvas` + Noto Sans SC（已批准，先做）

## Checkpoint A：依赖与字体

- [x] 320 × 240 中文 PNG 可读
- [x] Windows 预编译包已确认
- [x] 记录单次渲染耗时

## 阶段 2：共享核心

- [x] Task 2：实现 1-bit 位图打包与 TSPL `BITMAP` 序列化
- [x] Task 3：实现昵称/价格/VIP/时间戳/免责声明的动态标签渲染
- [x] Task 3：左右各 2 mm、上下各 2 mm，内容居中；边框默认关闭、可开启
- [x] Task 3：时间戳按 `Asia/Shanghai` 输出 `YYYY-MM-DD HH:mm:ss`
- [x] Task 3：底部固定输出 `纸制品默认微瑕，不退不换`

## Checkpoint B：共享核心

- [x] 位图、TSPL、布局测试全部通过
- [x] 预览图符合固定版式
- [x] 长昵称/长价格/emoji 不崩溃
- [x] 边框开启和关闭都检查过
- [x] 人工审核 40 × 30 mm 可读性

## 阶段 3：平台传输

- [x] Task 4：实现 Windows PowerShell `winspool` RAW transport
- [x] Task 5：实现 macOS `lp -o raw` transport
- [x] Task 6：增加平台 transport 选择器

## Checkpoint C：传输层

- [x] macOS/Windows transport 单元测试通过
- [x] macOS 实机打印一张完整 40 × 30 mm 标签
- [x] Windows 参数和 stdin 字节有测试覆盖

## 阶段 4：后端接入

- [x] Task 7：实现 `SystemPrinter`，默认 Mock，`PRINT_BACKEND=system` 才真实打印
- [x] Task 7：配置 `PRINT_QUEUE`、尺寸、2 mm 内边距、边框、时区、512 字节头
- [x] Task 8：字体资源构建复制与运行时路径
- [x] Task 9：离线 PNG 预览工具

## Checkpoint D：后端接入

- [x] 默认 Mock 模式不触发真实打印
- [x] `PRINT_BACKEND=system` 在 macOS 上端到端成功
- [x] 只改 `PRINT_QUEUE` 就能切换队列
- [x] `npm test --workspace backend`、`npm run typecheck`、`npm run build` 全部通过
- [x] 构建产物字体可加载

## 阶段 5：Windows 与交付

- [ ] Task 10：Windows 从命令行启动并连续打印 10 张
- [ ] Task 10：确认 512 字节头在 Windows 上是否需要
- [ ] Task 10：确认 40 × 30 mm、2 mm 内边距和实际偏移
- [x] Task 11：更新 README、环境变量、`cmd.exe` 启动和排障文档

## Checkpoint E：完成

- [ ] Windows 实机验证通过
- [ ] 所有测试、类型检查、构建通过
- [ ] 开放问题已有明确结论
- [ ] 人工审核计划中的风险项
