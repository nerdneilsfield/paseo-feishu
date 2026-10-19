import type { BindingScope, CardBuilders, FeishuPort, LiveFinish, LiveReplies, PaseoPort, ReplyView, TimelineEvent, TimelineSubscription } from "./contracts.js";
import { excerpt } from "./history.js";

interface Turn {
  id: string | null;
  sealed: boolean;
  messageId: string | null;
  write: Promise<void>;
  writing: boolean;
  pending: { scope: BindingScope; version: number; view: ReplyView } | null;
  view: ReplyView;
  creationFailed: boolean;
}

/** Only the current binding is observed. Events invalidate snapshots, never append text. */
export function createLiveReplies(deps: {
  paseo: PaseoPort;
  feishu: FeishuPort;
  cards: CardBuilders;
  isCurrent(scope: BindingScope): boolean;
  invalidateHistory(): void;
  now?: () => number;
}): LiveReplies {
  const { paseo, feishu, cards } = deps;
  const now = deps.now ?? Date.now;
  let scope: BindingScope | null = null;
  let subscription: TimelineSubscription | null = null;
  let version = 0;
  let observation = 0;
  let contentVersion = 0;
  let established = false;
  let ready = false;
  let failed = false;
  let dirty = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRead = -Infinity;
  let lastWrite = -Infinity;
  let turn: Turn | null = null;
  let epoch: string | null = null;
  let waiters: Array<(ok: boolean) => void> = [];

  const valid = (v: number): boolean => version === v;
  function settle(ok: boolean): void {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve(ok);
  }
  function cancelTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function newTurn(id: string | null, title = "当前会话"): Turn {
    return { id, sealed: false, messageId: null, write: Promise.resolve(), writing: false, pending: null, creationFailed: false,
      view: { title, phase: "处理中", updatedAt: now(), text: "", incomplete: id === null } };
  }
  function paint(t: Turn, s: BindingScope, v: number): void {
    if (t.creationFailed || t.sealed) return;
    t.pending = { scope: s, version: v, view: { ...t.view } };
    drainWrite(t);
  }
  function drainWrite(t: Turn): void {
    if (t.writing || !t.pending) return;
    const pending = t.pending;
    const { scope: s, version: v, view } = pending;
    if (!valid(v) || t.sealed || t.creationFailed) { t.pending = null; return; }
    if (now() < lastWrite + 1000) { schedule(); return; }
    t.pending = null;
    t.writing = true;
    t.write = (async () => {
      lastWrite = now();
      const card = cards.reply(view);
      if (t.messageId) await feishu.updateCard(t.messageId, card);
      else t.messageId = await feishu.sendCard(s.chatId, card);
    })().catch(() => { if (!t.messageId) t.creationFailed = true; }).finally(() => {
      t.writing = false;
      // Only one replaceable pending frame survives a slow network operation.
      drainWrite(t);
    });
  }
  function fault(s: BindingScope, v: number, phase: string): void {
    if (!valid(v)) return;
    ready = false;
    failed = true;
    dirty = false;
    cancelTimer();
    settle(false);
    if (turn && !turn.sealed) {
      turn.view = { ...turn.view, phase, incomplete: true, updatedAt: now() };
      paint(turn, s, v);
    }
  }
  function schedule(): void {
    cancelTimer();
    if (!scope) return;
    const canRead = established && dirty && !running && !failed;
    const canWrite = turn?.pending && !turn.writing;
    if (!canRead && !canWrite) return;
    const due = Math.min(canRead ? lastRead + 1000 : Infinity, canWrite ? lastWrite + 1000 : Infinity);
    const dispatch = (): void => {
      timer = null;
      if (turn?.pending && !turn.writing && now() >= lastWrite + 1000) drainWrite(turn);
      if (established && dirty && !failed && !running && now() >= lastRead + 1000) void refresh();
      // Due work synchronously clears pending or marks itself in flight; rearm
      // only what remains, including a read deadline later than this write.
      schedule();
    };
    if (due <= now()) dispatch();
    else timer = setTimeout(dispatch, due - now());
  }
  async function refresh(): Promise<void> {
    const s = scope;
    let v = version;
    if (!s || !valid(v) || !established || failed || running) return;
    running = true;
    dirty = false;
    lastRead = now();
    try {
      // One bounded projected tail. Older records outside this window are explicitly incomplete.
      const page = await paseo.readTimeline(s.agentId, { direction: "tail", projection: "projected", limit: 50 });
      if (!valid(v)) return;
      if (page.error) throw new Error("snapshot unavailable");
      if (epoch !== null && epoch !== page.epoch) {
        deps.invalidateHistory();
        turn = null;
        epoch = page.epoch;
        ++contentVersion;
        ++version;
        ready = false;
        dirty = true;
        return;
      }
      epoch = page.epoch;
      const activeId = page.agent?.activeTurn?.turnId;
      const id = activeId ?? turn?.id ?? null;
      if (id && (!turn || turn.id !== id)) {
        v = ++version;
        turn = newTurn(id);
      }
      if (!turn && page.agent?.status === "running") turn = newTurn(null);
      if (turn && !turn.sealed) {
        const entries = [...page.entries].sort((a, b) => a.seqStart - b.seqStart);
        const publicEntries = entries.filter(e => e.item.type === "assistant_message");
        const text = turn.id ? publicEntries.filter(e => e.turnId === turn!.id).map(e => e.item.type === "assistant_message" ? e.item.text : "").join("") : "";
        const first = entries[0];
        const incomplete = !turn.id || publicEntries.some(e => !e.turnId) || page.gap || page.reset || page.staleCursor || page.hasNewer || (page.hasOlder && (!first || first.turnId === turn.id));
        const pending = page.agent?.pendingPermissions;
        const phase = pending?.length
          ? pending.some(p => p.kind === "question") ? "等待回答（请回 Paseo）" : "等待授权"
          : turn.view.phase === "工具活动" ? "工具活动" : "处理中";
        turn.view = { ...turn.view, phase, title: page.agent?.title ?? turn.view.title, text: excerpt(text, 12000), incomplete };
        paint(turn, s, v);
      }
      // A valid reconciliation releases submissions even if newer events need another frame.
      ready = true;
      settle(true);
    } catch {
      fault(s, v, paseo.isReady() ? "观察中断，状态待核对（不会自动重发）" : "Paseo 未连接，状态待核对");
    } finally {
      running = false;
      schedule();
    }
  }
  function event(s: BindingScope, value: TimelineEvent): void {
    const e = value.event;
    if (e.type === "error") {
      ++version; // invalidate any outstanding snapshot and queued progress
      fault(s, version, "观察中断，状态待核对（不会自动重发）");
      return;
    }
    if (e.type === "replacement" || e.type === "subscription_restored") {
      ++version;
      ready = false;
      failed = false;
      if (e.type === "replacement") {
        ++contentVersion;
        turn = null;
        epoch = null;
        deps.invalidateHistory();
      }
    } else {
      if (failed) return;
      if (e.type === "turn_started") {
        if (turn?.sealed && e.turnId === turn.id) return;
        // Without an ID, only a snapshot can establish a new turn after a seal.
        if (!(turn?.sealed && !e.turnId) && (!turn || turn.sealed || turn.id !== (e.turnId ?? null))) {
          ++version;
          turn = newTurn(e.turnId ?? null);
        }
      }
      if (turn && !turn.sealed && e.type === "permission_resolved") turn.view.phase = "处理中";
      if (turn && !turn.sealed && e.type === "timeline" && e.item.type === "tool_call") turn.view.phase = "工具活动";
    }
    if (turn && !turn.sealed) turn.view.updatedAt = now();
    dirty = true;
    schedule();
  }
  function startObservation(s: BindingScope): void {
    ++version;
    const attempt = ++observation;
    cancelTimer();
    subscription?.();
    subscription = null;
    settle(false);
    established = ready = failed = dirty = false;
    try {
      subscription = paseo.subscribeTimeline(s.agentId, value => {
        if (attempt === observation) event(s, value);
      });
      void subscription.ready.then(() => {
        if (attempt !== observation || failed) return;
        established = true;
        dirty = true;
        schedule();
      }, () => {
        if (attempt === observation) fault(s, version, "观察中断，状态待核对（不会自动重发）");
      });
    } catch { fault(s, version, "观察中断，状态待核对（不会自动重发）"); }
  }
  function bind(next: BindingScope | null): void {
    ++version;
    ++observation;
    ++contentVersion;
    cancelTimer();
    subscription?.();
    subscription = null;
    settle(false);
    scope = next;
    turn = null;
    epoch = null;
    established = ready = failed = dirty = false;
    lastRead = lastWrite = -Infinity;
    if (next && paseo.isReady()) startObservation(next);
  }
  return {
    bind,
    async ensureReady(s, retryFailed = true) {
      if (!deps.isCurrent(s) || !paseo.isReady()) return false;
      if (!scope || scope.generation !== s.generation || scope.agentId !== s.agentId || scope.chatId !== s.chatId) bind(s);
      // Starting a previously offline observation preserves this binding's sealed turns/finals.
      // Do not retry a failure caused by this same call, or by startup completion.
      else if ((!subscription && !failed) || (failed && retryFailed)) startObservation(scope);
      if (failed) return false;
      if (ready) return true;
      if (established) { dirty = true; schedule(); }
      return new Promise<boolean>(resolve => waiters.push(resolve));
    },
    seal(s, turnId): LiveFinish | null {
      if (!scope || scope.generation !== s.generation || scope.agentId !== s.agentId || scope.chatId !== s.chatId || !turnId || !turn || turn.id !== turnId || turn.sealed) return null;
      const boundScope = scope;
      const finalVersion = contentVersion;
      const currentScope = (): boolean => contentVersion === finalVersion && scope === boundScope;
      const t = turn;
      ++version;
      cancelTimer();
      dirty = false;
      ready = false;
      settle(false);
      t.sealed = true;
      t.pending = null;
      return {
        async finish(view, reminder) {
          await t.write;
          if (!currentScope()) return;
          let finalized = false;
          try {
            const card = cards.reply(view);
            if (t.creationFailed) throw new Error("progress card failed");
            if (t.messageId) await feishu.updateCard(t.messageId, card);
            else t.messageId = await feishu.sendCard(s.chatId, card);
            finalized = true;
          } catch { /* Only a failed card operation falls back to the final body. */ }
          if (!currentScope()) return;
          try {
            await feishu.sendText(s.chatId, finalized ? reminder : `${reminder}${view.text ? `\n${view.text}` : ""}`);
          } catch { /* At most one attempt, including the short reminder. */ }
        },
      };
    },
    waiting(s, question) {
      if (!scope || !deps.isCurrent(s) || !turn || turn.sealed) return;
      turn.view.phase = question ? "等待回答（请回 Paseo）" : "等待授权";
      turn.view.updatedAt = now();
      dirty = true;
      schedule();
    },
    close() { bind(null); },
  };
}
