# rbxport 曲库 Agent 产品开发方案

状态：首版已实现并生成 Windows x64 安装包

## 1. 产品目标

在 rbxport 主窗口加入可收起的曲库 Agent。DJ 在浏览曲库时可以用自然语言询问当前界面、查找曲目、打开歌单，或直接要求创建歌单、添加曲目和修改元数据。

首版只交付 **Windows x64**，采用 **DeepSeek Harness（dsh）作为本地 Agent 运行时**。产品提供 OpenAI 的 GPT 模型和 DeepSeek 模型两种接入，均使用官方 Responses API。本次开发、测试和真实联调使用 DeepSeek，GPT 接入不列入测试与验收。曲库、歌单树和播放器沿用现有界面，新增右下角悬浮窗作为唯一 Agent 入口。

rbxport 启动随应用分发的 dsh 子进程，由 dsh 用用户配置的 API Key 请求模型、维护会话和调度工具。dsh 内加载 rbxport 曲库工具插件，界面状态、查询和编辑通过本地桥接回到 rbxport。用户只需打开 rbxport。运行时无需部署 Agent 服务、MCP 服务或本地模型。

首版聚焦曲库浏览和下文列出的编辑操作。删除、音频分析、USB 导出和设备控制留待后续评估。

## 2. 用户流程

### 首次配置

1. 点击主界面右下角的「曲库 Agent」，打开浮在曲库上的面板。面板打开时仍可操作曲库，收起后保留本次会话。
2. 选择「GPT（OpenAI）」或「DeepSeek」。应用预设相应的官方 API 地址。用户填写模型 ID 和 API Key。
3. 点击「测试连接」。rbxport 自动启动 dsh，由 dsh 用所选供应商和模型发送简短的模型请求。面板显示连接成功、密钥无效、模型不可用、额度受限或网络错误等结果。首次发送消息也可启动运行时。
4. 服务商和模型 ID 随应用偏好保存。用户填入 API Key 后，桌面进程按供应商自动保存到当前 Windows 用户的凭据管理器。重启后可继续使用。启动 dsh 时仅向其子进程环境传入当前会话所需的供应商密钥。
5. 悬浮窗显示正在查询、正在执行、完成、取消和失败等状态。收起面板可继续使用曲库。若 dsh 意外退出，面板提示重新启动，已经执行的写入可用原应用的编辑历史撤销。

### 历史对话

- 悬浮窗顶部提供「历史对话」入口，支持新建、切换和删除。标题取自第一条用户消息，按最近使用排序。重启后默认恢复上次聊天，打开任意历史对话都可以继续聊。
- 每条对话绑定创建时的供应商和模型。修改默认供应商或模型只影响新对话。续聊时使用该会话绑定的模型和供应商当前保存的密钥。
- 全应用同一时间只运行一条 Agent 请求。任务运行期间可以查看其他历史对话。要发新请求，等当前任务结束或主动停止。
- 删除对话时移除本机的该条记录和续聊上下文。已经完成的曲库编辑仍可通过 rbxport 的「编辑 → 撤销」回退。

### 查询与导航

- 「我现在选中了哪些歌？」读取当前界面状态，按选中的曲目回答。
- 「全库里有哪些 125 BPM 的曲目？」搜索整个曲库，显示歌名、艺人、BPM 和调性。结果超出一页时可继续查询。
- 「打开 Warmup，再告诉我里面有哪些歌。」先定位并打开指定歌单，再读取歌单内容。找不到目标时提示用户。同名时列出所属文件夹，请用户选定目标。

### 曲库编辑

- 「新建 Warmup，把选中的歌加进去。」找到明确的曲目和歌单目标后直接执行，完成时回复实际添加数量。写入流程省去变更预览和二次确认。
- 「把所有 125 BPM 的歌加进 Warmup。」rbxport 在本机找出全部匹配曲目，沿用现有 BPM 档位和歌单去重规则，完成后返回实际添加数量。
- 「把这两首的 Genre 改成 House。」直接调用现有字段编辑接口，列表显示新值。用户可以用 rbxport 的「编辑 → 撤销」回退。
- 产品 Agent 的系统指令规定，用户明确要求修改时直接执行，用户只询问建议时只给建议，目标有歧义时请用户指明。曲库和界面操作一律由 rbxport 的工具执行。

## 3. 首批工具

下文的「现有」指仓库已经提供的函数或 IPC。标为「拟新增」的名称是本方案约定的接口。每张表按执行顺序列出模型入参、本地步骤及最终返回给模型的数据。

### 3.1 通用调用约定

- 模型返回 Responses `function_call` 后，dsh 解析工具名、参数和调用 ID，并执行插件内注册的工具。插件通过本地桥接向 rbxport 发送 `{requestId, tool, arguments}`。rbxport 按下表第一步校验参数并执行其余步骤，再返回 `{requestId, result}`。桥接的 `requestId` 用于匹配本地请求，模型协议的 `call_id` 由 dsh 管理。
- 插件将 rbxport 的工具结果转成 dsh 工具输出，由 dsh 按原 `call_id` 发送 `function_call_output` 并继续模型交互。
- 成功结果统一为 `{ok: true, data: ...}`。失败结果统一为 `{ok: false, error: {code, message}}`，例如参数无效 `invalid_arguments`、目标不存在 `not_found`、用户取消 `cancelled`。失败步骤结束当前工具调用。
- 曲目、歌单和文件夹 ID 使用字符串。模型从此前的工具结果取得 ID。同名目标由用户选定后再继续。下表中的 `?` 表示可省略，`null` 表示当前没有该值。
- Agent 的写入工具处理用户明确要求的编辑，校验参数和目标后调用 rbxport 的现有编辑流程。该流程已经发送 `library:changed(generation)`，主界面已有监听逻辑会自动重新读取数据。

### 3.2 `get_ui_context` 读取当前界面

| 顺序 | 调用 | 输入 | 输出 |
| --- | --- | --- | --- |
| 1 | Agent 调度器 | `{}` | 请求读取当前窗口状态。 |
| 2 | 拟新增 AppBody 状态读取回调 | 无 | 主浏览器当前来源和歌单、`query`、`searchField`、`spec.filter`，以及选中曲目。沿用现有选中项回调，返回选区来源和曲目标题。 |
| 3 | 应用筛选并返回 | 步骤 2 的状态 | `{source: {kind, name, playlistId}, query, searchField, filters, selection: {pane, tracks: [{id, title}]}}`。没有选中项时 `tracks` 为空。外部设备或文件浏览来源保留类型和名称，省略路径及外部曲目 ID。 |

该工具在 React 层完成。选区标明来自主表还是副表。搜索词和生效筛选描述主浏览器，滚动后可见的表格行暂不纳入。

### 3.3 `search_tracks` 查询曲库

| 顺序 | 调用 | 输入 | 输出 |
| --- | --- | --- | --- |
| 1 | Agent 调度器 | `{query?, bpm?, playlistId?, offset?, limit?}`。无歌单 ID 时搜索全库，省略关键词时保留全部匹配项。 | 经校验的来源、关键词和分页参数。默认从第 0 条起取 20 条，每页最多 50 条。 |
| 2 | 拟新增 `backend.searchLibraryTracks(request)` → Tauri `search_library_tracks` | `{source, query, bpm, offset, limit}` | Rust 验证指定歌单，复用 `rbl-index` 的搜索和筛选生成临时视图，直接从视图取当前页，返回 `{total, rows}`。歌单失效时返回错误。 |
| 3 | 应用转换并返回 | `{total, rows}` 和分页参数 | `{total, offset, nextOffset, tracks: [{id, title, artist, bpm, key, genre, durationSec}]}`。到末页时 `nextOffset` 为 `null`。 |

首版的 `bpm` 为整数，按现有筛选栏的整 BPM 档位匹配。结果中的 BPM 从内部 `bpmX100` 转回常用单位。查询使用独立的临时索引视图，现有界面继续使用自己的 `open_view` 和 `fetch_rows` 句柄。

### 3.4 `list_playlists` 查找歌单和文件夹

| 顺序 | 调用 | 输入 | 输出 |
| --- | --- | --- | --- |
| 1 | Agent 调度器 | `{query?}`，可按名称查找。 | 可选名称搜索词。 |
| 2 | 现有 `backend.playlistTree()` → Tauri `playlist_tree` | 无 | `TreeNode[]`，包含 ID、名称、类型和层级。 |
| 3 | 应用整理并返回 | 步骤 2 的歌单树和名称搜索词 | `{items: [{id, name, kind, parentFolderId, folderPath}]}`。保留普通歌单、智能歌单和用户文件夹，再按名称筛选。根据树层级得到完整父文件夹路径，顶层的 `parentFolderId` 为 `null`。 |

### 3.5 `get_track_details` 查询单曲详情

| 顺序 | 调用 | 输入 | 输出 |
| --- | --- | --- | --- |
| 1 | Agent 调度器 | `{trackId}` | 曲目 ID。 |
| 2 | 现有 `backend.trackDetails(trackId)` → Tauri `track_details` | IPC 参数为 `{track: trackId}`。 | `TrackDetails`，曲目不存在时返回错误。 |
| 3 | 应用筛选并返回 | `TrackDetails` | `{id, title, artist, album, genre, label, bpm, key, durationSec, rating, year}`。将 `bpmX100` 转成常用单位，本机文件路径只在应用内部可见。 |

### 3.6 `open_playlist` 切换界面

| 顺序 | 调用 | 输入 | 输出 |
| --- | --- | --- | --- |
| 1 | Agent 调度器 | `{playlistId}` | 普通或智能歌单 ID。 |
| 2 | 拟新增 AppBody 导航回调，复用现有 `openShortcut` 的树查找和 `setSelectedNode` 的切换逻辑 | `playlistId` 和当前界面歌单树 | 命中的歌单节点。找到后更新主浏览器的选中节点。当前树中找不到该歌单时返回错误。 |
| 3 | 应用核对页面切换并返回 | React 已提交的选中节点 | `{id, name, kind}`。返回前核对实际选中的歌单 ID。 |

界面切换之后，现有主浏览器自行调用 `backend.openView(spec)` → `open_view` 获得视图句柄，再按滚动位置调用 `backend.fetchRows(viewId, offset, len)` → `fetch_rows` 渲染曲目。模型需要歌单内容时继续调用 `search_tracks({playlistId})`。

### 3.7 `create_playlist` 创建普通歌单

| 顺序 | 调用 | 输入 | 输出 |
| --- | --- | --- | --- |
| 1 | Agent 调度器 | `{name, parentFolderId?}` | 校验后的歌单名和父目录 ID。省略父目录时使用现有 `TREE_ROOT`（`root`）。 |
| 2 | 现有 `playlistTree()` | 父目录 ID | 核对父目录是有效的普通文件夹或顶层。 |
| 3 | 拟新增 `backend.edits.createPlaylistWithId(name, parent)` → Tauri `create_playlist_with_id` | `{name, parent}`，在该目录末尾创建。 | Rust 复用现有 `create_with_undo` 写入流程，返回 `{playlistId, generation}`。原有 `create_playlist` 调用方继续收到数字版本号。 |
| 4 | 应用汇总并返回 | 实际创建的 ID、名称和父目录 | `{playlistId, name, parentFolderId}`。后续添加曲目使用这里返回的 ID。 |

### 3.8 `add_tracks_to_playlist` 添加曲目

| 顺序 | 调用 | 输入 | 输出 |
| --- | --- | --- | --- |
| 1 | Agent 调度器 | `{playlistId, trackIds}` 或 `{playlistId, match: {query?, bpm?, sourcePlaylistId?}}`，二选一。 | 目标歌单与去重后的曲目 ID 列表，或目标歌单与查询条件。 |
| 2 | 现有 `playlistTree()`；按模式解析曲目 | 目标歌单 ID、曲目 ID 列表或 `match` 条件。 | 核对目标为普通歌单。显式 ID 走现有曲库校验。按条件添加时，由拟新增的本地批量入口复用 `search_tracks` 的索引搜索与 BPM 匹配，取得全部匹配曲目 ID。省略 `sourcePlaylistId` 时搜索全库。 |
| 3 | 现有歌单写入流程 | `{playlist: playlistId, tracks: trackIds, allowDuplicates: false}`。按条件添加时，曲目 ID 留在本地，从查询直接传到写入。 | `{generation, added}`。底层跳过已经在歌单中的曲目。 |
| 4 | 应用汇总并返回 | 实际写入结果和待添加曲目数 | `{playlistId, requestedCount, added}`。按条件添加时，`requestedCount` 为全量匹配数。模型据 `added` 报告实际添加数。 |

按条件添加的写入范围覆盖全部匹配项。查询工具的分页和单页上限仅用于浏览结果。曲目 ID 由 rbxport 一次性在本机解析，模型无需循环读取结果页。

### 3.9 `update_track_field` 编辑曲目字段

| 顺序 | 调用 | 输入 | 输出 |
| --- | --- | --- | --- |
| 1 | Agent 调度器 | `{trackIds, field, value}`。字段为 `title`、`artist`、`genre` 或 `label`。 | 校验后的曲目 ID 列表、字段和字符串新值。标题每次只允许修改一首，其余三个字段可批量修改。 |
| 2 | 现有 `trackDetails(trackId)` | 曲目 ID 列表 | 核对曲目仍在曲库中。 |
| 3 | 现有 `backend.edits.setTrackField(trackIds, field, value)` → Tauri `set_track_field` | `{tracks: trackIds, field, value, writeKeyTag: false}` | `EditHistoryState`，含曲库版本和撤销、重做状态。 |
| 4 | 应用汇总并返回 | 写入结果 | `{trackIds, field, value, canUndo}`，只有写入调用成功才返回。 |

### 3.10 组合示例

以「新建 Warmup，把我选中的歌加进去」为例，每次工具执行就是一次独立的 Responses 函数调用。

1. `get_ui_context({})` 返回当前选区，例如曲目 ID `["101", "102"]`。没有选中项时先请用户选曲。
2. `create_playlist({name: "Warmup"})` 执行后返回新歌单 ID，例如 `"450"`。
3. `add_tracks_to_playlist({playlistId: "450", trackIds: ["101", "102"]})` 使用工具返回的 ID 执行并返回实际添加数量。
4. 模型根据实际执行结果回答。用户可通过「编辑 → 撤销」按应用既有顺序回退。

[现有 TypeScript IPC 映射](src/ipc/client.ts) · [接口类型](src/ipc/types.ts) · [主界面状态](src/app/App.tsx) · [Rust 曲库命令](src-tauri/src/commands.rs) · [Rust 曲目详情与编辑](src-tauri/src/details.rs)

## 4. 技术实现

| 模块 | 技术与复用点 |
| --- | --- |
| 悬浮窗 | React 19、TypeScript、CSS Modules、Vite。复用主界面主题和翻译流程。 |
| Agent 运行时 | 固定版本的 DeepSeek Harness。首版从 SDK profile 起步，用项目自有 profile 配置挂载曲库插件，复用 dsh 的会话、模型请求、工具循环和运行事件。模型可用工具限定为第 3 节的 8 项。 |
| 曲库工具插件 | TypeScript + dsh 的 `defineTool` / `ctx.tools.register`。插件注册工具的输入与输出约定并转发调用。ID、歌单类型、字段和分页的业务检查由 rbxport 执行。 |
| 进程与会话桥接 | Tauri 2 + Rust 启停 dsh。通过 SDK 的 stdio JSON-RPC 发送会话命令、接收进度和结果，再用 Tauri IPC 与 React 悬浮窗通信。 |
| 工具回调桥接 | dsh 插件通过 Windows 命名管道调用 rbxport。每次启动分配独立连接地址和会话令牌，按请求 ID 匹配回包，只接收固定工具名和结构化参数。 |
| 模型配置 | 在 dsh profile 分别配置 GPT 与 DeepSeek 的 Responses 路由，显式选择 `openai-responses` 与官方地址，使用凭据环境变量引用。Rust 负责进程和 IPC，dsh 负责模型协议和续接。 |
| 历史会话 | dsh 在本机保存续聊所需的会话状态，rbxport 维护会话 ID、标题、模型、更新时间和最近打开的会话，并提供悬浮窗的历史消息。选择会话时使用 dsh SDK 的 `session/resume` 恢复对应上下文。 |
| 界面上下文 | 从 `AppBody` 读取浏览来源、搜索条件和选中曲目。 |
| 曲库读取 | 复用 `playlistTree`、`trackDetails` 和 `rbl-index`。新增窄范围分页查询 IPC，直接从已有索引取页，避免占用界面虚拟表格的视图句柄。 |
| 曲库写入 | 复用现有编辑、撤销记录和更新事件。创建歌单从同一写入流程返回新 ID，保留当前界面调用方依赖的返回契约。 |

### 进程生命周期与 Responses 协议

rbxport 第一次测试连接或发消息时启动 dsh，收到 SDK 就绪消息后创建或恢复会话。悬浮窗收起时保留会话，退出 rbxport 时保存会话状态、关闭 SDK 连接并回收子进程。SDK 输入输出与工具回调走各自的本地连接，无需监听 HTTP 端口。

两家供应商共用曲库插件。首项技术验证用固定版本的 dsh 调用 DeepSeek 官方 Responses 端点，检查多轮工具回传、无状态历史回放和推理项处理。若需要处理协议差异，补在 dsh 的供应商适配器层。GPT 保留官方 Responses 路由，产品代码照常提供该入口。

每一轮的执行顺序如下：

1. 悬浮窗将用户问题经 Tauri 和 SDK 交给 dsh。dsh 向当前供应商发送对话和已注册的曲库工具。
2. dsh 将工具请求交给插件。插件通过本地桥接回调 rbxport。查询和导航调用对应能力，写入在校验通过后逐项执行。
3. 插件把应用返回的结果交给 dsh，dsh 回传给模型并继续运行。悬浮窗接收 dsh 的进度和最终回答。
4. 同一时间只运行一条用户请求。每条请求最多发起 8 次模型请求，计入自动重试。先验证固定版本的 dsh 配置或钩子能执行该上限。达到上限、超时或取消时结束本次运行并显示状态。

### 打包与配置

- 通过 npm 获取 DeepSeek 官方发布的 `@deepseek-ai/dsh`。`agent/dsh/` 使用独立的 `package.json` 和依赖锁文件，固定验证过的 dsh 版本及插件依赖。CI 在该目录执行锁文件安装。dsh 上游源码和生成的依赖目录由各自的发布和构建流程管理。
- Windows x64 验证从 npm 包入口启动指定 SDK profile，确认官方包、匹配的 Node 运行时和插件能正常加载。发布时通过 Tauri sidecar 和资源打包提供这些组件，用户无需单独安装 Node.js 或运行 dsh 命令。
- 为 rbxport 的 dsh 进程设置当前 Windows 用户专用的持久 `DSH_HOME`。本地历史随应用重启保留。产品密钥存入 Windows 凭据管理器，经子进程环境提供给 dsh。开发使用 Git 忽略的项目本地 `.env.deepseek.local` 中的 `DEEPSEEK_API_KEY`。开发密钥文件不进入安装包。
- 使用仅含曲库能力的 profile，验证发给模型的函数清单。命令行、通用文件操作和第三方插件的入口不纳入此 profile。固定版本升级前重跑 SDK 协议、凭据和曲库工具回归。

#### Windows 开发与安装流程

| 场景 | 顺序 |
| --- | --- |
| 开发调试 | 安装 rbxport 的依赖；运行拟新增的 dsh 准备脚本，从独立锁文件安装 dsh 并准备本机运行时资源；执行现有 `pnpm dev`，在 Tauri 窗口配置模型后测试 Agent。使用临时曲库时在 PowerShell 先设置 `$env:RB_LITE_TEST = '1'`。 |
| 生成安装包 | 在现有 installer workflow 的 Tauri 打包步骤前运行准备脚本，按目标架构生成 Node sidecar。NSIS 通过 Agent 安装钩子把 dsh、专用 profile、工具插件和授权文件作为一个目录打包。沿用现有 Tauri NSIS 流程生成 `rbxport-…-setup.exe`。本地无更新签名密钥时，使用本地打包配置关闭 updater artifact 生成。 |
| 用户安装和启动 | 运行一个 `setup.exe`，从开始菜单启动 rbxport，打开「曲库 Agent」并填入 API Key。首次测试连接或发送消息时，Tauri 从安装目录解析运行时和资源路径，在后台启动 dsh SDK profile。收到就绪消息后开始会话。退出应用时关闭 dsh。 |

安装包验收在没有 Node.js、npm 或 dsh 的干净 Windows x64 环境进行。测试安装目录含空格、首次启动、重启续聊、DeepSeek 工具回调和批量添加。浏览器预览用于悬浮窗与模拟工具测试，原生 dsh 进程由桌面版验证。

[现有安装包工作流](.github/workflows/build-installer.yml) · [现有 Windows 安装包产物配置](.github/actions/package-installer/action.yml)

#### rbxAgent 发版与升级

1. 在 `dev` 上用 `node scripts/sync-version.mjs --version X.Y.Z` 递增应用版本，更新 `release-notes.json`，提交并推送。
2. 在 GitHub Actions 中运行 [rbxAgent Windows 发布流水线](.github/workflows/rbxagent-release.yml)，选择 `dev`。首次可从同一提交推送 `vX.Y.Z` 标签触发。流水线在 GitHub 托管的 Windows x64 Runner 上检查并构建带 dsh 的签名安装包。
3. 构建通过后，流水线将 `main` 快进到构建提交，在 [rbxAgent Releases](https://github.com/wuyue7508688/rbxAgent/releases) 发布 `setup.exe`、`.sig` 与 `latest.json`。签名私钥及密码由 GitHub Actions Secrets 提供，客户端使用项目配置中的公钥验签。
4. 已安装上游版或本地预览版的用户手动覆盖安装一次。使用 rbxAgent 渠道后，应用启动时检查新版本，后台下载并在应用退出时安装。

### 模块隔离与上游同步

| 拟新增位置 | 放什么 |
| --- | --- |
| `agent/dsh/` | dsh 精确版本、独立依赖锁文件、专用 profile、曲库工具插件、运行时准备脚本。dsh 的安装和升级集中在这里。 |
| `src-tauri/src/agent/` | rbxport 的子进程管理、SDK 通信、工具回调桥接和 Agent 专用 IPC 命令。 |
| `src/views/agent/` | 悬浮窗、配置、桌面会话状态、读取界面所需的入口类型和本地工具分发。 |

上游文件只接必要入口。主界面挂载悬浮窗并提供当前界面状态与导航回调。Tauri 入口注册 Agent 命令。安装包加入 sidecar 和资源。新增的曲库查询和带 ID 的创建命令优先放进 Agent 模块，调用现有曲库服务和编辑流程。上游改动最可能重叠的是主界面挂载处、IPC 命令注册和打包配置。

分别提交 dsh 依赖与插件、rbxport 接入、安装包接入，便于同步时定位改动。同步时先从 `upstream` 获取最新默认分支，在集成分支试合并，核对共享入口并运行曲库和安装包回归。即使 Git 自动合并，上游调整了界面状态或曲库接口，也要用 Agent 工具用例验证行为。升级 dsh 通过独立依赖锁文件单独提交。

### 数据范围与写入边界

- 模型请求发送用户输入和工具返回的必要元数据。发往模型的曲库数据按字段白名单投影，音频、数据库文件、本机绝对路径和设备路径留在本机。
- API Key 从密码输入控件交给桌面进程，并通过 dsh 子进程专用环境传入，最终用于供应商的鉴权头。日志、会话消息、工具结果和错误提示均省略密钥。
- 写入工具校验模型传入的目标和参数，并回传原有编辑流程的返回结果或错误。
- 界面更新完全复用现有事件和监听。新增的创建命令走相同编辑流程，因此新歌单会自动出现在左侧歌单树。成功写入进入现有编辑历史，可通过「编辑 → 撤销」按顺序回退。
- 自动重试模型请求时避免重复执行已经完成的写入。

## 5. 开发里程碑

| 阶段 | 开发内容 | 阶段验收 |
| --- | --- | --- |
| 1. dsh 接入验证 | 固定版本，从 rbxport 启动 SDK profile，挂载一个曲库测试工具。验证 stdio、私有工具回调桥接、运行上限和 DeepSeek Responses。 | Windows 上子进程可启停。DeepSeek 完成真实工具往返并根据工具结果作答。检查凭据传递和工具清单。 |
| 2. 悬浮窗与查询闭环 | 接入两家供应商配置、密钥自动保存、查询和导航工具，完成聊天列表和跨重启续聊。 | 用 DeepSeek 验证连续工具调用、同名歌单、界面切换、历史恢复和并发规则。 |
| 3. 曲库写入 | 接入创建歌单、按 ID 或条件添加曲目、编辑字段，复用编辑历史和更新事件。 | 在临时曲库验证新歌单自动出现、按条件添加跨页全部匹配项、准确计数和撤销。 |
| 4. 安装包与回归 | 将固定版本的 dsh、运行时依赖和插件放进 Windows x64 安装包。 | 在干净环境安装后打开悬浮窗并首次启动 dsh。用 DeepSeek 跑工具调用、批量添加和重启续聊，关闭后检查进程回收。 |

## 6. 验收标准

| 场景 | 通过条件 | 验证层 |
| --- | --- | --- |
| 悬浮窗与配置 | 可用鼠标和键盘打开、输入、收起和恢复。填写 DeepSeek 密钥后自动保存，重启后可继续使用。 | Playwright、桌面联调 |
| 历史对话 | 支持新建、切换和删除。重启后默认打开上次聊天并能继续理解原上下文。对话保存自身模型配置。运行期间可查阅其他历史，同一时间只有一条请求执行。删除历史移除本地记录及上下文，并保留已完成的曲库编辑。 | 应用测试、桌面联调 |
| dsh 启停与打包 | 用户只启动 rbxport。首次使用 Agent 自动启动 dsh，退出应用时子进程回收。异常退出会显式提示，重启后可发起新请求。 | 安装包、桌面联调 |
| DeepSeek Responses API | 完成「模型请求函数 → 本地执行 → 按调用 ID 回传 → 模型据结果回答」。覆盖多轮续接和并列工具调用。 | DeepSeek 官方端点、协议测试、本地模拟 HTTP 服务 |
| 读取当前界面 | 切换歌单、筛选或选中项后，下一次查询返回最新状态。空选中状态返回空结果。 | Vitest、Playwright |
| 查询与导航 | 全库和指定歌单作用域正确，BPM 与页面显示一致，分页结果完整。同名歌单可选，打开后应用切到实际目标。 | Rust 曲库测试、Playwright |
| 曲库写入 | 明确要求修改时直接执行，咨询建议时只回答建议。新歌单和曲目列表通过现有机制自动更新。按条件添加覆盖全部匹配项，跳过重复并返回实际数量。写入可用现有菜单撤销。 | Vitest、临时曲库、桌面联调 |
| 错误与数据 | 密钥错误、模型不可用、超时或参数无效时显示对应状态。模拟服务检查 HTTP 请求里密钥仅出现在鉴权头、模型工具限于曲库清单。检查落盘配置和日志无密钥，工具结果符合数据范围。 | dsh 集成测试、模拟 Responses 服务、Vitest |
| 项目回归 | 类型检查、前端 lint、已有相关测试和新增端到端场景通过。 | TypeScript、ESLint、Vitest、Playwright、Cargo |

浏览器模拟曲库用于界面和工具联调。原生传输、存储生命周期和实际编辑另用桌面应用加临时曲库验证。Windows 桌面验收环境需准备 Rust、MSVC、Windows SDK、WebView2 和 Perl。

本次执行按用户要求省去端到端测试，保留代码检查、单元测试和安装包构建。

前端包体在 Windows x64、Node.js 24.19.0 上用生产 Vite 构建及项目的 `check-bundle-size.ts` 脚本测量。接入前为 338.2 KB gzip，加入 Agent 后为 346.1 KB gzip。总代码上限调整至 350 KB，首块上限保持 150 KB。

## 7. 参考

- [rbxport 架构与 IPC](docs/development/architecture.md)
- [rbxport 接口定义](src/ipc/types.ts)
- [rbxport 开发环境](docs/development/getting-started.md)
- [DeepSeek Harness 官方仓库与预览状态](https://github.com/deepseek-ai/deepseek-harness)
- [dsh SDK profile 与架构](https://deepseek-harness.github.io/deepseek-harness/en/reference/)
- [dsh SDK 会话恢复协议](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md)
- [dsh 工具插件](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-tool)
- [dsh 模型配置与 Responses 路由](https://deepseek-harness.github.io/deepseek-harness/en/guide/providers)
- [Tauri sidecar 打包](https://v2.tauri.app/develop/sidecar/)
- [OpenAI Responses API 迁移指南](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [OpenAI 函数调用](https://developers.openai.com/api/docs/guides/function-calling)
- [DeepSeek Responses API](https://api-docs.deepseek.com/guides/responses_api/)
