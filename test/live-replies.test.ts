import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../server/session.js";
import { emptyState } from "../server/contracts.js";
import { createLiveReplies } from "../server/live-replies.js";
import { createCardBuilders } from "../server/cards.js";
import type { BindingScope, FeishuCard, PaseoPort, ReplyView, TimelineEvent, TimelinePage } from "../server/contracts.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
function page(text = "公开进展", over: Partial<TimelinePage> = {}): TimelinePage {
  return {
    requestId: "read", agentId: "a", agent: { title: "会话", status: "running", activeTurn: { turnId: "t" } } as TimelinePage["agent"],
    direction: "tail", projection: "projected", epoch: "e", reset: false, staleCursor: false, gap: false,
    window: { minSeq: 1, maxSeq: 1, nextSeq: 2 }, startCursor: { epoch: "e", seq: 1 }, endCursor: { epoch: "e", seq: 1 }, hasOlder: false, hasNewer: false, error: null,
    entries: [{ provider: "codex", turnId: "t", timestamp: "now", seqStart: 1, seqEnd: 1, sourceSeqRanges: [], collapsed: [], item: { type: "assistant_message", text } }], ...over,
  };
}
const final: ReplyView = { title: "会话", phase: "已完成", updatedAt: 10, text: "最终答案", incomplete: false };
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function setup(initial = page()) {
  let current: BindingScope = { generation: 1, agentId: "a", chatId: "c" };
  let connected = true;
  let listener!: (e: TimelineEvent) => void;
  const established = deferred<void>();
  const unsubscribe = Object.assign(vi.fn(), { ready: established.promise, subscriptionId: "sub", release: async () => {} });
  const read = vi.fn(async (): Promise<TimelinePage> => initial);
  const paseo = { isReady: () => connected, readTimeline: read, subscribeTimeline: vi.fn((_id: string, cb: typeof listener) => { listener = cb; return unsubscribe; }) };
  const feishu = { sendCard: vi.fn(async () => "card"), updateCard: vi.fn(async (_messageId: string, _card: FeishuCard) => {}), sendText: vi.fn(async () => {}) };
  const invalidateHistory = vi.fn();
  const live = createLiveReplies({ paseo: paseo as unknown as PaseoPort, feishu, cards: createCardBuilders(), isCurrent: s => s.generation === current.generation, invalidateHistory });
  const scope = current;
  live.bind(scope);
  return { live, scope, paseo, feishu, read, established, unsubscribe, invalidateHistory,
    event(event: TimelineEvent["event"]) { listener({ agentId: "a", event } as TimelineEvent); },
    switch() { current = { ...current, generation: current.generation + 1 }; live.bind(current); },
    bindAgent(agentId: string) { current = { ...current, agentId, generation: current.generation + 1 }; live.bind(current); return current; },
    offline() { connected = false; },
    closeScope() { current = { ...current, generation: current.generation + 1 }; live.close(); },
  };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10000); });
afterEach(() => { vi.useRealTimers(); });

describe("live replies lifecycle", () => {
  it("waits for ready and initial snapshot; renders public text before turn end", async () => {
    const t = setup();
    const gate = deferred<TimelinePage>();
    t.read.mockReturnValueOnce(gate.promise);
    let ready: boolean | undefined;
    void t.live.ensureReady(t.scope).then(value => { ready = value; });
    await flush();
    expect(t.read).not.toHaveBeenCalled();
    t.established.resolve(); await flush();
    expect(ready).toBeUndefined();
    gate.resolve(page()); await flush();
    expect(ready).toBe(true);
    expect(JSON.stringify(t.feishu.sendCard.mock.calls)).toContain("公开进展");
    t.live.close();
    expect(t.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("restored blocks readiness until a fresh snapshot, coalescing events without polling", async () => {
    const t = setup(); t.established.resolve(); await flush();
    const gate = deferred<TimelinePage>(); t.read.mockReturnValueOnce(gate.promise);
    t.event({ type: "subscription_restored" });
    let ready: boolean | undefined;
    void t.live.ensureReady(t.scope).then(v => { ready = v; });
    for (let i = 0; i < 10; i++) t.event({ type: "timeline", provider: "codex", item: { type: "assistant_message", text: "delta must not append" } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ready).toBeUndefined();
    gate.resolve(page("新快照")); await flush();
    expect(ready).toBe(true);
    expect(t.read).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(t.feishu.updateCard.mock.calls)).toContain("新快照");
    await vi.advanceTimersByTimeAsync(10000);
    expect(t.read).toHaveBeenCalledTimes(2);
  });

  it("seals during card creation, then finalizes the same card before one short reminder", async () => {
    const t = setup(); const gate = deferred<string>(); t.feishu.sendCard.mockReturnValueOnce(gate.promise);
    t.established.resolve(); await flush();
    const finish = t.live.seal(t.scope, "t")!;
    const done = finish.finish(final, "会话 · 已完成"); await flush();
    expect(t.feishu.sendText).not.toHaveBeenCalled();
    t.event({ type: "turn_started", provider: "codex", turnId: "t" });
    gate.resolve("card"); await done;
    expect(t.feishu.updateCard).toHaveBeenCalledWith("card", expect.objectContaining({ header: expect.anything() }));
    expect(JSON.stringify(t.feishu.updateCard.mock.calls)).toContain("最终答案");
    expect(t.feishu.sendText).toHaveBeenCalledExactlyOnceWith("c", "会话 · 已完成");
    expect(t.live.seal(t.scope, "t")).toBeNull();
    await vi.advanceTimersByTimeAsync(10000);
    expect(t.read).toHaveBeenCalledTimes(1);
  });

  it("final write waits for an in-flight update and cannot be overwritten by a pending snapshot", async () => {
    const t = setup(); t.established.resolve(); await flush();
    const update = deferred<void>(); t.feishu.updateCard.mockReturnValueOnce(update.promise);
    t.event({ type: "timeline", provider: "codex", item: { type: "assistant_message", text: "ignored delta" } });
    await vi.advanceTimersByTimeAsync(1000);
    const read = deferred<TimelinePage>(); t.read.mockReturnValueOnce(read.promise);
    t.event({ type: "timeline", provider: "codex", item: { type: "assistant_message", text: "ignored" } });
    await vi.advanceTimersByTimeAsync(1000);
    const done = t.live.seal(t.scope, "t")!.finish(final, "完成"); await flush();
    expect(t.feishu.updateCard).toHaveBeenCalledTimes(1);
    read.resolve(page("迟到旧进度")); await flush();
    update.resolve(); await done;
    expect(t.feishu.updateCard).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(t.feishu.updateCard.mock.calls.at(-1))).toContain("最终答案");
    expect(JSON.stringify(t.feishu.updateCard.mock.calls)).not.toContain("迟到旧进度");
  });

  it("replacement drops pending old text and invalidates history before reconciling", async () => {
    const t = setup(); const gate = deferred<TimelinePage>(); t.read.mockReturnValueOnce(gate.promise);
    t.established.resolve(); await flush();
    t.event({ type: "replacement", epoch: "new" });
    let ready: boolean | undefined; void t.live.ensureReady(t.scope).then(v => { ready = v; });
    t.read.mockResolvedValue(page("新 epoch", { epoch: "new" }));
    gate.resolve(page("旧 epoch")); await flush();
    expect(t.feishu.sendCard).not.toHaveBeenCalled();
    expect(t.invalidateHistory).toHaveBeenCalledOnce();
    expect(ready).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ready).toBe(true);
    expect(JSON.stringify(t.feishu.sendCard.mock.calls)).toContain("新 epoch");
    expect(JSON.stringify(t.feishu.sendCard.mock.calls)).not.toContain("旧 epoch");
  });

  it("switch and close discard old requests and release the subscription and timer", async () => {
    const t = setup(); const gate = deferred<TimelinePage>(); t.read.mockReturnValueOnce(gate.promise);
    t.established.resolve(); await flush();
    t.switch();
    gate.resolve(page("旧绑定")); await flush();
    expect(JSON.stringify(t.feishu.sendCard.mock.calls)).not.toContain("旧绑定");
    t.event({ type: "timeline", provider: "codex", item: { type: "reasoning", text: "secret" } });
    t.live.close(); await vi.advanceTimersByTimeAsync(10000);
    expect(t.unsubscribe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("card creation failure falls back once to final body; reminder failure never resends it", async () => {
    const t = setup(); t.feishu.sendCard.mockRejectedValueOnce(new Error("API"));
    t.established.resolve(); await flush();
    await t.live.seal(t.scope, "t")!.finish(final, "完成");
    expect(t.feishu.sendText).toHaveBeenCalledExactlyOnceWith("c", "完成\n最终答案");
    const other = setup(); other.established.resolve(); await flush();
    other.feishu.sendText.mockRejectedValueOnce(new Error("API"));
    await other.live.seal(other.scope, "t")!.finish(final, "完成");
    expect(other.feishu.sendText).toHaveBeenCalledExactlyOnceWith("c", "完成");
  });

  it("final update failure falls back, including a current binding with no active card", async () => {
    const t = setup(); t.established.resolve(); await flush();
    t.feishu.updateCard.mockRejectedValueOnce(new Error("API"));
    await t.live.seal(t.scope, "t")!.finish(final, "完成");
    expect(t.feishu.sendText).toHaveBeenCalledExactlyOnceWith("c", "完成\n最终答案");
    const idle = setup(page("旧答案", { agent: null })); idle.established.resolve(); await flush();
    expect(idle.feishu.sendCard).not.toHaveBeenCalled();
    idle.event({ type: "turn_started", provider: "codex", turnId: "new-turn" });
    await idle.live.seal(idle.scope, "new-turn")!.finish(final, "完成");
    expect(JSON.stringify(idle.feishu.sendCard.mock.calls)).toContain("最终答案");
    expect(JSON.stringify(idle.feishu.sendCard.mock.calls)).not.toContain("旧答案");
  });

  it("missing turn ownership and gaps are incomplete and never expose old or reasoning text", async () => {
    const p = page("旧答案"); p.entries[0]!.turnId = undefined;
    p.entries.push({ ...p.entries[0]!, item: { type: "reasoning", text: "secret reasoning" } });
    const t = setup({ ...p, gap: true }); t.established.resolve(); await flush();
    const card = JSON.stringify(t.feishu.sendCard.mock.calls);
    expect(card).toContain("不完整"); expect(card).not.toContain("旧答案"); expect(card).not.toContain("secret reasoning");
  });

  it("a new turn invalidates an old snapshot; an unidentified start cannot reopen the sealed turn", async () => {
    const t = setup(); const gate = deferred<TimelinePage>(); t.read.mockReturnValueOnce(gate.promise);
    t.established.resolve(); await flush();
    t.event({ type: "turn_started", provider: "codex", turnId: "new" });
    const p = page("新一轮"); p.agent!.activeTurn = { turnId: "new", startedAt: null }; p.entries[0]!.turnId = "new";
    t.read.mockResolvedValue(p);
    gate.resolve(page("旧一轮")); await flush();
    expect(t.feishu.sendCard).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.stringify(t.feishu.sendCard.mock.calls)).toContain("新一轮");
    await t.live.seal(t.scope, "new")!.finish(final, "完成");
    t.event({ type: "turn_started", provider: "codex" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.feishu.sendCard).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(t.feishu.updateCard.mock.calls.at(-1))).toContain("最终答案");
  });

  it("subscription errors block readiness without creating reconnect loops; known offline blocks", async () => {
    const t = setup(); t.established.resolve(); await flush();
    t.event({ type: "error", error: "subscription lost" });
    await vi.advanceTimersByTimeAsync(10000);
    expect(t.paseo.subscribeTimeline).toHaveBeenCalledTimes(1);
    expect(t.read).toHaveBeenCalledTimes(1);
    t.offline(); expect(await t.live.ensureReady(t.scope)).toBe(false);
  });
});


describe("session observation gate", () => {
  it("startup offline establishes observation on first submission; ready and restored gate send", async () => {
    let connected = false;
    let listener!: (e: TimelineEvent) => void;
    const ready = deferred<void>();
    const subscription = Object.assign(vi.fn(), { ready: ready.promise, subscriptionId: "sub", release: async () => {} });
    const read = vi.fn(async () => page("", { agent: null }));
    const send = vi.fn(async (_agentId: string, _body: string) => ({ ok: true as const }));
    const paseo = { isReady: () => connected, readTimeline: read, send,
      subscribeTimeline: vi.fn((_id: string, cb: typeof listener) => { listener = cb; return subscription; }) };
    const state = emptyState();
    state.binding = { agentId: "a", chatId: "c", openId: "owner", bindingRevision: 1, pickerMessageId: null, pickerRevision: 0 };
    const feishu = { sendCard: vi.fn(async () => "card"), updateCard: vi.fn(async (_messageId: string, _card: FeishuCard) => {}), sendText: vi.fn(async () => {}) };
    const session = await createSession({ ownerOpenId: "owner", store: { load: async () => state, save: async () => {} }, paseo: paseo as unknown as PaseoPort, cards: createCardBuilders(), feishu });
    expect(paseo.subscribeTimeline).not.toHaveBeenCalled();
    connected = true;
    const message = { messageId: "m1", chatId: "c", text: "hello" };
    const first = session.handleText(message); await flush();
    expect(paseo.subscribeTimeline).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    ready.resolve(); await first;
    expect(send).toHaveBeenCalledTimes(1);
    const gates = Array.from({ length: 4 }, () => deferred<TimelinePage>());
    for (const gate of gates) read.mockReturnValueOnce(gate.promise);
    listener({ agentId: "a", subscriptionId: "sub", event: { type: "subscription_restored" } });
    const second = session.handleText({ ...message, messageId: "m2" }); await flush();
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    for (let i = 0; i < gates.length; i++) {
      listener({ agentId: "a", event: { type: "timeline", provider: "codex", item: { type: "assistant_message", text: "continuous live" } } } as TimelineEvent);
      gates[i]!.resolve(page("", { agent: null })); await flush();
      if (i === 0) await second;
      expect(send).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
    }
    listener({ agentId: "a", event: { type: "error", error: "lost" } });
    // This explicit submission retries observation once; its ready rejection blocks sending.
    const rejectedReady = Promise.reject(new Error("subscribe failed"));
    paseo.subscribeTimeline.mockReturnValueOnce(Object.assign(vi.fn(), { ready: rejectedReady, subscriptionId: "retry", release: async () => {} }));
    await session.handleText({ ...message, messageId: "m3" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(feishu.sendText).toHaveBeenLastCalledWith("c", expect.stringContaining("消息未发送"));
    const retry = session.handleText({ ...message, messageId: "m4", text: "new retry" });
    await flush(); await vi.advanceTimersByTimeAsync(1000); await retry;
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith("a", "new retry");
    await session.close();
    expect(subscription).toHaveBeenCalledTimes(2);
  });
});

describe("T2 review regressions", () => {
  it("first valid reconciliation releases input while live events dirty four successive reads", async () => {
    const t = setup();
    const gates = Array.from({ length: 4 }, () => deferred<TimelinePage>());
    for (const gate of gates) t.read.mockReturnValueOnce(gate.promise);
    const send = vi.fn();
    void t.live.ensureReady(t.scope).then(ok => { if (ok) send(); });
    t.established.resolve(); await flush();
    for (let i = 0; i < gates.length; i++) {
      t.event({ type: "timeline", provider: "codex", item: { type: "assistant_message", text: "live" } });
      gates[i]!.resolve(page(`snapshot-${i}`)); await flush();
      expect(send).toHaveBeenCalledOnce();
      expect(await t.live.ensureReady(t.scope)).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
    }
    t.live.close();
  });

  it("a rejected ready fails that submission; only the next explicit input retries once", async () => {
    const t = setup();
    const first = t.live.ensureReady(t.scope);
    t.established.reject(new Error("ready rejected"));
    expect(await first).toBe(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(t.paseo.subscribeTimeline).toHaveBeenCalledTimes(1);
    const retry = deferred<void>();
    const release = Object.assign(vi.fn(), { ready: retry.promise, subscriptionId: "retry", release: async () => {} });
    t.paseo.subscribeTimeline.mockReturnValueOnce(release);
    let result: boolean | undefined;
    void t.live.ensureReady(t.scope).then(ok => { result = ok; });
    await flush(); expect(result).toBeUndefined();
    retry.resolve(); await flush();
    expect(result).toBe(true);
    expect(t.paseo.subscribeTimeline).toHaveBeenCalledTimes(2);
    t.live.close();
  });

  it("an error fails a waiting restored submission and a later input rebuilds the released subscription", async () => {
    const t = setup(); t.established.resolve(); await flush();
    t.event({ type: "subscription_restored" });
    const first = t.live.ensureReady(t.scope);
    t.event({ type: "error", error: "released" });
    expect(await first).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.paseo.subscribeTimeline).toHaveBeenCalledTimes(1);
    const result = t.live.ensureReady(t.scope); await flush();
    expect(await result).toBe(true);
    expect(t.paseo.subscribeTimeline).toHaveBeenCalledTimes(2);
    // Preserve the current turn/card rather than resetting it on retry.
    expect(t.feishu.sendCard).toHaveBeenCalledTimes(1);
    t.live.close();
  });

  it.each(["creation", "update"])("slow %s keeps one replaceable latest frame, then seals without draining stale frames", async stage => {
    const t = setup();
    const create = deferred<string>(); const update = deferred<void>();
    if (stage === "creation") t.feishu.sendCard.mockReturnValueOnce(create.promise);
    t.established.resolve(); await flush();
    if (stage === "update") t.feishu.updateCard.mockReturnValueOnce(update.promise);
    for (const text of ["second", "middle", "latest"]) {
      t.read.mockResolvedValue(page(text));
      t.event({ type: "timeline", provider: "codex", item: { type: "assistant_message", text } });
      await vi.advanceTimersByTimeAsync(1000);
    }
    if (stage === "creation") create.resolve("card");
    else update.resolve();
    await flush();
    const writes = JSON.stringify(t.feishu.updateCard.mock.calls);
    expect(writes).toContain("latest");
    expect(writes).not.toContain("middle");
    if (stage === "creation") expect(writes).not.toContain("second");
    const finalUpdate = deferred<void>(); t.feishu.updateCard.mockReturnValueOnce(finalUpdate.promise);
    t.read.mockResolvedValue(page("in-flight"));
    t.event({ type: "timeline", provider: "codex", item: { type: "assistant_message", text: "in-flight" } });
    await vi.advanceTimersByTimeAsync(1000);
    t.read.mockResolvedValue(page("discard on seal"));
    t.event({ type: "timeline", provider: "codex", item: { type: "assistant_message", text: "discard on seal" } });
    await vi.advanceTimersByTimeAsync(1000);
    const done = t.live.seal(t.scope, "t")!.finish(final, "完成");
    finalUpdate.resolve(); await done;
    expect(JSON.stringify(t.feishu.updateCard.mock.calls.at(-1))).toContain("最终答案");
    expect(JSON.stringify(t.feishu.updateCard.mock.calls)).not.toContain("discard on seal");
    t.live.close();
  });

  it("observation failures after visible progress never claim the accepted message was not sent", async () => {
    const t = setup(); t.established.resolve(); await flush();
    t.event({ type: "error", error: "released" });
    await vi.advanceTimersByTimeAsync(1000);
    let card = JSON.stringify(t.feishu.updateCard.mock.calls.at(-1));
    expect(card).toContain("观察中断"); expect(card).not.toContain("消息未发送");
    const other = setup(); other.established.resolve(); await flush();
    other.read.mockRejectedValueOnce(new Error("snapshot failed"));
    other.event({ type: "timeline", provider: "codex", item: { type: "assistant_message", text: "event" } });
    await vi.advanceTimersByTimeAsync(1000);
    card = JSON.stringify(other.feishu.updateCard.mock.calls.at(-1));
    expect(card).toContain("状态待核对"); expect(card).toContain("不会自动重发"); expect(card).not.toContain("消息未发送");
    t.live.close(); other.live.close();
  });
});

it("rearms the remaining read deadline after a staggered pending write, without another event", async () => {
  const t = setup();
  const first = deferred<TimelinePage>();
  t.read.mockReturnValueOnce(first.promise);
  t.established.resolve(); await flush(); // 10.000: first read starts
  await vi.advanceTimersByTimeAsync(500);
  first.resolve(page("first")); await flush(); // 10.500: creation starts
  t.read.mockResolvedValue(page("second"));
  t.event({ type: "timeline", provider: "codex", item: { type: "assistant_message", text: "second" } });
  await vi.advanceTimersByTimeAsync(500); // 11.000: second read; write waits until 11.500
  expect(t.read).toHaveBeenCalledTimes(2);
  expect(t.feishu.updateCard).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  t.read.mockResolvedValue(page("latest"));
  t.event({ type: "timeline", provider: "codex", item: { type: "assistant_message", text: "last live" } }); // 11.200
  await vi.advanceTimersByTimeAsync(300); // 11.500: write consumes the shared timer
  expect(t.feishu.updateCard).toHaveBeenCalledTimes(1);
  expect(t.read).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1); // remaining read deadline must stay armed
  await vi.advanceTimersByTimeAsync(500); // 12.000: third read, without another live event
  expect(t.read).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(500); // 12.500: latest write respects one-second spacing
  expect(JSON.stringify(t.feishu.updateCard.mock.calls.at(-1))).toContain("latest");
  expect(t.feishu.updateCard).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(20000);
  expect(t.read).toHaveBeenCalledTimes(3);
  expect(t.feishu.updateCard).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  t.live.close();
});


it("rejects an A turn after switching A to B and back to A", async () => {
  const t = setup(); t.established.resolve(); await flush();
  t.bindAgent("b"); await flush();
  const next = page("new A progress"); next.agent!.activeTurn = { turnId: "t2", startedAt: null }; next.entries[0]!.turnId = "t2";
  t.read.mockResolvedValue(next);
  const scope = t.bindAgent("a"); await flush();
  expect(await t.live.ensureReady(scope)).toBe(true);
  const before = [t.feishu.sendCard.mock.calls.length, t.feishu.updateCard.mock.calls.length];
  expect(t.live.seal(scope, "t")).toBeNull();
  expect(t.feishu.sendText).not.toHaveBeenCalled();
  expect([t.feishu.sendCard.mock.calls.length, t.feishu.updateCard.mock.calls.length]).toEqual(before);
  await t.live.seal(scope, "t2")!.finish(final, "current complete");
  expect(t.feishu.sendText).toHaveBeenCalledWith("c", "current complete");
  t.live.close();
});

it("rejects a previous epoch turn", async () => {
  const t = setup(); t.established.resolve(); await flush();
  t.event({ type: "replacement", epoch: "new" });
  for (let i = 2; i <= 20; i++) t.event({ type: "turn_started", provider: "codex", turnId: `t${i}` });
  const next = page("new epoch progress", { epoch: "new" });
  next.agent!.activeTurn = { turnId: "t20", startedAt: null }; next.entries[0]!.turnId = "t20";
  t.read.mockResolvedValue(next); await vi.advanceTimersByTimeAsync(1000);
  expect(t.live.seal(t.scope, "t")).toBeNull();
  expect(t.feishu.sendText).not.toHaveBeenCalled();
  expect(await t.live.ensureReady(t.scope)).toBe(true);
  await t.live.seal(t.scope, "t20")!.finish(final, "current complete");
  expect(t.feishu.sendText).toHaveBeenCalledWith("c", "current complete");
  t.live.close();
});


// 死锁回归：飞书 chatQueue 会等 handler 的 promise。ensureReady 一旦永不返回，
// 私聊就再也不处理后续消息——表现为「发了消息完全没反应」。
describe("ensureReady never hangs (deadlock regression)", () => {
  it("read 一直挂起时 ensureReady 也必须超时返回 false，否则整个 chatQueue 死锁", async () => {
    let listener!: (e: TimelineEvent) => void;
    const ready = Promise.resolve();
    const unsubscribe = Object.assign(vi.fn(), { ready, subscriptionId: "s", release: async () => {} });
    // readTimeline 永不 resolve：模拟 daemon 半死
    const hangs = new Promise<TimelinePage>(() => {});
    const paseo = {
      isReady: () => true,
      readTimeline: vi.fn(() => hangs),
      subscribeTimeline: vi.fn((_id: string, cb: (e: TimelineEvent) => void) => { listener = cb; return unsubscribe; }),
    };
    const feishu = { sendCard: vi.fn(async () => "c"), updateCard: vi.fn(async () => {}), sendText: vi.fn(async () => {}) };
    const scope = { generation: 1, agentId: "a", chatId: "c" };
    const live = createLiveReplies({
      paseo: paseo as unknown as PaseoPort, feishu, cards: createCardBuilders(),
      isCurrent: () => true, invalidateHistory() {},
    });
    live.bind(scope);
    await vi.advanceTimersByTimeAsync(10);

    let settled: boolean | undefined;
    void live.ensureReady(scope).then(v => { settled = v; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBeDefined();
    expect(listener).toBeDefined();
    live.close();
  });
});

describe("subscribe handshake never settles", () => {
  it("ensureReady returns false instead of hanging forever", async () => {
    const never = new Promise<void>(() => {});
    const unsubscribe = Object.assign(vi.fn(), { ready: never, subscriptionId: "s", release: async () => {} });
    const paseo = {
      isReady: () => true,
      readTimeline: vi.fn(async () => page()),
      subscribeTimeline: vi.fn(() => unsubscribe),
    };
    const feishu = { sendCard: vi.fn(async () => "c"), updateCard: vi.fn(async () => {}), sendText: vi.fn(async () => {}) };
    const scope = { generation: 1, agentId: "a", chatId: "c" };
    const live = createLiveReplies({ paseo: paseo as never, feishu, cards: createCardBuilders(), isCurrent: () => true, invalidateHistory() {} });
    live.bind(scope);
    let settled: boolean | undefined;
    void live.ensureReady(scope).then(v => { settled = v; });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toBe(false);
    live.close();
  });

  it("a failed observation releases every waiter in the same tick", async () => {
    const never = new Promise<void>(() => {});
    const unsubscribe = Object.assign(vi.fn(), { ready: never, subscriptionId: "s", release: async () => {} });
    const paseo = { isReady: () => true, readTimeline: vi.fn(async () => page()), subscribeTimeline: vi.fn(() => unsubscribe) };
    const feishu = { sendCard: vi.fn(async () => "c"), updateCard: vi.fn(async () => {}), sendText: vi.fn(async () => {}) };
    const scope = { generation: 1, agentId: "a", chatId: "c" };
    const live = createLiveReplies({ paseo: paseo as never, feishu, cards: createCardBuilders(), isCurrent: () => true, invalidateHistory() {} });
    live.bind(scope);
    let first: boolean | undefined, second: boolean | undefined;
    void live.ensureReady(scope).then(v => { first = v; });
    await vi.advanceTimersByTimeAsync(8_000);
    void live.ensureReady(scope).then(v => { second = v; });
    await vi.advanceTimersByTimeAsync(9_000);
    // 观测整体失败：已排队的提交都该立刻知道，而不是各自倒计时到天明。
    expect(first).toBe(false);
    expect(second).toBe(false);
    live.close();
  });
});

describe("tool phase does not stick", () => {
  it("returns to 处理中 once an assistant message follows the tool call", async () => {
    // 快照尾部就是未完成的工具调用：卡片应显示“正在使用工具”
    const t = setup(page("", { entries: [
      { provider: "codex", turnId: "t", timestamp: "n", seqStart: 1, seqEnd: 1, sourceSeqRanges: [], collapsed: [],
        item: { type: "tool_call", status: "running" } },
    ] } as never));
    t.established.resolve(); await flush();
    await vi.advanceTimersByTimeAsync(1200);
    expect(JSON.stringify(t.feishu.sendCard.mock.calls.at(-1))).toContain("正在使用工具");

    // 工具跑完后正文继续产出：阶段必须回到“处理中”，不能一直粘在工具上
    t.read.mockResolvedValue(page("工具结果已拿到"));
    t.event({ type: "timeline", provider: "codex", item: { type: "assistant_message", text: "工具结果已拿到" } });
    await vi.advanceTimersByTimeAsync(2000);
    const latest = JSON.stringify(t.feishu.updateCard.mock.calls.at(-1));
    expect(latest).toContain("处理中");
    expect(latest).not.toContain("正在使用工具");
    t.live.close();
  });
});
