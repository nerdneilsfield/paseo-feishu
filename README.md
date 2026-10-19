<p align="center">
  <img src="docs/assets/logo.svg" alt="paseo-feishu: Paseo agents in Feishu/Lark" width="480">
</p>

**English** | [简体中文](docs/zh-CN/README.md)

# paseo-feishu

Continue your existing [Paseo](https://github.com/getpaseo/paseo) agent sessions from a Feishu/Lark private chat. Pick a session, send it messages, get a notification when a turn ends, and approve or deny permission requests from your phone.

paseo-feishu is a server plugin that runs inside your own Paseo daemon. It does not create agents, run a separate gateway, or need a public URL.

> **Status:** experimental. Feishu private-chat messaging, session navigation, live reply cards, and completion notifications have been exercised with a real bot. Mobile card layout has been checked on a phone. Lark international and every permission flow have not been verified end to end.

## Highlights

- Selects an existing agent from a card, then forwards your text messages to that same agent session.
- Updates a reply card while the agent works, then sends a short notification when the turn completes, fails, or is canceled.
- Handles `/help`, `/status`, `/sessions`, and `/history` locally, with paged history excerpts and mobile-friendly navigation.
- Shows allow/deny buttons for tool permission requests. Requests that cannot be expressed as allow or deny are flagged, and you handle them in Paseo.
- Accepts messages and card clicks from exactly one Feishu/Lark user, in a private chat only.
- Works with both Feishu (China) and Lark (international) through one setting.

## Overview

You run coding agents in Paseo on a workstation. When you leave your desk, the agents keep working, but you can no longer answer a permission prompt or see that a turn finished. paseo-feishu connects one Feishu/Lark bot to the daemon over a long-lived WebSocket connection, so a chat message reaches the same agent session you were using at your desk.

It is a remote control, not a new agent runtime. In version 0.2, the bot's replies and card labels are in Chinese. It never creates, archives, or stops an agent. If the daemon is unreachable, it tells you the message was not sent and does not queue it.

Version 0.2 supports one daemon, one bot, and one authorized user. The author is [nerdneilsfield](https://github.com/nerdneilsfield).

## Installation

Requires a Paseo daemon 0.8.0 or later with plugins enabled, Node.js 22 or later, and npm. You also need a Feishu/Lark custom app; [Setup](docs/en/setup.md) walks you through it.

```bash
paseo plugin add github:nerdneilsfield/paseo-feishu
```

Paseo runs `npm install --omit=dev` during installation. To install from a local checkout instead, pass its absolute path in place of the `github:` source.

The plugin has no pinned dependency versions. Each install resolves the latest `@getpaseo/client` and `@larksuite/channel`, so an upstream breaking change can stop the plugin from loading.

## Quick start

Complete the app setup in [Setup](docs/en/setup.md) first. Then:

1. Set three environment variables in the environment that starts the daemon, and restart the daemon.

   ```bash
   export FEISHU_APP_ID=<your App ID>
   export FEISHU_APP_SECRET=<your App Secret>
   export FEISHU_OWNER_OPEN_ID=<your open_id, starting with ou_>
   ```

2. Run `paseo plugin ls`. The `paseo-feishu` row shows the status `running`.
3. Send any text message to the bot in a private chat. You receive a "Paseo · 选择会话" card, and the message is not forwarded to any agent.
4. On the card, choose an agent. From then on, your text messages go to that agent, and the bot confirms "Paseo 已受理（非任务完成），进展将在回复卡显示。" when a message is accepted. Use `/help` for navigation and `/history` for recent messages.

The plugin reads environment variables at startup. Reloading the plugin does not import later terminal exports; after changing a variable, restart the daemon from the updated environment once running tasks have finished.

If a required variable is missing, the plugin writes `missing required env: …` to its log and stays idle. Check it with `paseo plugin logs paseo-feishu`.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `FEISHU_APP_ID` | Yes | none | App ID of the Feishu/Lark app |
| `FEISHU_APP_SECRET` | Yes | none | App Secret of the Feishu/Lark app |
| `FEISHU_OWNER_OPEN_ID` | Yes | none | open_id of the one authorized user |
| `FEISHU_DOMAIN` | No | `feishu` | `feishu` for China, `lark` for international, or a full URL for a private deployment |
| `PASEO_URL` | No | `ws://127.0.0.1:6767/ws` | WebSocket address of the daemon |
| `PASEO_PASSWORD` | No | none | Plaintext daemon password, if one is set |
| `STATE_FILE` | No | `~/.paseo/plugins-data/paseo-feishu/state.json` | Binding and deduplication state |

The [reference](docs/en/reference.md) documents every variable, command, card, and limit.

## Documentation

- [Setup](docs/en/setup.md): create the Feishu/Lark app, install the plugin, and send your first message.
- [Reference](docs/en/reference.md): configuration, chat commands, notifications, state file, and known limits.
- Report problems in the [issue tracker](https://github.com/nerdneilsfield/paseo-feishu/issues).

## Development

```bash
npm install
npm run typecheck
npm test
```

The tests use fake Paseo and Feishu/Lark ports. They verify logic and do not replace an end-to-end run against a real app.

## License

MIT. See [LICENSE](LICENSE).
