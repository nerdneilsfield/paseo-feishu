import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyState } from "../server/contracts.js";
import type { ConnectablePaseoPort, FeishuChannel, SessionController, Store, TimelinePage } from "../server/contracts.js";

const mocks = vi.hoisted(() => ({ paseo: vi.fn(), channel: vi.fn(), store: vi.fn() }));
vi.mock("../server/paseo", async original => ({ ...await original<typeof import("../server/paseo")>(), createPaseoPort: mocks.paseo }));
vi.mock("../server/channel", () => ({ createFeishuChannel: mocks.channel }));
vi.mock("../server/store", () => ({ createFileStore: mocks.store }));
import contribute from "../index.server.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
const snapshot = {
  requestId: "read", agentId: "a", agent: { title: "Running", status: "running", activeTurn: { turnId: "t" } },
  direction: "tail", projection: "projected", epoch: "e", reset: false, staleCursor: false, gap: false,
  window: { minSeq: 1, maxSeq: 1, nextSeq: 2 }, startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, error: null,
  entries: [{ provider: "codex", turnId: "t", timestamp: "now", seqStart: 1, seqEnd: 1, sourceSeqRanges: [], collapsed: [], item: { type: "assistant_message", text: "running progress" } }],
} as unknown as TimelinePage;

beforeEach(() => {
  vi.stubEnv("FEISHU_APP_ID", "test-app"); vi.stubEnv("FEISHU_APP_SECRET", "test-secret"); vi.stubEnv("FEISHU_OWNER_OPEN_ID", "owner");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("real startup assembly with restored session", () => {
  it.each(["connection first", "session first"])("%s starts observing a running binding without user input", async order => {
    const connection = deferred<void>(); const load = deferred<ReturnType<typeof emptyState>>();
    let ready = false;
    let session: SessionController | undefined;
    const unsubscribe = Object.assign(vi.fn(), { ready: Promise.resolve(), subscriptionId: "sub", release: async () => {} });
    const paseo = {
      connect: vi.fn(async () => { await connection.promise; ready = true; }), isReady: () => ready,
      subscribeTimeline: vi.fn(() => unsubscribe), readTimeline: vi.fn(async () => snapshot), close: vi.fn(async () => {}),
    };
    const feishu = { sendCard: vi.fn(async () => "reply"), updateCard: vi.fn(async () => {}), sendText: vi.fn(async () => {}) };
    const channel = { port: feishu, start: vi.fn(async (created: SessionController) => { session = created; }), stop: vi.fn(async () => {}) };
    const store: Store = { load: () => load.promise, save: vi.fn(async () => {}) };
    mocks.paseo.mockReturnValue(paseo as unknown as ConnectablePaseoPort);
    mocks.channel.mockReturnValue(channel as FeishuChannel); mocks.store.mockReturnValue(store);
    const cleanup = contribute({ on: vi.fn() } as unknown as Parameters<typeof contribute>[0]);
    const state = emptyState();
    state.binding = { agentId: "a", chatId: "c", openId: "owner", bindingRevision: 1, pickerRevision: 0, pickerMessageId: null };
    if (order === "connection first") {
      connection.resolve(); await flush();
      expect(channel.start).not.toHaveBeenCalled();
      load.resolve(state);
    } else {
      load.resolve(state); await flush();
      expect(session?.currentScope()?.agentId).toBe("a");
      expect(paseo.subscribeTimeline).not.toHaveBeenCalled();
      connection.resolve();
    }
    await flush();
    expect(paseo.subscribeTimeline).toHaveBeenCalledOnce();
    expect(paseo.readTimeline).toHaveBeenCalledOnce();
    expect(JSON.stringify(feishu.sendCard.mock.calls)).toContain("running progress");
    expect(channel.start).toHaveBeenCalledOnce();
    cleanup(); await flush();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("finalizes and reminds once through real session scopes with equal values and distinct identities", async () => {
    let session: SessionController | undefined;
    const unsubscribe = Object.assign(vi.fn(), { ready: Promise.resolve(), subscriptionId: "sub", release: async () => {} });
    const paseo = {
      connect: vi.fn(async () => {}), isReady: () => true,
      subscribeTimeline: vi.fn(() => unsubscribe), readTimeline: vi.fn(async () => snapshot), close: vi.fn(async () => {}),
    };
    const feishu = { sendCard: vi.fn(async () => "reply"), updateCard: vi.fn(async () => {}), sendText: vi.fn(async () => {}) };
    const channel = { port: feishu, start: vi.fn(async (created: SessionController) => { session = created; }), stop: vi.fn(async () => {}) };
    const state = emptyState();
    state.binding = { agentId: "a", chatId: "c", openId: "owner", bindingRevision: 1, pickerRevision: 0, pickerMessageId: null };
    mocks.paseo.mockReturnValue(paseo as unknown as ConnectablePaseoPort);
    mocks.channel.mockReturnValue(channel as FeishuChannel);
    mocks.store.mockReturnValue({ load: async () => state, save: vi.fn(async () => {}) } satisfies Store);
    const on = vi.fn();
    const cleanup = contribute({ on } as unknown as Parameters<typeof contribute>[0]);
    try {
      await flush();
      const first = session!.currentScope()!;
      const second = session!.currentScope()!;
      expect(first).not.toBe(second);
      expect(first).toEqual(second);
      expect(session!.isCurrentScope(first)).toBe(true);
      expect(session!.isCurrentScope(second)).toBe(true);
      expect(feishu.sendCard).toHaveBeenCalledOnce();
      const ended = on.mock.calls.find(([name]) => name === "agent.turn_ended")![1];
      const event = {
        agent: { id: "a", title: "Running" }, turnId: "t", outcome: { kind: "completed" },
        timeline: [{ type: "assistant_message", text: "final answer" }],
      };
      await ended(event); await flush();
      expect(feishu.updateCard).toHaveBeenCalledOnce();
      expect(JSON.stringify(feishu.updateCard.mock.calls)).toContain("final answer");
      expect(JSON.stringify(feishu.updateCard.mock.calls)).toContain("已完成");
      expect(feishu.sendText).toHaveBeenCalledExactlyOnceWith("c", "Running · 已完成");
      await ended(event); await flush();
      expect(feishu.updateCard).toHaveBeenCalledOnce();
      expect(feishu.sendText).toHaveBeenCalledOnce();
    } finally {
      cleanup(); await flush();
    }
  });

});
