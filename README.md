# dsh-win-notify

> DSH（DeepSeek Harness）宿主端插件：任务完成 / 需要用户输入 / 需要审批时，弹出真正的 **Windows 系统 Toast**（进入通知中心、来源显示 DeepSeek Harness、黑底白鲸鱼图标）。
>
> ⚠️ **仅支持 Windows（Windows 10/11）**——通过 WinRT Toast Notification API 实现，非 Windows 系统安装后自动空转（不报错、不注册任何事件）。
>
> A DSH host plugin that raises real Windows toasts — persisting in Notification Center under "DeepSeek Harness" with the black whale icon — when a task finishes, the agent needs user input, or an approval is pending. **Windows-only (Windows 10/11).**

## 功能 Features

- 🔔 **任务完成**：用户可见根代理 running → idle 时弹出，正文优先带真实会话标题（`已完成：「<会话标题>」`）
- ✋ **需要您的输入**：`ask_user_question` 提问真正呈现给您的瞬间弹出（不是回答之后），含问题摘要与数量
- 🛡️ **需要您的审批**：Agent 请求操作审批时弹出，含工具名与原因
- 🐋 **品牌化**：来源名称 DeepSeek Harness + 黑底白鲸鱼图标（多帧 16–256px `notify.ico`，标题行小图标正确显示）
- 🧠 **噪音控制**：子代理 / AgentTeams 成员 / workflow worker 的完成、提问、审批一律不打扰；同一代理两次“任务完成”至少间隔 10 秒
- 📋 **通知中心持久**：toast 进入系统通知中心，不随横幅消失
- ⚡ **零依赖**：宿主端事件直出，重活由自编译 .NET 4 助手 EXE 完成（系统自带 csc.exe，无需安装任何运行时）

## 安装 Install

### 通过插件市场（推荐）

打开 **设置 → 插件市场**，搜索 `dsh-win-notify` 一键安装；安装后重启 `dsh web`（或点击市场的重启按钮）生效。

### 命令行安装（官方插件管理）

```bash
dsh plugin --profile web add dsh-win-notify
```

该命令会安装到 `~/.dsh/profiles/web`，并因为本包声明了 `dsh.bundle.patch`，自动把 `dsh-win-notify` 追加进 `dsh.profile.bundles`。重启 `dsh web` 生效。

> 若 pnpm ≥11 报 `minimumReleaseAge`（安全等待期），是**新发布的包**触发的策略，可一次性放行：
>
> ```bash
> dsh plugin --profile web add dsh-win-notify --config.minimumReleaseAge=0
> ```

### 开发模式（本地 link）

```bash
git clone https://github.com/kongdexu/dsh-win-notify
cd ~/.dsh/profiles/web
dsh plugin --profile web add link:D:\Project\dsh_notify
```

## 系统要求 Requirements

- **Windows 10 / 11**（x64；通知中心 + WinRT Toast 必需）
- Node.js ≥ 20（DSH 宿主环境自带）
- 无其他依赖：toast 由随包预编译的 `DshToast.exe` 发出；EXE 丢失时插件会用系统 `csc.exe`（.NET Framework 4.x，所有 Win10/11 自带）自动重建

> 非 Windows 平台（Linux/macOS）可以安装本包：`package.json` 声明了 `"os": ["win32"]`，插件在启动时检测平台并在非 Windows 上仅打印一条警告、不注册任何事件，不影响宿主。

## 文件结构 Layout

```
src/
  core.ts             # 纯逻辑：截断/平台判定/根代理判定/标题与问题摘要解析/审批摘要解析（无 ctx，可单测）
  index.ts            # 插件入口：name/inject/apply，事件接线 + helper 管理 + 平台守卫
  types/index.d.ts    # 声明文件，构建时拷入 lib/types
lib/                  # esbuild 构建产物（index.js + .dsh-notify/ 助手资产 + types），发布与加载用
  .dsh-notify/        # DshToast.cs / DshToast.exe / notify.ico / whale-black-bg.png（由 build.mjs 拷入）
.dsh-notify/          # 助手资产源（唯一真源，构建时复制进 lib/.dsh-notify）
build.mjs             # esbuild 构建 + 助手资产复制
tsconfig.json         # tsc 类型检查
vitest.config.ts      # vitest（node 环境行为测试）
test/
  core.test.ts        # 纯逻辑单测
  plugin.test.ts      # apply() 接线测试（mock ctx，不触碰真实进程/Windows API）
  smoke.mjs           # 构建产物加载契约 + 助手资产完整性断言
cordis.patch.yml      # Cordis profile patch，把插件插入 bundle 树
package.json          # 包元信息，含 dsh.bundle / os / files 字段
```

## 验证 Verify

一键跑完整校验（类型检查 → 构建 → 行为测试 → 加载契约）：

```bash
npm run check
```

- `npm run typecheck`：`tsc --noEmit` 类型检查 `src/`
- `npm run build`：esbuild 产出 `lib/`，并把 `.dsh-notify/` 助手资产复制进 `lib/.dsh-notify/`
- `npm test`：vitest 覆盖截断/平台判定/根代理过滤/摘要解析，以及 apply() 的事件接线（任务完成、输入、审批、冷却、子代理不打扰、平台守卫）
- `npm run test:smoke`：不依赖浏览器/Windows API，加载构建产物 `lib/index.js`，断言导出 `{ name, inject, apply }`、三个事件监听注册、助手资产（EXE/CS/ICO/PNG）齐备

## 实现说明 Implementation

- 事件挂接（均为 DSH 宿主既有事件）：
  - `agent/status`：running → idle 视为任务完成（仅用户可见根代理；见下「噪音控制」）
  - `tools/execute`：`ask_user_question` 弹提问的当刻发「需要您的输入」（挂 `tools/result` 会迟到——那是用户回答之后）
  - `approval/request`：待审批时发「需要您的审批」
- 噪音控制：`origin === 'subagent'`（含 `delegationDepth > 0`）的会话一律跳过；逐代理 `WeakMap` 状态机；10 秒完成冷却
- toast 图标链路：AUMID（`DeepSeekHarness.Notify`）→ 开始菜单快捷方式（`IPersistFile.Save` 必须在 `IPropertyStore.Commit` **之后**再执行一次才会把 AUMID 落盘）→ 注册表 `IconUri` → 多帧 `notify.ico`
- `DshToast.exe` 由 `DshToast.cs` 预编译并随包分发；运行期缺失时自动用 `csc.exe` 现场重建（fire-and-forget，本轮通知跳过，下一轮生效）

更多细节见 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)，变更记录见 [`CHANGELOG.md`](CHANGELOG.md)。

## 故障排查 Troubleshooting

- **安装时 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`**：新包在 pnpm 24h 安全等待期内，用上文一次性放行参数重试即可。
- **重启后无通知**：确认 `dsh.profile.bundles` 含 `dsh-win-notify`（`dsh plugin` 自动处理）；确认系统「通知和操作 → 通知」未被全局关闭；与参考项目一致，宿主插件改动需重启 `dsh web` 生效。
- **新通知标题行没有小图标**：Windows 对 toast 应用身份（图标）有缓存，注销再登录（或重启）一次即刷新；通知中心里旧通知的图标不会变，属正常现象。
- **Linux/macOS 上装了没反应**：预期行为——本插件仅支持 Windows，会在控制台打一条 `Windows-only plugin: refusing to start` 警告后空转。
- 更多细节（含历史修复过程）见 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)。

## License

MIT