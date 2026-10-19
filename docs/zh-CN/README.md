<p align="center">
  <img src="../assets/logo.zh-CN.svg" alt="paseo-feishu：在飞书（Feishu/Lark）里继续 Paseo agent" width="480">
</p>

[English](../../README.md) | **简体中文**

# paseo-feishu

人不在电脑前，也能在飞书（Feishu/Lark）私聊里接着用本机已有的 [Paseo](https://github.com/getpaseo/paseo) agent：选会话、发消息、收完成通知、点按钮批准或拒绝权限请求。

它是装在你自己 Paseo daemon 里的服务端插件。不新建 agent，不需要另起网关，也不需要公网地址。

> **状态：实验性。** 已通过真实飞书机器人使用私聊收发、会话导航、动态回复卡和完成通知，并在手机上检查卡片排版。国际版 Lark 和全部权限处理流程尚未完成端到端验证。

## 适用场景

agent 在工作站上跑着，你离开座位后，权限提示没人点，任务结束了也不知道。paseo-feishu 用一条 WebSocket 长连接把一个飞书机器人接到 daemon 上：你在手机上发的文字，会进入你在电脑前用的那个 agent 会话。

它只是遥控器，不是新的 agent 运行时，不会创建、归档或停止任何 agent。daemon 连不上时，它会告诉你消息没发出去，不排队，也不在恢复后补发。

目前的边界是一个 daemon、一个机器人、一个授权用户，只做私聊。

## 能做什么

- 在卡片里选一个已有 agent，之后的文字消息原样发给这个会话。
- agent 工作时持续更新同一张回复卡，一轮结束（完成、失败或取消）后发送简短通知。
- `/help`、`/status`、`/sessions`、`/history` 由插件本地处理，提供历史摘录翻页和适合手机的导航。
- 工具权限请求以带“允许”“拒绝”按钮的卡片送达。无法表达成二选一的请求（计划审阅、提问、模式变更）只提示你回 Paseo 处理。
- 只响应一个指定用户的私聊消息和卡片点击。
- 一个设置项同时支持国内的飞书和国际版 Lark。

机器人的回复和卡片文案在 0.2 版里是中文。

## 安装

要求：已启用插件的 Paseo daemon（0.8.0 或更高）、Node.js 22 或更高、npm，以及一个飞书企业自建应用。创建应用的步骤见[设置](./setup.md)。

```bash
paseo plugin add github:nerdneilsfield/paseo-feishu
```

安装时 Paseo 会运行 `npm install --omit=dev`。想从本地目录安装，把 `github:` 那一段换成目录的绝对路径。

插件的依赖版本不锁定，每次安装都取 `@getpaseo/client` 和 `@larksuite/channel` 的最新版。上游有破坏性更新时，插件可能无法加载。

## 快速开始

先按[设置](./setup.md)建好飞书应用，再继续：

1. 在启动 daemon 的环境里设置三个环境变量，然后重启 daemon。

   ```bash
   export FEISHU_APP_ID=<App ID>
   export FEISHU_APP_SECRET=<App Secret>
   export FEISHU_OWNER_OPEN_ID=<你的 open_id，ou_ 开头>
   ```

2. 运行 `paseo plugin ls`，`paseo-feishu` 一行的状态是 `running`。
3. 在飞书里给机器人发任意一条私聊文字。你会收到“Paseo · 选择会话”卡片；这条消息不会转发给任何 agent。
4. 在卡片上选一个 agent。此后发的文字都会进入该 agent，消息受理后机器人回复“Paseo 已受理（非任务完成），进展将在回复卡显示。”。用 `/help` 打开导航，用 `/history` 查看最近消息。

插件在启动时读取环境变量。重载插件不会导入之后在终端里 export 的新值；修改变量后，等运行中的任务结束，再从更新后的环境重启 daemon。

缺少必需的环境变量时，插件只在日志里写 `missing required env: …`，然后空载。用 `paseo plugin logs paseo-feishu` 查看。

## 配置

| 环境变量 | 必需 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `FEISHU_APP_ID` | 是 | 无 | 应用的 App ID |
| `FEISHU_APP_SECRET` | 是 | 无 | 应用的 App Secret |
| `FEISHU_OWNER_OPEN_ID` | 是 | 无 | 唯一被授权用户的 open_id |
| `FEISHU_DOMAIN` | 否 | `feishu` | `feishu` 为国内版，`lark` 为国际版，其他值按完整 URL 处理（私有部署） |
| `PASEO_URL` | 否 | `ws://127.0.0.1:6767/ws` | daemon 的 WebSocket 地址 |
| `PASEO_PASSWORD` | 否 | 无 | daemon 设了密码时填写，明文 |
| `STATE_FILE` | 否 | `~/.paseo/plugins-data/paseo-feishu/state.json` | 绑定与去重状态文件 |

每个变量、命令、卡片和限制的完整说明见[参考](./reference.md)。

## 文档

- [设置](./setup.md)：创建飞书应用、安装插件、发出第一条消息。
- [参考](./reference.md)：配置、聊天命令、通知、状态文件、已知限制。
- 问题请到 [issue](https://github.com/nerdneilsfield/paseo-feishu/issues) 反馈。

## 开发

```bash
npm install
npm run typecheck
npm test
```

测试用的是 fake 的 Paseo 与飞书端口，只能说明逻辑正确，不能代替真实应用上的端到端验证。

## 许可证

MIT，见 [LICENSE](../../LICENSE)。
