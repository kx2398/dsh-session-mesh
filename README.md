# dsh-session-mesh · 会话网格

> 让 DeepSeek Harness（dsh）里**所有工作区**的普通会话互相发现、互相发消息、互相建会话/改标题/归档的 Host 插件。无任务板、无新增会话事件、不依赖 `experimental-agent-team` 或 subagent。
>
> **English**: a DeepSeek Harness (dsh) host plugin that turns every root session in every workspace into a peer: list sessions, message any session as a real `agent-message`, create/rename/archive/cancel sessions, and wait for session changes. No task board, no new session event types.

- License: MIT
- 要求：DSH `>=0.2.1-rc.3 <0.3.0`（`engines.dsh`）；desktop / web-app 这类包含标准 Host 服务的 profile
- 零运行时依赖、无构建步骤、纯 ESM
- 7 个 `mesh_*` 工具 + 两段模型可见提示（policy / identity）
- 分发方式：GitHub tag / Release tarball（**不发布到 npm**）

---

## 1. 安装

```text
# 从 GitHub 按 tag 安装
plugin_manager install_bundle  target = github:kx2398/dsh-session-mesh#v0.2.1

# 或下载 Release 里的 tgz 后本地安装
plugin_manager install_bundle  target = file:C:/.../dsh-session-mesh-0.2.1.tgz
```

## 2. 它做什么

| 工具 | 能力 |
|---|---|
| `mesh_list_sessions` | 列出**所有工作区**的会话：sessionId、标题、所属工作区（id/title/path）、cwd、running、archived、agent 可用性、是否 subagent、更新时间。支持工作区/运行态/归档/subagent/ID或标题子串过滤 + 游标分页（`nextCursor`） |
| `mesh_send_message` | 给**任意会话**发一条自包含消息，**以真实 `agent-message/relay` 消息投递**（source 带 `senderSessionId`，不伪装成人类消息）。运行中目标 `queue`（回合后）或 `steer`（步边界，默认禁用）；空闲目标被唤醒；冷会话自动恢复。有速率限制与重复抑制 |
| `mesh_create_session` | 新建根会话：可指定工作区（id/路径/标题）、标题、初始 prompt、agent preset；不指定工作区时**默认为调用方所在工作区** |
| `mesh_rename_session` | 改任意会话标题（pin 住，不被自动标题覆盖） |
| `mesh_archive_session` | 归档/取消归档任意会话；运行中的会话默认拒绝并说明有哪些工作，`stop_activity: true` 时先停止再归档 |
| `mesh_cancel_session` | 停止某个会话当前正在跑的回合（保留待处理 inbox），用于止损 |
| `mesh_wait_for_change` | 等待下一次会话状态/活动/新建/移除事件（1s–1h），返回第一个变化；替代轮询 |

模型可见文本两段：

- `session-mesh:policy`（system prompt 段，可用 `policy: full|short|off` 配置）：协作纪律——peer 消息是另一个 agent 的请求、只回复决策/结果、不要回执、不要乒乓、不共享对话历史、不要给自己发消息。
- `session-mesh:identity`（required runtime context）：`You are session "<title>" (<id>) in workspace "<title>" (<path>)`。非根会话不注入；生成失败时退化为最小一行，不阻断 prompt 组装。

## 3. 实现方式

全部状态复用宿主既有服务，不新增会话事件类型、不落自定义文件：

```
mesh_* 工具
  ├─ 列会话   sessionController.list() + workspaceRegistry.list()（一次建 session→workspace 索引）
  │            + workspaceRegistry.archivedSessionIds + sessionQuery.readTitleSnapshots()（30s 标题缓存，只取当页）
  ├─ 发消息   sessionController.resolveAgent(target)
  │            → agent.followup(relayUserMessage) / agent.steer(relayUserMessage)
  │            （消息 source = {kind:'agent-message', form:'relay', senderSessionId}；
  │              消息对象按 dsh-llm createUserMessage 的同一形态手工构造并深冻结，避免 import 依赖）
  ├─ 新建     sessionController.create({workspaceId|cwd, agentPreset}) → rename → prompt
  ├─ 改名     sessionController.rename({sessionId, title})
  ├─ 归档     workspaceRegistry.archiveSession(id, {stopActivity}) / unarchiveSession(id)
  ├─ 取消     sessionController.cancel({sessionId})
  └─ 等待     ctx.on('api-session/status|activity|added|removed') 一次性 waiter
```

- **性能**：列表先做不需要标题的过滤 → 排序 → 分页 → 只给当页读标题；带 `query` 时才读候选集标题。工作区映射一次 O(工作区×会话) 建索引，不再每行遍历。
- **安全**：默认 `allowSteer: false`、`maxSendsPerMinute: 30`、同目标同内容 60s 内重复抑制；可选 `allowedPeers`/`blockedPeers`（精确 sessionId）白/黑名单；发送写 `ctx.logger.info` 审计。
- **可靠**：消息投递失败时错误信息带目标与错误码；`resolveAgent` 失败不会静默。
- 工作区引用解析：精确 id → 精确路径 → 精确标题 → 唯一子串；多命中报歧义并列出候选。

## 4. 配置（`cordis.patch.yml` 的 `config`）

| 字段 | 默认 | 含义 |
|---|---|---|
| `defaultMode` | `queue` | 发消息默认投递模式 |
| `maxMessageBytes` | `65536` | 含 mesh 信封的单条消息 UTF-8 字节上限 |
| `allowCreate` | `true` | 允许创建会话 |
| `allowArchive` | `true` | 允许归档/取消归档 |
| `allowCancel` | `true` | 允许停止他人回合 |
| `allowSteer` | `false` | 允许 `steer` 投递（可能打断人类正在跑的回合） |
| `maxSendsPerMinute` | `30` | 每个发送方每分钟发送上限 |
| `allowArchivedSend` | `false` | 允许向已归档会话发消息 |
| `identityContext` | `true` | 注入身份 runtime context |
| `policy` | `short` | `full` / `short` / `off`，控制 system prompt 段长度 |
| `allowedPeers` | `[]` | 非空时仅允许给这些 sessionId 发消息 |
| `blockedPeers` | `[]` | 禁止给这些 sessionId 发消息 |

改配置：编辑本目录 `cordis.patch.yml` → Plugin Manager 里 disable → enable，或重启 DSH。

## 5. 重载与卸载

- **改代码后重载**：先运行 `npm test`（离线 mock 自检），再在 Plugin Manager 里把 `session-mesh` 关一次再开。模块热替换会触发 Host 重新组合，进行中的回合可能被中断，重要操作不要和重载放在同一回合。
- 卸载：`plugin_manager remove_bundle` 目标 `dsh-session-mesh`。

## 6. 验证

### 离线自检（无需 DSH）

```powershell
git clone https://github.com/kx2398/dsh-session-mesh.git
cd dsh-session-mesh
npm test        # node test/mock-apply.mjs，21 项
```

覆盖：7 个工具注册、policy/identity 注入（含身份文本渲染）、列表过滤/游标分页、agent-message 投递形态、重复抑制、steer 禁用、自消息拒绝、速率限制、归档目标拒绝、创建（含工作区推断/改名 warning）、改名、归档运行中会话的错误格式化、归档/取消归档、取消自拒绝、wait 成功/超时、`policy: off`。

### 在线验证

- `mesh_list_sessions` 跨多个工作区返回全部会话，标题/运行态/归档态正确；游标分页可用。
- `mesh_create_session` / `mesh_rename_session` / `mesh_archive_session` / 取消归档正常。
- `mesh_send_message` 向空闲空白会话投递 → 目标被唤醒并跑完回合；目标会话日志中该消息的 `source` 为 `{"kind":"agent-message","form":"relay","senderSessionId":...}`。

## 7. 已知限制

1. **`agent.followup/steer` 是 Host 内部 Agent 接口**：绕过 `sessionController.prompt` 的入站准入（文本消息无影响；图片/附件不走此路径）。若未来宿主改变消息形态，需要同步调整 `relayUserMessage`。
2. **成功 ≠ 已处理**：投递只保证进入目标 inbox；需要结果时让对方向你的 sessionId 回消息，或用 `mesh_wait_for_change` 观察变化后 `mesh_list_sessions` 复查。
3. **无 Web UI**：只有工具面。可选后续：会话网格面板（列表/跳转/发消息/归档），复用 `ui-workspace` 的导航。
4. **归档会话不可唤醒**：宿主 `ArchivedSessionGate` 会拒绝其 pre-step；必须先 unarchive。
5. **消息不进入发送方日志**：发送记录落在目标会话；发送方只能在回复到达时看到 `[mesh]` 消息。
6. **没有强制文件隔离**：不同工作区的会话可能共享同一文件系统路径；写冲突仍需自行协调。

## 8. 与生态现有插件的关系

调研结论（基于 npm registry / unpkg 对同类插件的逐包核查）：**没有现成插件同时覆盖**「全工作区列表 + 任意会话发消息 + 互建会话 + 改标题 + 归档/取消归档 + 无任务板」。最接近的是两个互补半成品：`dsh-cross-session-agent-pre`（列表+发消息）与 `dsh-cross-session-approval`（建会话/改名/仅归档），以及已 deprecated 的 `dsh-team-rooms`。本插件刻意只做薄层：直接依赖宿主 `sessionController` / `workspaceRegistry` / `sessionQuery`。

## 9. 开发

- 入口：`index.js`（Host 插件，`apply` 形态）；装配：`cordis.patch.yml` 以 `insert` 方式插入一行 `id: session-mesh`。
- 测试：`test/mock-apply.mjs` 用假 Host context 启动插件并跑通全部工具与注入文本，`npm test` 即可。
- 设计原则：状态只放宿主既有域（Session / Workspace），不新增事件类型；prompt 注入失败必须降级而不是中断回合；对模型暴露的每个限制都给出可行动的错误信息。
- 发布/维护流程见 [docs/RELEASING.zh.md](docs/RELEASING.zh.md)。

## 10. 许可证

[MIT](LICENSE)。
