import "./server/shim";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createCardBuilders } from "./server/cards";
import { createFeishuChannel } from "./server/channel";
import type { PluginConfig, SessionController } from "./server/contracts";
import { registerNotifications } from "./server/notifications";
import { createPaseoPort } from "./server/paseo";
import { createSession } from "./server/session";
import { createFileStore } from "./server/store";

const DEFAULT_PASEO_URL = "ws://127.0.0.1:6767/ws";

/** 缺任何必需项都明确报错，不退化为无鉴权或空运行。 */
export function readConfig(env: NodeJS.ProcessEnv): PluginConfig {
  const missing = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_OWNER_OPEN_ID"].filter(
    (k) => !env[k],
  );
  if (missing.length > 0) {
    throw new Error(`paseo-feishu: missing required env: ${missing.join(", ")}`);
  }
  const home = env.PASEO_HOME ?? join(homedir(), ".paseo");
  return {
    feishuAppId: env.FEISHU_APP_ID!,
    feishuAppSecret: env.FEISHU_APP_SECRET!,
    ownerOpenId: env.FEISHU_OWNER_OPEN_ID!,
    paseoUrl: env.PASEO_URL || DEFAULT_PASEO_URL,
    paseoPassword: env.PASEO_PASSWORD || undefined,
    stateFile: env.STATE_FILE || join(home, "plugins-data", "paseo-feishu", "state.json"),
  };
}

function logError(scope: string, err: unknown): void {
  console.error(`[paseo-feishu] ${scope}:`, err instanceof Error ? err.message : err);
}

// contribute 必须同步返回 cleanup（宿主不等待 Promise）。所有异步启动放进 start()。
export default function contribute(server: PluginServerContext): () => void {
  let config: PluginConfig;
  try {
    config = readConfig(process.env);
  } catch (err) {
    // 配置缺失：不启动任何连接，插件保持空载并把原因写进日志。
    logError("config", err);
    return () => {};
  }

  const cards = createCardBuilders();
  const paseo = createPaseoPort(config);
  const channel = createFeishuChannel(config);
  const store = createFileStore(config.stateFile);

  let session: SessionController | null = null;
  let stopped = false;

  // hook 路径用 context.paseo 之外的独立 client 只做主动操作；hook 本身不依赖它。
  registerNotifications(server, { session: () => session, feishu: channel.port, cards });

  void (async () => {
    // 先连 Paseo（不阻塞），再起 session，最后连飞书：飞书消息进来时 session 必须已就绪。
    void paseo.connect();
    const created = await createSession({
      ownerOpenId: config.ownerOpenId,
      store,
      paseo,
      feishu: channel.port,
      cards,
    });
    if (stopped) {
      await created.close();
      return;
    }
    session = created;
    await channel.start(created);
  })().catch((err) => logError("start", err));

  return () => {
    stopped = true;
    // 关闭只有约 4 秒：并行收尾，各自吞掉错误。
    void Promise.allSettled([
      channel.stop(),
      session?.close(),
      paseo.close(),
    ]);
  };
}
