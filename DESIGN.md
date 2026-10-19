# Paseo Feishu — Technical Design

> v0.1 · 2026-10-19 · 设计文档（不含实现）  
> 产品契约与验收标准：[SPEC.md](./SPEC.md)

## 1. 设计原则

目标是做一个**轻量 Paseo Server Plugin**，让飞书机器人私聊成为现有 Paseo Agent 的辅助客户端，而不是另一套 Agent 管理系统。

1. **复用，不接管**：Agent 的生命周期、上下文、权限、执行队列、Worktree 都由 Paseo 管理。
2. **失联不影响任务**：飞书失败、插件重启、SDK 断线不得关闭或归档 Agent。
3. **避免隐式执行**：选择卡片只改变绑定；不执行 prompt，不创建会话，不自动重试不确定的请求。
4. **少保存状态**：仅保存飞书用户/当前 Agent 绑定、卡片版本、去重与通知游标；不复制对话历史。
5. **优先真实能力**：如果依赖的公开 SDK 不支持某项行为，先做最小接口验证；不要通过解析 CLI 输出或私有 daemon 协议绕开。

## 2. 运行结构

```text
Feishu private chat
   │
   │ WebSocket: im.message.receive_v1, card.action.trigger
   ▼
@larksuite/channel
   │  NormalizedMessage / CardActionEvent
   ▼
Paseo Feishu Server Plugin  (one daemon subprocess)
   ├─ Feishu adapter: 卡片、回调、回复、通知
   ├─ Session controller: 身份、绑定、版本、消息入口
   ├─ Local state store: JSON 原子写入、去重/进度记录
   ├─ Local Paseo SDK client: 飞书主动触发的 list/ref/refresh/send/permission
   └─ Paseo lifecycle hooks: turn_ended / permission_requested / permission_resolved / archived
          │
          ▼
     Existing Paseo daemon
          └─ Existing Agent IDs and timelines (Codex / OpenCode / etc.)
```

只提供 `index.server.ts`；不提供 `index.client.tsx`（飞书本身就是 UI）。普通 Node 模块放在 `server/` 内。不要引入独立 HTTP 服务、数据库、HTTP webhook、ACP 桥接或 CLI 解析层。

### 2.1 为什么同时使用 Paseo Plugin Hook 与 Client SDK

已核实的插件接口：

- `server.on('agent.turn_ended', (event, { paseo, signal }) => ...)`
- `server.on('agent.permission_requested', ...)`
- `server.on('agent.permission_resolved', ...)`
- `server.on('agent.archived', ...)`

**插件注册时传入的 `PluginServerContext` 没有长期可调用的 `server.paseo` 成员**；`paseo` 在 hook/RPC handler 的 context 内。飞书消息与点击卡片并非由这些 hook 发起，所以主动处理时用 `createPaseoClient({ url, password? })` 建立本机连接；hook 内直接使用 `context.paseo`，不用为读取 hook 事件再建额外连接。

**已对照 Paseo 源码核实（本地 clone，见 `.cw/FINDINGS.md`）：**

- `context.paseo` 是插件子进程内唯一的、与进程同寿命的 `PaseoApi`，通过 IPC 连接 daemon，无需密码；但它只出现在 hook / RPC handler 的 context 中。启动后没有会立即触发的 hook，插件 RPC 又只能由外部客户端调用，所以飞书侧的主动操作不能依赖它，也不能等到“第一个 hook 到来再捕获”（会让冷启动窗口违反 A01、A12）。
- 因此飞书主动路径使用公开 API `createPaseoClient({ url, password? })`。**公开 `PaseoClientConfig` 没有 `localCredential`，不得为此引用 `@getpaseo/client/internal/*`。**
- daemon 未设密码时直接放行；设置了密码就必须提供明文密码（持久化的是 bcrypt 哈希，插件无法反推）。插件子进程继承 daemon 的环境变量，密码若由 `PASEO_PASSWORD` 提供可直接读取，否则需用户在插件配置中给出。
- `contribute()` 必须**同步**返回 cleanup 函数。在函数体内 `void client.connect()` 并启动飞书长连接，不得写成 `async`。
- 连接未就绪时，对飞书消息和卡片点击显式回复“Paseo 未连接，消息未发送”。不排队，不在恢复后自动重投（见 A10、A14）。断线后依赖 client 自带重连，再用 `timeline.refetch` 与 `pendingPermissions` 补查。
- hook 内继续使用 `context.paseo`，与自建 client 两条路径互不依赖。

实现前仍要做最小联调：在 daemon 插件子进程内用 `createPaseoClient` 连接默认 `ws://127.0.0.1:6767/ws`，验证有/无密码时的认证、建立会话、列出 Agents；失败时要给出明确部署诊断，不能静默降级到 shell/CLI。v0.1 只支持 TCP loopback；daemon 监听 unix socket 时公开 client 是否可用**未核实**。

### 2.2 依赖

| 依赖 | 作用 | 约束 |
| --- | --- | --- |
| `@getpaseo/plugin/server` | server entry / lifecycle hooks | 与实际安装的 Paseo daemon SDK 版本匹配 |
| `@getpaseo/client` | 已有 Agent 查询、消息与权限接口 | Node.js 22+（默认 WS 传输依赖 `globalThis.WebSocket`）。**不是宿主模块**，必须随插件打包或安装到插件 `node_modules`；版本以 daemon 实际运行版本为准 |
| `@larksuite/channel` | 飞书长连接、消息标准化、卡片发送、交互回调 | 确认生产包版本并锁定 |
| `zod`（可复用） | 配置和回调 payload 结构校验 | 仅简单校验，不引入额外框架 |

在 2026-10-19 检查的源码中，Paseo 插件包为 `0.11.2`，飞书 Channel 包的仓库 `package.json` 为 `0.7.1`。它们是**源码检查时的版本，不是自动宣称已验证的发布兼容矩阵**；**不锁版本**：依赖写 `*`，安装时取最新；API 破坏性变更时让插件在加载或运行时崩溃，以此提示需要升级支持，不为兼容旧版本写垫片。

Paseo host 只提供 `@getpaseo/plugin/*` 与 `zod`；`@larksuite/channel`、`@getpaseo/client` 等运行时依赖不是宿主模块，必须能被 esbuild 打进 bundle，或位于插件目录的 `node_modules`。`npm` 包形式安装时 daemon 会执行 `npm install --omit=dev`；目录 / Git 源不会自动安装依赖，需在 `paseo-plugin.json` 的 `build`（argv 数组，不经过 shell）里写 `["npm", "ci", "--omit=dev"]`。

以根目录 `paseo-plugin.json`（最小形态：`id` 与 `requirements.paseo`）及 `index.server.ts`（默认导出 `contribute(server)`）为插件入口；插件默认不启动，须 `pluginsEnabled` 开启后用 `paseo plugin add <路径>` 安装。不 fork Paseo。

**版本（已核实）：** 开发机上的 daemon 是 `0.11.4`（`paseo --version`），npm 上 `@getpaseo/{plugin,client,protocol}` 的最新稳定版也是 `0.11.4`。文中的源码结论读自上游 `main`（0.12.0-beta.3），已对照 `v0.11.4` tag：`plugin-process.ts`、`runtime.ts`、`bundle-evaluator.ts`、`plugin-sdk-specifiers.ts`、`plugin/src/server/{contracts,lifecycle}.ts`、`session-admission-auth.ts` 与 `main` 相同；`compiler.ts` 与 `client/src/index.ts` 仅有与本插件无关的小差异；`agent-manager.ts` 的 hook 派发点与 `shouldDispatchEvent` 逻辑同样存在于 `0.11.4`。依赖不锁版本（`*`）；`paseo-plugin.json` 的 `requirements.paseo` 保留 `>=0.8.0`——宿主要求该字段存在，缺失会被当成 0.8 之前的旧插件拒绝安装。

## 3. 外部 API 映射

### 3.1 Paseo SDK

| 意图 | 对应调用 | 关键语义 |
| --- | --- | --- |
| 获取会话 | `client.agents.list(options?)` | 分页列出，过滤归档并整理可显示字段 |
| 指定会话 | `client.agents.ref(agentId)` | 只创建本地 handle，不验证存在 |
| 验证会话 | `agent.refresh()` | `null` 表示找不到；检查归档标记 |
| 发送文本 | `agent.send(text)` | Promise 成功仅代表 daemon 已接受 |
| 读取状态 | `agent.status` / `agent.current()` | 快照字段；先 refresh 或观察 |
| 待审批 | `agent.pendingPermissions` | 重新核对请求 ID 和具体类型 |
| 回复审批 | `agent.respondToPermission({ requestId, response })` | 使用 SDK 原生 allow / deny，失败即如实反馈 |
| 历史补查 | `agent.timeline.refetch(options)` | cursor: epoch/seq；缺失历史不伪造 |

从现有会话继续消息使用 `send()`，**不调用** `agents.create()`、`archive()`、`detach()` 或其他改变生命周期的功能。

### 3.2 飞书 SDK

| 意图 | 对应调用/事件 |
| --- | --- |
| 初始化/关闭 | `createLarkChannel(options)`、`connect()`、`disconnect()` |
| 接收文本 | `channel.on('message', (msg) => ...)` |
| 接收卡片点击 | `channel.on('cardAction', (event) => ...)` |
| 发卡片/文本 | `channel.send(chatId, { card })` / `{ markdown }` |
| 更新原卡片 | `channel.updateCard(messageId, card)` |
| 即时操作反馈 | cardAction handler 返回标准 toast；处理未完成只回复“正在处理” |

应用必须是飞书**企业自建应用机器人**（不是仅能发消息的群 Webhook），并配置接收消息与卡片动作事件。默认 WebSocket transport，不暴露公网接收接口。事件/权限以飞书开放平台实际配置为准。

`NormalizedMessage` 的关键字段是 `messageId`、`chatId`、`chatType`、`senderId`、`content`、`rawContentType`。卡片动作是 `messageId`、`chatId`、`operator.openId` 与 `action.value`。**卡片操作必须重新鉴权**，不能因为普通消息用了 `dmAllowlist` 就默认安全。

## 4. 卡片协议

### 4.1 会话列表卡

标题：`Paseo · 选择会话`。显示连接状况、Agent 数量、最多五个会话条目和翻页/刷新按钮。单个条目仅展示标题、Provider、简短目录、状态、最近活动，按钮为“继续此会话”或“切换到此会话”。

- 列表数据每次打开/刷新都从 Paseo 获取；不能把旧的状态缓存当权威。
- 当前绑定置顶，其余按活动时间逆序；排序稳定（相同时间用 ID 排序）。
- 分页基于当次查询结果；翻页时列表可能改变，因此**页面编号不能成为权限依据**。
- Schema 2.0 交互按钮携带明确操作、`agentId`（选择时）、`pickerRevision`；这些值仅作指示，服务端仍须验证身份、来源和 Agent 状态。
- 旧卡片默认不能再执行切换。
- 飞书卡片组件数量、文字长度、CardKit 更新能力应在实测中按平台限制调整；不要依赖客户端一定渲染某种布局。

### 4.2 当前会话卡

成功绑定后尽量**原地更新**选择卡片：标题为 `Paseo · 当前会话`、当前 Agent 标题、Provider/工作区、状态，以及“切换会话”“刷新状态”。更新卡片失败时**不能回滚已成功保存的绑定**；可以发送一条简短文字确认并在下一次交互创建新卡片。

### 4.3 操作集合

| action | 数据 | 效果 |
| --- | --- | --- |
| `select_agent` | `agentId`、`pickerRevision` | 校验/绑定已有会话 |
| `open_picker` | `pickerRevision` | 原地重绘选择卡 |
| `refresh_agents` | `pickerRevision` | 在选择卡上查询并重绘列表 |
| `refresh_current` | `pickerRevision` | 在当前会话卡上重新读取绑定 Agent 并原地更新 |
| `page_agents` | `page`、`pickerRevision` | 展示指定页 |
| `approve_permission` | `agentId`、`requestId` | 审核后允许 |
| `deny_permission` | `agentId`、`requestId` | 审核后拒绝 |

业务动作集固定为上表。`/sessions` 和 `/status` 只是无卡片/过期卡片时的辅助入口，不构建全量命令菜单。

### 4.4 示例交互（业务含义）

```text
User → Bot: /sessions
Bot → User: [KVMux · Relay 审阅 | 运行中 | 继续此会话]
            [Punctiform · Codec | 空闲 | 切换到此会话]
User → Bot: 点击 KVMux
Bot → User: [当前会话：KVMux · Relay 审阅]
User → Bot: 继续检查 KCP 背压处理
Bot → User: 已发送到 KVMux · Relay 审阅（非任务完成）
Paseo → Bot: agent.turn_ended
Bot → User: KVMux · Relay 审阅 · 已完成 + 简短结果
```

## 5. 回调处理与并发

### 5.1 选择 Agent

1. 收到 `cardAction` 后校验 `chatId`、`operator.openId`、当前允许的操作类型与 payload 结构；**拒绝未授权用户，不泄露具体 Agent 信息**。
2. 查找该 chat 的**当前有效** `pickerMessageId`、`pickerRevision`；与点击卡片不一致就拒绝。
3. 在本地状态中立即置为 `SWITCHING`（使同时进入的文本失败关闭），异步查询 `agents.ref(id).refresh()`。
4. Agent 存在且未归档时，原子持久化新 `agentId` 与新 revision，然后恢复 `BOUND`。
5. 成功后更新原卡片；失败则回到先前绑定，向用户明确报告“未切换”；不能暗中重试该动作。
6. 如果用户连续快速点两次，只处理一个有效切换；后一操作需重新打开有效选择卡。

卡片处理器需要及时向飞书返回响应；耗时 I/O 放到受控的后续处理，不应同步等待整个 Agent turn。业务自己的小型按 chat 锁用于切换与消息路由的快照一致性，不引入通用工作队列。

### 5.2 文本转发

1. `chatType !== 'p2p'`、用户不在白名单、非文本或机器人自身消息：拒绝。
2. 未绑定：回复选择卡；本条文本不转发。
3. `SWITCHING`：告知“此消息未发送，请切换后重发”。
4. 有绑定：生成该消息处理记录，用 `messageId` 去重；读取**同一原子快照**的 `agentId`。
5. 验证 Agent 未归档，调用 `send(content)`；受理后回复“已发送”。拒绝时如实说明；连接超时但受理结果未知时标记 `unknown`，**不自行重发**。

特别注意：不能先异步等待远端 Agent 验证，期间悄悄读到一个新绑定而把消息送到另一个 Agent。每个用户消息只对应一个已确定的目标 Agent ID。

### 5.3 Channel 队列约束

已对照 `@larksuite/channel` 源码核实（`channel-sdk-node/src/safety/index.ts:75`、`types.ts:475-503`）：**`safety.chatQueue.enabled` 默认是 `true`**，每个 chat 的消息与卡片点击默认串行；`cardActions` 有 `same`（默认）/ `separate` 两种模式；`mergeWhileBusy` 默认关闭。

v0.1 使用默认 `same`，前提是 `message` handler **绝不等待完整 Agent 执行，也绝不等待用户之后点击审批卡片**，卡片 handler 只处理短事务和即时反馈。否则点击会排在正在运行的 message handler 之后，同一 chat 的新消息又排在点击之后，造成死锁。

去重与身份：

- 重复事件被静默丢弃（不触发 handler）。默认 `dedup.ttl` 12 小时，`maxEntries` 5000（`safety/types.ts:23-28`）。
- 卡片点击的去重键是 `messageId + operator.openId + (tag | name | option | value 前 128 字符)`（`channel.ts:1203`、`cardActionId`）。因此**相同按钮的合法重复点击在 12 小时内会被吞掉**；审批类按钮的 `value` 里必须带 `requestId` 和卡片版本，保证不同请求不会撞键，同时依赖业务层的“首次有效决定”判定，不依赖 SDK 去重。
- `senderId` 优先取 `open_id`，缺失才回退 `user_id`、`union_id`（`normalize/index.ts:84-87`）；`dmAllowlist` 与它比对，因此 `FEISHU_OWNER_OPEN_ID` 填 `ou_…`，不是 `cli_…`。
- `cardAction` 返回值可以是 `{ toast: { type: 'success'|'info'|'error'|'warning'|'loading', content } }` 或原地换卡（`types.ts:137-158`）。

如果将来切换为 `separate`，必须显式串行化共享的 chat 绑定状态，不能假设 SDK 保证消息与卡片点击互斥。避免为 v0.1 引入两条复杂处理管线。

## 6. 本地状态与恢复

### 6.1 最小持久化字段

建议单个私聊记录：

| 字段 | 含义 |
| --- | --- |
| `chatId`、`openId` | 私聊身份与授权主体 |
| `agentId`（可空） | 当前绑定的 Agent |
| `pickerMessageId`、`pickerRevision` | 最新有效卡片及版本 |
| `bindingRevision` | 切换并发检查和状态版本 |
| `lastNotifiedTurn` / 可用的 timeline cursor | 补查和避免重复通知 |
| 限量近期 `messageId → deliveryState` | 消息去重与发送状态确认 |

`SWITCHING` 是**内存瞬态**：崩溃恢复后不得永久卡在切换中；以最后成功持久化的绑定为准。`deliveryState` 可区分 `claimed`、`accepted`、`rejected`、`unknown`。处理前先保存 claim，崩溃后残留 claim 视为未知，不自动重投。

单实例按顺序原子写 JSON（写临时文件、落盘/替换、校验），限制状态增长并清理过期消息去重记录。不要存 Agent 对话全文或任何密钥。多实例写冲突不在 v0.1 支持范围内。

### 6.2 通知与缺口恢复

- **实时路径**：用 `agent.turn_ended` 发完成/失败/取消通知，`agent.permission_requested` 发权限卡，`agent.permission_resolved` 更新过期卡片。
- **归属**：通知发给事件到达时仍绑定该 Agent 的私聊；切换后的旧 Agent 事件不向新会话冒充结果。
- **摘要来源**：`agent.turn_ended` 事件自带 `timeline` 快照（`AgentTimelineItem[]`），完成摘要优先从这里取最后的助手文本，不必再 `refetch`；字段形态实现时以 `@getpaseo/protocol` 的类型为准。
- **hook 不能阻塞**：hook 超过 30 秒会被丢弃且不补发。hook 内只做“入队/落盘幂等记录”并立即返回，飞书发送与有限重试放到 hook 之外异步完成。
- **恢复路径**：插件重启/重新连接后，对**当前绑定 Agent**读状态、待审批和可用 timeline；可通过 timeline 的 `epoch/seq` 游标补查已记录观察位置之后的已完成 turn。
- **去重**：按 `agentId + turnId`（有稳定 turnId 时），否则按 timeline epoch/seq 的确定性事件标识；不依赖 `idle` 状态变化判断完成。
- **发送结果不确定**：飞书发送后但 ACK 丢失时可能产生重复通知；尽力去重但不承诺跨系统 exactly-once。
- **历史不可得/重置**：在受影响时间段内不猜测或重构 turn；仅显示恢复后已知状态。

首次绑定不补发历史已完成事件，但绑定时若有正在运行的 turn，允许它结束时推送结果。为了防止敏感信息泄露，默认只发终态 + 最后回答的有限长度摘录（建议上限约 1200 字符）；无可靠纯文本摘要就只发终态。

### 6.3 关闭与插件重载

插件停用/重载时：注销 Feishu listeners → 关闭 WebSocket → 释放 Paseo SDK client 与订阅 → 完成必要的状态刷新。**不调用 Agent stop / archive**，不依赖卸载过程能“完美清理”网络请求。重复启动时不能产生两个同时活跃的飞书长连接。

Paseo 的关闭时序是：IPC `shutdown` → 2 秒后 `SIGTERM` → 再 2 秒后 `SIGKILL`。cleanup（`client.close()`、`channel.disconnect()`、状态落盘）要在约 4 秒内做完，状态写入必须是原子的。

hook 没有持久化队列：daemon 或插件重启期间的事件会丢，超过 30 秒未返回的 hook 会被丢弃，且 `permission_resolved` 不去重。所以通知的幂等键要用业务标识（`agentId + turnId`、`requestId`），不能依赖 hook 只触发一次。

## 7. 权限请求的具体边界

审批卡单独发送，不混入会话选择卡。默认只展示简短描述，不展示环境变量、完整输出、密钥或无限制长度的脚本内容。

- 在生成按钮之前先检查请求结构是否真的允许映射成 Paseo `allow` / `deny`。
- 处理点击时以 `operator.openId` 重新鉴权，检查 `requestId` 仍在目标 Agent 的 `pendingPermissions` 中、且当前绑定一致。`agents.ref(id)` 得到的 handle 在 `refresh()` 之前 `pendingPermissions` 为 `null`，所以必须先 `refresh()` 再读。
- 同一 `requestId` 只接受首次有效决定；若桌面端已审批，显示“该请求已处理”。
- `permission_resolved` 到达后尽量把审批卡标注为已处理；更新失败也不能重新批准。
- 对不适合二选一的请求类型，只推送“请回 Paseo 处理”提示，不创建虚假的 allow/deny 按钮。

使用 Paseo 原生 `agent.respondToPermission()`，不得自行修改 provider 状态或直接给 CLI 注入按键。

## 8. 配置、部署与安全

### 配置项（名称为本设计建议，不是现有 SDK 强制字段）

| 配置 | 说明 |
| --- | --- |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 企业自建应用凭据；仅在本机安全注入 |
| `FEISHU_OWNER_OPEN_ID` | 唯一允许操作的用户；默认不允许其他人 |
| `PASEO_URL` | 本机 daemon WebSocket URL，按安装配置 |
| `PASEO_PASSWORD`（可选） | daemon 若配置认证则需提供。读取顺序：进程环境变量（继承自 daemon）→ 插件 settings（0600 文件）。不得写入日志 |
| `STATE_FILE`（可选） | 具权限保护的本地插件状态文件路径 |

- **绝不提交**真实 `.env`、令牌、授权用户私有资料或会话记录。
- 仅允许私聊，SDK 使用 `dmMode: 'allowlist'` 与 `dmAllowlist` 做第一层过滤；应用层所有消息和卡片点击再校验一次。
- 不要自动开启 Paseo 全局 `pluginsEnabled`；安装者须明确许可。
- 加载前验证版本、依赖、插件入口和 `paseo-plugin.json`；构建/安装遵循 Paseo 官方插件指南。
- 配置缺失时明确报错/显示连接不可用；不退化为无鉴权运行。
- 日志只记录匿名化 chat/agent 标识、状态变化、错误类型；不打印消息内容、权限命令全文、App Secret、Paseo password。

### 可参考的工程布局（只表达职责，不强制拆成许多类）

```text
paseo-feishu/
  paseo-plugin.json
  package.json
  tsconfig.json
  index.server.ts
  server/
    channel.ts       # Feishu SDK 初始化、事件转发、卡片呈现
    paseo.ts         # 本机 Paseo SDK 连接和 Agent 操作
    session.ts       # 验证、绑定、状态持久化与去重
    notifications.ts # Paseo 生命周期事件 → 飞书通知
  SPEC.md
  DESIGN.md
  README.md
```

先让 Coding Agent 实现可工作的少量模块；没有理由引入抽象工厂、跨 Channel Adapter 规范、RPC 总线、多租户框架等。

## 9. 实现前最小接口验证（技术门槛）

按顺序做四个实验，每项需记录实际 Paseo 版本、飞书 Channel 包版本、运行环境与结果：

1. **Plugin loading**：仅服务端插件能够通过类型检查、安装、启动、重载、卸载，且可解析 `@larksuite/channel` 的运行时依赖。
2. **Daemon loopback**：插件子进程使用 `@getpaseo/client` 连接本机 daemon，可以 `agents.list()`、`agents.ref(id).refresh()`；验证身份配置和释放连接。
3. **Feishu CardKit**：发送一张 Schema 2.0 选择卡，从 WebSocket 收到 `cardAction`，识别 `operator.openId`，返回 Toast，尝试 `updateCard()`。
4. **Agent hook**：真实存在的 Agent 在 desktop 触发 turn/permission，插件收到 `agent.turn_ended` / `agent.permission_requested` 并向飞书发送通知。

四项中任何一项失败：只修具体兼容问题，不擅自改为新的 Agent Runner、不扩建独立 Gateway；如果确实有 SDK 限制，记录限制并提出一个最小替代实现供审阅。

## 10. 验收、交付与不确定项

**自动化测试**：卡片解析/旧版拒绝、未授权用户、状态映射、切换与消息竞争、消息事件重复、超时未知状态、原子持久化/损坏文件处理、重启恢复、审批双击/桌面抢先审批、通知重复与游标补查。

**人工端到端**：严格按 [SPEC.md A01–A16](./SPEC.md) 在实际设备进行。交付中记录验证步骤、成功/失败证据，不能用 mock 通过代替真实飞书回调通过。

**需要实验确认、暂不视为已通过**：

- Paseo Server Plugin 子进程回连本机 daemon 的认证/连接细节；
- CardKit 2.0 按钮及更新在当前企业飞书应用的真实可用性；
- 待审批数据能否被安全转换为独立的允许/拒绝卡；
- 重启期间可恢复的 timeline 事件范围；
- 当前版本和后续 Paseo/Feishu SDK 的打包兼容性。

## 11. 参考

- [Paseo Plugin Reference](https://github.com/getpaseo/paseo/blob/main/public-docs/plugins/reference.md)
- [Paseo SDK Quickstart](https://github.com/getpaseo/paseo/blob/main/public-docs/sdk/quickstart.md)
- [Paseo SDK Reference](https://github.com/getpaseo/paseo/blob/main/public-docs/sdk/reference.md)
- [Paseo SDK Events](https://github.com/getpaseo/paseo/blob/main/public-docs/sdk/events.md)
- [Feishu Channel SDK Types](https://github.com/larksuite/channel-sdk-node/blob/main/src/types.ts)
- [Feishu Channel SDK](https://github.com/larksuite/channel-sdk-node)
