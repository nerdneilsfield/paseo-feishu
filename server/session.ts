import type {
  AgentSummary,
  BindingScope,
  CardAction,
  CardResponse,
  FeishuCard,
  FeishuPort,
  IncomingCardAction,
  IncomingText,
  PaseoPort,
  PersistedState,
  SendResult,
  SessionController,
  SessionDeps,
  ToastType,
} from "./contracts.js";
import { createLiveReplies } from "./live-replies.js";
import { HistoryReadError, readHistory, type HistoryPosition } from "./history.js";
import { logError, logInfo } from "./log.js";

// channel 负责外部输入校验；这里负责绑定、去重、转发和卡片动作。
// SWITCHING 只存在于内存；持久化的永远是最后一次成功的 Binding。

let scopeGeneration = 0;

function short(id: string): string {
  return `…${id.slice(-6)}`;
}

function logErr(scope: string, err: unknown, sensitive: readonly string[] = []): void {
  logError("session.failed", err, { scope }, sensitive);
}

export async function createSession(deps: SessionDeps): Promise<SessionController> {
  const { ownerOpenId, store: storeDep, paseo, feishu, cards } = deps;
  const now = deps.now ?? Date.now;

  let state: PersistedState = await storeDep.load();
  let switching = false;
  // 审批在途集合：同一 requestId 的第二次点击（含相反按钮）在首个结果落定前一律拒绝。
  const inFlightPermissions = new Set<string>();
  let closed = false;
  let generation = ++scopeGeneration;
  const navigationCards = new Map<string, { generation: number; chatId: string }>();
  let history: { position: HistoryPosition; messageId: string; chatId: string } | null = null;
  let historyChain: Promise<void> = Promise.resolve();

  function currentScope(): BindingScope | null {
    const binding = state.binding;
    return !closed && !switching && binding?.agentId
      ? { generation, agentId: binding.agentId, chatId: binding.chatId }
      : null;
  }

  function isCurrentScope(scope: BindingScope): boolean {
    return !closed && !switching && generation === scope.generation && state.binding?.agentId === scope.agentId && state.binding.chatId === scope.chatId;
  }

  const liveReplies = createLiveReplies({ paseo, feishu, cards, isCurrent: isCurrentScope, invalidateHistory: () => { history = null; }, now });
  liveReplies.bind(currentScope());

  function rememberNavigation(messageId: string, chatId: string): void {
    navigationCards.set(messageId, { generation, chatId });
    if (navigationCards.size > 32) navigationCards.delete(navigationCards.keys().next().value!);
  }


  // 写盘串行化：所有 save 经同一条 promise 链，避免并发交错。
  let saveChain: Promise<void> = Promise.resolve();
  // close() 等待后台任务；最终关闭期限由宿主负责。
  const pending = new Set<Promise<void>>();
  // 选择、刷新、翻页画的是同一张卡。点击时同步取号，写卡串行，
  // 旧请求的结果回来时号已经变了就丢弃，避免盖住更新的点击。
  let sessionCardEpoch = 0;
  let cardWrite: Promise<void> = Promise.resolve();

  function nextCardEpoch(): number {
    sessionCardEpoch += 1;
    return sessionCardEpoch;
  }

  function paintSessionCard(epoch: number, messageId: string, card: FeishuCard, expectedGeneration: number): Promise<void> {
    const op = cardWrite.then(async () => {
      if (closed || expectedGeneration !== generation || epoch !== sessionCardEpoch) return;
      await feishu.updateCard(messageId, card);
      if (!closed && expectedGeneration === generation) rememberNavigation(messageId, state.binding!.chatId);
    });
    cardWrite = op.catch(() => undefined);
    return op;
  }

  function enqueueSave(): Promise<void> {
    const op = saveChain.then(() => storeDep.save(state));
    saveChain = op.catch(() => undefined);
    return op;
  }

  function runBackground(work: Promise<void>, scope: string): void {
    const tracked = work.catch((err: unknown) => {
      logErr(scope, err);
    });
    pending.add(tracked);
    void tracked.finally(() => {
      pending.delete(tracked);
    });
  }

  async function safeSendText(chatId: string, text: string): Promise<void> {
    try {
      await feishu.sendText(chatId, text);
    } catch (err) {
      logErr(`sendText to ${short(chatId)}`, err, [text]);
    }
  }

  function toast(type: ToastType, content: string): CardResponse {
    return { toast: { type, content } };
  }

  // 发出新的选择卡：revision +1，记录新 pickerMessageId。本条触发文本不转发。
  async function sendPicker(chatId: string, page = 0): Promise<void> {
    if (switching) {
      await safeSendText(chatId, "切换中，请稍后选择会话。");
      return;
    }
    const expectedGeneration = generation;
    const cardEpoch = nextCardEpoch();
    const nextRev = (state.binding?.pickerRevision ?? 0) + 1;
    const connected = paseo.isReady();
    let agents: AgentSummary[] = [];
    let ok = connected;
    if (connected) {
      try {
        agents = await paseo.listAgents();
      } catch (err) {
        logErr("listAgents", err);
        ok = false;
        agents = [];
      }
    }
    if (closed || expectedGeneration !== generation || cardEpoch !== sessionCardEpoch) return;
    const currentAgentId = state.binding?.agentId ?? null;
    const card = cards.picker({ agents, page, pickerRevision: nextRev, currentAgentId, connected: ok });
    let messageId: string;
    try {
      messageId = await feishu.sendCard(chatId, card);
    } catch (err) {
      logErr(`sendCard to ${short(chatId)}`, err);
      return;
    }
    if (closed || expectedGeneration !== generation || cardEpoch !== sessionCardEpoch) return;
    rememberNavigation(messageId, chatId);
    state.binding = {
      chatId: state.binding?.chatId ?? chatId,
      openId: ownerOpenId,
      agentId: currentAgentId,
      bindingRevision: state.binding?.bindingRevision ?? 0,
      pickerMessageId: messageId,
      pickerRevision: nextRev,
    };
    try {
      await enqueueSave();
    } catch (err) {
      logErr("save picker state", err);
    }
  }

  async function sendNavigationCard(chatId: string, card: FeishuCard, expectedGeneration = generation): Promise<void> {
    if (closed || expectedGeneration !== generation) return;
    const messageId = await feishu.sendCard(chatId, card);
    if (!closed && expectedGeneration === generation) rememberNavigation(messageId, chatId);
  }

  async function sendStatus(chatId: string): Promise<void> {
    const scope = currentScope();
    if (!scope) {
      await safeSendText(chatId, switching ? "切换中，请稍后查询状态。" : "当前未绑定会话，请先选择会话。");
      return;
    }
    if (!paseo.isReady()) {
      await safeSendText(chatId, "Paseo 未连接，无法读取当前会话状态。");
      return;
    }
    try {
      const agent = await paseo.refreshAgent(scope.agentId);
      if (!isCurrentScope(scope)) return;
      if (!agent || agent.archived) {
        await safeSendText(chatId, "当前会话不可用（不存在或已归档），请重新选择会话。");
        return;
      }
      await sendNavigationCard(chatId, cards.current({ agent }), scope.generation);
    } catch (err) {
      logErr("read status", err);
      if (isCurrentScope(scope)) await safeSendText(chatId, "状态读取失败，请稍后重试。");
    }
  }

  function sendHistory(chatId: string, more: boolean, expected?: Extract<CardAction, { action: "history_page" }> & { messageId: string }): Promise<void> {
    const requestedGeneration = generation;
    const work = historyChain.then(async () => {
      if (closed || requestedGeneration !== generation) return;
      const scope = currentScope();
      if (!scope) {
        await safeSendText(chatId, switching ? "切换中，请稍后重新查询历史。" : "当前未绑定会话，请先选择会话。");
        return;
      }
      if (expected && (!history || history.messageId !== expected.messageId || history.chatId !== chatId)) {
        await safeSendText(chatId, "历史卡片已过期，请重新发送 /history。");
        return;
      }
      if (more && !history) {
        await safeSendText(chatId, "尚无历史位置，请先发送 /history。");
        return;
      }
      if (!paseo.isReady()) {
        await safeSendText(chatId, "Paseo 未连接，历史未读取。");
        return;
      }
      try {
        const agent = await paseo.refreshAgent(scope.agentId);
        if (!isCurrentScope(scope)) return;
        if (!agent || agent.archived) {
          await safeSendText(chatId, "当前会话不可用（不存在或已归档），无法读取历史。");
          return;
        }
        const candidate = await readHistory(paseo, scope, more ? history!.position : null, () => isCurrentScope(scope));
        if (!candidate) return;
        const messageId = await feishu.sendCard(chatId, cards.history({
          agent, messages: candidate.messages,
          hasOlder: candidate.position.hasOlder || candidate.position.buffer.length > 0,
        }));
        if (!isCurrentScope(scope)) return;
        if (history) navigationCards.delete(history.messageId);
        history = { position: candidate.position, messageId, chatId };
        rememberNavigation(messageId, chatId);
      } catch (err) {
        if (!isCurrentScope(scope)) return;
        if (err instanceof HistoryReadError && err.invalidCursor) history = null;
        // SDK/network errors may contain transcript text; never log their raw message.
        await safeSendText(chatId, err instanceof HistoryReadError ? err.message : "历史读取或发送失败，位置未推进，请稍后重试。");
      }
    });
    historyChain = work.catch(() => undefined);
    return work;
  }

  async function navigate(chatId: string, destination: "sessions" | "status" | "history" | "help" | "commands"): Promise<void> {
    switch (destination) {
      case "sessions": return sendPicker(chatId);
      case "status": return sendStatus(chatId);
      case "history": return sendHistory(chatId, false);
      case "help":
      case "commands": return sendNavigationCard(chatId, cards.help({ commands: destination === "commands" }));
    }
  }

  function recordDelivery(
    messageId: string,
    result: SendResult,
  ): "accepted" | Exclude<SendResult, { ok: true }>["reason"] {
    if (result.ok) {
      state.deliveries[messageId] = { state: "accepted", at: now() };
      return "accepted";
    }
    const mapped = result.reason === "not_connected" ? "rejected" : result.reason;
    state.deliveries[messageId] = {
      state: result.reason === "unknown" ? "unknown" : "rejected",
      at: now(),
    };
    return mapped;
  }

  async function handleText(msg: IncomingText): Promise<void> {
    try {
      await routeText(msg);
    } catch (err) {
      // 没有这一层，handler 抛错就等于消息凭空消失：用户看不到任何回应。
      logErr(`handleText ${short(msg.messageId)}`, err, [msg.text]);
      await safeSendText(msg.chatId, "处理这条消息时出错，未发送，请稍后重试。");
    }
  }

  async function routeText(msg: IncomingText): Promise<void> {
    if (closed) {
      logInfo("session.message.ignored", { messageId: msg.messageId, reason: "closed" });
      return;
    }
    // 去重放在入口：未绑定/切换中/命令这些不转发的消息也要记一笔，
    // 否则重投后已绑定，它们会被当成普通提示词转给 Agent（A01/A10）。
    if (state.deliveries[msg.messageId]) {
      logInfo("session.message.ignored", { messageId: msg.messageId, reason: "duplicate", deliveryState: state.deliveries[msg.messageId]?.state });
      return;
    }
    const consume = async (): Promise<void> => {
      state.deliveries[msg.messageId] = { state: "rejected", at: now() };
      try {
        logInfo("session.consume.started", { messageId: msg.messageId });
        await enqueueSave();
        logInfo("session.consume.succeeded", { messageId: msg.messageId });
      } catch (err) {
        logErr("save consumed", err);
      }
    };
    const cmd = msg.text.trim();
    const [first, ...args] = cmd.split(/\s+/);
    if (first === "/help" || first === "/history") {
      logInfo("session.routed", { messageId: msg.messageId, action: first === "/help" ? "help" : "history" });
      await consume();
      if (first === "/help") {
        if (args.length) await safeSendText(msg.chatId, "用法：/help");
        else await navigate(msg.chatId, "help");
      } else if (!args.length || (args.length === 1 && args[0] === "more")) {
        await sendHistory(msg.chatId, args.length === 1);
      } else await safeSendText(msg.chatId, "用法：/history 或 /history more");
      return;
    }
    if (cmd === "/sessions" || cmd === "/status") {
      logInfo("session.routed", { messageId: msg.messageId, action: cmd === "/sessions" ? "picker" : "status" });
      await consume();
      await navigate(msg.chatId, cmd === "/sessions" ? "sessions" : "status");
      return;
    }
    if (switching) {
      logInfo("session.routed", { messageId: msg.messageId, action: "switching" });
      await consume();
      await safeSendText(msg.chatId, "切换中：此消息未发送，请切换后重发。");
      return;
    }
    const agentId = state.binding?.agentId;
    if (!agentId) {
      logInfo("session.routed", { messageId: msg.messageId, action: "picker", reason: "unbound" });
      await consume();
      await sendPicker(msg.chatId);
      return;
    }
    // 同一原子快照的目标：此后不再重新读取绑定。
    const targetScope = currentScope();
    const targetAgentId = agentId;
    logInfo("session.routed", { messageId: msg.messageId, action: "forward", agentId: short(agentId), paseoConnected: paseo.isReady() });
    const targetChatId = msg.chatId;
    const body = msg.text;
    state.deliveries[msg.messageId] = { state: "claimed", at: now() };
    try {
      await enqueueSave();
    } catch (err) {
      logErr("save claim", err);
    }
    if (!paseo.isReady()) {
      state.deliveries[msg.messageId] = { state: "rejected", at: now() };
      try {
        await enqueueSave();
      } catch (err) {
        logErr("save rejected", err);
      }
      await safeSendText(targetChatId, "Paseo 未连接，消息未发送");
      return;
    }
    if (!targetScope || !(await liveReplies.ensureReady(targetScope)) || !isCurrentScope(targetScope)) {
      state.deliveries[msg.messageId] = { state: "rejected", at: now() };
      await enqueueSave().catch((err) => logErr("save observation rejection", err));
      if (targetScope && isCurrentScope(targetScope)) await safeSendText(targetChatId, "动态回复观察尚未就绪，消息未发送，请稍后重试。");
      return;
    }
    let result: SendResult;
    try {
      result = await paseo.send(targetAgentId, body);
    } catch (err) {
      logErr(`send to ${short(targetAgentId)}`, err, [body]);
      result = { ok: false, reason: "unknown" };
    }
    const outcome = recordDelivery(msg.messageId, result);
    logInfo("session.forward.result", { messageId: msg.messageId, agentId: short(targetAgentId), outcome });
    try {
      await enqueueSave();
    } catch (err) {
      logErr("save delivery", err);
    }
    if (!isCurrentScope(targetScope)) return;
    if (outcome === "accepted") {
      await safeSendText(targetChatId, "Paseo 已受理（非任务完成），进展将在回复卡显示。");
    } else if (outcome === "unknown") {
      await safeSendText(targetChatId, "发送结果不确定，请到 Paseo 核对，未自动重发");
    } else if (outcome === "not_found" || outcome === "archived") {
      await safeSendText(targetChatId, "当前会话不可用（不存在或已归档），消息未发送，请重新选择会话。");
    } else if (result.ok === false && result.reason === "not_connected") {
      await safeSendText(targetChatId, "Paseo 未连接，消息未发送");
    } else {
      await safeSendText(targetChatId, "Paseo 拒绝了这条消息，消息未发送。");
    }
  }

  async function handleSelect(evt: IncomingCardAction, agentId: string, rev: number): Promise<CardResponse> {
    const binding = state.binding;
    if (!binding || binding.pickerMessageId !== evt.messageId || binding.pickerRevision !== rev) {
      return toast("warning", "卡片已过期，请重新打开");
    }
    // 幂等：重复点击同一 Agent 无任何副作用。
    if (binding.agentId === agentId) {
      return toast("info", "已是当前会话，无需切换");
    }
    if (switching) return toast("loading", "正在切换，请稍候");
    if (!paseo.isReady()) return toast("error", "Paseo 未连接，消息未发送");
    switching = true;
    liveReplies.bind(null);
    generation = ++scopeGeneration;
    history = null;
    const expectedGeneration = generation;
    const cardEpoch = nextCardEpoch();
    const prevChatId = binding.chatId;
    runBackground(
      (async () => {
        let summary: AgentSummary | null;
        try {
          summary = await paseo.refreshAgent(agentId);
        } catch (err) {
          logErr(`refresh ${short(agentId)}`, err);
          if (closed || generation !== expectedGeneration) return;
          switching = false;
          liveReplies.bind(currentScope());
          await safeSendText(prevChatId, "未切换：验证会话时发生错误，保留原绑定。");
          return;
        }
        if (closed || generation !== expectedGeneration) return;
        if (!summary || summary.archived) {
          switching = false;
          liveReplies.bind(currentScope());
          await safeSendText(
            prevChatId,
            `未切换：目标会话${summary ? "已归档" : "不存在"}，保留原绑定。`,
          );
          return;
        }
        const nextRev = (state.binding?.pickerRevision ?? 0) + 1;
        const nextBindingRev = (state.binding?.bindingRevision ?? 0) + 1;
        state.binding = {
          chatId: prevChatId,
          openId: ownerOpenId,
          agentId,
          bindingRevision: nextBindingRev,
          pickerMessageId: evt.messageId,
          pickerRevision: nextRev,
        };
        // 可观测翻转必须是原子的：绑定与 switching 在同一同步块内一起变，
        // 落盘只影响崩溃恢复，不影响当前内存路由。
        switching = false;
        liveReplies.bind(currentScope());
        try {
          await enqueueSave();
        } catch (err) {
          logErr("save binding", err);
        }
        if (closed || generation !== expectedGeneration) return;
        rememberNavigation(evt.messageId, prevChatId);
        const card = cards.current({ agent: summary });
        try {
          await paintSessionCard(cardEpoch, evt.messageId, card, expectedGeneration);
        } catch (err) {
          // 已成功保存的绑定不得回滚，只发文字确认。
          logErr(`updateCard ${short(evt.messageId)}`, err);
          await safeSendText(prevChatId, "已切换到新会话，但卡片更新失败，下次打开选择卡即可看到最新状态。");
        }
      })(),
      "select_agent",
    );
    return toast("loading", "正在切换会话…");
  }

  async function handlePickerRefresh(evt: IncomingCardAction, rev: number, page: number): Promise<CardResponse> {
    if (switching) return toast("loading", "正在切换，请稍候");
    const binding = state.binding;
    if (!binding || binding.pickerMessageId !== evt.messageId || binding.pickerRevision !== rev) {
      return toast("warning", "卡片已过期，请重新打开");
    }
    // 列表查询和卡片更新都是网络调用。卡片回调必须在 3 秒内返回，
    // 所以这里只做同步校验，耗时工作放后台。
    const chatId = binding.chatId;
    const pickerRevision = binding.pickerRevision;
    const currentAgentId = binding.agentId;
    const expectedGeneration = generation;
    const cardEpoch = nextCardEpoch();
    runBackground(
      (async () => {
        const connected = paseo.isReady();
        let agents: AgentSummary[] = [];
        let ok = connected;
        if (connected) {
          try {
            agents = await paseo.listAgents();
          } catch (err) {
            logErr("listAgents", err);
            ok = false;
            agents = [];
          }
        }
        if (closed || generation !== expectedGeneration) return;
        try {
          await paintSessionCard(
            cardEpoch,
            evt.messageId,
            cards.picker({
              agents,
              page,
              pickerRevision,
              currentAgentId,
              connected: ok,
            }),
            expectedGeneration,
          );
        } catch (err) {
          logErr(`updateCard ${short(evt.messageId)}`, err);
          await safeSendText(chatId, "刷新失败：卡片更新失败");
        }
      })(),
      "refresh_picker",
    );
    return toast("loading", "正在刷新…");
  }

  async function handlePermission(
    evt: IncomingCardAction,
    agentId: string,
    requestId: string,
    approve: boolean,
  ): Promise<CardResponse> {
    const decision = approve ? "allow" : "deny";
    const binding = state.binding;
    if (!binding?.agentId || agentId !== binding.agentId || evt.chatId !== binding.chatId) {
      return toast("info", "该请求已处理");
    }
    if (state.decidedPermissions[requestId] || inFlightPermissions.has(requestId)) {
      return toast("info", "该请求已处理或正在处理");
    }
    if (!paseo.isReady()) return toast("error", "Paseo 未连接，消息未发送");
    // 第一个 await 之前同步占位：「允许」「拒绝」两个按钮的 value 不同，SDK 去重挡不住，
    // 快速连点会向 daemon 并发提交两个冲突的决定。后台任务结束（成功或失败）才释放。
    inFlightPermissions.add(requestId);
    const release = (): void => {
      inFlightPermissions.delete(requestId);
    };
    const targetAgent = binding.agentId;
    const targetChat = binding.chatId;
    runBackground(
      (async () => {
        try {
          let res: { ok: true } | { ok: false; reason: string };
          try {
            res = await paseo.respondToPermission(targetAgent, requestId, decision);
          } catch (err) {
            logErr("respondToPermission", err);
            await safeSendText(targetChat, "审批提交时发生错误，未重复提交，请到 Paseo 核对。");
            return;
          }
          if (!res.ok) {
            if (res.reason === "not_pending") {
              await markPermissionDecided(requestId, "resolved_elsewhere");
              await safeSendText(targetChat, "该请求已处理。");
              return;
            }
            await safeSendText(targetChat, `审批未成功（${res.reason}），未重复提交，请到 Paseo 核对。`);
            return;
          }
          state.decidedPermissions[requestId] = { decision, at: now() };
          try {
            await enqueueSave();
          } catch (err) {
            logErr("save permission decision", err);
          }
          try {
            await feishu.updateCard(
              evt.messageId,
              cards.permissionResolved({ agentTitle: "当前会话", outcome: decision }),
            );
          } catch (err) {
            logErr(`updateCard ${short(evt.messageId)}`, err);
            await safeSendText(targetChat, `审批已提交（${decision}），但卡片更新失败。`);
          }
        } finally {
          release();
        }
      })(),
      "permission_decision",
    );
    return toast("loading", "正在处理审批…");
  }

  async function handleCardAction(evt: IncomingCardAction): Promise<CardResponse> {
    if (closed) return toast("error", "服务已关闭");
    const action = evt.action;
    switch (action.action) {
      case "navigate": {
        const card = navigationCards.get(evt.messageId);
        if (!card || card.generation !== generation || card.chatId !== evt.chatId || switching) return toast("warning", "卡片已过期，请重新打开 /help");
        runBackground(navigate(evt.chatId, action.destination), "navigate");
        return toast("loading", "正在打开…");
      }
      case "history_page":
        runBackground(sendHistory(evt.chatId, !action.latest, { ...action, messageId: evt.messageId }), "history_page");
        return toast("loading", "正在读取历史…");
      case "select_agent":
        return handleSelect(evt, action.agentId, action.pickerRevision);
      case "refresh_agents":
        return handlePickerRefresh(evt, action.pickerRevision, 0);
      case "page_agents":
        return handlePickerRefresh(evt, action.pickerRevision, action.page);
      case "approve_permission":
        return handlePermission(evt, action.agentId, action.requestId, true);
      case "deny_permission":
        return handlePermission(evt, action.agentId, action.requestId, false);
    }
  }

  async function markNotified(key: string): Promise<boolean> {
    if (closed) return false;
    if (state.notified.some((n) => n.key === key)) return false;
    state.notified.push({ key, at: now() });
    try {
      await enqueueSave();
    } catch (err) {
      logErr("save notified", err);
    }
    return true;
  }

  async function markPermissionDecided(
    requestId: string,
    decision: "allow" | "deny" | "resolved_elsewhere",
  ): Promise<boolean> {
    if (closed) return false;
    if (state.decidedPermissions[requestId]) return false;
    state.decidedPermissions[requestId] = { decision, at: now() };
    try {
      await enqueueSave();
    } catch (err) {
      logErr("save permission decided", err);
    }
    return true;
  }

  async function close(): Promise<void> {
    closed = true;
    liveReplies.close();
    generation = ++scopeGeneration;
    history = null;
    navigationCards.clear();
    await saveChain;
    await Promise.allSettled([...pending]);
    await saveChain;
  }

  const controller: SessionController = {
    liveReplies,
    resumeObservation() {
      const scope = currentScope();
      if (scope && paseo.isReady()) void liveReplies.ensureReady(scope, false);
    },
    handleText,
    handleCardAction,
    currentScope,
    isCurrentScope,
    markNotified,
    markPermissionDecided,
    close,
  };
  return controller;
}
