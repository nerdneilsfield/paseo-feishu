# paseo-feishu

在飞书私聊里继续本机已有的 [Paseo](https://github.com/getpaseo/paseo) agent 会话：选择会话、发送消息、接收完成通知、批准或拒绝权限请求。

这是一个运行在 Paseo daemon 内的服务端插件，不新建 agent，不引入独立的网关或数据库。

**状态：** 已在本机 daemon 上验证插件可加载，并验证了与 Paseo 的连接、列出 agent、刷新 agent。飞书一侧（长连接、卡片渲染与回传、真实消息收发）以及 hook 的真实触发尚未实机验证。

## 能做什么

- 在飞书私聊的卡片里选择一个已有 agent，之后的文本消息原样发给该 agent。
- agent 的 turn 结束时（完成、失败或取消），在飞书收到通知，并附最后一段助手回复的摘要。
- agent 请求工具权限时，在飞书收到审批卡片，可点击允许或拒绝。无法映射成二选一的请求（计划审阅、提问、模式变更），只提示回 Paseo 处理。
- 只响应一个指定用户的私聊。其他用户的消息和卡片点击会被丢弃。

## 限制

- 一个 daemon、一个飞书机器人、一个授权用户，仅私聊。
- 不创建、归档、停止 agent，不镜像完整对话。
- Paseo 未连通时，消息不会排队，也不会在恢复后补发；插件会回复“Paseo 未连接，消息未发送”。
- 通知发送失败不重试。
- 目前只支持 TCP 连接 daemon，不支持 unix socket。

## 安装

要求：Paseo daemon（已启用插件）、Node.js 22 或更高版本、npm、一个飞书企业自建应用。

飞书应用的创建与配置见 [docs/setup.md](./docs/setup.md)。完成后：

```bash
paseo plugin add <插件目录>
```

`<插件目录>` 替换为本仓库的绝对路径。安装时 Paseo 会运行 `npm install --omit=dev`。

## 快速开始

1. 按 [docs/setup.md](./docs/setup.md) 创建飞书应用，取得 App ID、App Secret 和你的 open_id。
2. 在启动 daemon 的环境里设置三个环境变量，然后重启 daemon：

   ```bash
   export FEISHU_APP_ID=<App ID>
   export FEISHU_APP_SECRET=<App Secret>
   export FEISHU_OWNER_OPEN_ID=<你的 open_id，ou_ 开头>
   ```

3. 安装插件（见上文），运行 `paseo plugin ls`，确认 `paseo-feishu` 的状态为 `running`。
4. 在飞书里给机器人发任意一条私聊消息。你应收到一张会话选择卡片，这条消息本身不会转发给任何 agent。
5. 在卡片里选择一个 agent，之后发的文本会进入该 agent 的会话。

## 配置

| 环境变量 | 必需 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `FEISHU_APP_ID` | 是 | 无 | 飞书应用的 App ID |
| `FEISHU_APP_SECRET` | 是 | 无 | 飞书应用的 App Secret |
| `FEISHU_OWNER_OPEN_ID` | 是 | 无 | 唯一被授权的用户的 open_id |
| `PASEO_URL` | 否 | `ws://127.0.0.1:6767/ws` | daemon 的 WebSocket 地址 |
| `PASEO_PASSWORD` | 否 | 无 | daemon 设置了密码时必填，明文 |
| `STATE_FILE` | 否 | `~/.paseo/plugins-data/paseo-feishu/state.json` | 绑定与去重状态文件 |

缺少任一必需变量时，插件只在日志里写出缺失项，然后空载，不会连接飞书或 Paseo。完整说明见 [docs/reference.md](./docs/reference.md)。

## 文档

- [docs/setup.md](./docs/setup.md)：飞书应用设置、安装、验证、排错。
- [docs/reference.md](./docs/reference.md)：配置、命令、卡片、状态文件、日志、已知限制。
- [SPEC.md](./SPEC.md)：产品行为、范围与 16 条验收场景。
- [DESIGN.md](./DESIGN.md)：架构、SDK 接口、并发与恢复设计。

## 开发

```bash
npm install
npm run typecheck
npm test
```

测试使用 fake 的 Paseo 与飞书端口，只能说明逻辑正确，不代表端到端通过。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
