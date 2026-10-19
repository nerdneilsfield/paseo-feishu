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
import { idHint, logError, logInfo } from "./server/log";

const LARK_DOMAIN = "https://open.larksuite.com";
const DEFAULT_PASEO_URL = "ws://127.0.0.1:6767/ws";

/** 空或 "feishu" 用 SDK 默认（国内）；"lark" 为国际版；其余当作完整 URL（私有部署）。 */
function resolveDomain(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v || v.toLowerCase() === "feishu") return undefined;
  return v.toLowerCase() === "lark" ? LARK_DOMAIN : v;
}

/** 缺任何必需项都明确报错，不退化为无鉴权或空运行。 */
export function readConfig(env: NodeJS.ProcessEnv): PluginConfig {
  const missing = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_OWNER_OPEN_ID"].filter(
    (k) => !env[k],
  );
  if (missing.length > 0) {
    throw new Error(`paseo-feishu: missing required env: ${missing.join(", ")}`);
  }
  const feishuDomain = resolveDomain(env.FEISHU_DOMAIN);
  const home = env.PASEO_HOME ?? join(homedir(), ".paseo");
  return {
    feishuAppId: env.FEISHU_APP_ID!,
    feishuAppSecret: env.FEISHU_APP_SECRET!,
    ...(feishuDomain ? { feishuDomain } : {}),
    ownerOpenId: env.FEISHU_OWNER_OPEN_ID!,
    paseoUrl: env.PASEO_URL || DEFAULT_PASEO_URL,
    paseoPassword: env.PASEO_PASSWORD || undefined,
    stateFile: env.STATE_FILE || join(home, "plugins-data", "paseo-feishu", "state.json"),
  };
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

  logInfo("startup.config.loaded", {
    appId: idHint(config.feishuAppId),
    ownerId: idHint(config.ownerOpenId),
    domain: config.feishuDomain ?? "https://open.feishu.cn",
    paseoPasswordSet: Boolean(config.paseoPassword),
    stateFile: config.stateFile,
  });

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
    const connection = paseo.connect();
    void connection.then(() => {
      if (!stopped && paseo.isReady()) session?.resumeObservation();
    });
    logInfo("startup.session.loading", { stateFile: config.stateFile });
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
    if (paseo.isReady()) created.resumeObservation();
    logInfo("startup.session.ready", { agentId: idHint(created.currentScope()?.agentId) });
    await channel.start(created);
    logInfo("startup.ready", { paseoConnected: paseo.isReady() });
  })().catch((err) => logError("startup.failed", err));

  return () => {
    stopped = true;
    logInfo("shutdown.started");
    // 关闭只有约 4 秒：并行收尾，各自吞掉错误。
    void Promise.allSettled([
      channel.stop(),
      session?.close(),
      paseo.close(),
    ]);
  };
}
