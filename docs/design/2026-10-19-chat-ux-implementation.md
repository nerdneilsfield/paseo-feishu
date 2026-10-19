# 飞书聊天 UI/UX 实施计划

> For agentic workers: use subagent-driven-development，顺序派发 implementation agent；主代理维护本计划并监督 task reviewer 和 final reviewer。

状态：ready。用户已授权“用 subagent 调用 gpt 6.1 sol low 开干，你调度监督”。所有子代理使用 `codex/gpt-6.1-sol`、`thinkingOptionId: low`。

## 目标和约束

依据[命令与动态回复规格](./2026-10-19-chat-commands-and-live-updates.md)和[调研建议](./2026-10-19-chat-control-ux-research.md)，交付本地帮助、状态和历史导航、动态回复、授权/问题分层。入口不占用 agent turn，过程中可见真实进展，结束结果不会被旧进度覆盖。

工作分支 `feat/feishu-chat-ux`，基于本地 `master`。开始时只有上一轮本代理生成的调研文档未跟踪；没有其他代码改动。只做本地提交，不 push、不 merge、不重启 daemon、不更改开放平台设置。现有插件已获用户授权，最终按现有运行目录核对后只重载插件。

- 保持单 owner、私聊、消息去重、审批重新核查、不重发未知提交、不持久化/记录正文。
- 不新增依赖、环境变量开关、后台轮询或持久化格式。只使用 SDK 现有操作。
- 不创建/停止 agent，不引入远程终端或新执行引擎。
- 原生菜单用开放平台“发送文字”发送精确 `/sessions`、`/history`、`/help`。若后台直接发送菜单名称，名称就填命令本身；不声称中文标签可独立映射。中文快捷入口由帮助卡提供，不增加 raw 菜单事件。
- 问题只用安全标题/描述显示“需要回答，请回 Paseo 回答”。协议缺少标准答案结构，不猜 `updatedInput`。
- 授权不声称未经协议保证的“一次性”范围；保留真实动作的安全语义，拒绝用普通按钮。

## 设计与共享契约

`server/session.ts` 唯一拥有绑定版本与进程内 generation。新增不可变 `BindingScope { generation, agentId, chatId }`；恢复/切换产生新代次，异步结果发送前重新检查。历史游标与卡片操作关联 scope、卡片 ID、分页版本；普通帮助可以在未绑定或离线时使用。

`server/paseo.ts` 增加 timeline 的窄读取/订阅接口，复用已安装 SDK 的页面、游标及事件类型，不隐藏 `error/reset/staleCursor/gap`。历史选择 projected 页，按序列排序，只展示用户和助手消息。每次最多 5 页，每页 50 条；每屏最多 10 条可见消息。剩余已读消息保存在有限内存缓冲，发送成功后才提交游标。摘录每条 1200 字、每屏 12000 字，明确截断；完整超长内容回 Paseo 查看，不把摘录当完整答案。

新增 `server/live-replies.ts` 专门管理当前 scope 的订阅和回复卡。session 在转发前调用 `ensureReady(scope)`，关闭/切换释放旧订阅及一次性 timer。先订阅、等待 ready、补查 tail，再允许发送。SDK live 事件无可靠序列，故只触发快照替换：一个请求在途、一个 dirty 标志，最多每秒调度一次补查/写卡；没有固定后台轮询。replacement 递增协调版本，旧请求不能应用；restored 协调成功前不发新提示词。只渲染可归属当前 turn 的助手文本，缺失归属时标明不完整，不混入旧回答。不展示 reasoning 或原始工具输出。

PaseoClient 公开接口没有连接状态订阅；不得访问 SDK 私有属性或造心跳。每次提交、补查和写卡检查当前连通性；已知订阅错误或恢复事件更新状态。没有事件时无法保证立即检测断开，最终说明该限制。

`server/notifications.ts` 负责 `turn_ended` 的权威终态、现有去重和完成通知。第一个 await 前同步 `seal()`，使在途快照和后续事件失效；取得通知权后后台定格。最终正文只取 hook timeline 最新一组连续助手文本（忽略尾部非消息项），不能收集所有历史助手回复。正文上限 12000，超出明确引导回 Paseo。最终更新与进度写卡串行；成功后一次短提醒；建卡/最终更新失败才用原正文通知兜底，提醒失败不重复发送正文。保留现有“至多一次尝试”，不宣称 exactly-once。

`server/cards.ts` 负责 Card JSON 2.0 展示。帮助首屏少量按钮，会话统一标题/短目录/状态，内部 revision 不占首屏。状态和绑定分别表达。历史显示角色、时间和目标会话，旧卡不操作新绑定。授权与问题用不同标题，点击先提交中，后端确认后才显示处理结果；不展示不存在的停止/回答功能。

## 验收映射

| ID | 行为 | 任务 | 检查及期望 |
| --- | --- | --- | --- |
| U1 | 本地命令和按钮不发 agent 提示词 | T1 | session 路径测试：help/history/非法参数 send 次数为零；help 离线/未绑定可用 |
| U2 | 历史有限分页不漏记录，失败不推进，旧 scope 不发送 | T1 | 含工具密集页、剩余缓冲、发送失败和切换中读取的测试 |
| U3 | 卡片导航可识别会话、菜单复用命令 | T1 | 卡片及 action schema 测试；菜单配置文档映射仅已实现命令 |
| U4 | 提交前观察就绪，结束前可见真实助手内容 | T2 | pending ready、快照、实时事件测试：未 ready 不 send，更新同 messageId |
| U5 | 结束、重连、replacement、切换不会混入旧内容或覆盖终态 | T2 | 含在途补查/写卡的时序测试、重复 hook 只提醒一次、close 释放资源 |
| U6 | 权限失败不误判已处理，问题不冒充授权 | T3 | SDK refresh 失败和请求形状改变测试；question 卡无 allow/deny |
| U7 | 运行代码与说明一致 | T3 + final | typecheck、全套 Vitest、diff 检查；核对安装源并重载插件，不发测试消息给他人 |

## 顺序执行

### T1：本地导航、历史卡与菜单说明

状态：done。依赖：无。验收：U1/U2/U3。

证据：主代理复跑 typecheck、全套130 tests、diff check 均通过；fresh task reviewer 判定 Spec/Quality 通过。

文件：`server/contracts.ts`、`server/paseo.ts`、`server/session.ts`、`server/cards.ts`、`server/channel.ts`；现有 `test/` 中相关测试；`docs/zh-CN/` 与 `docs/en/` 设置/参考文档。

- [x] 增加 SDK timeline 读取端口和 scope；精确首词识别 `/help`、`/history`，非法参数也本地返回；保留其他 provider 命令转发。
- [x] 帮助/状态/会话卡共用本地导航逻辑；按钮不模拟用户消息。历史展示最近、更早、回到最新，按候选状态提交分页进度。
- [x] 用现有 Vitest 路径验证命令不转发、分页/竞态，运行 `rtk npm run typecheck`、`rtk test npx vitest run --silent`。
- [x] 主代理检查 diff，task reviewer 审查规格与实际缺陷；修复后本地提交 `feat: add local Feishu navigation and session history`。

### T2：动态回复生命周期与完成提醒

状态：in_progress。依赖：T1。验收：U4/U5。

文件：新增 `server/live-replies.ts`，修改 `server/contracts.ts`、`server/paseo.ts`、`server/session.ts`、`server/notifications.ts`、`server/cards.ts`、`index.server.ts`；现有相关测试及必要的 live 时序测试。

- [ ] 复用 T1 的 scope 与读取接口，增加 SDK 订阅窄接口。由 session/装配管理 bind、ensureReady、seal/finish、close。
- [ ] 基于快照替换合并更新，终态同步封存，最终正文与通知独立，所有发送校验 scope。
- [ ] 用 fake timer/受控 Promise 验证 ready、恢复、迟到事件、建卡/写卡失败及结束竞态，类型检查和相关 Vitest 通过。
- [ ] 主代理检查 diff，task reviewer 审查时序不变量；修复后本地提交 `feat: stream Feishu reply cards with completion receipts`。

### T3：授权/问题表达与使用说明

状态：pending。依赖：T2。验收：U6/U7。

文件：`server/paseo.ts`、`server/session.ts`、`server/cards.ts`、`server/notifications.ts`、`paseo-plugin.json` 与相关测试；README、`docs/en/`、`docs/zh-CN/` 及旧设计状态。

- [ ] 重新验证 pending 动作映射（tool、唯一 allow/deny、有效且不同 ID）；refresh 错误不当作已处理；已处理旧卡收起按钮并说明真实状态。
- [ ] 工具授权与问题/其他操作区分，拒绝不使用 danger，标题/摘要/按钮适合手机，不增加无协议支持的答案提交。
- [ ] 更新功能、菜单外部配置、环境继承时机、动态更新/提醒和已验证范围；采用保守的最低已核验 Paseo 版本 `>=0.11.4`（当前 CLI/SDK 均为0.11.4），同步 setup 中版本说明；全套测试/类型检查、task reviewer 通过后本地提交。

## 监督与收尾

主代理保存执行记录、派发 fresh implementation agent，一次只允许一个 writer。子代理不得再派 reviewer、不得重启/重载运行环境或修改计划；报告列出改动、命令及实际结果。审查只找本轮范围缺失、可达错误和无根据复杂度。任务报告之后由主代理核对 Git diff 和证据，再进入下一任务。

最终由 fresh final reviewer 检查整体实现和跨任务问题。类型检查与全套测试通过后，核对已安装插件 source path，若为托管副本则同步本轮命名文件后只重载该插件。不得复制状态或凭据。日志和 running 状态只能证明加载，不能冒充飞书手机真机验收；用户未实际操作的手机通知/视觉结果在最终说明。

执行记录：baseline 7 个测试文件、102 项测试通过；explorer 与 planner 均只读完成。T1完成并通过独立审查；下一步 T2。
