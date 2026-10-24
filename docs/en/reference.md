**English** | [简体中文](../zh-CN/reference.md)

# Reference

This page lists the configuration, chat commands, message handling rules, notifications, state file, and known limits of paseo-feishu. For installation and first use, see [Setup](./setup.md).

Feishu and Lark are the same product under two names. This page writes "Feishu/Lark" for the product and uses `feishu` in names that appear in code, such as environment variables.

The bot's replies and card labels are Chinese strings in version 0.2. This page quotes them verbatim and gives their meaning.

## Configuration

The plugin reads its configuration only from environment variables. It has no configuration file and no plugin settings. The daemon inherits its environment at startup; the plugin inherits that environment and reads its configuration once when it starts. Later terminal exports or shell configuration edits do not update the running daemon's environment. Neither `paseo plugin reload paseo-feishu` nor `paseo reload` imports your terminal's new environment variables. After changing a variable, start the daemon again from the updated environment. A daemon restart interrupts running tasks, so wait for those tasks to finish.

After changing `FEISHU_OWNER_OPEN_ID`, check the last 6 characters of `ownerId` in the new `startup.config.loaded` entry to verify the value in use. `sender_not_allowed` means the SDK received the message, but its sender does not match the plugin's configured authorized user. The daemon can still hold an old value even when your terminal shows the correct one.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `FEISHU_APP_ID` | Yes | none | App ID of the Feishu/Lark app. Starts with `cli_`. |
| `FEISHU_APP_SECRET` | Yes | none | App Secret of the Feishu/Lark app. |
| `FEISHU_OWNER_OPEN_ID` | Yes | none | open_id of the one authorized user. Starts with `ou_`. |
| `FEISHU_DOMAIN` | No | `feishu` | `feishu` or empty: Feishu in China (`https://open.feishu.cn`). `lark`: Lark international (`https://open.larksuite.com`). Any other value is used as a full URL, for a private deployment. The value is case-insensitive for `feishu` and `lark`. |
| `PASEO_URL` | No | `ws://127.0.0.1:6767/ws` | WebSocket address of the Paseo daemon. |
| `PASEO_PASSWORD` | No | none | Plaintext daemon password. Not needed when the daemon has no password. |
| `STATE_FILE` | No | `$PASEO_HOME/plugins-data/paseo-feishu/state.json` | Path of the state file. |
| `PASEO_HOME` | No | `~/.paseo` | Used only to derive the default `STATE_FILE`. |

If any required variable is missing, the plugin writes the missing names to its log and stays idle. It connects to neither Paseo nor Feishu/Lark, and `paseo plugin ls` still shows `running`. An empty string counts as missing.

`PASEO_URL` accepts only a TCP WebSocket address. Unix sockets are not supported.

## Chat commands

Any text outside this table is not a command. While a session is bound, the plugin sends it to the agent as a prompt.

| Input | Effect |
| --- | --- |
| `/sessions` | Sends the session picker card. |
| `/status` | Shows the bound session title, short directory and current state. |
| `/help` | Opens local navigation, including when unbound or Paseo is offline. |
| `/history` | Shows the latest ten user/assistant excerpts and resets the paging position. |
| `/history more` | Shows earlier excerpts; first run `/history`. |

Commands are case-sensitive; surrounding whitespace is ignored. `/sessions` and `/status` must be the whole message. The exact first word `/help` or `/history` is always handled locally, including invalid arguments (which return usage). `/helpful`, other provider commands such as `/compact`, and ordinary Chinese text keep the normal forwarding behavior.

History uses projected SDK pages, filtering out reasoning and tools. Each command scans at most five pages of 50 entries, displays up to ten messages in sequence order, and buffers undisplayed excerpts in memory. Each excerpt is at most 1,000 characters; card text is limited to 12,000 with explicit truncation guidance to Paseo. A successful card send advances the position; failed reads or sends leave it unchanged. Switching, restarting or an invalid timeline cursor resets it. Read errors and gaps are reported separately from empty history. The menu configuration is described in [Setup](./setup.md#optional-bot-menu).

## Message handling

For each incoming message, the plugin applies the following rules in order and stops at the first match.

| Condition | Behavior |
| --- | --- |
| The sender is not `FEISHU_OWNER_OPEN_ID`, the chat is not private, or the sender is a bot | Dropped without a reply. |
| The message is not text | Dropped without a reply. |
| The message is a local command listed above (including invalid `/help` or `/history` arguments) | Runs local navigation or replies with usage, without an agent turn. |
| A session switch is in progress | Replies "切换中：此消息未发送，请切换后重发。" (switching; message not sent). |
| No session is bound | Sends the picker card. The message is not forwarded. |
| Paseo is not connected | Replies "Paseo 未连接，消息未发送" (Paseo not connected; message not sent). The message is not queued. |
| A session is bound and Paseo is connected | Sends the message to the bound agent. |

The plugin deduplicates messages by Feishu/Lark `message_id`. If Feishu/Lark redelivers a message, the agent does not receive it a second time. Messages that pass the channel checks are recorded before local routing or forwarding.

After a message is sent to the agent, the bot replies with one of four results:

| Reply | Meaning |
| --- | --- |
| Paseo 已受理（非任务完成），进展将在回复卡显示。 | Paseo accepted the message. This is not the agent's answer. A notification follows when the turn ends. |
| 发送结果不确定，请到 Paseo 核对，未自动重发 | The request was sent but no confirmation came back. The plugin does not resend, to avoid running the prompt twice. |
| 当前会话不可用（不存在或已归档），消息未发送，请重新选择会话。 | The bound agent no longer exists or is archived. |
| Paseo 拒绝了这条消息，消息未发送。 | Paseo rejected the message. |

## Cards

| Card | Title | Buttons |
| --- | --- | --- |
| Session picker | Paseo · 选择会话 | One **切换** (switch) per unbound agent, a **当前** (current) label in that place for the bound agent; **上一页** (previous) and **下一页** (next); **刷新** (refresh). |
| Current session | Paseo · 当前会话 | **选择会话** (choose session), **历史** (history), **命令说明** (commands). |
| Help | Paseo · 帮助 | The four local navigation buttons. |
| Commands | Paseo · 命令说明 | The command list, plus **帮助** (help) and the other local navigation buttons. |
| History | Paseo · 会话历史（摘录） | **更早** (earlier, when available), **回到最新** (latest), and local navigation. |
| Approval request | Paseo · 审批请求 | **允许本次** (allow once) and **拒绝** (deny). |
| Approval handled | Paseo · 审批已处理 | None. |

Buttons use at most two equal-width columns per row. A single button fills its row, with the native centered label. Deny is a plain button, not a red one: declining is the safe exit, so emphasis stays on the action that actually runs something. Local navigation never points back at the card it is on: the current-session card has no **状态** (status) button, and the commands card returns to the help card with **帮助**.

The picker shows 5 agents per page. The bound agent comes first. The others are ordered from the most recent to the least recent activity. An agent's status appears as one of 运行中 (running), 空闲 (idle), 异常 (error), 已关闭 (closed), 启动中 (starting), or 未知 (unknown).

Each agent takes one block: a bold title, then provider, status, directory, and relative activity time on a second line, with the **切换** (switch) button in the same row. In that right-hand slot the bound agent shows `当前` (current) instead of a button, because switching to it would only send the same card again; the placeholder keeps every title on the same left edge. Activity times are relative ("2 分钟前") rather than clock times, because the question a picker answers is how recent a session is, not what time it was. The full clock format is still used in history excerpts, where each message needs an absolute time.

The reply card leads with the session title and the assistant text, and closes with the last-event time. Header colour marks only states that need you: 处理中 and 正在使用工具 (working) are blue, 等待授权 and 等待回答 (needs approval or an answer) are orange, 已完成 is green, 失败 is red, and 已取消 is grey. While a turn is running with no public assistant text yet, the body reads 等待公开进展… (waiting for visible progress); a finished turn with no text reads 暂无公开助手内容 (no public assistant content).

The channel checks callback structure and identity once. Session actions check the current card and binding; history paging uses the latest history card’s message ID.

**Old cards expire.** Each new picker card increments the picker revision and records the new card's message ID. If a clicked card's message ID or revision does not match the record, the plugin answers "卡片已过期，请重新打开" (card expired; reopen it). Send `/sessions` to get a current card.

**Callback time limit.** Feishu/Lark requires a response to a card click within 3 seconds. If the handler has not answered after 2.5 seconds, the plugin returns a loading toast, so the response stays inside the limit. Other toasts are info, warning, and error. Switching, refreshing, and approving continue in the background, and the plugin updates the card or sends a text reply when they finish.

**No indefinite waiting.** Every wait on a network call has a ceiling, because one hung call used to silence the chat permanently:

| Wait | Ceiling | What recovers |
| --- | --- | --- |
| Live observation becomes ready | 10 s | The submission is refused and says so |
| One card write (progress, picker, final) | 10–15 s | The next frame writes; a hung create is retried instead of abandoned; a stale progress frame cannot repaint a sealed card |
| One timeline page for `/history` | 10 s | The next `/history` runs instead of queueing forever |
| Outbound Feishu/Lark REST call | 20 s | SDK-level; without it a hung API blocks the bot |
| One timeline read for the live card | 20 s | The read slot is released and the card marks its state as unverified; the next frame reads again |

The final-answer read-back has the same 15 s ceiling. When it times out, fails, or only reaches the tail of a long turn, the card says the result is incomplete rather than showing 「暂无公开助手内容」 for a read that merely failed.

A text message whose routing throws still gets a reply saying it was not sent. The history and card limits exist because both run inside a serialized chain: without them, one hung call queued every later request behind it, and the bot answered nothing at all.

Card clicks use their own queue, separate from messages. A message handler that is still waiting therefore cannot block an approval or a picker click.

**Card format.** Cards use card JSON 2.0, which needs Feishu/Lark client version 7.20 or later. Older clients show the card title and an upgrade prompt.

**Update limits.** Feishu/Lark allows a card update only within 14 days of sending the message, and at most 5 updates per second for one message.

## Notifications

Notifications go only to the currently bound agent. With no bound session, the plugin sends none.

| Event | Condition | What you receive |
| --- | --- | --- |
| An agent turn ends | The agent is currently bound and the turn has an ID | The current turn updates its reply card and sends a short notification; a late older turn sends a separate text result. |
| An agent requests permission | The agent is the bound agent | An approval card, or a notice card that says to handle the request in Paseo. |
| A permission request is resolved elsewhere | An approval card for it exists in the chat | The approval card changes to "已在 Paseo 处理" (handled in Paseo). |
| An agent is archived | The agent is the bound agent | A text message that the binding is no longer usable and you must select a session again. |

`<title>` is the agent's title. If the agent has none, it is the first 8 characters of the agent ID.

**Live replies.** The plugin updates one card from public assistant messages, at most once per second. The final card shows up to 12,000 characters. If the card fails, a text notification carries the result. A late end event from the currently bound agent gets a separate text result with its turn ID, once; it does not change the current reply card. End events without a turn ID are ignored. Retired cards are not cached.

The end-event payload no longer carries the conversation (Paseo 0.13 sends an empty `timeline`). The final answer is read back by `turnId` through `context.paseo.agents.ref(...).timeline.refetch`, paging backwards at most 10 pages of 100 entries. A turn longer than that yields only the tail of its answer. If the read fails, the notification is sent without body text.

**Approval cards and notice cards.** The plugin builds an approval card with buttons only when the permission kind is a tool call and its actions are exactly one allow and one deny. Every other request gets a notice card that tells you to handle it in Paseo, with no buttons. Examples are free-text questions, plan reviews, mode changes, and requests with more than two actions.

**No retry.** If sending a notification fails, the plugin logs the failure and does not retry. It records each notification's idempotency key before sending, so the same turn of the same agent, or the same permission request, never notifies twice. The cost is that a notification whose sending failed is not resent.

**Which approval cards get updated.** When a request is resolved elsewhere, the plugin can update only approval cards it sent during the current run, up to the most recent 500. After a restart, approval cards sent earlier are not updated. If you click a button on such a card, the plugin first asks Paseo whether the request is still pending. For a handled request it answers "该请求已处理" (request already handled) and submits nothing.

## Approvals

When you click **允许本次** or **拒绝**, the plugin:

1. Checks the current agent and chat, then reads the pending request once and verifies its allow/deny actions.
2. Submits the decision to Paseo.
3. Queries Paseo again to confirm the request left the pending list.
4. Updates the card to "已允许" (allowed) or "已拒绝" (denied).

Repeated clicks on the same request submit it once. If step 3 finds the request still pending, the bot replies "审批未成功（failed）…" and does not submit again. A failed confirmation is not recorded as handled. Check in Paseo before deciding whether to retry.

## State file

The default path is `~/.paseo/plugins-data/paseo-feishu/state.json`, with mode `0600`. The plugin writes a temporary file, calls `fsync`, and then atomically replaces the state file.

| Field | Contents | Limit |
| --- | --- | --- |
| `binding` | The bound agent ID, chat ID, user open_id, binding revision, and the message ID of the picker card | 1 entry |
| `deliveries` | Handled message IDs with a state: `claimed`, `accepted`, `rejected`, or `unknown` | Last 500 inserted |
| `notified` | Idempotency keys of sent notifications | Last 500 inserted |
| `decidedPermissions` | Handled permission request IDs with a result: `allow`, `deny`, or `resolved_elsewhere` | Last 500 inserted |

The file does not store conversation content, passwords, or the App Secret.

The plugin drops records beyond each limit. After a restart, if Feishu/Lark redelivers an old message whose ID has fallen out of the newest 500, the plugin can forward it again.

**A corrupt state file.** If the file is not valid JSON or does not match the expected structure, the Feishu/Lark connection does not start, the log reports the file path, and the plugin does not overwrite the file. Repair or delete the file, then reload the plugin with `paseo plugin reload paseo-feishu`. Deleting the file loses the binding, so you must select a session again.

## Logs

Read the log with `paseo plugin logs paseo-feishu`. Common entries:

| Entry | Meaning |
| --- | --- |
| `Plugin ready` | The plugin loaded. It does not mean Feishu/Lark or Paseo is connected. |
| `missing required env: …` | The listed required variables are missing. The plugin stays idle. |
| `could not resolve bot identity …` | Feishu/Lark rejected the App ID or App Secret, the Bot capability is off, or the domain does not match the account. |
| `startup.session.loading` / `startup.session.ready` | State loading started / the session is ready. |
| `feishu.connected` / `paseo.connected` | The corresponding connection is established. `startup.ready` includes the current `paseoConnected` state. |
| `feishu.event.observed` | The SDK observed a message event, with its ID and type. This observer runs after the SDK's built-in handler. |
| `feishu.policy.rejected` / `feishu.message.rejected` | SDK policy / plugin filtering rejected a message. `reason` explains why; user IDs show only their last 6 characters. |
| `session.routed` | The message entered a command or forwarding branch. `/status` produces `action=status`. |
| `session.consume.started` / `session.consume.succeeded` | Saving the message deduplication state started / finished. A lone started entry can indicate a stalled state write. |
| `feishu.send.started` / `feishu.send.succeeded` / `feishu.send.failed` | A reply send started / succeeded / failed, including elapsed time and error details supplied by the SDK. |
| `feishu.channel.error` / `session.failed` / `startup.failed` | An SDK, session, or asynchronous startup failure. |
| `feishu.reconnecting` / `feishu.reconnected` | The Feishu/Lark connection is reconnecting / restored. |

New entries use a `[paseo-feishu]` prefix followed by one line of JSON. During message handling, `sourceMessageId` links routing and reply sends to the same input message. Error entries extract the error type, code, reason, HTTP status, Feishu/Lark API code, and request ID when the SDK supplies them. They do not serialize complete requests, responses, or raw events. Known App Secrets, Paseo passwords, Bearer tokens, and URL query parameters are redacted.

To investigate a missing reply, send `/status` in private chat, then rerun `paseo plugin logs paseo-feishu`. The command returns a snapshot rather than following live output. For rejection entries, inspect `reason`. After `session.routed`, use the same `sourceMessageId` to follow state saving and reply delivery. Error messages come from underlying libraries; review the log for sensitive content before sharing it.

## Lifecycle

- At startup, the plugin starts the Paseo connection without waiting for it, loads the state file, and then starts the Feishu/Lark long connection. A Paseo connection failure is only logged, and the Feishu/Lark connection still starts. The SDK reconnects to Paseo automatically, and until it connects, messages get "Paseo 未连接，消息未发送".
- If loading the state file fails, including when the file is corrupt, the Feishu/Lark connection does not start and the plugin stays idle.
- When the plugin stops, it closes the Feishu/Lark connection, the session handler, and the Paseo connection in parallel. The host enforces its stop deadline.
- The plugin never creates, archives, detaches, or stops an agent. Stopping the plugin does not affect running agents.

## Known limits

- One daemon, one bot, one authorized user, private chat only.
- Text input only.
- Messages sent while Paseo is disconnected are neither queued nor resent.
- Failed notifications are not retried.
- Deduplication and idempotency records keep the newest 500 entries each.
- Dependency versions are not pinned. An upstream breaking change can make the plugin fail to load or run, and the plugin then needs an update.
- Not yet verified against a real Feishu/Lark app: the long connection, card rendering and button callbacks, the 3-second callback limit, and real message delivery. Not yet verified on a real daemon: the `turn_ended` and permission hooks firing, sending a message to an agent, submitting an approval, and connecting with a password.
