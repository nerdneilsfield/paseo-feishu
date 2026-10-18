# 待用户拍板的细节

流程不因这些停下。每条写明：问题、我先采用的默认、理由。

## D1 插件如何拿到 paseo（飞书消息不经 hook）—— 已定，不需你拍板
- 采用方案 C：插件内自建 createPaseoClient；hook 里用 context.paseo。依据与 oracle 全文：/tmp/advice-paseo-access.md，事实见 FINDINGS.md。
- 需你拍板的细节 D1a：Paseo 密码放哪。默认：先读环境变量 PASEO_PASSWORD，没有再读插件 settings（0600 文件）；daemon 没设密码则都不用。
- 需你拍板的细节 D1b：Paseo 地址默认 ws://127.0.0.1:6767/ws，可由配置覆盖。unix socket 监听 v0.1 不支持。

## 已发现并更正的调研错误（无需你处理，供参考）
- task-4 报告写 timeline 单页 100，实际 TIMELINE_FETCH_PAGE_SIZE=40（paseo/packages/app/src/timeline/timeline-fetch-policy.ts:3）。
- task-1 报告称本地无 plugin-examples/，实际有 14 个示例。
- 我自己早先的 FINDINGS 第 1 条"认证风险不存在"是错的，已按 oracle 更正。
- task-3 报告写"chatQueue 默认关"，实际默认 true（channel-sdk-node/src/safety/index.ts:75）。已按源码改 DESIGN §5.3。

## D2 依赖版本锁定
- 默认：@getpaseo/client、@getpaseo/plugin、@getpaseo/protocol 均锁 0.11.4（与本机 daemon 一致）；@larksuite/channel 锁 0.7.1。daemon 升级后需你重新评估。

## D3 是否开启本机 daemon 的 pluginsEnabled（需你拍板，我未动）
- 现状：~/.paseo/config.json 未设置 pluginsEnabled，`paseo plugin ls` 为空。
- 为什么不替你开：DESIGN §8 要求"不要自动开启 Paseo 全局 pluginsEnabled；安装者须明确许可"，且它是对你整台 daemon 的全局改动。
- 影响：不开则无法做真实的 plugin loading / hook 实机验证；其余（类型检查、fake-port 单测、打包加载、client loopback）不受影响。
- 你醒来后若同意：`paseo plugin add /home/dengqi/Source/langs/javascript/paseo-feishu` 之前先在设置里开 Enable plugins。

## 记录：`gl/oc-muse-spark-1.3-contributor` 不可用
- 两次启动都以 `400 MissingSessionID (x-opencode-session)` 失败，属提供商路由问题，重试无效。
- 处理：Writer B 改用 `gl/cc-muse-spark-1.3-contributor`（与 Writer A 同提供商，两者在不同 worktree）。
