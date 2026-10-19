**English** | [简体中文](../zh-CN/setup.md)

# Setup

This guide walks you through creating and configuring a Feishu/Lark app, installing the plugin into your Paseo daemon, and sending your first message. For every setting, command, and limit, see the [reference](./reference.md).

Feishu and Lark are the same product under two names: Feishu in China, Lark internationally. The steps are the same for both. Only the developer console address and one plugin setting differ, and the guide calls those out.

## Before you begin

You need:

- A machine that runs a Paseo daemon 0.8.0 or later.
- Node.js 22 or later and npm on that machine. The daemon runs `npm install --omit=dev` when it installs the plugin, so the machine must be able to reach the npm registry.
- A Feishu/Lark account that can create a custom (enterprise self-built) app. If your organization restricts app publishing, an administrator must approve the app version.
- The ability to change the environment in which the daemon starts.

> **Caution:** Paseo plugins are not sandboxed. The plugin's server code and the `npm install` that runs at install time execute with the daemon user's permissions, and later updates of the plugin's dependencies are part of the code you trust. This plugin does not pin dependency versions, so each install picks up the latest releases.

## 1. Create the Feishu/Lark app

The console labels below come from the official English Feishu documentation. Labels can differ slightly after a console redesign.

1. Open the developer console and create a **custom app** (also called an enterprise self-built app):
   - Feishu (China): <https://open.feishu.cn/app>
   - Lark (international): <https://open.larksuite.com/app>
2. On **Basic Information > Credentials and Basic Information**, copy the **App ID** and **App Secret**. The App Secret works like a password. Do not commit it or paste it into a chat.
3. On **Application Capabilities > Add Application Capabilities**, add the **Bot** capability.

## 2. Enable permissions

On **Development Configuration > Permission Management > API Permissions**, enable these application-identity permissions:

| Permission | Purpose |
| --- | --- |
| `im:message.p2p_msg:readonly` | Read private-chat messages that users send to the bot |
| `im:message:send_as_bot` | Send messages as the app |

The plugin also updates cards it has already sent, for example to turn a selection card into a "current session" card. The update API accepts any one of `im:message`, `im:message:send_as_bot`, or `im:message:update`, so `im:message:send_as_bot` already covers it. Feishu limits card updates to messages sent within the last 14 days and to 5 updates per second for a single message.

The plugin handles private chats only. You do not need any group-chat permission.

## 3. Get your open_id

The plugin responds to one user, identified by an open_id. An open_id starts with `ou_` and is specific to your app: the same person has a different open_id in a different app. An ID that starts with `cli_` is the App ID, not an open_id.

1. Open the [API Explorer](https://open.feishu.cn/api-explorer).
2. Search for the **Send message** API. On the **Query Parameters** tab, set `user_id_type` to `open_id`, then select **Copy open_id**.
3. In the organization chart that opens, select yourself and choose **Copy Member ID**.
4. Check that the value starts with `ou_`.

Alternatively, call the **Obtain user ID via email or mobile number** API. It needs the extra permission `contact:user.id:readonly`.

## 4. Set environment variables and install the plugin

The plugin process inherits its environment from the daemon, so the variables must exist in the **daemon's** environment. Set them where you start the daemon:

```bash
export FEISHU_APP_ID=<your App ID>
export FEISHU_APP_SECRET=<your App Secret>
export FEISHU_OWNER_OPEN_ID=<your open_id>
```

Replace each `<…>` placeholder with the value from the previous steps. If a service manager or the desktop app starts the daemon, put the variables in that service's configuration. An `export` in your current terminal does not reach it. Restart the daemon after you set them.

**When environment changes take effect:** the daemon inherits its startup environment, and the plugin inherits that environment and reads its configuration when it starts. Running `export` in another terminal or editing a shell configuration file after the daemon starts does not update the running daemon's environment. `paseo plugin reload paseo-feishu` restarts only the plugin; `paseo reload` reloads daemon configuration. Neither imports new environment variables from your terminal. After changing a variable, start the daemon again from the updated environment. A daemon restart interrupts running tasks, so wait for those tasks to finish.

After changing `FEISHU_OWNER_OPEN_ID`, check `ownerId` in the new `startup.config.loaded` entry and confirm its last 6 characters match the expected user. If `feishu.policy.rejected` reports `sender_not_allowed`, compare its `senderId` and `ownerId`: a mismatch means the message reached the plugin, but the sender is not the configured authorized user, so the plugin sends no reply.

Set more variables only if they apply:

- Lark (international): `FEISHU_DOMAIN=lark`. Without it, the plugin connects to Feishu in China.
- A daemon password: `PASEO_PASSWORD=<password>`.
- A daemon that is not at `ws://127.0.0.1:6767/ws`: `PASEO_URL=<address>`.

Then enable plugins and install:

1. In the Paseo app, open **Settings > Plugins** and turn on **Enable plugins**. This is the daemon-wide switch for all plugins and corresponds to `pluginsEnabled` in `config.json`. If you edit the file directly, run `paseo reload`. You do not need to restart the daemon.
2. Install the plugin:

   ```bash
   paseo plugin add github:nerdneilsfield/paseo-feishu
   ```

   To install from a local checkout, pass its absolute path instead of the `github:` source.

3. Check that the plugin is running:

   ```bash
   paseo plugin ls
   ```

   The `paseo-feishu` row shows the status `running`.

4. Read the log:

   ```bash
   paseo plugin logs paseo-feishu
   ```

   The log shows `Plugin ready`. If it shows `missing required env: …`, the listed variables did not reach the daemon process. See [Troubleshooting](#troubleshooting).

## 5. Configure the long connection and subscriptions

The plugin receives events and card callbacks over a long-lived WebSocket connection, so you do not need a public address. Feishu/Lark lets you save the long-connection subscription method only while a client is connected, which is why this step comes after the plugin is running.

1. On **Development Configuration > Events and Callbacks > Event Configuration**, set **Subscription Method** to **Receive events using long connection** and save.
2. In **Added Events**, add **Receive message** (`im.message.receive_v1`).
3. On **Callback Configuration** in the same section, set **Subscription Method** to **Receive callbacks using long connection** and save.
4. In **Subscribed Callbacks**, add **Card callback interaction** (`card.action.trigger`).

Without the callback, text messages still work, but the buttons on cards do nothing.

## 6. Publish the app

Permission, event, and callback changes take effect only after you publish a new app version. On **Application Publishing > Version Management and Publishing**, select **Create Version**, fill in the version details, and request publication. If your organization requires administrator review, wait for approval before you continue.

## 7. Send your first message

1. In Feishu/Lark, find your bot and open a private chat with it.
2. Send any text message.
3. A card titled "Paseo · 选择会话" appears. It lists the agents on your daemon, five per page. The message you sent is not forwarded to any agent.
4. On the card, select **切换到此会话** next to an agent. The card changes to "Paseo · 当前会话".
5. Send a text message. The bot replies "已发送（非任务完成）到当前会话。", and the same text appears in that agent's conversation in Paseo.
6. When the agent finishes its turn, the bot sends "`<title>` · 已完成" with an excerpt of the reply.

If no card arrives, see [Troubleshooting](#troubleshooting).

## Daily use

- **Send a prompt:** while a session is bound, any plain text message goes to the agent as a prompt.
- **Switch session:** select **切换会话** on the current-session card, or send `/sessions`.
- **Check the binding:** send `/status`.
- **Refresh:** select **刷新** or **刷新状态** on a card.
- **Approve or deny:** when the agent asks for permission, a "Paseo · 审批请求" card arrives. Select **允许** or **拒绝**. If you already handled the request in Paseo, the card says so and does nothing.

Only text messages are supported. Other message types get the reply "仅支持文本消息，其他类型暂不支持。"

The bot's replies and card labels are in Chinese in version 0.1. The [reference](./reference.md#cards) lists them with their meanings.

## Troubleshooting

Start with the plugin log:

```bash
paseo plugin logs paseo-feishu
```

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `paseo-feishu` is missing from `paseo plugin ls`, or its status is `disabled` | **Enable plugins** is off | Turn on the switch under **Settings > Plugins**. If you edited the config file, run `paseo reload`. |
| Installation fails with `__dirname is not defined` | The plugin is an old version without `server/shim.ts` | Update the plugin to the latest version and reinstall. |
| Installation fails with `requires Paseo <0.8.0` | `paseo-plugin.json` has no `requirements.paseo` | Restore the field with the value `>=0.8.0`. |
| The log shows `missing required env: …` | The variables did not reach the daemon process | Put them in the daemon's startup environment and restart the daemon. |
| After changing `FEISHU_OWNER_OPEN_ID`, the log still shows the old `ownerId` or `sender_not_allowed` | The plugin still inherits the daemon's old startup environment | Update the environment that actually starts the daemon, then restart it from that environment after running tasks finish. Reloading only the plugin does not import your terminal's new variables. |
| The log shows `could not resolve bot identity` | Wrong App ID or App Secret, the Bot capability is off, or `FEISHU_DOMAIN` does not match your account | Check both values and the Bot capability. For a Lark account, set `FEISHU_DOMAIN=lark`. |
| The plugin is `running` but messages get no reply | The app version is not published, `im.message.receive_v1` is not subscribed, the subscription method is not the long connection, or the sender is not `FEISHU_OWNER_OPEN_ID` | Recheck steps 5 and 6. Confirm that the open_id comes from this app. |
| The card arrives but its buttons do nothing | The `card.action.trigger` callback is not added, or its subscription method is not the long connection | Recheck steps 3 and 4 of section 5. |
| The bot replies "Paseo 未连接，消息未发送" (Paseo not connected, message not sent) | The plugin cannot reach the daemon: wrong address, wrong password, or the daemon just restarted | Check `PASEO_URL` and `PASEO_PASSWORD`, and read the connection error in the log. |
| The bot replies "发送结果不确定，请到 Paseo 核对，未自动重发" (result uncertain) | The message was submitted but the plugin received no confirmation | Look at the agent's conversation in Paseo and decide whether to resend. |
| The bot replies "当前会话不可用（不存在或已归档）…" (session unavailable) | The bound agent was deleted or archived | Select a session again. |
| A card says "卡片已过期，请重新打开" (card expired) | You clicked an old card | Send `/sessions` to get a new one. |
| An approval click returns "审批未成功（failed）…" | After submitting, Paseo still lists the request as pending | Check in Paseo. A second click on the same card takes the "already handled" path and does not submit again. |

The plugin's log code does not write the App Secret, the Paseo password, or message text. Error lines include the message of the underlying library error, so review a log before you share it.

## Uninstall

```bash
paseo plugin remove paseo-feishu
```

Stopping the plugin closes its Feishu/Lark and Paseo connections and does not affect any agent. The state file is not deleted. To remove it, delete `~/.paseo/plugins-data/paseo-feishu/state.json` yourself.

## Further reading

These pages come from outside this project. They can change without notice.

- Feishu: [App configuration instructions](https://open.feishu.cn/document/develop-a-card-interactive-bot/faqs?lang=en-US), the official steps for bot, permission, event, and callback setup.
- Feishu: [How to obtain Open ID](https://open.feishu.cn/document/faq/trouble-shooting/how-to-obtain-openid).
- Feishu: [Update sent message card](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch), including the permission list and update limits.
- Feishu: [Card callback communication](https://open.feishu.cn/document/feishu-cards/card-callback-communication), including the 3-second response limit.
- OpenClaw: [Feishu setup](https://docs.openclaw.ai/channels/feishu/setup), a Feishu/Lark bot setup for another agent gateway. It shows the Feishu versus Lark choice.
- AstrBot: [Connect Feishu](https://docs.astrbot.app/platform/lark.html), a Chinese-language walkthrough with screenshots. It confirms that both the China and international editions support the long connection.
