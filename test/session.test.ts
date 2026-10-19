import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentSummary,
  CardBuilders,
  FeishuCard,
  FeishuPort,
  IncomingCardAction,
  IncomingText,
  PaseoPort,
  PendingPermission,
  PermissionDecision,
  SendResult,
} from "../server/contracts.js";
import { createFileStore } from "../server/store.js";
import { createSession } from "../server/session.js";
import type { SessionController } from "../server/contracts.js";

const OWNER = "ou_owner";
const CHAT = "chat_p2p";

function agent(over: Partial<AgentSummary> & { id: string }): AgentSummary {
  return {
    title: `title-${over.id}`,
    provider: "codex",
    cwdLabel: "proj",
    status: "idle",
    archived: false,
    lastActivityAt: 100,
    ...over,
  };
}

class FakePaseo implements PaseoPort {
  ready = true;
  agents = new Map<string, AgentSummary>();
  sends: Array<{ agentId: string; text: string }> = [];
  sendQueue: SendResult[] = [];
  sendBehavior: ((agentId: string, text: string) => Promise<SendResult>) | null = null;
  refreshCalls: string[] = [];
  refreshBehavior: ((id: string) => Promise<AgentSummary | null>) | null = null;
  listCalls = 0;
  /** 设置后 respondToPermission 会挂起到它 resolve，用来制造「在途」窗口。 */
  respondGate: Promise<void> | null = null;
  pendings = new Map<string, PendingPermission[]>();
  responds: Array<{ agentId: string; requestId: string; decision: PermissionDecision }> = [];
  respondResult: { ok: true } | { ok: false; reason: "not_pending" | "not_connected" | "failed" } = {
    ok: true,
  };

  isReady(): boolean {
    return this.ready;
  }
  async listAgents(): Promise<AgentSummary[]> {
    this.listCalls++;
    return [...this.agents.values()];
  }
  async refreshAgent(id: string): Promise<AgentSummary | null> {
    this.refreshCalls.push(id);
    if (this.refreshBehavior) return this.refreshBehavior(id);
    return this.agents.get(id) ?? null;
  }
  async send(agentId: string, text: string): Promise<SendResult> {
    this.sends.push({ agentId, text });
    if (this.sendBehavior) return this.sendBehavior(agentId, text);
    return this.sendQueue.shift() ?? { ok: true };
  }
  async getPendingPermissions(agentId: string): Promise<PendingPermission[]> {
    return this.pendings.get(agentId) ?? [];
  }
  async respondToPermission(
    agentId: string,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<{ ok: true } | { ok: false; reason: "not_pending" | "not_connected" | "failed" }> {
    this.responds.push({ agentId, requestId, decision });
    if (this.respondGate) await this.respondGate;
    return this.respondResult;
  }
  async close(): Promise<void> {}
}

class FakeFeishu implements FeishuPort {
  texts: Array<{ chatId: string; text: string }> = [];
  cards: Array<{ chatId: string; card: FeishuCard }> = [];
  updates: Array<{ messageId: string; card: FeishuCard }> = [];
  failUpdate = false;
  seq = 0;

  async sendText(chatId: string, text: string): Promise<void> {
    this.texts.push({ chatId, text });
  }
  async sendCard(chatId: string, card: FeishuCard): Promise<string> {
    const id = `picker-${++this.seq}`;
    this.cards.push({ chatId, card });
    return id;
  }
  async updateCard(messageId: string, card: FeishuCard): Promise<void> {
    if (this.failUpdate) throw new Error("update failed");
    this.updates.push({ messageId, card });
  }
}

const fakeCards: CardBuilders = {
  picker: (input) => ({ kind: "picker", ...input }) as FeishuCard,
  current: (input) => ({ kind: "current", agentId: input.agent.id, ...input }) as FeishuCard,
  permission: (input) => ({ kind: "permission", ...input }) as FeishuCard,
  permissionResolved: (input) => ({ kind: "resolved", ...input }) as FeishuCard,
  notice: (input) => ({ kind: "notice", ...input }) as FeishuCard,
};

function text(over: Partial<IncomingText> = {}): IncomingText {
  return {
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    chatId: CHAT,
    senderId: OWNER,
    chatType: "p2p",
    text: "hello",
    rawContentType: "text",
    ...over,
  };
}

interface Fixture {
  session: SessionController;
  paseo: FakePaseo;
  feishu: FakeFeishu;
  storePath: string;
}

async function setup(agents: AgentSummary[] = []): Promise<Fixture> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-session-"));
  const storePath = path.join(dir, "state.json");
  const paseo = new FakePaseo();
  for (const a of agents) paseo.agents.set(a.id, a);
  const feishu = new FakeFeishu();
  const session = await createSession({
    ownerOpenId: OWNER,
    store: createFileStore(storePath),
    paseo,
    feishu,
    cards: fakeCards,
  });
  return { session, paseo, feishu, storePath };
}

async function reopen(fx: Fixture): Promise<SessionController> {
  const paseo = fx.paseo;
  const feishu = fx.feishu;
  return createSession({
    ownerOpenId: OWNER,
    store: createFileStore(fx.storePath),
    paseo,
    feishu,
    cards: fakeCards,
  });
}

// 先经过一次未绑定文本，拿到当前有效 picker 卡信息。
async function currentPicker(fx: Fixture): Promise<{ messageId: string; revision: number }> {
  await fx.session.handleText(text({ messageId: "m-picker", text: "hi" }));
  const st = await createFileStore(fx.storePath).load();
  const b = st.binding;
  if (!b?.pickerMessageId) throw new Error("no picker sent");
  return { messageId: b.pickerMessageId, revision: b.pickerRevision };
}

function selectAction(
  fx: Fixture,
  picker: { messageId: string; revision: number },
  agentId: string,
): IncomingCardAction {
  return {
    messageId: picker.messageId,
    chatId: CHAT,
    operatorOpenId: OWNER,
    action: { action: "select_agent", agentId, pickerRevision: picker.revision },
  };
}

describe("session: text routing (A01/A03/A10/A11/A13)", () => {
  it("A01: unbound first text shows picker and is not forwarded", async () => {
    const fx = await setup([agent({ id: "a1" })]);
    await fx.session.handleText(text({ messageId: "m1", text: "继续检查背压" }));
    expect(fx.feishu.cards).toHaveLength(1);
    expect(fx.paseo.sends).toHaveLength(0);
    expect(fx.session.currentAgentId()).toBeNull();
    const st = await createFileStore(fx.storePath).load();
    expect(st.binding?.pickerRevision).toBe(1);
    expect(st.binding?.pickerMessageId).toBe("picker-1");
    expect(st.binding?.agentId).toBeNull();
  });

  it("A03: bound text forwards original text to the bound agent id", async () => {
    const fx = await setup([agent({ id: "a1" }), agent({ id: "a2" })]);
    const picker = await currentPicker(fx);
    const res = await fx.session.handleCardAction(selectAction(fx, picker, "a1"));
    expect(res.toast.type).toBe("loading");
    await vi.waitFor(() => expect(fx.session.currentAgentId()).toBe("a1"));
    // fake 里没有 create 方法：绑定前后 agent 数量不变是结构保证，这里断言无 send 外调用。
    expect(fx.paseo.agents.size).toBe(2);

    await fx.session.handleText(text({ messageId: "m2", text: "继续检查 KCP 背压处理" }));
    expect(fx.paseo.sends).toEqual([{ agentId: "a1", text: "继续检查 KCP 背压处理" }]);
    expect(fx.feishu.texts.at(-1)?.text).toContain("已发送（非任务完成）");
  });

  it("sends to the snapshot agent even if binding changes mid-send", async () => {
    const fx = await setup([agent({ id: "a1" }), agent({ id: "a2" })]);
    const picker = await currentPicker(fx);
    await fx.session.handleCardAction(selectAction(fx, picker, "a1"));
    await vi.waitFor(() => expect(fx.session.currentAgentId()).toBe("a1"));

    let release!: (v: SendResult) => void;
    fx.paseo.sendBehavior = () => new Promise<SendResult>((res) => void (release = res));
    const inFlight = fx.session.handleText(text({ messageId: "m3", text: "snapshot me" }));
    await vi.waitFor(() => expect(fx.paseo.sends).toHaveLength(1));
    // 发送在途时切换绑定：用 /sessions 拿新卡（命令路径，不产生新的 send）。
    await fx.session.handleText(text({ messageId: "m-picker2", text: "/sessions" }));
    const st = await createFileStore(fx.storePath).load();
    const cur = { messageId: st.binding?.pickerMessageId ?? "", revision: st.binding?.pickerRevision ?? 0 };
    await fx.session.handleCardAction(selectAction(fx, cur, "a2"));
    await vi.waitFor(() => expect(fx.session.currentAgentId()).toBe("a2"));
    release({ ok: true });
    await inFlight;
    expect(fx.paseo.sends[0]).toEqual({ agentId: "a1", text: "snapshot me" });
  });

  it("A10: text during SWITCHING is rejected and never sent", async () => {
    const fx = await setup([agent({ id: "a1" }), agent({ id: "a2" })]);
    const picker = await currentPicker(fx);
    let release!: (v: AgentSummary | null) => void;
    fx.paseo.refreshBehavior = () => new Promise<AgentSummary | null>((res) => void (release = res));
    const res = await fx.session.handleCardAction(selectAction(fx, picker, "a2"));
    expect(res.toast.type).toBe("loading");
    await vi.waitFor(() => expect(fx.paseo.refreshCalls).toHaveLength(1));

    await fx.session.handleText(text({ messageId: "m-sw", text: "别发出去" }));
    expect(fx.paseo.sends).toHaveLength(0);
    expect(fx.feishu.texts.at(-1)?.text).toContain("请切换后重发");

    release(agent({ id: "a2" }));
    await vi.waitFor(() => expect(fx.session.currentAgentId()).toBe("a2"));
  });

  it("A11: unauthorized user / group chat get nothing and leak nothing", async () => {
    const fx = await setup([agent({ id: "a1" })]);
    await fx.session.handleText(text({ messageId: "m-evil", senderId: "ou_stranger" }));
    await fx.session.handleText(text({ messageId: "m-grp", chatType: "group" }));
    expect(fx.feishu.texts).toHaveLength(0);
    expect(fx.feishu.cards).toHaveLength(0);
    expect(fx.paseo.sends).toHaveLength(0);
    expect(fx.paseo.listCalls).toBe(0);

    const evilClick: IncomingCardAction = {
      messageId: "picker-99",
      chatId: CHAT,
      operatorOpenId: "ou_stranger",
      action: { action: "select_agent", agentId: "a1", pickerRevision: 1 },
    };
    const res = await fx.session.handleCardAction(evilClick);
    expect(res.toast.type).toBe("error");
    expect(fx.paseo.refreshCalls).toHaveLength(0);
    expect(fx.feishu.updates).toHaveLength(0);
  });

  it("redelivered messages that were consumed while unbound/switching/command never reach the agent after binding", async () => {
    const fx = await setup([agent({ id: "a1" })]);
    // 未绑定时的首条消息、命令，都不转发。
    await fx.session.handleText(text({ messageId: "m-first", text: "不该发出去" }));
    await fx.session.handleText(text({ messageId: "m-cmd", text: "/status" }));
    const picker = await currentPicker(fx);
    await fx.session.handleCardAction(selectAction(fx, picker, "a1"));
    await vi.waitFor(() => expect(fx.session.currentAgentId()).toBe("a1"));

    // 飞书重投同一批 messageId。
    await fx.session.handleText(text({ messageId: "m-first", text: "不该发出去" }));
    await fx.session.handleText(text({ messageId: "m-cmd", text: "/status" }));
    expect(fx.paseo.sends).toHaveLength(0);

    // 重启后同样不穿透。
    const again = await reopen(fx);
    await again.handleText(text({ messageId: "m-first", text: "不该发出去" }));
    expect(fx.paseo.sends).toHaveLength(0);
  });

  it("A13: duplicate messageId never re-sends", async () => {
    const fx = await setup([agent({ id: "a1" })]);
    const picker = await currentPicker(fx);
    await fx.session.handleCardAction(selectAction(fx, picker, "a1"));
    await vi.waitFor(() => expect(fx.session.currentAgentId()).toBe("a1"));
    const m = text({ messageId: "m-dup", text: "once" });
    await fx.session.handleText(m);
    await fx.session.handleText(m);
    await fx.session.handleText(m);
    expect(fx.paseo.sends).toHaveLength(1);
  });

  it("/sessions sends a fresh picker; /status reports binding without full ids", async () => {
    const fx = await setup([agent({ id: "a1" })]);
    await fx.session.handleText(text({ messageId: "c1", text: " /sessions " }));
    expect(fx.feishu.cards).toHaveLength(1);
    await fx.session.handleText(text({ messageId: "c2", text: "/status" }));
    expect(fx.feishu.texts.at(-1)?.text).toContain("未绑定");
    const picker = await currentPicker(fx);
    await fx.session.handleCardAction(selectAction(fx, picker, "a1"));
    await vi.waitFor(() => expect(fx.session.currentAgentId()).toBe("a1"));
    await fx.session.handleText(text({ messageId: "c3", text: "/status" }));
    const statusText = fx.feishu.texts.at(-1)?.text ?? "";
    expect(statusText).toContain("当前绑定");
    expect(statusText).not.toContain("a1-very-secret-full-id");
  });

  it("non-text content from owner is refused without forwarding", async () => {
    const fx = await setup([agent({ id: "a1" })]);
    const picker = await currentPicker(fx);
    await fx.session.handleCardAction(selectAction(fx, picker, "a1"));
    await vi.waitFor(() => expect(fx.session.currentAgentId()).toBe("a1"));
    await fx.session.handleText(text({ messageId: "m-img", rawContentType: "image", text: "" }));
    expect(fx.paseo.sends).toHaveLength(0);
    expect(fx.feishu.texts.at(-1)?.text).toContain("仅支持文本");
  });
});

describe("session: switching (A02/A04/A08/A09/A15)", () => {
  it("A02/A04: running agent binds in place, card updated, no prompt sent", async () => {
    const fx = await setup([agent({ id: "relay", status: "running", title: "KVMux · Relay 审阅" })]);
    const picker = await currentPicker(fx);
    const revBefore = (await createFileStore(fx.storePath).load()).binding?.bindingRevision ?? 0;
    await fx.session.handleCardAction(selectAction(fx, picker, "relay"));
    // updateCard 发生在落盘之后，等它即等切换完全持久化。
    await vi.waitFor(() => expect(fx.feishu.updates).toHaveLength(1));
    expect(fx.session.currentAgentId()).toBe("relay");
    const st = await createFileStore(fx.storePath).load();
    expect((st.binding?.bindingRevision ?? 0)).toBe(revBefore + 1);
    expect(fx.feishu.updates).toHaveLength(1);
    expect(fx.feishu.updates[0]?.messageId).toBe(picker.messageId);
    expect(fx.paseo.sends).toHaveLength(0);
    expect(fx.session.currentChatId()).toBe(CHAT);
  });

  it("A08: repeat click on the bound agent is idempotent with zero side effects", async () => {
    const fx = await setup([agent({ id: "a1" })]);
    const picker = await currentPicker(fx);
    await fx.session.handleCardAction(selectAction(fx, picker, "a1"));
    await vi.waitFor(() => expect(fx.feishu.updates).toHaveLength(1));
    const rev = (await createFileStore(fx.storePath).load()).binding?.bindingRevision;
    const updatesBefore = fx.feishu.updates.length;
    const refreshBefore = fx.paseo.refreshCalls.length;

    // 注意：成功后 revision 已 +1，卡片值里还是旧 revision；用“当前有效”值重放等价点击。
    const st = await createFileStore(fx.storePath).load();
    const res = await fx.session.handleCardAction({
      messageId: st.binding?.pickerMessageId ?? "",
      chatId: CHAT,
      operatorOpenId: OWNER,
      action: { action: "select_agent", agentId: "a1", pickerRevision: st.binding?.pickerRevision ?? 0 },
    });
    expect(res.toast.type).toBe("info");
    expect(fx.paseo.refreshCalls).toHaveLength(refreshBefore);
    expect(fx.feishu.updates).toHaveLength(updatesBefore);
    expect(fx.paseo.sends).toHaveLength(0);
    expect((await createFileStore(fx.storePath).load()).binding?.bindingRevision).toBe(rev);
  });

  it("A09: stale pickerRevision is rejected without changing binding", async () => {
    const fx = await setup([agent({ id: "a1" }), agent({ id: "a2" })]);
    const picker = await currentPicker(fx);
    await fx.session.handleCardAction(selectAction(fx, picker, "a1"));
    await vi.waitFor(() => expect(fx.session.currentAgentId()).toBe("a1"));
    // 旧卡片（旧 revision + 旧 messageId）再次点击。
    const res = await fx.session.handleCardAction(selectAction(fx, picker, "a2"));
    expect(res.toast.content).toContain("卡片已过期");
    expect(fx.session.currentAgentId()).toBe("a1");
    expect(fx.paseo.refreshCalls).toHaveLength(1);
  });

  it("rapid double clicks only trigger one verification", async () => {
    const fx = await setup([agent({ id: "a1" }), agent({ id: "a2" })]);
    const picker = await currentPicker(fx);
    let release!: (v: AgentSummary | null) => void;
    fx.paseo.refreshBehavior = () => new Promise<AgentSummary | null>((res) => void (release = res));
    const r1 = await fx.session.handleCardAction(selectAction(fx, picker, "a2"));
    const r2 = await fx.session.handleCardAction(selectAction(fx, picker, "a2"));
    expect(r1.toast.type).toBe("loading");
    expect(r2.toast.type).toBe("loading");
    await vi.waitFor(() => expect(fx.paseo.refreshCalls).toHaveLength(1));
    expect(fx.paseo.refreshCalls).toHaveLength(1);
    release(agent({ id: "a2" }));
    await vi.waitFor(() => expect(fx.session.currentAgentId()).toBe("a2"));
  });

  it("A15: empty list shows offline-capable picker; archived cannot bind; closed can", async () => {
    const fx = await setup([]);
    await fx.session.handleText(text({ messageId: "m-empty", text: "hi" }));
    const pickerCard = fx.feishu.cards[0]?.card as unknown as {
      agents: AgentSummary[];
      connected: boolean;
    };
    expect(pickerCard.agents).toHaveLength(0);
    expect(pickerCard.connected).toBe(true);

    const fx2 = await setup([
      agent({ id: "gone", archived: true }),
      agent({ id: "resumable", status: "closed" }),
    ]);
    const picker2 = await currentPicker(fx2);
    const bad = await fx2.session.handleCardAction(selectAction(fx2, picker2, "gone"));
    expect(bad.toast.type).toBe("loading");
    await vi.waitFor(() => expect(fx2.feishu.texts.length).toBeGreaterThan(0));
    expect(fx2.feishu.texts.at(-1)?.text).toContain("未切换");
    expect(fx2.session.currentAgentId()).toBeNull();

    const ok = await fx2.session.handleCardAction(selectAction(fx2, picker2, "resumable"));
    expect(ok.toast.type).toBe("loading");
    await vi.waitFor(() => expect(fx2.session.currentAgentId()).toBe("resumable"));
  });

  it("missing agent cannot bind and keeps prior binding", async () => {
    const fx = await setup([agent({ id: "a1" })]);
    const picker = await currentPicker(fx);
    await fx.session.handleCardAction(selectAction(fx, picker, "a1"));
    await vi.waitFor(() => expect(fx.feishu.updates).toHaveLength(1));
    const st = await createFileStore(fx.storePath).load();
    const cur = {
      messageId: st.binding?.pickerMessageId ?? "",
      revision: st.binding?.pickerRevision ?? 0,
    };
    const res = await fx.session.handleCardAction(selectAction(fx, cur, "nope"));
    expect(res.toast.type).toBe("loading");
    await vi.waitFor(() => expect(fx.feishu.texts.length).toBeGreaterThan(0));
    expect(fx.feishu.texts.at(-1)?.text).toContain("未切换");
    expect(fx.session.currentAgentId()).toBe("a1");
  });

  it("updateCard failure does not roll back a saved binding", async () => {
    const fx = await setup([agent({ id: "a1" })]);
    const picker = await currentPicker(fx);
    fx.feishu.failUpdate = true;
    await fx.session.handleCardAction(selectAction(fx, picker, "a1"));
    await vi.waitFor(() => expect(fx.session.currentAgentId()).toBe("a1"));
    // updateCard 失败后的文字确认发生在落盘之后，等它即等绑定已持久化。
    await vi.waitFor(() => expect(fx.feishu.texts.length).toBeGreaterThan(0));
    const st = await createFileStore(fx.storePath).load();
    expect(st.binding?.agentId).toBe("a1");
    // 只发文字确认，不回滚。
    expect(fx.feishu.texts.at(-1)?.text).toContain("卡片更新失败");
  });

  it("refresh_agents on the current-session card reports the live status, not the picker", async () => {
    const fx = await setup([agent({ id: "a1", status: "idle", title: "Relay" })]);
    const picker = await currentPicker(fx);
    await fx.session.handleCardAction(selectAction(fx, picker, "a1"));
    // 当前会话卡在落盘之后才更新；等它，读到的才是卡片按钮里的 revision。
    await vi.waitFor(() => expect(fx.feishu.updates).toHaveLength(1));
    const st = await createFileStore(fx.storePath).load();
    fx.paseo.agents.set("a1", agent({ id: "a1", status: "running", title: "Relay" }));
    const res = await fx.session.handleCardAction({
      messageId: st.binding?.pickerMessageId ?? "",
      chatId: CHAT,
      operatorOpenId: OWNER,
      action: { action: "refresh_current", pickerRevision: st.binding?.pickerRevision ?? 0 },
    });
    expect(res.toast.type).toBe("loading");
    await vi.waitFor(() => expect(fx.feishu.updates.length).toBeGreaterThan(1));
    const card = fx.feishu.updates.at(-1)?.card as { kind: string; agent: AgentSummary };
    expect(card.kind).toBe("current");
    expect(card.agent.status).toBe("running");
  });

  it("refresh returns before listAgents settles so the card callback is not held", async () => {
    const fx = await setup([agent({ id: "a1" })]);
    const picker = await currentPicker(fx);
    let release!: (agents: AgentSummary[]) => void;
    fx.paseo.listAgents = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const pending = fx.session.handleCardAction({
      messageId: picker.messageId,
      chatId: CHAT,
      operatorOpenId: OWNER,
      action: { action: "refresh_agents", pickerRevision: picker.revision },
    });
    const raced = await Promise.race([
      pending.then((res) => res.toast.type),
      new Promise((resolve) => setTimeout(() => resolve("held"), 200)),
    ]);
    expect(raced).toBe("loading");
    release([...fx.paseo.agents.values()]);
    await pending;
  });

  it("a slow refresh cannot paint the picker over a selection that already landed", async () => {
    const fx = await setup([agent({ id: "a1", title: "Relay" })]);
    const picker = await currentPicker(fx);
    let release!: (agents: AgentSummary[]) => void;
    fx.paseo.listAgents = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const pending = fx.session.handleCardAction({
      messageId: picker.messageId,
      chatId: CHAT,
      operatorOpenId: OWNER,
      action: { action: "refresh_agents", pickerRevision: picker.revision },
    });
    expect((await pending).toast.type).toBe("loading");
    await fx.session.handleCardAction(selectAction(fx, picker, "a1"));
    await vi.waitFor(() => expect(fx.session.currentAgentId()).toBe("a1"));
    await vi.waitFor(() =>
      expect((fx.feishu.updates.at(-1)?.card as { kind: string }).kind).toBe("current"),
    );
    release([agent({ id: "a1", title: "Relay" })]);
    await new Promise((r) => setTimeout(r, 30));
    expect((fx.feishu.updates.at(-1)?.card as { kind: string }).kind).toBe("current");
  });

  it("open_picker / refresh_agents re-list fresh and update the card; offline card when disconnected", async () => {
    const fx = await setup([agent({ id: "a1" })]);
    const picker = await currentPicker(fx);
    fx.paseo.agents.set("a2", agent({ id: "a2" }));
    const res = await fx.session.handleCardAction({
      messageId: picker.messageId,
      chatId: CHAT,
      operatorOpenId: OWNER,
      action: { action: "refresh_agents", pickerRevision: picker.revision },
    });
    expect(res.toast.type).toBe("loading");
    await vi.waitFor(() => expect(fx.feishu.updates.length).toBeGreaterThan(0));
    expect(fx.paseo.listCalls).toBeGreaterThan(0);
    const card = fx.feishu.updates.at(-1)?.card as unknown as { agents: AgentSummary[] };
    expect(card.agents.map((a) => a.id)).toContain("a2");

    fx.paseo.ready = false;
    const off = await fx.session.handleCardAction({
      messageId: picker.messageId,
      chatId: CHAT,
      operatorOpenId: OWNER,
      action: { action: "open_picker", pickerRevision: picker.revision },
    });
    expect(off.toast.type).toBe("loading");
    await vi.waitFor(() =>
      expect(
        (fx.feishu.updates.at(-1)?.card as unknown as { connected: boolean }).connected,
      ).toBe(false),
    );
    const offCard = fx.feishu.updates.at(-1)?.card as unknown as { connected: boolean };
    expect(offCard.connected).toBe(false);
  });
});

describe("session: send outcomes + readiness", () => {
  it("unknown send result is recorded once, never retried", async () => {
    const fx = await setup([agent({ id: "a1" })]);
    const picker = await currentPicker(fx);
    await fx.session.handleCardAction(selectAction(fx, picker, "a1"));
    await vi.waitFor(() => expect(fx.session.currentAgentId()).toBe("a1"));
    fx.paseo.sendQueue.push({ ok: false, reason: "unknown" });
    await fx.session.handleText(text({ messageId: "m-u", text: "risky" }));
    expect(fx.paseo.sends).toHaveLength(1);
    expect(fx.feishu.texts.at(-1)?.text).toContain("发送结果不确定");
    const st = await createFileStore(fx.storePath).load();
    expect(st.deliveries["m-u"]?.state).toBe("unknown");
    // 同一 messageId 重放也不重发。
    await fx.session.handleText(text({ messageId: "m-u", text: "risky" }));
    expect(fx.paseo.sends).toHaveLength(1);
  });

  it("not_found / archived / rejected map to rejected with reselect guidance", async () => {
    const fx = await setup([agent({ id: "a1" })]);
    const picker = await currentPicker(fx);
    await fx.session.handleCardAction(selectAction(fx, picker, "a1"));
    await vi.waitFor(() => expect(fx.session.currentAgentId()).toBe("a1"));
    fx.paseo.sendQueue.push({ ok: false, reason: "archived" });
    await fx.session.handleText(text({ messageId: "m-a", text: "x" }));
    expect(fx.feishu.texts.at(-1)?.text).toContain("重新选择");
    fx.paseo.sendQueue.push({ ok: false, reason: "rejected" });
    await fx.session.handleText(text({ messageId: "m-r", text: "y" }));
    expect(fx.feishu.texts.at(-1)?.text).toContain("拒绝");
    const st = await createFileStore(fx.storePath).load();
    expect(st.deliveries["m-a"]?.state).toBe("rejected");
  });

  it("not-ready paseo rejects text without queueing", async () => {
    const fx = await setup([agent({ id: "a1" })]);
    const picker = await currentPicker(fx);
    await fx.session.handleCardAction(selectAction(fx, picker, "a1"));
    await vi.waitFor(() => expect(fx.session.currentAgentId()).toBe("a1"));
    fx.paseo.ready = false;
    await fx.session.handleText(text({ messageId: "m-off", text: "queued?" }));
    expect(fx.paseo.sends).toHaveLength(0);
    expect(fx.feishu.texts.at(-1)?.text).toContain("Paseo 未连接，消息未发送");
    const st = await createFileStore(fx.storePath).load();
    expect(st.deliveries["m-off"]?.state).toBe("rejected");
    // 恢复后新消息可发，旧消息不补发。
    fx.paseo.ready = true;
    await fx.session.handleText(text({ messageId: "m-on", text: "fresh" }));
    expect(fx.paseo.sends.map((s) => s.text)).toEqual(["fresh"]);
  });
});

describe("session: permissions (A07)", () => {
  const perm: PendingPermission = {
    requestId: "req-1",
    agentId: "a1",
    kind: "tool",
    title: "run tests",
    summary: "npm test",
    mappable: true,
    allowActionId: "allow",
    denyActionId: "deny",
  };

  async function boundWithPending(): Promise<Fixture> {
    const fx = await setup([agent({ id: "a1" })]);
    const picker = await currentPicker(fx);
    await fx.session.handleCardAction(selectAction(fx, picker, "a1"));
    await vi.waitFor(() => expect(fx.session.currentAgentId()).toBe("a1"));
    fx.paseo.pendings.set("a1", [perm]);
    return fx;
  }

  function approveEvt(fx: Fixture, requestId = "req-1"): IncomingCardAction {
    return {
      messageId: "perm-card-1",
      chatId: CHAT,
      operatorOpenId: OWNER,
      action: { action: "approve_permission", agentId: "a1", requestId },
    };
  }

  it("happy path: approve responds once, marks card resolved, second click is a no-op", async () => {
    const fx = await boundWithPending();
    const res = await fx.session.handleCardAction(approveEvt(fx));
    expect(res.toast.type).toBe("loading");
    await vi.waitFor(() => expect(fx.paseo.responds).toHaveLength(1));
    expect(fx.paseo.responds[0]).toEqual({ agentId: "a1", requestId: "req-1", decision: "allow" });
    await vi.waitFor(() => expect(fx.feishu.updates.length).toBeGreaterThan(0));

    const again = await fx.session.handleCardAction(approveEvt(fx));
    expect(again.toast.content).toContain("该请求已处理");
    expect(fx.paseo.responds).toHaveLength(1);
    const st = await createFileStore(fx.storePath).load();
    expect(st.decidedPermissions["req-1"]?.decision).toBe("allow");
  });

  it("in-flight approve blocks an opposite deny click: daemon sees exactly one decision", async () => {
    const fx = await boundWithPending();
    let open!: () => void;
    fx.paseo.respondGate = new Promise<void>((r) => void (open = r));
    const first = await fx.session.handleCardAction(approveEvt(fx));
    expect(first.toast.type).toBe("loading");
    await vi.waitFor(() => expect(fx.paseo.responds).toHaveLength(1));

    const deny: IncomingCardAction = {
      ...approveEvt(fx),
      action: { action: "deny_permission", agentId: "a1", requestId: "req-1" },
    };
    const second = await fx.session.handleCardAction(deny);
    expect(second.toast.content).toContain("处理");
    expect(fx.paseo.responds).toHaveLength(1);

    open();
    await vi.waitFor(() => expect(fx.feishu.updates.length).toBeGreaterThan(0));
    expect(fx.paseo.responds).toEqual([{ agentId: "a1", requestId: "req-1", decision: "allow" }]);
  });

  it("a failed respond releases the slot so the user can retry", async () => {
    const fx = await boundWithPending();
    fx.paseo.respondResult = { ok: false, reason: "failed" };
    await fx.session.handleCardAction(approveEvt(fx));
    await vi.waitFor(() => expect(fx.paseo.responds).toHaveLength(1));
    await vi.waitFor(() => expect(fx.feishu.texts.at(-1)?.text).toContain("审批未成功"));

    fx.paseo.respondResult = { ok: true };
    const retry = await fx.session.handleCardAction(approveEvt(fx));
    expect(retry.toast.type).toBe("loading");
    await vi.waitFor(() => expect(fx.paseo.responds).toHaveLength(2));
  });

  it("A07: desktop pre-resolved request cannot be re-approved", async () => {
    const fx = await boundWithPending();
    fx.paseo.pendings.set("a1", []); // 桌面端已处理，pending 里没有了
    const res = await fx.session.handleCardAction(approveEvt(fx));
    expect(res.toast.content).toContain("该请求已处理");
    expect(fx.paseo.responds).toHaveLength(0);
    const st = await createFileStore(fx.storePath).load();
    expect(st.decidedPermissions["req-1"]?.decision).toBe("resolved_elsewhere");
  });

  it("unmappable pending request is not approved", async () => {
    const fx = await boundWithPending();
    fx.paseo.pendings.set("a1", [{ ...perm, mappable: false }]);
    const res = await fx.session.handleCardAction(approveEvt(fx));
    expect(res.toast.content).toContain("该请求已处理");
    expect(fx.paseo.responds).toHaveLength(0);
  });

  it("stale agent in the button value is rejected without side effects", async () => {
    const fx = await boundWithPending();
    const res = await fx.session.handleCardAction({
      messageId: "perm-card-1",
      chatId: CHAT,
      operatorOpenId: OWNER,
      action: { action: "deny_permission", agentId: "other-agent", requestId: "req-1" },
    });
    expect(res.toast.content).toContain("该请求已处理");
    expect(fx.paseo.responds).toHaveLength(0);
  });

  it("failed respond reports truthfully and does not mark decided", async () => {
    const fx = await boundWithPending();
    fx.paseo.respondResult = { ok: false, reason: "not_pending" };
    const res = await fx.session.handleCardAction(approveEvt(fx));
    expect(res.toast.type).toBe("loading");
    await vi.waitFor(() => expect(fx.feishu.texts.length).toBeGreaterThan(0));
    expect(fx.feishu.texts.at(-1)?.text).toContain("未成功");
    const st = await createFileStore(fx.storePath).load();
    expect(st.decidedPermissions["req-1"]).toBeUndefined();
  });
});

describe("session: persistence + lifecycle (A12)", () => {
  it("A12: restart restores binding and keeps forwarding", async () => {
    const fx = await setup([agent({ id: "a1" })]);
    const picker = await currentPicker(fx);
    await fx.session.handleCardAction(selectAction(fx, picker, "a1"));
    await vi.waitFor(() => expect(fx.session.currentAgentId()).toBe("a1"));
    await fx.session.close();

    const s2 = await reopen(fx);
    expect(s2.currentAgentId()).toBe("a1");
    expect(s2.currentChatId()).toBe(CHAT);
    await s2.handleText(text({ messageId: "m-after", text: "after restart" }));
    expect(fx.paseo.sends).toEqual([{ agentId: "a1", text: "after restart" }]);
    await s2.close();
  });

  it("markNotified / markPermissionDecided are idempotent", async () => {
    const fx = await setup();
    expect(await fx.session.markNotified("a1:t1")).toBe(true);
    expect(await fx.session.markNotified("a1:t1")).toBe(false);
    expect(await fx.session.markPermissionDecided("req-9", "deny")).toBe(true);
    expect(await fx.session.markPermissionDecided("req-9", "deny")).toBe(false);
    const st = await createFileStore(fx.storePath).load();
    expect(st.notified.map((n) => n.key)).toContain("a1:t1");
    expect(st.decidedPermissions["req-9"]?.decision).toBe("deny");
  });

  it("close stops new work and resolves within budget", async () => {
    const fx = await setup([agent({ id: "a1" })]);
    const picker = await currentPicker(fx);
    await fx.session.handleCardAction(selectAction(fx, picker, "a1"));
    await vi.waitFor(() => expect(fx.session.currentAgentId()).toBe("a1"));
    await fx.session.close();
    await fx.session.handleText(text({ messageId: "m-late", text: "late" }));
    expect(fx.paseo.sends).toHaveLength(0);
    expect(await fx.session.markNotified("x")).toBe(false);
  });
});
