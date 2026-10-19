# Coding agent 聊天控制界面调研与飞书交互建议

调研日期：2026-10-19。对象：通过 Telegram、飞书和移动客户端控制编码会话的产品。用途：为 paseo-feishu 的下一轮 UI/UX 设计提供依据；本文是研究和设计提案，不改变现有产品行为，也不代表已经实现。

本轮覆盖 27 个项目或入口。三组 BFC MiniMax-M3-M 调研分别研究 Telegram、飞书及跨平台、远程客户端；主代理补查 Claude 官方 Telegram 插件，并交叉核对关键源码、文档、截图和 issue。未安装或运行这些第三方项目。

证据标记：**源码**表示静态阅读过相关实现，不等于实机验证；**文档**表示项目自述；**截图**表示查看过仓库发布的客户端图片；**issue**表示特定版本或环境下的报告，不能推成平台普遍限制。下文“建议”均为我们自己的设计判断。

## 1. 先决定这五件事

| 设计决定 | 建议 | 解决的问题 |
| --- | --- | --- |
| 用户从哪里开始 | 飞书固定菜单提供“会话 / 历史 / 帮助”；帮助卡展示少量常用操作 | 用户不用先记住斜杠命令 |
| 用户怎么知道消息送达 | 明确区分“已接收”“处理中”“等待你操作” | 避免把接收确认误当作模型开始执行 |
| 用户怎么看中间过程 | 一张持续更新的回复卡：公开的助手进展、当前活动、最近更新时间 | 长任务不再长时间无反馈，也不逐条刷屏 |
| 用户离开聊天后怎么知道完成 | 完成后更新原卡，并发送一条简短完成提示；手机实测通知效果 | 编辑旧卡和产生新通知是两个问题 |
| 用户怎么授权和回答问题 | 授权卡与问题卡分别设计；操作结果以后端确认状态为准 | “允许工具执行”和“选择需求”不能共用含糊按钮 |

建议优先打磨这些已有功能的可发现性、状态和反馈。当前产品以选择已有 Paseo 会话为边界；创建会话、切换执行引擎、杀进程、远程终端不因竞品具备就加入本轮。

## 2. 重点样本：哪些值得细看

| 项目 / 入口 | 已查看的一手材料 | 可借鉴的交互 | 迁移边界 |
| --- | --- | --- | --- |
| [Claude 官方 Telegram 插件](https://github.com/anthropics/claude-plugins-official/tree/ea10b213686c90bb1984b2016937310e05336cf3/external_plugins/telegram) | 源码、README | 本地处理帮助和状态；编辑进度与完成通知分开；授权详情可展开 | 它是连接 Claude Code 的 channel，不能据此宣称有完整多会话管理 UI |
| [Telecodex](https://github.com/benedict2310/telecodex) | `src/bot-ui.ts` 源码 | 首次欢迎与返回欢迎不同；会话按钮包含目录、标题、时间；帮助分组 | 不照搬其创建、重试、认证等全部命令 |
| [a5c-ai/claude-code-telegram-bot](https://github.com/a5c-ai/claude-code-telegram-bot) | README、`OutputParser.ts` 源码 | 问题选项直接点选，并提供自由输入出口 | CLI 事件解析路径；终端 escape、abort、kill 语义不能直接映射成 Paseo 按钮 |
| [cc-connect](https://github.com/chenhg5/cc-connect) | 飞书及使用文档、issue | 接收确认、处理中、完成三种信号分开；一条消息或卡片持续更新 | 多平台支持不代表所有平台具备相同控件或回调能力 |
| [Claude-to-IM](https://github.com/op7418/Claude-to-IM) | 飞书 adapter 源码 | 飞书流式卡片、更新节流、授权回调进入统一处理路径 | 配套 skill 是同一套方案，不重复算成独立产品 |
| [CodeBridge](https://github.com/Chenkeliang/CodeBridge) | 飞书菜单文档、命令帮助源码 | 原生机器人菜单与命令入口复用；简短帮助与完整帮助分层 | 菜单需要开放平台配置和相应事件处理，不能只改卡片模板 |
| [DSH Feishu channel](https://github.com/whoisjiahao/dsh-feishu-channel) | README、DESIGN、三张客户端截图 | 小型状态栏、正文优先、活动记录折叠 | 截图是仓库发布，未亲自运行；桌面截图不能证明手机体验 |
| [lark-acp-bridge](https://github.com/wthislifehuh/lark-acp-bridge) | README | 一任务一卡、权限与任务状态关联 | 文档中的 mock 示例不能当实机截图；部分高级操作需要对应后端能力 |
| [HAPI](https://github.com/tiann/hapi) | README、架构和 PWA 文档 | 会话列表、手机授权、状态同步与通知分工 | Telegram Mini App 是嵌入的 Web 客户端，不等于普通机器人消息 |
| [Happy](https://github.com/slopus/happy) | 当前 README | 本地与移动端接续会话的整体产品定位 | 当前 README 同时介绍 HappyHarness 与原 Happy CLI，需分清版本和产品形态 |
| [OpenClaw](https://docs.openclaw.ai/concepts/queue) | 官方队列文档 | 忙碌时新消息的含义明确：插入、后续、合并、打断各不相同 | 我们应说明 Paseo 的实际行为，不为复制菜单而新增队列系统 |

### Claude 官方入口给出的两个直接答案

其 Telegram 源码直接注册 `/start`、`/help`、`/status`，由插件响应；源码指示助手编辑消息来汇报进度，长任务结束另发回复。它还提供授权详情展开。我们要求帮助走插件本地处理，有直接参考。[命令处理](https://github.com/anthropics/claude-plugins-official/blob/ea10b213686c90bb1984b2016937310e05336cf3/external_plugins/telegram/server.ts#L691-L733)、[进度与完成](https://github.com/anthropics/claude-plugins-official/blob/ea10b213686c90bb1984b2016937310e05336cf3/external_plugins/telegram/server.ts#L407-L415)、[授权按钮](https://github.com/anthropics/claude-plugins-official/blob/ea10b213686c90bb1984b2016937310e05336cf3/external_plugins/telegram/server.ts#L420-L450)。

这里要区分“插件本地命令”和“模型自行调用发消息工具”。我们的常用控制动作应由插件确定处理，避免响应时间和模型判断影响导航。

## 3. 广泛筛选：其余 16 个样本

这些样本用于扩展视野。已核对仓库及项目定位；其中部分由子代理阅读 README，未逐项独立审查所有功能。此表不是功能通过测试清单。

| 项目 | 定位 / 本轮用途 |
| --- | --- |
| [Claudegram](https://github.com/NachoSEO/claudegram) | Telegram 到 Claude Code 的桥接；长回复与会话体验的补充样本 |
| [Codex Console](https://github.com/InDreamer/telegram-codex-bridge) | 项目、会话、运行状态卡片；观察信息层级 |
| [ccgram](https://github.com/alexei-led/ccgram) | tmux / 终端桥接；与结构化会话协议的能力边界不同 |
| [telegram-claude-codex](https://github.com/Mark-Life/telegram-claude-codex) | 多 provider、会话和队列；观察忙碌时输入的说明 |
| [heyagent](https://github.com/gergomiklos/heyagent) | Claude / Codex Telegram 桥；观察终端与手机接续 |
| [overwirehq/claude-code-telegram](https://github.com/overwirehq/claude-code-telegram) | 项目和会话持久化；观察控制命令组织 |
| [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) | 原生飞书/Lark，项目自述有流式卡片和按聊天区分会话 |
| [larkway](https://github.com/chuckwu0/larkway) | 飞书团队使用；多人和群聊模式与我们的单 owner 私聊不同 |
| [clibot](https://github.com/keepmind9/clibot) | ACP 到多个 IM；作为跨平台能力差异样本 |
| [im-cli-bridge](https://github.com/tmwgsicp/im-cli-bridge) | 多 IM、多 CLI；不能把平台支持列表当 UI 一致性证明 |
| [loomlet](https://github.com/plfccc/loomlet) | Telegram / 飞书编排；调度层超出本轮范围 |
| [codex-im-connector](https://github.com/fish106/codex-im-connector) | 飞书私聊、Codex SDK；与单用户机器人接近 |
| [Paige](https://github.com/Tao-Ma/paige) | tmux 到飞书话题，项目自述有可点击权限/选项卡 |
| [nanobot](https://github.com/HKUDS/nanobot) | 通用 IM agent 框架；用于渠道模式参考，不当作已有编码会话客户端 |
| [AgentAPI](https://github.com/coder/agentapi) | HTTP agent 接口；截至调研日仓库已归档，主要参考消息/状态边界 |
| [CloudCLI / Claude Code UI](https://github.com/siteboon/claudecodeui) | Web 和移动会话管理；完整网页布局不适合直接塞进飞书卡片 |

## 4. 按用户任务提炼交互

### 4.1 找入口：固定菜单 + 小型帮助卡

Telegram 有命令菜单、内联按钮和 Mini App 等不同入口；飞书应使用自身的机器人菜单和卡片。两平台都能提供操作入口，但组件和配置方式不同。[Telegram 官方交互说明](https://core.telegram.org/bots/features#inputs)、[飞书机器人概述](https://open.feishu.cn/document/client-docs/bot-v3/bot-overview)。

CodeBridge 的菜单文档和路由源码展示了事件键与命令复用的做法。[菜单配置](https://github.com/Chenkeliang/CodeBridge/blob/42fbd9056249dc5b5ace73f92e450a35274052c6/docs/zh-CN/feishu-bot-menu.md)、[帮助与映射](https://github.com/Chenkeliang/CodeBridge/blob/42fbd9056249dc5b5ace73f92e450a35274052c6/packages/router/src/command-help.ts)。

**建议：**输入框旁的固定菜单为“会话 / 历史 / 帮助”。帮助首屏说明普通文字发往哪里，并给出四个常用操作；详细命令作为次级内容。菜单、卡片、斜杠命令使用相同处理逻辑，不让 agent 再解释一次。

```text
Paseo · 帮助
普通文字会发送给当前会话。
当前：修复登录问题 · paseo-feishu

[选择会话]  [查看状态]
[历史消息]  [命令说明]
```

未绑定时把第一句改为“先选择一个已有会话，再发送消息”。Paseo 断开时，帮助仍可显示；状态明确指出断开的部分。仅为已授权用户提供这些信息。

### 4.2 找对会话：标题、目录、状态比 ID 更重要

Telecodex 的按钮标签组合了工作目录、标题、相对时间和模型，并区分首次欢迎与已有会话的返回欢迎。[UI 源码](https://github.com/benedict2310/telecodex/blob/main/src/bot-ui.ts)。

**建议：**保留现有会话选择能力，改善识别信息和切换反馈。当前绑定是“当前”标记，执行状态另列；不能用一个绿色标题同时表示“已绑定”“连接正常”“任务成功”。

```text
选择会话
当前：修复登录问题

● 修复登录问题
  paseo-feishu · Claude · 处理中 · 2 分钟前
  [当前会话]

  调整文档导航
  website · Codex · 空闲 · 18 分钟前
  [切换到此会话]

[上一页]  [下一页]  [刷新]
```

切换成功后显示目标标题和目录，说明“后续消息发往这里”。若旧会话仍运行，说明切换不会停止旧任务。页码、总数和刷新时间只显示实际取得的数据。

### 4.3 等回复：接收确认、进度和通知分别设计

cc-connect 文档把接收确认与实际处理区分开，并提供持续编辑同一消息/卡片的形式；同时说明编辑卡片与完成通知不同。[飞书说明](https://github.com/chenhg5/cc-connect/blob/2dec7173bdd44ec598c3c7e5c7ff00407acfdedf/docs/feishu.md#L114-L131)。

**建议：**每个请求先给出准确的接收状态；开始执行后，同一张回复卡持续呈现公开的助手进展及当前活动。无需等待最终回答才让用户看到内容。用实际事件更新状态，不编造百分比、步骤总数或剩余时间。

```text
修复登录问题 · 处理中
已用 32 秒 · 最近更新 3 秒前

已定位到登录回调，正在检查重定向参数。

当前活动：读取 auth/callback.ts
▸ 活动记录

[查看会话状态]
```

这里的进展来自对用户公开的助手说明和工具活动，不显示模型隐藏推理。没有新事件时保留最近活动时间；连接丢失应改成“连接中断，正在确认状态”，不能一直显示“正在处理”。

**完成方案建议：**原卡保留完整结果，再发一条短提示，如“「修复登录问题」已完成，结果见上方”。不要重复整篇回答。它解决离开聊天后的可发现性；新消息、表情回复对手机通知的实际影响，仍需在目标飞书客户端实测。


流式显示还需要控制更新积压。deer-flow 的历史 issue 中，维护者讨论了全卡更新及过时帧重试带来的延迟。[issue #3801](https://github.com/bytedance/deer-flow/issues/3801)。我们的目标应是展示最新状态：合并中间更新、丢弃过时快照，并保证最终结果能落定；具体 API 路径另据当前 SDK 验证。

### 4.4 读结果：正文优先，活动记录可展开

DSH 的仓库截图中，完成卡用紧凑的时间/状态栏，正文下方折叠“分析过程”；其设计文档说明这里呈现活动记录。[完成截图](https://github.com/whoisjiahao/dsh-feishu-channel/blob/604c22079c4398063768566ba6b4e9a17c4f4fde/docs/preview/feishu-reply-completed.png)、[DESIGN](https://github.com/whoisjiahao/dsh-feishu-channel/blob/604c22079c4398063768566ba6b4e9a17c4f4fde/docs/DESIGN.md)。

我们适合借用这种层级：状态占小块空间，结果在前，工具活动按需展开。正文保留 agent 的内容结构，不强制每条回复都变成“结论 + 表格 + 三条建议”，也不为了卡片好看再调用模型重写答案。

```text
修复登录问题 · 已完成 · 用时 1 分 12 秒

已修复回调地址校验，补充了错误提示。
……完整回答、代码和验证结果……

▸ 活动记录（8 条）
[历史消息]  [查看会话状态]
```

长内容必须有可用的完整阅读路径；截断摘要不能冒充完整回答。不要把“复制”作为按钮标签，除非客户端确实能执行复制。正常回复采用克制的标题和层级，注意状态才使用强调色。[飞书消息卡片设计规范](https://open.feishu.cn/document/ukTMukTMukTM/ugDOwYjL4gDM24CO4AjN)。该规范较早，不据此推断当前 Card JSON 2.0 的尺寸或组件限制。

### 4.5 等用户操作：授权卡与问题卡各自说清楚

a5c 的解析器为 `AskUserQuestion` 生成选项，并保留自由输入入口；这与工具权限的允许/拒绝不同。[问题处理源码](https://github.com/a5c-ai/claude-code-telegram-bot/blob/main/src/parser/OutputParser.ts)。

**建议授权卡：**标题说明需要授权，内容说明会话、目录、具体动作和本次范围。默认只有后端真实支持的选项，例如“允许本次 / 拒绝”；不要凭 UI 新增“始终允许”。

```text
需要你授权 · 修复登录问题
目录：paseo-feishu
操作：执行命令
命令：npm run test:auth
范围：本次请求

[允许本次]  [拒绝]
▸ 查看完整参数
```

拒绝是安全的退出动作，通常不应套用表示破坏性操作的红色 danger 样式。点击后先显示“正在提交”，后端确认后才改为“已允许/已拒绝”。若已在 Paseo 处理、会话发生变化或请求失效，明确告知并收起旧按钮，避免旧卡像新请求一样继续诱导点击。

**建议问题卡：**用完整问题和具体选项，不写抽象的“确认/取消”。自由输入必须能关联到对应问题；若现有协议不能表达，就暂不展示该入口。

```text
需要你回答 · 修复登录问题
登录失效后应该跳转到哪里？

[登录页]  [首页]
[输入其他答案]
```

按钮要在手机上能读全，关键内容不能只靠 hover 或颜色区分。cc-connect 曾有已关闭的移动端提问卡问题；它说明“其他按钮能用”不能替代对问题卡的单独验证。[issue #1658](https://github.com/chenhg5/cc-connect/issues/1658)。

### 4.6 看历史：会话记录与飞书消息记录分清楚

**建议：**`/history` 是当前绑定 Paseo 会话的只读浏览，不向 agent 发提示。首屏是最近若干条用户/助手消息，明确角色、时间和会话；工具明细放到次级内容。历史可包含桌面端产生的消息，所以应标注“会话历史”。

```text
会话历史 · 修复登录问题
最近 10 条消息

你 · 14:02
检查一下回调地址为什么丢失……

助手 · 14:03
问题出在重定向参数被覆盖……

[更早消息]  [回到最新]
```

分页只表示已经拿到的范围；没有总数就不显示“第 1/12 页”。加载下一页期间保持上下文，错误时允许重试读取。切换会话后，旧历史卡仍应标明原会话，不能把旧卡按钮悄悄作用到新会话。

### 4.7 忙碌与异常：明确用户这条消息发生了什么

OpenClaw 文档明确区分插入执行中的任务、排成后续轮次、合并输入、打断执行等行为。[队列语义](https://docs.openclaw.ai/concepts/queue)。这提示我们必须说明 Paseo 实际采用的处理方式；“已接收”不够解释下一条消息何时生效。

建议只对真实情况显示“已提交”“已排队”或“当前无法提交”。不支持的队列、停止、重试操作不展示成可用按钮。断线后无法判断提交结果时，显示“提交结果待确认”，先核对状态，不自动重发可能执行过的请求。

诊断也属于 UX。cc-connect 的 issue 报告过显示名查询卡住，让私聊长时间没有日志、之后才执行。[issue #2017](https://github.com/chenhg5/cc-connect/issues/2017)。接收反馈和必要控制动作不应等待显示名等装饰性信息；我们应先报告真实接收/提交阶段，再补齐展示信息。

对本项目已遇到的环境变量问题，设置说明和诊断信息必须写清楚：daemon 继承启动时的环境，插件在启动时读取配置；在另一个 shell 里 export 后仅重载插件，不会更新已运行 daemon 的环境。状态页可以显示脱敏的实际 owner、匹配结果、配置读取时间和连接状态；未授权发送者的排错信息保留在本地日志，避免泄露配置。

## 5. 飞书适配中需要保留的边界

| 容易误搬的做法 | 本项目采用的边界 |
| --- | --- |
| Telegram topic、Mini App、终端图片直接当飞书原生组件 | 分别验证飞书原生菜单、消息卡片和现有会话协议 |
| 编辑卡片等同于手机收到通知 | 将进度呈现与完成提醒分开，并做真机检查 |
| 每个 token 都发一次完整卡片更新 | 展示最新状态，合并过时中间更新；不把旧帧排成长期积压 |
| “思考过程”一律展示 | 仅展示公开助手进展和允许呈现的活动摘要 |
| 点击按钮立即显示成功 | 等待后端确认，处理重复点击及其他客户端先处理的情况 |
| 所有回复都用彩色大标题 | 常规内容用普通层级；等待操作、失败等需要注意时才强调 |
| `/help` 展示几十个高级命令 | 常用操作在首屏，详细说明分层，只展示已支持能力 |
| 按固定秒数认定任务已失败 | 显示最后已知状态和更新时间；超时、断开、失败分别表达 |

没有把“某项目默认分块 2000 字”写成飞书平台硬限制，也没有采纳未经核实的卡片统一过期时间、问题统一 TTL 或全平台通用 QPS。CardKit 流式更新与普通消息卡片更新也不能只凭名称当作同一条 API。

## 6. 建议的改进顺序

以下是下一轮设计与实现的优先级，不是已经完成的功能清单。

| 优先级 | 改进范围 | 可观察的完成条件 |
| --- | --- | --- |
| P0 | 接收、提交、处理、等待操作、完成、断开的统一状态文案 | 用户能知道消息是否收到，以及现在是否需要自己操作 |
| P0 | 动态回复的内容层级和完成提醒 | 中途有真实进展；最终内容落定；手机离开聊天后仍能发现完成 |
| P0 | 帮助首页、会话列表、状态卡共用清晰的会话标识 | 首次使用不背命令；相似标题也能选对目录和会话 |
| P1 | 飞书固定菜单与命令入口一致 | 从菜单与输入命令得到同样结果；本地导航不产生 agent turn |
| P1 | 授权和提问卡、旧卡反馈 | 手机能完成操作；桌面端先处理后再点击旧卡也有准确反馈 |
| P1 | 历史浏览与阅读长回复 | 可向前翻页、回到最新，并始终知道属于哪个会话 |
| P2 | 诊断详情和次级活动记录 | 无需读整段日志也能定位连接/配置阶段，技术细节不占普通回复首屏 |

视觉上先统一卡片的标题、状态行、正文、次级详情和操作区，再调颜色和间距。不要先增设主题选项、密度开关或多种回复样式，让用户替我们选择尚未收敛的设计。

## 7. 下一轮用这些任务验收

1. 手机首次进入，找到会话并发送请求；无需另查命令文档。
2. 三个相似标题、不同目录的会话中，正确选择目标并识别当前绑定。
3. 长任务暂时没有助手正文时，仍能看出真实阶段与最后更新时间；断线不会伪装成持续执行。
4. 收到授权或问题时完成操作；在桌面端先处理后，旧卡给出明确反馈。
5. 执行中查看历史，不产生额外 agent turn；切换会话后旧历史卡仍标明原会话。
6. 提交后立即断网，界面准确表达不确定状态，不诱导重复执行。
7. 手机后台等待任务完成，检查通知、点击后定位、正文完整性和滚动位置。
8. 深色/浅色模式分别检查长标题、中文按钮、长代码块、表格和错误内容。

记录接收反馈延迟、进度新鲜度、按钮到确认结果的延迟、重复消息数，以及用户找到下一步操作所需的点击。当前没有实测基线，因此本文不宣称提升比例或给出已达成的延迟指标。

## 8. 视觉材料与来源复核

DSH 的三张图已查看，适合设计讨论时并排参考。它们是第三方仓库发布的图片，本项目未复制资源，也未在本地复现界面：

- [处理中：紧凑状态栏与工具活动](https://github.com/whoisjiahao/dsh-feishu-channel/blob/604c22079c4398063768566ba6b4e9a17c4f4fde/docs/preview/feishu-command-running.png)
- [完成：正文优先，活动折叠](https://github.com/whoisjiahao/dsh-feishu-channel/blob/604c22079c4398063768566ba6b4e9a17c4f4fde/docs/preview/feishu-reply-completed.png)
- [命令中心：用于讨论首屏信息过多的问题](https://github.com/whoisjiahao/dsh-feishu-channel/blob/604c22079c4398063768566ba6b4e9a17c4f4fde/docs/preview/feishu-command-center.png)

补充的一手材料：

- [Claude-to-IM 飞书 adapter](https://github.com/op7418/Claude-to-IM/blob/main/src/lib/bridge/adapters/feishu-adapter.ts)：卡片流式状态、节流和回调路径。
- [HAPI 架构](https://github.com/tiann/hapi/blob/main/docs/guide/how-it-works.md)、[PWA](https://github.com/tiann/hapi/blob/main/docs/guide/pwa.md)：区分客户端状态同步、授权交互和通知机制。
- [Telegram 流式回复](https://core.telegram.org/bots/features#streaming-replies)：草稿是临时预览，需要另发最终消息才能持久保留；不能把这一平台行为直接当成飞书卡片行为。
- [lark-acp-bridge README](https://github.com/wthislifehuh/lark-acp-bridge/blob/main/README.md)：用于文档级能力筛选，不把 mock 图当实机证据。

固定 commit 的链接用于稳定引用；其他 `main` 分支文档及产品页面可能更新。后续实现应重新核对相应 SDK 和平台接口，尤其是菜单事件、卡片回调、流式更新和客户端通知。
