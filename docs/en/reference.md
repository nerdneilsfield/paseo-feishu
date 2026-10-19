**English** | [简体中文](../zh-CN/reference.md)

# Reference

This page lists the configuration, chat commands, message handling rules, notifications, state file, and known limits of paseo-feishu. For installation and first use, see [Setup](./setup.md).

Feishu and Lark are the same product under two names. This page writes "Feishu/Lark" for the product and uses `feishu` in names that appear in code, such as environment variables.

The bot's replies and card labels are Chinese strings in version 0.1. This page quotes them verbatim and gives their meaning.

## Configuration

The plugin reads its configuration only from environment variables. It has no configuration file and no plugin settings. The plugin process reads the variables when it starts, so a variable set after the daemon started has no effect.

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
| `/status` | Replies with the first 8 characters of the bound agent's ID and the binding revision. |

A command must be the whole message. Surrounding whitespace is ignored. Commands are case-sensitive.

## Message handling

For each incoming message, the plugin applies the following rules in order and stops at the first match.

| Condition | Behavior |
| --- | --- |
| The sender is not `FEISHU_OWNER_OPEN_ID`, the chat is not private, or the sender is a bot | Dropped without a reply. |
| The message is not text | Replies "仅支持文本消息，其他类型暂不支持。" (only text is supported). |
| The message is `/sessions` or `/status` | Runs the command. |
| A session switch is in progress | Replies "切换中：此消息未发送，请切换后重发。" (switching; message not sent). |
| No session is bound | Sends the picker card. The message is not forwarded. |
| Paseo is not connected | Replies "Paseo 未连接，消息未发送" (Paseo not connected; message not sent). The message is not queued. |
| A session is bound and Paseo is connected | Sends the message to the bound agent. |

The plugin deduplicates messages by Feishu/Lark `message_id`. If Feishu/Lark redelivers a message, the agent does not receive it a second time. Every branch above, including the rejecting ones, records the `message_id`, so a redelivery does not change the outcome.

After a message is sent to the agent, the bot replies with one of four results:

| Reply | Meaning |
| --- | --- |
| 已发送（非任务完成）到当前会话。 | Paseo accepted the message. This is not the agent's answer. A notification follows when the turn ends. |
| 发送结果不确定，请到 Paseo 核对，未自动重发 | The request was sent but no confirmation came back. The plugin does not resend, to avoid running the prompt twice. |
| 当前会话不可用（不存在或已归档），消息未发送，请重新选择会话。 | The bound agent no longer exists or is archived. |
| Paseo 拒绝了这条消息，消息未发送。 | Paseo rejected the message. |

## Cards

| Card | Title | Buttons |
| --- | --- | --- |
| Session picker | Paseo · 选择会话 | One **切换到此会话** (switch to this session) per agent, shown as **继续此会话** (continue this session) for the bound agent; **上一页** (previous) and **下一页** (next); **刷新** (refresh). |
| Current session | Paseo · 当前会话 | **切换会话** (switch session); **刷新状态** (refresh status). |
| Approval request | Paseo · 审批请求 | **允许** (allow) and **拒绝** (deny). |
| Approval handled | Paseo · 审批已处理 | None. |

The picker shows 5 agents per page. The bound agent comes first. The others are ordered from the most recent to the least recent activity. An agent's status appears as one of 运行中 (running), 空闲 (idle), 异常 (error), 可恢复 (recoverable, the Paseo status `closed`), 启动中 (starting), or 未知 (unknown).

A button carries only an action name, an agent ID, a request ID, and a revision number. The plugin revalidates all of them when you click.

**Old cards expire.** Each new picker card increments the picker revision and records the new card's message ID. If a clicked card's message ID or revision does not match the record, the plugin answers "卡片已过期，请重新打开" (card expired; reopen it). Send `/sessions` to get a current card.

**Callback time limit.** Feishu/Lark requires a response to a card click within 3 seconds. If the handler has not answered after 2.5 seconds, the plugin returns a loading toast, so the response stays inside the limit. Other toasts are info, warning, and error. Switching, refreshing, and approving continue in the background, and the plugin updates the card or sends a text reply when they finish.

**Card format.** Cards use card JSON 2.0, which needs Feishu/Lark client version 7.20 or later. Older clients show the card title and an upgrade prompt.

**Update limits.** Feishu/Lark allows a card update only within 14 days of sending the message, and at most 5 updates per second for one message.

## Notifications

Notifications go only to the currently bound agent. With no bound session, the plugin sends none.

| Event | Condition | What you receive |
| --- | --- | --- |
| An agent turn ends | The agent is the bound agent | `<title> · 已完成` (completed), `<title> · 失败：<error>` (failed), or `<title> · 已取消：<reason>` (canceled). An excerpt follows when the agent produced assistant text. |
| An agent requests permission | The agent is the bound agent | An approval card, or a notice card that says to handle the request in Paseo. |
| A permission request is resolved elsewhere | An approval card for it exists in the chat | The approval card changes to "已在 Paseo 处理" (handled in Paseo). |
| An agent is archived | The agent is the bound agent | A text message that the binding is no longer usable and you must select a session again. |

`<title>` is the agent's title. If the agent has none, it is the first 8 characters of the agent ID.

**Excerpt.** The excerpt joins the consecutive assistant message chunks at the end of the turn and truncates the result to 1200 characters. It stops at the first non-assistant timeline entry, such as a tool call, when reading backward.

**Approval cards and notice cards.** The plugin builds an approval card with buttons only when the permission kind is a tool call and its actions are exactly one allow and one deny. Every other request gets a notice card that tells you to handle it in Paseo, with no buttons. Examples are free-text questions, plan reviews, mode changes, and requests with more than two actions.

**No retry.** If sending a notification fails, the plugin logs the failure and does not retry. It records each notification's idempotency key before sending, so the same turn of the same agent, or the same permission request, never notifies twice. The cost is that a notification whose sending failed is not resent.

**Which approval cards get updated.** When a request is resolved elsewhere, the plugin can update only approval cards it sent during the current run, up to the most recent 500. After a restart, approval cards sent earlier are not updated. If you click a button on such a card, the plugin first asks Paseo whether the request is still pending. For a handled request it answers "该请求已处理" (request already handled) and submits nothing.

## Approvals

When you click **允许** or **拒绝**, the plugin:

1. Checks the revision, the request ID, and that the request is still pending.
2. Submits the decision to Paseo.
3. Queries Paseo again to confirm the request left the pending list.
4. Updates the card to "已允许" (allowed) or "已拒绝" (denied).

Repeated clicks on the same request submit it once. If step 3 finds the request still pending, the bot replies "审批未成功（failed）…" and does not submit again. A later click on the same card takes the "already handled" path. If Paseo did apply the decision and only its state was slow to update, this reply is a false alarm, so check in Paseo.

## State file

The default path is `~/.paseo/plugins-data/paseo-feishu/state.json`, with mode `0600`. The plugin writes a temporary file, calls `fsync`, and then atomically replaces the state file.

| Field | Contents | Limit |
| --- | --- | --- |
| `binding` | The bound agent ID, chat ID, user open_id, binding revision, and the message ID of the picker card | 1 entry |
| `deliveries` | Handled message IDs with a state: `claimed`, `accepted`, `rejected`, or `unknown` | Newest 500 |
| `notified` | Idempotency keys of sent notifications | Newest 500 |
| `decidedPermissions` | Handled permission request IDs with a result: `allow`, `deny`, or `resolved_elsewhere` | Newest 500 |

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
| `[session] <scope> failed (<kind>)` | A step of session handling failed. The log records the error kind only, not message content. |
| `[paseo-feishu] <scope>: <message>` | An error in notifications or startup wiring. |

The log code does not write the App Secret, the Paseo password, or message text. Error lines contain the message of the underlying library error, so review a log before you share it.

## Lifecycle

- At startup, the plugin starts the Paseo connection without waiting for it, loads the state file, and then starts the Feishu/Lark long connection. A Paseo connection failure is only logged, and the Feishu/Lark connection still starts. The SDK reconnects to Paseo automatically, and until it connects, messages get "Paseo 未连接，消息未发送".
- If loading the state file fails, including when the file is corrupt, the Feishu/Lark connection does not start and the plugin stays idle.
- When the plugin stops, it closes the Feishu/Lark connection, the session handler, and the Paseo connection in parallel. The stop budget is about 4 seconds, after which the host terminates the plugin process.
- The plugin never creates, archives, detaches, or stops an agent. Stopping the plugin does not affect running agents.

## Known limits

- One daemon, one bot, one authorized user, private chat only.
- Text input only.
- Messages sent while Paseo is disconnected are neither queued nor resent.
- Failed notifications are not retried.
- Deduplication and idempotency records keep the newest 500 entries each.
- Dependency versions are not pinned. An upstream breaking change can make the plugin fail to load or run, and the plugin then needs an update.
- Not yet verified against a real Feishu/Lark app: the long connection, card rendering and button callbacks, the 3-second callback limit, and real message delivery. Not yet verified on a real daemon: the `turn_ended` and permission hooks firing, sending a message to an agent, submitting an approval, and connecting with a password.
