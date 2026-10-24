import type { BindingScope, CardBuilders, FeishuPort, LiveFinish, LiveReplies, PaseoPort, ReplyView, TimelineEvent, TimelinePage, TimelineSubscription } from "./contracts.js";
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
  // 用 token 而不是布尔值：一次永不返回的读不能把后续会话的刷新也堵死。
  let activeRead = 0;
  let readSeq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRead = -Infinity;
  let lastWrite = -Infinity;
  let turn: Turn | null = null;
  let epoch: string | null = null;
  let waiters: Array<(ok: boolean) => void> = [];
  const waiterTimers = new Set<ReturnType<typeof setTimeout>>();

  /**
   * 提交方等观测就绪的上限。订阅握手既不 resolve 也不 reject 时，
   * ensureReady 会永远挂着：不发消息、不回复、不报错。
   */
  const READY_TIMEOUT_MS = 10_000;

  /** 写卡/发文字的兜底上限：飞书 API 卡住时不能把收尾永远挂在那里。 */
  const WRITE_TIMEOUT_MS = 15_000;
  class WriteTimeout extends Error {}
  const TIMED_OUT = new WriteTimeout("card write timed out");
  /** 真的拒绝照原样抛出；只有真的卡住才变成 WriteTimeout。有结果就清掉自己的计时器。 */
  const bounded = <T>(p: Promise<T>, ms = WRITE_TIMEOUT_MS): Promise<T | WriteTimeout> =>
    new Promise<T | WriteTimeout>((resolve, reject) => {
      const timer = setTimeout(() => resolve(TIMED_OUT), ms);
      p.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error: unknown) => { clearTimeout(timer); reject(error); },
      );
    });

  class ReadTimeout extends Error {}
  /**
   * 读卡住时必须自己放弃：不释放读取槽的话，完成首次观测之后的一次挂起
   * 会让当前绑定再也拿不到新快照（ensureReady 已 ready，提交照常成功，但看不到进展）。
   */
  const readWithTimeout = async (p: Promise<TimelinePage>): Promise<TimelinePage> =>
    new Promise<TimelinePage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ReadTimeout("timeline read timed out")), READ_TIMEOUT_MS);
      p.then(
        (page) => { clearTimeout(timer); resolve(page); },
        (error: unknown) => { clearTimeout(timer); reject(error); },
      );
    });

  const valid = (v: number): boolean => version === v;
  function settle(ok: boolean): void {
    for (const timer of waiterTimers) clearTimeout(timer);
    waiterTimers.clear();
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
    // 写卡也必须封顶：飞书 API 卡住时 writing 不复位，回复卡从此停止更新。
    t.write = bounded((async () => {
      lastWrite = now();
      const card = cards.reply(view);
      // 排队期间本轮可能已封口：再更新会把“已完成”的卡覆盖回“处理中”。
      // 建卡不同——收尾正需要这个 id 才能复用同一张卡，只有已经建过卡才跳过。
      if (t.messageId) {
        if (t.sealed) return;
        await feishu.updateCard(t.messageId, card);
      } else {
        const created = await feishu.sendCard(s.chatId, card);
        if (!t.messageId) t.messageId = created;
      }
    })()).then((r) => {
      if (r instanceof WriteTimeout) throw r;
    }).catch((err: unknown) => {
      // 超时不等于永久失败：下一帧可以再试一次建卡；真正的拒绝才算创建失败。
      if (!t.messageId && !(err instanceof WriteTimeout)) t.creationFailed = true;
    }).finally(() => {
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
    const canRead = established && dirty && activeRead === 0 && !failed;
    const canWrite = turn?.pending && !turn.writing;
    if (!canRead && !canWrite) return;
    const due = Math.min(canRead ? lastRead + 1000 : Infinity, canWrite ? lastWrite + 1000 : Infinity);
    const dispatch = (): void => {
      timer = null;
      if (turn?.pending && !turn.writing && now() >= lastWrite + 1000) drainWrite(turn);
      if (established && dirty && !failed && activeRead === 0 && now() >= lastRead + 1000) void refresh();
      // Due work synchronously clears pending or marks itself in flight; rearm
      // only what remains, including a read deadline later than this write.
      schedule();
    };
    if (due <= now()) dispatch();
    else timer = setTimeout(dispatch, due - now());
  }
  /** 单次快照读取的上限。读不回来就必须释放读取槽，否则当前绑定永久停更。 */
  const READ_TIMEOUT_MS = 20_000;

  async function refresh(): Promise<void> {
    const s = scope;
    let v = version;
    if (!s || !valid(v) || !established || failed || activeRead !== 0) return;
    const token = ++readSeq;
    activeRead = token;
    dirty = false;
    lastRead = now();
    try {
      // One bounded projected tail. Older records outside this window are explicitly incomplete.
      // 超时后旧请求可能仍在路上；它的结果会因 version/token 不符被丢弃。
      const page = await readWithTimeout(
        paseo.readTimeline(s.agentId, { direction: "tail", projection: "projected", limit: 50 }),
      );
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
        // 工具阶段不能粘住：只有快照里最后一个活动项仍是未完成的工具调用，
        // 才显示“正在使用工具”。否则工具早跑完、正文一直在长，标题却还写着在跑工具。
        const lastActive = entries.at(-1)?.item;
        const toolRunning = lastActive?.type === "tool_call" && lastActive.status !== "completed";
        const phase = pending?.length
          ? pending.some(p => p.kind === "question") ? "等待回答（请回 Paseo）" : "等待授权"
          : toolRunning ? "正在使用工具" : "处理中";
        turn.view = { ...turn.view, phase, title: page.agent?.title ?? turn.view.title, text: excerpt(text, 12000), incomplete };
        paint(turn, s, v);
      }
      // A valid reconciliation releases submissions even if newer events need another frame.
      ready = true;
      settle(true);
    } catch (err) {
      if (err instanceof ReadTimeout) {
        // 读超时只释放读取槽：订阅本身没坏，下一拍应当能重新读。
        // 整体 fault 会让 failed=true 永久停读，那比卡住更难恢复。
        // 但用户要能看到“状态待核对”，所以降级当前卡片文案再继续重读。
        dirty = true;
        if (turn && !turn.sealed) {
          turn.view = { ...turn.view, phase: "处理中", incomplete: true, updatedAt: now() };
          paint(turn, s, v);
        }
      } else {
        fault(s, v, paseo.isReady() ? "观察中断，状态待核对（不会自动重发）" : "Paseo 未连接，状态待核对");
      }
    } finally {
      // 只清自己的 token：旧读晚到时不能把新会话的读取状态一起清掉。
      if (activeRead === token) activeRead = 0;
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
      if (turn && !turn.sealed && e.type === "timeline" && e.item.type === "tool_call") turn.view.phase = "正在使用工具";
      // 工具之后的正文说明工具已经产出结果，阶段该回到“处理中”。
      if (turn && !turn.sealed && e.type === "timeline" && e.item.type === "assistant_message") turn.view.phase = "处理中";
    }
    if (turn && !turn.sealed) turn.view.updatedAt = now();
    dirty = true;
    schedule();
  }
  function startObservation(s: BindingScope): void {
    ++version;
    const attempt = ++observation;
    cancelTimer();
    // 上一次读可能永远不返回；放行新的读取，旧结果会因 version 不符被丢弃。
    activeRead = 0;
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
    // 同 startObservation：未完成的读不再阻止后续刷新。
    activeRead = 0;
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
      // 超时按未就绪处理：宁可拒掉这一条并告知用户，也不能让会话永久卡住。
      return new Promise<boolean>(resolve => {
        waiters.push(resolve);
        const timer = setTimeout(() => {
          waiterTimers.delete(timer);
          fault(scope ?? s, version, paseo.isReady() ? "观察超时，请稍后重试" : "Paseo 未连接");
          settle(false);
        }, READY_TIMEOUT_MS);
        waiterTimers.add(timer);
      });
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
          // 上一次进展写卡可能永远不返回；不能让收尾通知跟着一起消失。
          await bounded(t.write);
          if (!currentScope()) return;
          let finalized = false;
          try {
            const card = cards.reply(view);
            if (t.creationFailed) throw new Error("progress card failed");
            if (t.messageId) {
              const sent = await bounded(feishu.updateCard(t.messageId, card));
              if (sent instanceof WriteTimeout) throw new Error("update timed out");
              finalized = true;
            } else {
              const sent = await bounded(feishu.sendCard(s.chatId, card));
              if (sent instanceof WriteTimeout) throw new Error("create timed out");
              t.messageId = sent;
              finalized = true;
            }
          } catch { /* Only a failed card operation falls back to the final body. */ }
          if (!currentScope()) return;
          try {
            await bounded(feishu.sendText(s.chatId, finalized ? reminder : `${reminder}${view.text ? `\n${view.text}` : ""}`));
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
