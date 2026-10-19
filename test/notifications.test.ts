import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveReplies } from "../server/live-replies.js";
import { createCardBuilders } from "../server/cards.js";
import { registerNotifications } from "../server/notifications.js";
import type {
  NotificationDeps,
  SessionController,
  TimelineEvent,
} from "../server/contracts.js";

type Handler = (event: never, ctx?: never) => unknown;

function setup() {
  const handlers = new Map<string, Handler>();
  const server = {
    on: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => {
        handlers.delete(name);
      };
    }),
  };
  const notified = new Set<string>();
  const decided = new Map<string, string>();
  const scope = { generation: 1, agentId: "agent-1", chatId: "chat-1" };
  const session = {
    currentScope: vi.fn(() => scope),
    isCurrentScope: (s: unknown) => s === scope,
    liveReplies: null as unknown as SessionController["liveReplies"],
    markNotified: vi.fn(async (key: string) => {
      if (notified.has(key)) return false;
      notified.add(key);
      return true;
    }),
    markPermissionDecided: vi.fn(async (requestId: string, decision: string) => {
      if (decided.has(requestId)) return false;
      decided.set(requestId, decision);
      return true;
    }),
  };
  const feishu = {
    sendText: vi.fn(async () => {}),
    sendCard: vi.fn(async () => "msg-1"),
    updateCard: vi.fn(async () => {}),
  };
  const cards = {
    picker: vi.fn(() => ({})),
    current: vi.fn(() => ({})),
    permission: vi.fn(() => ({ kind: "approval" })),
    permissionResolved: vi.fn(() => ({ kind: "resolved" })),
    notice: vi.fn(() => ({ kind: "notice" })),
  };
  let observe!: (event: TimelineEvent) => void;
  session.liveReplies = createLiveReplies({
    paseo: { isReady: () => true, subscribeTimeline: (_id: string, handler: typeof observe) => {
      observe = handler;
      return Object.assign(() => {}, { ready: new Promise<void>(() => {}), subscriptionId: "test", release: async () => {} });
    } } as never, feishu, cards: createCardBuilders(),
    isCurrent: (s) => s === scope, invalidateHistory() {},
  });
  session.liveReplies.bind(scope);
  observe({ agentId: scope.agentId, event: { type: "turn_started", provider: "codex", turnId: "turn-1" } } as TimelineEvent);
  const deps = {
    session: (() => session) as unknown as NotificationDeps["session"],
    feishu,
    cards: cards as unknown as NotificationDeps["cards"],
  };
  registerNotifications(
    server as unknown as Parameters<typeof registerNotifications>[0],
    deps,
  );
  const emit = async (name: string, event: unknown) => {
    const h = handlers.get(name);
    if (!h) throw new Error(`no handler for ${name}`);
    if (name === "agent.turn_ended" && (event as { turnId?: string }).turnId) {
      observe({ agentId: scope.agentId, event: { type: "turn_started", provider: "codex", turnId: (event as { turnId: string }).turnId } } as TimelineEvent);
    }
    await h(event as never);
    // 后台 void task() 留一个 macrotask 让它跑完。
    await new Promise((r) => setTimeout(r, 0));
  };
  return { handlers, session, feishu, cards, emit, deps, observe };
}

const agent = { id: "agent-1", workspaceId: null, parentAgentId: null, provider: "codex", cwd: "/x", title: "Relay" };

function turnEvent(outcome: { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string }, timeline: { type: string; text?: string }[] = [], turnId: string | null = "turn-1") {
  return { agent, turnId, outcome, timeline };
}

const permRequest = {
  id: "req-1",
  provider: "codex",
  name: "exec",
  kind: "tool",
  title: "Run",
  description: "ls",
  actions: [
    { id: "a-allow", label: "Allow", behavior: "allow" },
    { id: "a-deny", label: "Deny", behavior: "deny" },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("registerNotifications", () => {
  it("turn_ended 按 completed/failed/canceled 映射", async () => {
    const t = setup();
    await t.emit("agent.turn_ended", turnEvent({ kind: "completed" }, [{ type: "assistant_message", text: "done" }]));
    expect(t.feishu.sendText).toHaveBeenLastCalledWith("chat-1", expect.stringContaining("已完成"));

    await t.emit("agent.turn_ended", turnEvent({ kind: "failed", error: { message: "boom" } }, [], "turn-2"));
    expect(t.feishu.sendText).toHaveBeenLastCalledWith("chat-1", expect.stringContaining("失败"));

    await t.emit("agent.turn_ended", turnEvent({ kind: "canceled", reason: "user" }, [], "turn-3"));
    expect(t.feishu.sendText).toHaveBeenLastCalledWith("chat-1", expect.stringContaining("已取消"));
  });

  it("非当前绑定被忽略", async () => {
    const t = setup();
    t.session.currentScope.mockReturnValue({ ...t.session.currentScope(), agentId: "other-agent" });
    await t.emit("agent.turn_ended", turnEvent({ kind: "completed" }));
    await t.emit(
      "agent.permission_requested",
      { agent, request: permRequest },
    );
    expect(t.feishu.sendText).not.toHaveBeenCalled();
    expect(t.feishu.sendCard).not.toHaveBeenCalled();
  });

  it("session 为 null 被忽略", async () => {
    const t = setup();
    (t.deps as { session: unknown }).session = (() => null) as unknown as SessionController;
    const { session: fastSession, feishu, cards } = t;
    void fastSession;
    // deps.session 已被替换，emit 走新的 null session。
    await t.emit("agent.turn_ended", turnEvent({ kind: "completed" }));
    await t.emit("agent.archived", { agent, archivedAt: "x" });
    expect(feishu.sendText).not.toHaveBeenCalled();
    expect(cards).toBeDefined();
  });

  it("重复 turn_ended 只发一次", async () => {
    const t = setup();
    const e = turnEvent({ kind: "completed" }, [{ type: "assistant_message", text: "hi" }]);
    await t.emit("agent.turn_ended", e);
    await t.emit("agent.turn_ended", e);
    expect(t.feishu.sendText).toHaveBeenCalledTimes(1);
  });

  it("delivers a late old turn once without sealing or repainting the new turn", async () => {
    const t = setup();
    t.observe({ agentId: agent.id, event: { type: "turn_started", provider: "codex", turnId: "turn-2" } } as TimelineEvent);
    const ended = t.handlers.get("agent.turn_ended")!;
    const old = turnEvent({ kind: "completed" }, [{ type: "assistant_message", text: "old result" }]);
    await ended(old as never);
    await ended(old as never);
    expect(t.feishu.sendText).toHaveBeenCalledExactlyOnceWith("chat-1", "Relay · 已完成（轮次 turn-1）\nold result");
    expect(t.feishu.sendCard).not.toHaveBeenCalled();
    expect(t.feishu.updateCard).not.toHaveBeenCalled();

    await ended(turnEvent({ kind: "completed" }, [{ type: "assistant_message", text: "new result" }], "turn-2") as never);
    await vi.waitFor(() => expect(t.feishu.sendText).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(t.feishu.sendCard.mock.calls)).toContain("new result");
    expect(JSON.stringify(t.feishu.sendCard.mock.calls)).not.toContain("old result");
  });

  it("permission_resolved 重复到达只处理一次", async () => {
    const t = setup();
    await t.emit("agent.permission_requested", { agent, request: permRequest });
    expect(t.cards.permission).toHaveBeenCalledTimes(1);
    await t.emit("agent.permission_resolved", { agent, requestId: "req-1", resolution: { behavior: "allow" } });
    await t.emit("agent.permission_resolved", { agent, requestId: "req-1", resolution: { behavior: "allow" } });
    expect(t.feishu.updateCard).toHaveBeenCalledTimes(1);
  });

  it("不可映射的权限请求发 notice 而非审批卡", async () => {
    const t = setup();
    await t.emit("agent.permission_requested", {
      agent,
      request: { ...permRequest, id: "req-2", kind: "question", actions: undefined },
    });
    expect(t.cards.permission).not.toHaveBeenCalled();
    expect(t.cards.notice).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("需要回答") }));
  });

  it("hook 在 feishu 挂起时仍立刻返回", async () => {
    const t = setup();
    t.feishu.sendText.mockImplementation(() => new Promise(() => {}));
    const h = t.handlers.get("agent.turn_ended")!;
    const started = Date.now();
    await h(turnEvent({ kind: "completed" }, []) as never);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("无助手文本时只发状态", async () => {
    const t = setup();
    await t.emit("agent.turn_ended", turnEvent({ kind: "completed" }, [{ type: "reasoning", text: "hmm" }]));
    expect(t.feishu.sendText).toHaveBeenLastCalledWith("chat-1", "Relay · 已完成");
  });

  it("archived 发 notice 且不调 session 的清除", async () => {
    const t = setup();
    await t.emit("agent.archived", { agent, archivedAt: "2026-01-01" });
    expect(t.feishu.sendText).toHaveBeenLastCalledWith("chat-1", expect.stringContaining("已归档"));
  });

  it("逆序取最后一段助手文本", async () => {
    const t = setup();
    await t.emit(
      "agent.turn_ended",
      turnEvent({ kind: "completed" }, [
        { type: "assistant_message", text: "first" },
        { type: "tool_call" },
        { type: "assistant_message", text: "last" },
      ]),
    );
    expect(JSON.stringify(t.feishu.sendCard.mock.calls)).toContain("last");
    expect(JSON.stringify(t.feishu.sendCard.mock.calls)).not.toContain("first");
  });

  it("连续的助手分片拼成完整答复，工具输出不并入", async () => {
    const t = setup();
    await t.emit(
      "agent.turn_ended",
      turnEvent({ kind: "completed" }, [
        { type: "assistant_message", text: "前半" },
        { type: "tool_call", text: "secret command output" },
        { type: "assistant_message", text: "后半" },
        { type: "assistant_message", text: "结尾" },
      ]),
    );
    const body = JSON.stringify(t.feishu.sendCard.mock.calls);
    expect(body).toContain("后半结尾");
    expect(body).not.toContain("前半");
    expect(body).not.toContain("secret command output");
  });
});


describe("authoritative final content", () => {
  it("ignores trailing non-message items, excludes earlier dialogue, and bounds final text", async () => {
    const t = setup();
    await t.emit("agent.turn_ended", turnEvent({ kind: "completed" }, [
      { type: "assistant_message", text: "old answer" }, { type: "user_message", text: "new question" },
      { type: "assistant_message", text: "new answer" + "x".repeat(13000) }, { type: "reasoning", text: "private" }, { type: "tool_call", text: "secret" },
    ]));
    const card = JSON.stringify(t.feishu.sendCard.mock.calls);
    expect(card).toContain("new answer"); expect(card).toContain("截断"); expect(card).toContain("Paseo");
    expect(card).not.toContain("old answer"); expect(card).not.toContain("private"); expect(card).not.toContain("secret");
    expect(card.length).toBeLessThan(13000);
    expect(t.feishu.sendText).toHaveBeenCalledExactlyOnceWith("chat-1", "Relay · 已完成");
  });
  it("a hook without turn ownership does not reuse historical assistant text", async () => {
    const t = setup();
    await t.emit("agent.turn_ended", turnEvent({ kind: "completed" }, [{ type: "assistant_message", text: "old answer" }], null));
    expect(JSON.stringify(t.feishu.sendCard.mock.calls)).not.toContain("old answer");
    expect(t.feishu.sendCard).not.toHaveBeenCalled();
    expect(t.feishu.sendText).not.toHaveBeenCalled();
  });
});

it.each(["failed", "canceled"] as const)("%s preserves a bounded protocol reason in final card, reminder and fallback", async kind => {
  const reason = "specific reason\n" + "x".repeat(500);
  const outcome = kind === "failed" ? { kind, error: { message: reason, diagnostic: "DO NOT SERIALIZE" } } : { kind, reason };
  const event = turnEvent(outcome, [{ type: "assistant_message", text: "final body" }]);
  const t = setup();
  await t.emit("agent.turn_ended", event);
  const card = JSON.stringify(t.feishu.sendCard.mock.calls);
  expect(card).toContain("specific reason"); expect(card).not.toContain("DO NOT SERIALIZE");
  const reminder = (t.feishu.sendText.mock.calls as unknown as [string, string][])[0]![1];
  expect(reminder).toContain("specific reason"); expect(reminder.length).toBeLessThan(350);
  expect(reminder).not.toContain("final body"); expect(reminder).not.toContain("\n");
  const fallback = setup(); fallback.feishu.sendCard.mockRejectedValueOnce(new Error("card API"));
  await fallback.emit("agent.turn_ended", event);
  expect(fallback.feishu.sendText).toHaveBeenCalledExactlyOnceWith("chat-1", `${reminder}\nfinal body`);
});
