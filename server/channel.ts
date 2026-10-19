import { createLarkChannel } from "@larksuite/channel";
import type {
  CardActionEvent,
  NormalizedMessage,
} from "@larksuite/channel";
import { z } from "zod";
import { idHint, logError, logInfo, withMessageLog } from "./log.js";
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
  z.object({ action: z.literal("navigate"), destination: z.enum(["sessions", "status", "history", "help", "commands"]) }),
  z.object({ action: z.literal("history_page"), agentId: z.string().min(1), generation: z.number().int(), version: z.number().int(), latest: z.boolean() }),
  z.object({
    action: z.literal("select_agent"),
    agentId: z.string().min(1),
    pickerRevision: z.number().int(),
  }),
  z.object({ action: z.literal("open_picker"), pickerRevision: z.number().int() }),
  z.object({ action: z.literal("refresh_agents"), pickerRevision: z.number().int() }),
  z.object({ action: z.literal("refresh_current"), pickerRevision: z.number().int() }),
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

export function createFeishuChannel(
  config: Pick<PluginConfig, "feishuAppId" | "feishuAppSecret" | "feishuDomain" | "ownerOpenId">,
): FeishuChannel {
  const { ownerOpenId } = config;
  const channel = createLarkChannel({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    ...(config.feishuDomain ? { domain: config.feishuDomain } : {}),
    transport: "websocket",
    policy: { dmMode: "allowlist", dmAllowlist: [ownerOpenId] },
    // 显式声明队列行为：不依赖 SDK 默认值。
    safety: { chatQueue: { enabled: true, cardActions: "same" } },
  });

  const port: FeishuPort = {
    async sendText(chatId, text) {
      const started = Date.now();
      logInfo("feishu.send.started", { kind: "text", chatId: idHint(chatId) });
      try {
        const result = await channel.send(chatId, { text });
        logInfo("feishu.send.succeeded", { kind: "text", chatId: idHint(chatId), messageId: result.messageId, elapsedMs: Date.now() - started });
      } catch (err) {
        logError("feishu.send.failed", err, { kind: "text", chatId: idHint(chatId), elapsedMs: Date.now() - started }, [text, config.feishuAppSecret]);
        throw err;
      }
    },
    async sendCard(chatId, card) {
      const started = Date.now();
      logInfo("feishu.send.started", { kind: "card", chatId: idHint(chatId) });
      try {
        const result = await channel.send(chatId, { card });
        logInfo("feishu.send.succeeded", { kind: "card", chatId: idHint(chatId), messageId: result.messageId, elapsedMs: Date.now() - started });
        return result.messageId;
      } catch (err) {
        logError("feishu.send.failed", err, { kind: "card", chatId: idHint(chatId), elapsedMs: Date.now() - started }, [config.feishuAppSecret]);
        throw err;
      }
    },
    async updateCard(messageId, card) {
      const started = Date.now();
      logInfo("feishu.card.update.started", { messageId });
      try {
        await channel.updateCard(messageId, card);
        logInfo("feishu.card.update.succeeded", { messageId, elapsedMs: Date.now() - started });
      } catch (err) {
        logError("feishu.card.update.failed", err, { messageId, elapsedMs: Date.now() - started }, [config.feishuAppSecret]);
        throw err;
      }
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
    const self = botOpenId();
    const reason = msg.chatType !== "p2p" ? "not_p2p"
      : msg.senderId !== ownerOpenId ? "sender_not_allowed"
      : msg.rawContentType !== "text" ? "unsupported_content_type"
      : msg.senderIsBot === true ? "bot_sender"
      : self !== undefined && msg.senderId === self ? "self_message"
      : null;
    if (reason !== null) {
      logInfo("feishu.message.rejected", { messageId: msg.messageId, reason, senderId: idHint(msg.senderId), ownerId: idHint(ownerOpenId) });
      return null;
    }
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
    logInfo("feishu.card.action.received", { messageId: evt.messageId, operatorId: idHint(evt.operator.openId) });
    const action = parseCardAction(evt.action.value);
    if (action === null) {
      logInfo("feishu.card.action.rejected", { messageId: evt.messageId, reason: "invalid_action" });
      return INVALID_RESPONSE;
    }
    if (evt.operator.openId !== ownerOpenId) {
      logInfo("feishu.card.action.rejected", { messageId: evt.messageId, reason: "sender_not_allowed" });
      return FORBIDDEN_RESPONSE;
    }
    const incoming: IncomingCardAction = {
      messageId: evt.messageId,
      chatId: evt.chatId,
      operatorOpenId: evt.operator.openId,
      action,
    };
    return withMessageLog(evt.messageId, () => raceWithLoading(sessionRef.current?.handleCardAction(incoming), evt.messageId));
  }

  // start() 之后才有值；cardAction 回调只在 start 后触发。
  const sessionRef: { current: SessionController | null } = { current: null };

  function raceWithLoading(pending: Promise<CardResponse> | undefined, messageId: string): Promise<CardResponse> {
    if (pending === undefined) return Promise.resolve(FAILED_RESPONSE);
    // safe 永不 reject：session 抛错记为失败 toast；超时后后台继续，不取消。
    const safe = pending.then(
      (res) => res,
      (err: unknown) => {
        logError("feishu.card.action.failed", err, { messageId });
        return FAILED_RESPONSE;
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<CardResponse>((resolve) => {
      timer = setTimeout(() => {
        logInfo("feishu.card.action.timeout", { messageId, timeoutMs: CARD_ACTION_TIMEOUT_MS });
        resolve(LOADING_RESPONSE);
      }, CARD_ACTION_TIMEOUT_MS);
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
        // SDK 的内建处理在 raw observer 之前运行；这里仍能看到被策略/去重丢弃的事件。
        channel.onRawEvent("im.message.receive_v1", (raw) => {
          const event = raw as { message?: { message_id?: string; chat_type?: string; message_type?: string } } | null | undefined;
          logInfo("feishu.event.observed", { eventType: "im.message.receive_v1", messageId: event?.message?.message_id, chatType: event?.message?.chat_type, contentType: event?.message?.message_type });
        }),
        channel.on("reject", (evt) => {
          logInfo("feishu.policy.rejected", { messageId: evt.messageId, reason: evt.reason, senderId: idHint(evt.senderId), ownerId: idHint(ownerOpenId), chatId: idHint(evt.chatId) });
        }),
        channel.on("error", (err) => logError("feishu.channel.error", err, {}, [config.feishuAppSecret])),
        channel.on("reconnecting", () => logInfo("feishu.reconnecting")),
        channel.on("reconnected", () => logInfo("feishu.reconnected")),
      );
      unsubs.push(
        channel.on("message", (msg) => {
          logInfo("feishu.message.received", { messageId: msg.messageId, chatId: idHint(msg.chatId), senderId: idHint(msg.senderId), chatType: msg.chatType, contentType: msg.rawContentType });
          const incoming = toIncomingText(msg);
          if (incoming === null) return;
          logInfo("feishu.message.accepted", { messageId: msg.messageId });
          // 只等 session 的快速受理，不等 Agent 执行，更不等后续点击。
          void withMessageLog(msg.messageId, () => session.handleText(incoming))
            .then(() => logInfo("feishu.message.handled", { messageId: msg.messageId }))
            .catch((err: unknown) => logError("feishu.message.failed", err, { messageId: msg.messageId }, [msg.content, config.feishuAppSecret]));
        }),
      );
      unsubs.push(
        channel.on("cardAction", (evt) => {
          return onCardAction(evt);
        }),
      );
      logInfo("feishu.connect.started", { domain: config.feishuDomain ?? "https://open.feishu.cn", ownerId: idHint(ownerOpenId) });
      await channel.connect();
      logInfo("feishu.connected", { botId: idHint(botOpenId()) });
    },

    async stop(): Promise<void> {
      for (const unsub of unsubs) unsub();
      unsubs = [];
      sessionRef.current = null;
      logInfo("feishu.disconnect.started");
      await channel.disconnect();
      logInfo("feishu.disconnected");
    },
  };
}

export { CARD_ACTION_TIMEOUT_MS };
