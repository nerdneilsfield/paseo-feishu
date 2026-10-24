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

type FinalItem = { type: string; text?: string };

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
  // turn_ended 不再携带 timeline，handler 通过 context.paseo 回读；这里按事件回填条目。
  type Page = { item: FinalItem; turnId: string | undefined; seqStart: number; seqEnd: number }[];
  let finalEntries: Page = [];
  // 空表示只有一页，测试需要翻页时替换成多页。
  let pages: Page[] | null = null;
  const refetch = vi.fn(async (..._args: unknown[]) => {
    const body = pages ? (pages.shift() ?? []) : finalEntries;
    return {
      error: null,
      hasOlder: pages !== null && pages.length > 0,
      startCursor: pages && pages.length > 0 ? { epoch: "e", seq: pages.length } : null,
      entries: body.map((e) => ({ ...e, timestamp: "t", provider: "codex", sourceSeqRanges: [], collapsed: [] })),
    };
  });
  const hookPaseo = {
    agents: { ref: vi.fn(() => ({ timeline: { refetch } })) },
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
    if (name === "agent.turn_ended") {
      const e = event as { turnId?: string; timeline?: FinalItem[] };
      const turnId = e.turnId ?? "turn-1";
      if (e.turnId) {
        observe({ agentId: scope.agentId, event: { type: "turn_started", provider: "codex", turnId: e.turnId } } as TimelineEvent);
      }
      if (pages === null) setTimeline(turnId, e.timeline ?? []);
    }
    await h(event as never, { paseo: hookPaseo } as never);
    // 后台 void task() 留一个 macrotask 让它跑完。
    await new Promise((r) => setTimeout(r, 0));
  };
  const setTimeline = (turnId: string, items: FinalItem[]) => {
    finalEntries = items.map((item, i) => ({ item, turnId, seqStart: i, seqEnd: i }));
    pages = null;
  };
  // turnId: null 表示该条目确实没有 turnId（fork、历史回放、压缩都会这样）。
  const setPages = (turnId: string, pageItems: (FinalItem & { turnId?: string | null })[][]) => {
    let seq = 1000;
    pages = pageItems.map((items) =>
      items.map(({ turnId: own, ...item }) => ({
        item,
        turnId: own === null ? undefined : (own ?? turnId),
        seqStart: seq--,
        seqEnd: seq,
      })),
    );
  };
  return { handlers, session, feishu, cards, emit, deps, observe, refetch, hookPaseo, setTimeline, setPages };
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
    const ctx = { paseo: t.hookPaseo } as never;
    const old = turnEvent({ kind: "completed" });
    t.setTimeline("turn-1", [{ type: "assistant_message", text: "old result" }]);
    await ended(old as never, ctx);
    await ended(old as never, ctx);
    await vi.waitFor(() => expect(t.feishu.sendText).toHaveBeenCalledExactlyOnceWith("chat-1", "Relay · 已完成（轮次 turn-1）\nold result"));
    expect(t.feishu.sendCard).not.toHaveBeenCalled();
    expect(t.feishu.updateCard).not.toHaveBeenCalled();

    await t.emit("agent.turn_ended", turnEvent({ kind: "completed" }, [{ type: "assistant_message", text: "new result" }], "turn-2"));
    await vi.waitFor(() => expect(t.feishu.sendText).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(t.feishu.sendCard.mock.calls)).toContain("new result");
    expect(JSON.stringify(t.feishu.sendCard.mock.calls)).not.toContain("old result");
  });

  it("reads the final answer from timeline.refetch instead of the hook payload", async () => {
    const t = setup();
    await t.emit("agent.turn_ended", turnEvent({ kind: "completed" }, []));
    expect(t.hookPaseo.agents.ref).toHaveBeenCalledWith(agent.id);
    expect(t.refetch).toHaveBeenCalledWith({ direction: "tail", projection: "projected", limit: 100 });
    expect(t.feishu.sendText).toHaveBeenLastCalledWith("chat-1", "Relay · 已完成");
  });

  it("keeps paging backwards until the turn ends", async () => {
    const t = setup();
    // 尾页只有工具条目，答案在前一页；第三页已跨过本轮起点。
    t.setPages("turn-1", [
      [{ type: "tool_call" }],
      [{ type: "assistant_message", text: "paged answer" }],
      [{ type: "assistant_message", text: "previous turn", turnId: "turn-0" }],
    ]);
    await t.emit("agent.turn_ended", turnEvent({ kind: "completed" }, []));
    expect(t.refetch).toHaveBeenCalledTimes(3);
    expect(t.refetch.mock.calls[1]![0]).toMatchObject({ direction: "before" });
    expect(JSON.stringify(t.feishu.sendCard.mock.calls)).toContain("paged answer");
    expect(JSON.stringify(t.feishu.sendCard.mock.calls)).not.toContain("previous turn");
  });

  it("stops at a cursor that does not advance", async () => {
    const t = setup();
    t.refetch.mockResolvedValue({
      error: null,
      hasOlder: true,
      startCursor: { epoch: "e", seq: 1 },
      entries: [],
    });
    await t.emit("agent.turn_ended", turnEvent({ kind: "completed" }, []));
    expect(t.refetch).toHaveBeenCalledTimes(2);
    expect(t.feishu.sendText).toHaveBeenLastCalledWith("chat-1", "Relay · 已完成");
  });

  it("still notifies when the history read fails", async () => {
    const t = setup();
    t.refetch.mockRejectedValueOnce(new Error("daemon gone"));
    await t.emit("agent.turn_ended", turnEvent({ kind: "completed" }, []));
    expect(t.feishu.sendText).toHaveBeenLastCalledWith("chat-1", "Relay · 已完成");
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
    await h(turnEvent({ kind: "completed" }, []) as never, { paseo: t.hookPaseo } as never);
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
    expect(t.refetch).not.toHaveBeenCalled();
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

describe("final text fallback", () => {
  it("falls back to entries without a turnId when the turn itself has no assistant text", async () => {
    const t = setup();
    // fork 出来的会话：正文落在没有 turnId 的条目上
    t.setPages("turn-1", [[{ type: "assistant_message", text: "forked body", turnId: null }]]);
    await t.emit("agent.turn_ended", turnEvent({ kind: "completed" }, []));
    expect(JSON.stringify(t.feishu.sendCard.mock.calls)).toContain("forked body");
  });

  it("still reports an empty body when neither the turn nor the tail has text", async () => {
    const t = setup();
    t.setPages("turn-1", [[{ type: "tool_call", turnId: null }]]);
    await t.emit("agent.turn_ended", turnEvent({ kind: "completed" }, []));
    expect(t.feishu.sendText).toHaveBeenLastCalledWith("chat-1", "Relay · 已完成");
  });
});

it("a throwing handler still answers instead of going silent", async () => {
  const t = setup();
  t.feishu.sendCard.mockRejectedValue(new Error("card API down"));
  await t.emit("agent.turn_ended", turnEvent({ kind: "completed" }, []));
  // 卡片挂了也要有文字回执；绝不能什么都不发。
  expect(t.feishu.sendText).toHaveBeenCalled();
});
