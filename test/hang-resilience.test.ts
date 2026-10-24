import { describe, expect, it, vi } from "vitest";
import { createLiveReplies } from "../server/live-replies.js";
import { createSession } from "../server/session.js";
import { createCardBuilders } from "../server/cards.js";
import { emptyState } from "../server/contracts.js";
import type { BindingScope, PaseoPort, TimelinePage } from "../server/contracts.js";

// A hung API call must never leave the chat permanently silent. Every wait on a
// network operation here is expected to give up on its own; these tests hang the
// dependency and assert that later work still proceeds.

function page(over: Partial<TimelinePage> = {}): TimelinePage {
  return {
    requestId: "r", agentId: "a", agent: null, direction: "tail", projection: "projected",
    epoch: "e", reset: false, staleCursor: false, gap: false,
    window: { minSeq: 1, maxSeq: 1, nextSeq: 2 }, startCursor: null, endCursor: null,
    hasOlder: false, hasNewer: false, error: null, entries: [], ...over,
  };
}

const feishuPort = (over: Partial<Record<string, unknown>> = {}) => ({
  sendText: vi.fn(async () => {}),
  sendCard: vi.fn(async () => "m"),
  updateCard: vi.fn(async () => {}),
  ...over,
});

const cards = {
  picker: () => ({}), current: () => ({}), help: () => ({}), history: () => ({}),
  reply: () => ({}), permission: () => ({}), permissionResolved: () => ({}), notice: () => ({}),
} as never;

/** 一个带 activeTurn 的尾页：让观测真的建立 turn，从而开始写进度卡。 */
function runningPage(text = "进展"): TimelinePage {
  return page({
    agent: { title: "t", status: "running", activeTurn: { turnId: "t1" } } as TimelinePage["agent"],
    entries: [{
      provider: "p", turnId: "t1", timestamp: "n", seqStart: 1, seqEnd: 1,
      sourceSeqRanges: [], collapsed: [], item: { type: "assistant_message", text },
    }],
  });
}

function live(paseoOver: Record<string, unknown>, feishuOver: Partial<Record<string, unknown>> = {}) {
  const unsubscribe = Object.assign(vi.fn(), {
    ready: Promise.resolve(), subscriptionId: "s", release: async () => {},
  });
  const paseo = {
    isReady: () => true,
    readTimeline: vi.fn(async () => runningPage()),
    subscribeTimeline: vi.fn(() => unsubscribe),
    ...paseoOver,
  };
  const feishu = feishuPort(feishuOver);
  const scope: BindingScope = { generation: 1, agentId: "a", chatId: "c" };
  const l = createLiveReplies({
    paseo: paseo as unknown as PaseoPort, feishu: feishu as never, cards,
    isCurrent: () => true, invalidateHistory() {},
  });
  l.bind(scope);
  return { live: l, scope, paseo, feishu };
}

const never = <T,>() => new Promise<T>(() => {});

describe("a hung timeline read", () => {
  it("does not stop a later binding from refreshing", async () => {
    vi.useFakeTimers();
    try {
      const t = live({ readTimeline: vi.fn(() => never<TimelinePage>()) });
      await vi.advanceTimersByTimeAsync(1200);
      expect(t.paseo.readTimeline).toHaveBeenCalledTimes(1);
      // Rebind to another agent: the stuck read must not keep the new one idle.
      t.live.bind({ generation: 2, agentId: "b", chatId: "c" });
      await vi.advanceTimersByTimeAsync(5000);
      expect(t.paseo.readTimeline.mock.calls.length).toBeGreaterThan(1);
      t.live.close();
    } finally { vi.useRealTimers(); }
  });
});

describe("a hung card write", () => {
  it("times out the progress frame and lets later frames through", async () => {
    vi.useFakeTimers();
    try {
      let hang = true;
      const t = live(
        {},
        { sendCard: vi.fn(() => (hang ? never<string>() : Promise.resolve("card-1"))) },
      );
      // 观测建立后第一帧就会写卡
      await vi.advanceTimersByTimeAsync(200);
      expect(t.feishu.sendCard).toHaveBeenCalledTimes(1);
      hang = false;
      // 写卡上限过去后 writing 必须复位，新事件才能再写一帧。
      await vi.advanceTimersByTimeAsync(20_000);
      t.live.waiting(t.scope, true);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(t.feishu.sendCard.mock.calls.length).toBeGreaterThan(1);
      t.live.close();
    } finally { vi.useRealTimers(); }
  });

  it("does not strand the completion notification behind it", async () => {
    vi.useFakeTimers();
    try {
      const t = live({}, { updateCard: vi.fn(() => never<void>()) });
      await vi.advanceTimersByTimeAsync(200);
      const finish = t.live.seal(t.scope, "t1")!;
      expect(finish).not.toBeNull();
      let done = false;
      void finish.finish({ title: "t", phase: "已完成", updatedAt: 0, text: "b", incomplete: false }, "提醒")
        .then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(40_000);
      expect(done).toBe(true);
      // The reminder still has to reach the user.
      expect(t.feishu.sendText).toHaveBeenCalled();
      t.live.close();
    } finally { vi.useRealTimers(); }
  });
});

describe("a hung history page", () => {
  it("frees the serialized history chain for the next request", async () => {
    vi.useRealTimers();
    const state = emptyState();
    state.binding = { agentId: "a", chatId: "c", openId: "o", bindingRevision: 1, pickerRevision: 0, pickerMessageId: null };
    let reads = 0;
    const session = await createSession({
      ownerOpenId: "o",
      store: { load: async () => state, save: async () => {} },
      paseo: {
        isReady: () => true,
        refreshAgent: async () => ({ id: "a", title: "t", provider: "p", cwdLabel: "c", status: "idle", archived: false, lastActivityAt: 0 }),
        subscribeTimeline: () => Object.assign(() => {}, { ready: Promise.resolve(), subscriptionId: null, release: async () => {} }),
        readTimeline: () => { reads++; return never<TimelinePage>(); },
      } as never,
      feishu: feishuPort() as never,
      cards,
    });
    void session.handleText({ messageId: "h1", chatId: "c", text: "/history" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    const afterFirst = reads;
    void session.handleText({ messageId: "h2", chatId: "c", text: "/history" }).catch(() => {});
    // 单页读取上限之后，排队的第二个 /history 必须能拿到自己的读取机会。
    await vi.waitFor(() => expect(reads).toBeGreaterThan(afterFirst), { timeout: 15_000 });
    await session.close();
  }, 25_000);
});

describe("a hung picker update", () => {
  it("does not block later picker refreshes", async () => {
    vi.useRealTimers();
    const state = emptyState();
    state.binding = { agentId: "a", chatId: "c", openId: "o", bindingRevision: 1, pickerRevision: 1, pickerMessageId: "p1" };
    let writes = 0;
    const session = await createSession({
      ownerOpenId: "o",
      store: { load: async () => state, save: async () => {} },
      paseo: {
        isReady: () => true,
        listAgents: async () => [],
        refreshAgent: async () => ({ id: "a", title: "t", provider: "p", cwdLabel: "c", status: "idle", archived: false, lastActivityAt: 0 }),
        subscribeTimeline: () => Object.assign(() => {}, { ready: Promise.resolve(), subscriptionId: null, release: async () => {} }),
        readTimeline: async () => page(),
      } as never,
      feishu: feishuPort({ updateCard: () => { writes++; return never<void>(); } }) as never,
      cards,
    });
    const click = () => session.handleCardAction({
      messageId: "p1", chatId: "c", action: { action: "refresh_agents", pickerRevision: 1 },
    });
    void click();
    await new Promise((r) => setTimeout(r, 50));
    const afterFirst = writes;
    void click();
    await vi.waitFor(() => expect(writes).toBeGreaterThan(afterFirst), { timeout: 15_000 });
    await session.close();
  }, 25_000);
});

describe("a hung read on the current binding", () => {
  it("does not freeze the card forever once the first read succeeded", async () => {
    vi.useFakeTimers();
    try {
      // 第二次读取挂住：首次已就绪，ensureReady 会直接放行，正是盲点所在。
      let n = 0;
      const reads = vi.fn(() =>
        ++n === 2 ? never<TimelinePage>() : Promise.resolve(runningPage(`p${n}`)),
      );
      let listener!: (e: unknown) => void;
      const unsubscribe = Object.assign(vi.fn(), {
        ready: Promise.resolve(), subscriptionId: "s", release: async () => {},
      });
      const paseo = {
        isReady: () => true,
        readTimeline: reads,
        subscribeTimeline: vi.fn((_id: string, cb: (e: unknown) => void) => { listener = cb; return unsubscribe; }),
      };
      const feishu = feishuPort();
      const scope: BindingScope = { generation: 1, agentId: "a", chatId: "c" };
      const l = createLiveReplies({
        paseo: paseo as unknown as PaseoPort, feishu: feishu as never, cards,
        isCurrent: () => true, invalidateHistory() {},
      });
      l.bind(scope);
      await vi.advanceTimersByTimeAsync(1200);
      expect(await l.ensureReady(scope)).toBe(true);
      // 触发第二次读（会挂住）
      listener({ agentId: "a", event: { type: "timeline", provider: "p", item: { type: "assistant_message", text: "x" } } });
      await vi.advanceTimersByTimeAsync(1200);
      const afterHang = reads.mock.calls.length;
      expect(afterHang).toBe(2);
      // 读上限（20s）之后必须释放读取槽：新事件要能再触发一次读取，而不是永久冻结
      await vi.advanceTimersByTimeAsync(25_000);
      listener({ agentId: "a", event: { type: "timeline", provider: "p", item: { type: "assistant_message", text: "y" } } });
      await vi.advanceTimersByTimeAsync(1200);
      expect(reads.mock.calls.length).toBeGreaterThan(afterHang);
      l.close();
    } finally { vi.useRealTimers(); }
  });
});
