# 设置与使用

本文带你完成三件事：创建并配置飞书应用，把插件装进本机 Paseo daemon，在飞书里完成第一次对话。配置项的完整说明见 [reference.md](./reference.md)。

## 开始前

你需要：

- 一台已运行 Paseo daemon 的机器，daemon 版本不低于 0.8.0。
- Node.js 22 或更高版本，以及 npm。daemon 安装插件时会运行 `npm install --omit=dev`，该机器需要能访问 npm 仓库。
- 一个能创建企业自建应用的飞书账号。如果你的企业限制应用发布，需要管理员审批版本。
- 能修改 daemon 启动环境的权限。

> **Caution：** Paseo 插件不在沙箱里运行。服务端代码和安装时的 `npm install` 以 daemon 用户的权限执行，依赖包的后续更新也属于你所信任的代码。本插件的依赖版本不锁定，每次安装取最新版本。

## 1. 创建飞书应用

以下界面名称取自飞书开放平台的官方文档。控制台改版后位置可能不同。

1. 登录[飞书开发者后台](https://open.feishu.cn/app)，创建**企业自建应用**。
2. 在 **基础信息 > 凭证与基础信息** 页面，记下 **App ID** 和 **App Secret**。App Secret 等同密码，不要提交到仓库或贴进聊天。
3. 在 **应用能力 > 添加应用能力** 页面，添加**机器人**能力。

## 2. 开通权限

在 **开发配置 > 权限管理 > API 权限** 页面，开通以下应用身份权限：

| 权限标识 | 用途 |
| --- | --- |
| `im:message.p2p_msg:readonly` | 读取用户发给机器人的单聊消息 |
| `im:message:send_as_bot` | 以应用身份发送消息 |

插件还会更新已发出的卡片（选择会话后把卡片改成“当前会话”，审批后把按钮改成结果）。更新卡片所需的权限标识我没能在官方文档里核实。如果卡片更新失败，到权限管理页搜索“消息”相关权限，开通与“更新应用发送的消息卡片”对应的一项；插件日志里也会记录失败的类别。

插件只处理私聊，所以不需要群聊权限。

## 3. 取得你的 open_id

插件只响应一个用户。这个用户用 open_id 标识，以 `ou_` 开头。open_id 在不同应用之间不通用，必须取**你这个应用**下的 open_id。注意区分：`cli_` 开头的是 App ID，不是 open_id。

1. 打开[飞书 API 调试台](https://open.feishu.cn/api-explorer)。
2. 搜索“发送消息”接口，在 **Query 参数**页把 `user_id_type` 设为 `open_id`，点击**复制 open_id**。
3. 在弹出的组织架构里选择你自己，点击**复制成员 ID**。
4. 确认复制到的值以 `ou_` 开头。

另一种办法是调用“通过手机号或邮箱获取用户 ID”接口，需要额外开通 `contact:user.id:readonly` 权限。

## 4. 设置环境变量并安装插件

环境变量必须在 **daemon 进程**里存在，插件子进程才会继承。在启动 daemon 的环境里设置：

```bash
export FEISHU_APP_ID=<App ID>
export FEISHU_APP_SECRET=<App Secret>
export FEISHU_OWNER_OPEN_ID=<你的 open_id>
```

占位符 `<…>` 替换为你在前面步骤取得的值。daemon 如果已在运行，设置后重启它。如果 daemon 是由 systemd、launchd 或桌面应用拉起的，需要把变量写到对应的服务配置里，而不是只在当前终端里 `export`。

如果 daemon 设置了密码，同时设置 `PASEO_PASSWORD`。如果 daemon 不在默认地址 `ws://127.0.0.1:6767/ws` 上，设置 `PASEO_URL`。

接着开启插件功能并安装：

1. 在 Paseo 应用的 **Settings > Plugins** 里打开 **Enable plugins**。这是整台 daemon 上所有插件的总开关，对应 `config.json` 里的 `pluginsEnabled`。如果你直接改了配置文件，运行 `paseo reload` 使其生效，不需要重启 daemon。
2. 运行安装命令，路径换成本仓库的绝对路径：

   ```bash
   paseo plugin add <插件目录>
   ```

3. 确认插件在运行：

   ```bash
   paseo plugin ls
   ```

   `paseo-feishu` 一行的状态应为 `running`。

4. 查看日志，确认没有缺失变量的提示：

   ```bash
   paseo plugin logs paseo-feishu
   ```

   日志里应出现 `Plugin ready`。如果出现 `missing required env: …`，说明列出的变量没有传进 daemon 进程，见下文排错。

## 5. 建立长连接并配置订阅

插件通过长连接接收事件和卡片回调，不需要公网地址。

飞书要求先有一个已连上的客户端，才能保存“长连接”订阅方式，所以这一步放在插件运行之后。

1. 在 **开发配置 > 事件与回调 > 事件配置** 页面，把**订阅方式**设为**使用长连接接收事件**，保存。
2. 在**已添加事件**区域，添加**接收消息**事件（`im.message.receive_v1`）。
3. 在 **开发配置 > 事件与回调 > 回调配置** 页面，把**订阅方式**设为**使用长连接接收回调**，保存。
4. 在**已订阅的回调**区域，添加**卡片回传交互**回调（`card.action.trigger`）。

少订阅回调不会影响收发文本，但点击卡片上的按钮不会有任何反应。

## 6. 发布应用

在 **应用发布 > 版本管理与发布** 页面，点击**创建版本**，填写版本信息并申请发布。权限、事件和回调的变更都要发布新版本后才生效。如果企业要求管理员审核，等审核通过后再继续。

## 7. 第一次对话

1. 在飞书里搜索你的机器人，打开与它的单聊。
2. 发送任意一条文字消息。
3. 你应收到一张标题为“Paseo · 选择会话”的卡片，列出本机已有的 agent，每页 5 个。这条消息不会被转发给任何 agent。
4. 在卡片上选择一个 agent，点击**切换到此会话**。卡片会更新为“Paseo · 当前会话”。
5. 发送一条文字消息。机器人回复“已发送（非任务完成）到当前会话。”，同一条消息出现在该 agent 的对话里。
6. 等该 agent 的这一轮结束，你会在飞书收到“<会话标题> · 已完成”和一段摘要。

如果没有收到卡片，见“排错”。

## 日常使用

- 发送文字：已绑定时，普通文字消息直接作为 agent 的提示词发出。
- 切换会话：点击当前会话卡上的**切换会话**，或发送 `/sessions`。
- 查看当前绑定：发送 `/status`。
- 刷新状态：点击卡片上的**刷新**或**刷新状态**。
- 审批：agent 请求权限时，飞书会收到“Paseo · 审批请求”卡片，点击**允许**或**拒绝**。如果你已在 Paseo 里处理了该请求，再点会提示“该请求已处理”。

只支持文字。图片、文件等其他类型的消息会收到“仅支持文本消息，其他类型暂不支持。”

## 排错

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `paseo plugin ls` 里没有 `paseo-feishu`，或状态是 `disabled` | **Enable plugins** 没打开 | 在 **Settings > Plugins** 打开总开关；改了配置文件则运行 `paseo reload` |
| 安装时报 `__dirname is not defined` | 使用了没有包含 `server/shim.ts` 的旧版本 | 更新本仓库到最新版本后重新安装 |
| 安装时报 `requires Paseo <0.8.0` | `paseo-plugin.json` 缺少 `requirements.paseo` | 恢复该字段，值为 `>=0.8.0` |
| 日志出现 `missing required env: …` | 变量没有传进 daemon 进程 | 把变量写进 daemon 的启动环境后重启 daemon，不要只在当前终端 `export` |
| 日志出现 `could not resolve bot identity` | App ID 或 App Secret 错误，或应用尚未启用机器人能力 | 核对两个值和机器人能力；注意 App ID 以 `cli_` 开头 |
| 状态是 `running`，但发消息没有任何反应 | 应用没有发布新版本；没订阅 `im.message.receive_v1`；订阅方式不是长连接；发消息的人不是 `FEISHU_OWNER_OPEN_ID` | 逐项核对第 5、6 步；确认 open_id 取自本应用 |
| 能收到卡片，点按钮没反应或报错 | 没添加 `card.action.trigger` 回调，或回调订阅方式不是长连接 | 核对第 5 步的第 3、4 点 |
| 机器人回复“Paseo 未连接，消息未发送” | 插件连不上 daemon：地址错误、密码错误，或 daemon 刚重启 | 核对 `PASEO_URL` 和 `PASEO_PASSWORD`；查看日志里的连接错误 |
| 机器人回复“发送结果不确定，请到 Paseo 核对，未自动重发” | 消息已提交但没拿到确认 | 到 Paseo 里查看该 agent 的对话，决定是否重发 |
| 机器人回复“当前会话不可用（不存在或已归档）…” | 绑定的 agent 已被删除或归档 | 重新选择会话 |
| 提示“卡片已过期，请重新打开” | 点击的是旧卡片 | 发送 `/sessions` 打开新卡片 |
| 审批点击后提示“审批未成功（failed）…” | 提交后 Paseo 里该请求仍显示待处理 | 到 Paseo 里核对；再点同一张卡会进入“已处理”分支，不会重复提交 |

排查时优先看插件日志：

```bash
paseo plugin logs paseo-feishu
```

插件的日志代码不输出 App Secret、Paseo 密码和消息正文；错误日志只记录错误信息本身，提交日志前仍请自行检查。

## 卸载

```bash
paseo plugin remove paseo-feishu
```

插件停止时会断开飞书长连接和 Paseo 连接，不会影响任何 agent。状态文件不会被自动删除。需要彻底清理时，手动删除状态文件，默认路径为 `~/.paseo/plugins-data/paseo-feishu/state.json`。
