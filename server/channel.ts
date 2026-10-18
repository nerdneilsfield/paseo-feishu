import { createLarkChannel } from "@larksuite/channel";
import type {
  CardActionEvent,
  NormalizedMessage,
} from "@larksuite/channel";
import { z } from "zod";
import type {
  CardAction,
  CardResponse,
  FeishuChannel,
  FeishuPort,
  IncomingCardAction,
  IncomingText,
  PluginConfig,
  SessionController,
} from "./contracts.js";

// 飞书 3 秒卡片回调硬限制：2.5 秒内 session 未返回则先回 loading，后台继续。
const CARD_ACTION_TIMEOUT_MS = 2500;

const LOADING_RESPONSE: CardResponse = { toast: { type: "loading", content: "正在处理…" } };
const INVALID_RESPONSE: CardResponse = {
  toast: { type: "error", content: "请求无效，请使用最新卡片重试" },
};
const FORBIDDEN_RESPONSE: CardResponse = { toast: { type: "error", content: "无操作权限" } };
const FAILED_RESPONSE: CardResponse = {
  toast: { type: "error", content: "处理失败，请稍后重试" },
};

// value 里的 cardRevision 等多余字段会被 zod 默认 strip，只留下契约字段。
const cardActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("select_agent"),
    agentId: z.string().min(1),
    pickerRevision: z.number().int(),
  }),
  z.object({ action: z.literal("open_picker"), pickerRevision: z.number().int() }),
  z.object({ action: z.literal("refresh_agents"), pickerRevision: z.number().int() }),
  z.object({
    action: z.literal("page_agents"),
    page: z.number().int(),
    pickerRevision: z.number().int(),
  }),
  z.object({
    action: z.literal("approve_permission"),
    agentId: z.string().min(1),
    requestId: z.string().min(1),
  }),
  z.object({
    action: z.literal("deny_permission"),
    agentId: z.string().min(1),
    requestId: z.string().min(1),
  }),
]);

function parseCardAction(value: unknown): CardAction | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return null;
  }
  const parsed = cardActionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// 只记错误类型，不记消息内容与密钥。
function logError(scope: string, err: unknown): void {
  const kind = err instanceof Error ? err.name : typeof err;
  console.error(`[feishu-channel] ${scope}: ${kind}`);
}

export function createFeishuChannel(
  config: Pick<PluginConfig, "feishuAppId" | "feishuAppSecret" | "ownerOpenId">,
): FeishuChannel {
  const { ownerOpenId } = config;
  const channel = createLarkChannel({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    transport: "websocket",
    policy: { dmMode: "allowlist", dmAllowlist: [ownerOpenId] },
    // 显式声明队列行为：不依赖 SDK 默认值。
    safety: { chatQueue: { enabled: true, cardActions: "same" } },
  });

  const port: FeishuPort = {
    async sendText(chatId, text) {
      await channel.send(chatId, { text });
    },
    async sendCard(chatId, card) {
      const result = await channel.send(chatId, { card });
      return result.messageId;
    },
    async updateCard(messageId, card) {
      await channel.updateCard(messageId, card);
    },
  };

  let unsubs: Array<() => void> = [];

  function botOpenId(): string | undefined {
    try {
      return channel.botIdentity?.openId;
    } catch {
      return undefined;
    }
  }

  function toIncomingText(msg: NormalizedMessage): IncomingText | null {
    // 应用层二次校验：SDK 的 dmAllowlist 只是第一层。
    if (msg.chatType !== "p2p") return null;
    if (msg.senderId !== ownerOpenId) return null;
    if (msg.rawContentType !== "text") return null;
    if (msg.senderIsBot === true) return null;
    const self = botOpenId();
    if (self !== undefined && msg.senderId === self) return null;
    return {
      messageId: msg.messageId,
      chatId: msg.chatId,
      senderId: msg.senderId,
      chatType: msg.chatType,
      text: msg.content,
      rawContentType: msg.rawContentType,
    };
  }

  async function onCardAction(evt: CardActionEvent): Promise<CardResponse> {
    const action = parseCardAction(evt.action.value);
    if (action === null) return INVALID_RESPONSE;
    if (evt.operator.openId !== ownerOpenId) return FORBIDDEN_RESPONSE;
    const incoming: IncomingCardAction = {
      messageId: evt.messageId,
      chatId: evt.chatId,
      operatorOpenId: evt.operator.openId,
      action,
    };
    return raceWithLoading(sessionRef.current?.handleCardAction(incoming));
  }

  // start() 之后才有值；cardAction 回调只在 start 后触发。
  const sessionRef: { current: SessionController | null } = { current: null };

  function raceWithLoading(pending: Promise<CardResponse> | undefined): Promise<CardResponse> {
    if (pending === undefined) return Promise.resolve(FAILED_RESPONSE);
    // safe 永不 reject：session 抛错记为失败 toast；超时后后台继续，不取消。
    const safe = pending.then(
      (res) => res,
      (err: unknown) => {
        logError("handleCardAction", err);
        return FAILED_RESPONSE;
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<CardResponse>((resolve) => {
      timer = setTimeout(() => resolve(LOADING_RESPONSE), CARD_ACTION_TIMEOUT_MS);
    });
    return Promise.race([safe, timeout]).then((res) => {
      if (timer !== undefined) clearTimeout(timer);
      return res;
    });
  }

  return {
    port,

    async start(session: SessionController): Promise<void> {
      for (const unsub of unsubs) unsub();
      unsubs = [];
      sessionRef.current = session;
      unsubs.push(
        channel.on("message", (msg) => {
          const incoming = toIncomingText(msg);
          if (incoming === null) return;
          // 只等 session 的快速受理，不等 Agent 执行，更不等后续点击。
          void session
            .handleText(incoming)
            .catch((err: unknown) => logError("handleText", err));
        }),
      );
      unsubs.push(
        channel.on("cardAction", (evt) => {
          return onCardAction(evt);
        }),
      );
      await channel.connect();
    },

    async stop(): Promise<void> {
      for (const unsub of unsubs) unsub();
      unsubs = [];
      sessionRef.current = null;
      await channel.disconnect();
    },
  };
}

export { CARD_ACTION_TIMEOUT_MS };
