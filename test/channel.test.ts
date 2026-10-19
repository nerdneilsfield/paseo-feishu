import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return { createLarkChannel: vi.fn() };
});

vi.mock("@larksuite/channel", () => ({
  createLarkChannel: mocks.createLarkChannel,
}));

import { createFeishuChannel } from "../server/channel.js";
import type { SessionController } from "../server/contracts.js";

const OWNER = "ou_owner";
const OTHER = "ou_stranger";

interface FakeSdk {
  handlers: Record<string, (...args: Array<any>) => unknown>;
  unsubs: Array<() => void>;
  sent: Array<{ to: string; input: unknown }>;
  updated: Array<{ messageId: string; card: unknown }>;
  connectCalls: number;
  disconnectCalls: number;
  botIdentity?: { openId: string };
  options: unknown;
  on: (name: string, handler: (...args: Array<any>) => unknown) => () => void;
  send: (to: string, input: unknown) => Promise<{ messageId: string }>;
  updateCard: (messageId: string, card: unknown) => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

function makeFakeSdk(): FakeSdk {
  const fake: FakeSdk = {
    handlers: {},
    unsubs: [],
    sent: [],
    updated: [],
    connectCalls: 0,
    disconnectCalls: 0,
    botIdentity: { openId: "ou_bot" },
    options: undefined,
    on: (name, handler) => {
      fake.handlers[name] = handler;
      const unsub = vi.fn();
      fake.unsubs.push(unsub);
      return unsub;
    },
    send: async (to: string, input: unknown) => {
      fake.sent.push({ to, input });
      return { messageId: "om_new" };
    },
    updateCard: async (messageId: string, card: unknown) => {
      fake.updated.push({ messageId, card });
    },
    connect: async () => {
      fake.connectCalls += 1;
    },
    disconnect: async () => {
      fake.disconnectCalls += 1;
    },
  };
  return fake;
}

function makeSession(over: Partial<SessionController> = {}): SessionController {
  return {
    handleText: vi.fn().mockResolvedValue(undefined),
    handleCardAction: vi.fn().mockResolvedValue({ toast: { type: "success", content: "ok" } }),
    currentAgentId: () => null,
    currentChatId: () => null,
    markNotified: vi.fn().mockResolvedValue(true),
    markPermissionDecided: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

function textMsg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: "om_1",
    chatId: "oc_dm",
    chatType: "p2p",
    senderId: OWNER,
    content: "hello",
    rawContentType: "text",
    senderIsBot: false,
    ...over,
  };
}

function cardEvt(value: unknown, operatorOpenId = OWNER): Record<string, unknown> {
  return {
    messageId: "om_card",
    chatId: "oc_dm",
    operator: { openId: operatorOpenId },
    action: { value, tag: "button" },
  };
}

const VALID_SELECT = { action: "select_agent", agentId: "a1", pickerRevision: 3 };

beforeEach(() => {
  mocks.createLarkChannel.mockReset();
  mocks.createLarkChannel.mockImplementation((options: unknown) => {
    const fake = makeFakeSdk();
    fake.options = options;
    return fake;
  });
});

function setup() {
  const feishu = createFeishuChannel({
    feishuAppId: "app",
    feishuAppSecret: "secret",
    ownerOpenId: OWNER,
  });
  const fake = mocks.createLarkChannel.mock.results[0]?.value as FakeSdk;
  return { feishu, fake };
}

describe("建通道配置", () => {
  test("transport/policty/safety 按设计显式设置，不开 mergeWhileBusy", () => {
    setup();
    const opts = mocks.createLarkChannel.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts["transport"]).toBe("websocket");
    expect(opts["policy"]).toMatchObject({ dmMode: "allowlist", dmAllowlist: [OWNER] });
    const safety = opts["safety"] as { chatQueue: Record<string, unknown> };
    expect(safety.chatQueue).toMatchObject({ enabled: true, cardActions: "same" });
    expect(safety.chatQueue["mergeWhileBusy"]).not.toBe(true);
  });
});

describe("domain", () => {
  test("未设置时不传 domain，设置后原样传给 SDK", () => {
    mocks.createLarkChannel.mockClear();
    createFeishuChannel({ feishuAppId: "a", feishuAppSecret: "s", ownerOpenId: OWNER });
    createFeishuChannel({
      feishuAppId: "a",
      feishuAppSecret: "s",
      feishuDomain: "https://open.larksuite.com",
      ownerOpenId: OWNER,
    });
    const calls = mocks.createLarkChannel.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect("domain" in (calls[0] ?? {})).toBe(false);
    expect(calls[1]?.["domain"]).toBe("https://open.larksuite.com");
  });
});

describe("port 发送", () => {
  test("sendCard 返回新 messageId，updateCard 透传", async () => {
    const { feishu, fake } = setup();
    const id = await feishu.port.sendCard("oc_dm", { schema: "2.0" });
    expect(id).toBe("om_new");
    await feishu.port.updateCard("om_old", { schema: "2.0" });
    expect(fake.updated).toHaveLength(1);
    expect(fake.updated[0]?.messageId).toBe("om_old");
    await feishu.port.sendText("oc_dm", "hi");
    expect(fake.sent[1]?.input).toEqual({ text: "hi" });
  });
});

describe("message 监听", () => {
  test("合法私聊文本转交给 session", async () => {
    const { feishu, fake } = setup();
    const session = makeSession();
    await feishu.start(session);
    await fake.handlers["message"]?.(textMsg());
    await new Promise((r) => setTimeout(r, 0));
    expect(session.handleText).toHaveBeenCalledTimes(1);
    expect(session.handleText).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "om_1", senderId: OWNER, text: "hello" }),
    );
    await feishu.stop();
  });

  test.each([
    ["非授权用户", textMsg({ senderId: OTHER })],
    ["非 p2p", textMsg({ chatType: "group" })],
    ["非 text", textMsg({ rawContentType: "image" })],
    ["机器人自身", textMsg({ senderIsBot: true })],
    ["senderId 等于 bot 自身", textMsg({ senderId: "ou_bot" })],
  ])("%s 消息被丢弃且不调用 session", async (_label, msg) => {
    const { feishu, fake } = setup();
    const session = makeSession();
    await feishu.start(session);
    await fake.handlers["message"]?.(msg);
    await new Promise((r) => setTimeout(r, 0));
    expect(session.handleText).not.toHaveBeenCalled();
    await feishu.stop();
  });
});

describe("cardAction 监听", () => {
  test("合法点击返回 session 的 toast", async () => {
    const { feishu, fake } = setup();
    const session = makeSession({
      handleCardAction: vi
        .fn()
        .mockResolvedValue({ toast: { type: "success", content: "已绑定" } }),
    });
    await feishu.start(session);
    const res = await fake.handlers["cardAction"]?.(cardEvt(VALID_SELECT));
    expect(res).toEqual({ toast: { type: "success", content: "已绑定" } });
    expect(session.handleCardAction).toHaveBeenCalledWith(
      expect.objectContaining({ operatorOpenId: OWNER }),
    );
    await feishu.stop();
  });

  test("非法/旧格式 value 一律拒绝且不调用 session、不泄露信息", async () => {
    const { feishu, fake } = setup();
    const session = makeSession();
    await feishu.start(session);
    for (const bad of [
      "not-json{{{",
      42,
      null,
      { action: "select_agent" },
      { action: "nope", pickerRevision: 1 },
      { action: "approve_permission", agentId: "a", requestId: "" },
      { action: "page_agents", page: "x", pickerRevision: 1 },
    ]) {
      const res = (await fake.handlers["cardAction"]?.(cardEvt(bad))) as {
        toast: { type: string; content: string };
      };
      expect(res.toast.type).toBe("error");
      expect(JSON.stringify(res)).not.toContain("a1");
    }
    expect(session.handleCardAction).not.toHaveBeenCalled();
    await feishu.stop();
  });

  test("未授权 operator 返回通用拒绝且不调用 session", async () => {
    const { feishu, fake } = setup();
    const session = makeSession();
    await feishu.start(session);
    const res = (await fake.handlers["cardAction"]?.(cardEvt(VALID_SELECT, OTHER))) as {
      toast: { content: string };
    };
    expect(session.handleCardAction).not.toHaveBeenCalled();
    expect(res.toast.content).not.toContain(OWNER);
    await feishu.stop();
  });

  test("字符串形式的 JSON value 也能解析", async () => {
    const { feishu, fake } = setup();
    const session = makeSession();
    await feishu.start(session);
    const res = await fake.handlers["cardAction"]?.(cardEvt(JSON.stringify(VALID_SELECT)));
    expect(res).toEqual({ toast: { type: "success", content: "ok" } });
    expect(session.handleCardAction).toHaveBeenCalledTimes(1);
    await feishu.stop();
  });

  test("2.5 秒超时返回 loading，后台继续且 rejection 不泄漏", async () => {
    vi.useFakeTimers();
    try {
      const { feishu, fake } = setup();
      let resolveLater!: (v: { toast: { type: string; content: string } }) => void;
      const pending = new Promise<{ toast: { type: string; content: string } }>((r) => {
        resolveLater = r;
      });
      const session = makeSession({ handleCardAction: vi.fn().mockReturnValue(pending) });
      await feishu.start(session);
      const promise = fake.handlers["cardAction"]?.(cardEvt(VALID_SELECT)) as Promise<unknown>;
      const settled: Array<unknown> = [];
      void promise.then((v) => settled.push(v));
      await vi.advanceTimersByTimeAsync(2600);
      expect(settled).toHaveLength(1);
      expect(settled[0]).toEqual({ toast: { type: "loading", content: "正在处理…" } });
      // 后台继续完成：先 resolve 再让 race 清掉 timer，不抛。
      resolveLater({ toast: { type: "success", content: "done" } });
      await vi.advanceTimersByTimeAsync(0);
      await feishu.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("session 抛错时返回失败 toast 而不是把 rejection 抛给 SDK", async () => {
    const { feishu, fake } = setup();
    const session = makeSession({
      handleCardAction: vi.fn().mockRejectedValue(new Error("boom")),
    });
    await feishu.start(session);
    const res = (await fake.handlers["cardAction"]?.(cardEvt(VALID_SELECT))) as {
      toast: { type: string };
    };
    expect(res.toast.type).toBe("error");
    await feishu.stop();
  });
});

describe("stop 幂等", () => {
  test("重复 stop 不报错", async () => {
    const { feishu, fake } = setup();
    const session = makeSession();
    await feishu.start(session);
    await feishu.stop();
    await feishu.stop();
    expect(fake.disconnectCalls).toBeGreaterThanOrEqual(2);
  });

  test("未 start 直接 stop 不报错", async () => {
    const { feishu } = setup();
    await expect(feishu.stop()).resolves.toBeUndefined();
  });
});
