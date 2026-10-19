# 待用户拍板的细节

流程不因这些停下。每条写明：问题、我先采用的默认、理由。

## D1 插件如何拿到 paseo（飞书消息不经 hook）—— 已定，不需你拍板
- 采用方案 C：插件内自建 createPaseoClient；hook 里用 context.paseo。依据与 oracle 全文：/tmp/advice-paseo-access.md，事实见 FINDINGS.md。
- 需你拍板的细节 D1a：Paseo 密码放哪。默认：先读环境变量 PASEO_PASSWORD，没有再读插件 settings（0600 文件）；daemon 没设密码则都不用。
- 需你拍板的细节 D1b：Paseo 地址默认 ws://127.0.0.1:6767/ws，可由配置覆盖。unix socket 监听 v0.1 不支持。

以环境变量为主，没有采用文件。
默认直接先走 tcp 吧。

## 已发现并更正的调研错误（无需你处理，供参考）
- task-4 报告写 timeline 单页 100，实际 TIMELINE_FETCH_PAGE_SIZE=40（paseo/packages/app/src/timeline/timeline-fetch-policy.ts:3）。
- task-1 报告称本地无 plugin-examples/，实际有 14 个示例。
- 我自己早先的 FINDINGS 第 1 条"认证风险不存在"是错的，已按 oracle 更正。
- task-3 报告写"chatQueue 默认关"，实际默认 true（channel-sdk-node/src/safety/index.ts:75）。已按源码改 DESIGN §5.3。

## D2 依赖版本锁定
- **已定（用户）：不锁版本。** 依赖写 `*`，不兼容就让它崩，提示升级。已执行：package.json 全部 `*`；删除 package-lock.json 并加入 .gitignore；build 改为 `npm install --omit=dev`（没有 lockfile，`npm ci` 会失败）；`requirements.paseo` 保留 `>=0.8.0`（去掉会被宿主按旧插件拒绝安装，实测）。
- 代价：每次安装取最新，上游破坏性更新会让插件加载失败；这是你要的行为。

不要锁太死......应该让它崩溃，才能提示我们要升级支持。因为这些项目一天一个版本，难道我一天就要更新一次吗？尽量不要客户的版本，能用就行，不能用再说。这些 API 一般不会大变的。

## D3 是否开启本机 daemon 的 pluginsEnabled（需你拍板，我未动）
- 现状：~/.paseo/config.json 未设置 pluginsEnabled，`paseo plugin ls` 为空。
- 为什么不替你开：DESIGN §8 要求"不要自动开启 Paseo 全局 pluginsEnabled；安装者须明确许可"，且它是对你整台 daemon 的全局改动。
- 影响：不开则无法做真实的 plugin loading / hook 实机验证；其余（类型检查、fake-port 单测、打包加载、client loopback）不受影响。
- 你醒来后若同意：`paseo plugin add /home/dengqi/Source/langs/javascript/paseo-feishu` 之前先在设置里开 Enable plugins。

可以试试。

## 记录：`gl/oc-muse-spark-1.3-contributor` 不可用
- 两次启动都以 `400 MissingSessionID (x-opencode-session)` 失败，属提供商路由问题，重试无效。
- 处理：Writer B 改用 `gl/cc-muse-spark-1.3-contributor`（与 Writer A 同提供商，两者在不同 worktree）。

## 醒来后请处理（按优先级）
1. **D3（你已回复“可以试试”）开启 pluginsEnabled**：我只在临时 home（端口 6799，已删除）里验证过真实加载，没动你的 ~/.paseo。要用的话：开 Enable plugins 后 `paseo plugin add /home/dengqi/Source/langs/javascript/paseo-feishu`。
2. **飞书凭据**：插件从环境变量读 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_OWNER_OPEN_ID`（`ou_…`，不是 `cli_…`），可选 `PASEO_URL`、`PASEO_PASSWORD`、`STATE_FILE`。插件子进程继承 daemon 环境，所以要在启动 daemon 的环境里设置。缺任何一个就只打日志并空载。
3. **D1a/D1b/D2**：密码读取顺序、默认地址 ws://127.0.0.1:6767/ws、依赖锁 0.11.4/0.7.1。
4. **实机必验清单**（全部未验证）：飞书长连接；卡片 2.0 渲染（column_set 内的 button + behaviors 回传，value 是否进 action.value）；3 秒回调；turn_ended 与 permission hook 真实触发；respond 之后紧接 refresh 是否已清掉 pending（否则会误报 failed，用户再点会走"已处理"，不会重复提交）；真实 send。
5. **已知取舍**：通知发送失败不重试；去重记录各留 500 条，插件重启后窗口外的 messageId 可能再送一次。
