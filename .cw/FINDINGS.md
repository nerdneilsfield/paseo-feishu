# 已核实的源码事实（均读自 ../paseo 本地 clone）

## 插件里的 paseo 是什么
- plugin-process.ts:263-276：插件子进程内建一个 DaemonClient（url=ipc://plugin/<id>，transportFactory=IPC 桥，reconnect.enabled=true），再 `createPaseoApi(daemonClient)` 得到 `paseo`。这是**唯一一个、与子进程同寿命**的实例，shutdown 时才 dispose（:321-338）。
- hook / RPC handler 收到的 `context.paseo` 就是这同一个对象（plugin-process.ts:498-499, :526）。
- `PaseoApi`（client/src/index.ts:486）= dispose、observeEvents、terminals、workspaces、projects、agents、providers、config。
- `agents.list(options)`、`agents.ref(id)`；handle 有 refresh()/send(text)/respondToPermission({requestId,...})/timeline.refetch()/pendingPermissions(快照属性，ref 后为 null 直至 refresh)/archive()/detach()/subscribe()。
- `PluginServerContext`（plugin/src/server/contracts.ts:32-44）只有 registerSettings/handle/registerProvider/registerUsageSource/on/before，**没有 paseo**。

## 对设计的影响（已按 oracle 结论更正；原第 1 条"认证风险不存在"是错的）
1. `context.paseo` 走 IPC，不需要密码；但它只出现在 hook / RPC handler 的 context 里，contribute() 拿不到，启动后也没有会立刻触发的 hook，RPC 只能由外部客户端调用。所以飞书消息、卡片点击这些主动操作不能依赖它（否则冷启动窗口违反 SPEC A01/A12）。
2. **采用方案 C**：插件内自建公开 API `createPaseoClient({ url, password? })`；hook 里仍用 context.paseo，两条路径互不依赖。
3. 认证（session-admission-auth.ts:17-36）：daemon 没设密码 → 直接放行；设了密码 → 必须明文密码；localCredential 只在内部 DaemonClientConfig，公开 PaseoClientConfig 没有（client/src/index.ts:81-101），不得走 internal 路径。
4. 插件子进程 fork 时不传 env（runtime.ts:234-238），继承 daemon 环境变量；密码若来自 PASEO_PASSWORD 可直接读到，若只在配置文件里（bcrypt 哈希）则读不到，需用户给插件配置。
5. contribute() 必须**同步**返回 cleanup（plugin-process.ts:285-296）；在函数体内 `void client.connect()`，不能 async。
6. 冷启动 / 断线：未连通时对飞书消息显式回复"Paseo 未连接，未发送"，不排队、不自动重投（符合 SPEC A10/A14）；恢复靠 client 重连 + timeline.refetch + pendingPermissions。
7. @getpaseo/client 不是宿主模块，必须被打进 bundle 或在插件 node_modules；版本以 daemon 实机为准（本地源码 0.12.0-beta.3，DESIGN 写的是 0.11.2）。
8. cleanup 必须在约 4s 内 client.close() + channel.disconnect() + 落盘。
9. 默认地址 ws://127.0.0.1:6767/ws；Node 需 22+（globalThis.WebSocket）。unix socket 监听未核实，v0.1 只支持 TCP loopback。

## 插件加载
- 入口 index.server.ts 默认导出 contribute(server) 返回 cleanup；manifest 最小 {id, requirements.paseo}；build 为 argv 数组不经 shell。
- 第三方依赖（@larksuite/channel）不是宿主模块：npm 包形式安装会自动 npm install --omit=dev；目录/Git 源要在 manifest.build 里写 ["npm","ci","--omit=dev"]。
- 默认 pluginsEnabled 不为 true 时插件不启动；`paseo plugin add <路径>`。
- 关闭：IPC shutdown → 2s SIGTERM → 2s SIGKILL；cleanup 须在约 4s 内完成。
- hook 超时 30s，之后丢弃；无持久化队列，无重放。

## hook / 权限（来自 task-4，正由核对组复核）
- turn_ended.outcome.kind ∈ completed/failed/canceled；permission_requested.request.kind ∈ tool/plan/question/mode/other；只有 kind=tool 且 actions 恰为 allow+deny 各一时才做二选一卡。
- permission_resolved 无去重；turn_ended 有去重；internal agent 不触发 hook；同 agent 串行。

## 飞书 channel（来自 task-3，正由核对组复核）
- chatQueue 默认关；cardActions 默认 'same'；cardAction 须 3s 内同步返回；dmAllowlist 填 open_id；重复 messageId 静默丢弃。

## 已自行核实（agent-manager.ts，本地 clone）
- turn_completed/failed/canceled 分支不改 flags.shouldDispatchEvent（默认 true）：dispatchStreamEventByType :4472-4498，派发点 :4349-4351 → turn_ended hook 必达（除 internal agent，:5162）。
- shouldDispatchEvent=false 只压：provider 重复的 turn_started（前台 turn 已在 runPrompt 里手动 dispatchStream 一次，:2645）、mode/model 变更、timeline、以及 **我方 respondToPermission 在飞时**的 permission_resolved（:4745-4752）。
- 因此"桌面端发起的 turn 完成"和"我方发起的 turn 完成"都会触发 turn_ended；飞书不会因此漏通知。
- hook 派发走 publishAgentStream，且仅在 !agent.internal && event.type !== "timeline"（:5162）。

## 已自行核实（channel-sdk-node 本地 clone）——task-3 报告更正
- **chatQueue.enabled 默认 true**（safety/index.ts:75），报告写 false 是错的。cardActions 默认 'same'（types.ts:488-503）；mergeWhileBusy 默认关。
- dedup 默认 ttl 12h、maxEntries 5000、sweep 5min（safety/types.ts:23-28），报告称"未公开"是遗漏。
- cardAction 去重键 = card:<messageId>:<operator.openId>:<tag|name|option|value[:128]>（channel.ts:1203, cardActionId ~1512）。同一按钮 12h 内重复点击会被静默吞掉。
- senderId = open_id，缺失回退 user_id、union_id（normalize/index.ts:84-87）。
- toast type 含 'loading'（types.ts:148）。
- 未核实：飞书开放平台的 3 秒时限、权限名、事件名（外部文档，本地无法核）。

## 版本（已核实）
- 本机 daemon 0.11.4（监听 127.0.0.1:6767，~/.paseo/config.json 未设 password），npm 上 @getpaseo/{plugin,client,protocol} 最新 0.11.4，@larksuite/channel 0.7.1，Node v24.1.0。
- 本地 clone 是 main（0.12.0-beta.3）；已用 `git fetch tag v0.11.4` 对照：插件运行时、hook 契约、认证、agent-manager 派发逻辑一致。
- v0.11.4 npm 包 @getpaseo/client 导出 createPaseoClient / createPaseoApi，且 `./internal/daemon-client` 为 internal 路径。
- 开发机 daemon 未设密码 → 联调时 createPaseoClient 不需要 password。

## 骨架阶段已验证（本机）
- npm install 成功（167 包）；tsc --noEmit 通过。
- 用 esbuild 以 Paseo 同样的 external 列表（@getpaseo/plugin/*、zod）打包 `@getpaseo/client@0.11.4` + `@larksuite/channel@0.7.1`：成功，约 14.9MB；在项目目录下 require 可加载，两个入口函数都是 function。bufferutil/utf-8-validate 是 ws 的可选依赖（try/catch），不影响。
- 尚未验证：paseo plugin add 的真实加载（daemon 的 pluginsEnabled 未开，开关属于用户的全局设置，不替用户打开）。

## 实现阶段教训
- 子代理 worktree 完成后会被清理，分支也可能消失；只有 commit 对象留存为 dangling。Writer C 靠 `git fsck --lost-found` 找回（现挂在分支 writer-c，已合入 master）。收到完成通知后**立即**合并，不要拖。
- Writer C 报告 "tsc 通过"，合入后实测有 1 处类型错误（session.ts recordDelivery 返回类型），已修。报告里的"通过"必须自己复跑。
- 在没有 node_modules 的目录里 `npx vitest` 会临时拉最新版（v5），结果不可信；先 `npm ci`。

## 实机验证（本机 daemon 0.11.4，无密码）
- `createPaseoPort`（真实 `@getpaseo/client`）：connect → isReady=true；listAgents 返回 5 个；refreshAgent 正常；不存在的 id 返回 null；getPendingPermissions=0；close 连续两次 1ms，isReady=false。
- 未验证：send（会向真实 agent 发消息，不在冒烟测试里做）、respondToPermission、带密码路径、插件加载（D3）、全部飞书侧。
