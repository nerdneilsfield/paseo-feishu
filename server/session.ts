import type {
  AgentSummary,
  CardBuilders,
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
  Store,
  ToastType,
} from "./contracts.js";
import { logError, logInfo } from "./log.js";

// 会话控制：身份校验、绑定切换、文本转发卡片动作。
// SWITCHING 只存在于内存；持久化的永远是最后一次成功的 Binding。

const CLOSE_TIMEOUT_MS = 2000;

function short(id: string): string {
  return id.length <= 6 ? `…${id}` : `…${id.slice(-6)}`;
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

  // 写盘串行化：所有 save 经同一条 promise 链，避免并发交错。
  let saveChain: Promise<void> = Promise.resolve();
  // 后台任务跟踪：close() 等待它们（总上限 2 秒）。
  const pending = new Set<Promise<void>>();
  // 选择、刷新、翻页画的是同一张卡。点击时同步取号，写卡串行，
  // 旧请求的结果回来时号已经变了就丢弃，避免盖住更新的点击。
  let sessionCardEpoch = 0;
  let cardWrite: Promise<void> = Promise.resolve();

  function nextCardEpoch(): number {
    sessionCardEpoch += 1;
    return sessionCardEpoch;
  }

  function paintSessionCard(epoch: number, messageId: string, card: FeishuCard): Promise<void> {
    const op = cardWrite.then(async () => {
      if (epoch !== sessionCardEpoch) return;
      await feishu.updateCard(messageId, card);
    });
    cardWrite = op.catch(() => undefined);
    return op;
  }

  const store: Store = storeDep;

  function snapshot(): PersistedState {
    return JSON.parse(JSON.stringify(state)) as PersistedState;
  }

  function enqueueSave(): Promise<void> {
    const op = saveChain.then(() => store.save(snapshot()));
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
    const currentAgentId = state.binding?.agentId ?? null;
    let card: ReturnType<CardBuilders["picker"]>;
    try {
      card = cards.picker({
        agents,
        page,
        pickerRevision: nextRev,
        currentAgentId,
        connected: ok,
      });
    } catch (err) {
      logErr("build picker card", err);
      return;
    }
    let messageId: string;
    try {
      messageId = await feishu.sendCard(chatId, card);
    } catch (err) {
      logErr(`sendCard to ${short(chatId)}`, err);
      return;
    }
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

  async function sendStatus(chatId: string): Promise<void> {
    const agentId = state.binding?.agentId;
    if (!agentId) {
      await safeSendText(chatId, "当前未绑定会话，请先选择会话。");
      return;
    }
    const rev = state.binding?.bindingRevision ?? 0;
    await safeSendText(chatId, `当前绑定：Agent ${short(agentId)}（bindingRevision ${rev}）。`);
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
    if (closed) {
      logInfo("session.message.ignored", { messageId: msg.messageId, reason: "closed" });
      return;
    }
    // 身份/渠道校验：不通过只记诊断日志，不向发送者回复会话信息。
    if (msg.senderId !== ownerOpenId || msg.chatType !== "p2p") {
      logInfo("session.message.ignored", { messageId: msg.messageId, reason: "unauthorized" });
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
    if (msg.rawContentType !== "text") {
      logInfo("session.routed", { messageId: msg.messageId, action: "unsupported_content_type" });
      await consume();
      await safeSendText(msg.chatId, "仅支持文本消息，其他类型暂不支持。");
      return;
    }
    const cmd = msg.text.trim();
    if (cmd === "/sessions") {
      logInfo("session.routed", { messageId: msg.messageId, action: "picker" });
      await consume();
      await sendPicker(msg.chatId);
      return;
    }
    if (cmd === "/status") {
      logInfo("session.routed", { messageId: msg.messageId, action: "status", bound: Boolean(state.binding?.agentId), paseoConnected: paseo.isReady() });
      await consume();
      await sendStatus(msg.chatId);
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
    if (outcome === "accepted") {
      await safeSendText(targetChatId, "已发送（非任务完成）到当前会话。");
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
    const cardEpoch = nextCardEpoch();
    const prevChatId = binding.chatId;
    runBackground(
      (async () => {
        let summary: AgentSummary | null;
        try {
          summary = await paseo.refreshAgent(agentId);
        } catch (err) {
          logErr(`refresh ${short(agentId)}`, err);
          switching = false;
          await safeSendText(prevChatId, "未切换：验证会话时发生错误，保留原绑定。");
          return;
        }
        if (!summary || summary.archived) {
          switching = false;
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
        try {
          await enqueueSave();
        } catch (err) {
          logErr("save binding", err);
        }
        let card: ReturnType<CardBuilders["current"]>;
        try {
          card = cards.current({ agent: summary, pickerRevision: nextRev });
        } catch (err) {
          logErr("build current card", err);
          await safeSendText(prevChatId, "已切换到新会话，但卡片构造失败，下次打开选择卡即可看到最新状态。");
          return;
        }
        try {
          await paintSessionCard(cardEpoch, evt.messageId, card);
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
    const binding = state.binding;
    if (!binding || binding.pickerMessageId !== evt.messageId || binding.pickerRevision !== rev) {
      return toast("warning", "卡片已过期，请重新打开");
    }
    // 列表查询和卡片更新都是网络调用。卡片回调必须在 3 秒内返回，
    // 而且 chatQueue 要等 handler 结束才放行下一条，所以这里只做同步校验。
    const chatId = binding.chatId;
    const pickerRevision = binding.pickerRevision;
    const currentAgentId = binding.agentId;
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

  async function handleCurrentRefresh(evt: IncomingCardAction, rev: number): Promise<CardResponse> {
    const binding = state.binding;
    if (!binding || binding.pickerMessageId !== evt.messageId || binding.pickerRevision !== rev) {
      return toast("warning", "卡片已过期，请重新打开");
    }
    if (!binding.agentId) return toast("info", "尚未选择会话");
    if (!paseo.isReady()) return toast("error", "Paseo 未连接，消息未发送");
    const agentId = binding.agentId;
    const pickerRevision = binding.pickerRevision;
    const chatId = binding.chatId;
    const cardEpoch = nextCardEpoch();
    runBackground(
      (async () => {
        let summary: AgentSummary | null;
        try {
          summary = await paseo.refreshAgent(agentId);
        } catch (err) {
          logErr(`refresh ${short(agentId)}`, err);
          await safeSendText(chatId, "刷新失败");
          return;
        }
        if (!summary || summary.archived) {
          await safeSendText(chatId, "当前会话不可用，请重新选择");
          return;
        }
        try {
          await paintSessionCard(
            cardEpoch,
            evt.messageId,
            cards.current({ agent: summary, pickerRevision }),
          );
        } catch (err) {
          logErr(`updateCard ${short(evt.messageId)}`, err);
          await safeSendText(chatId, "刷新失败：卡片更新失败");
        }
      })(),
      "refresh_current",
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
    if (!binding?.agentId || agentId !== binding.agentId) {
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
    let pendings;
    try {
      pendings = await paseo.getPendingPermissions(binding.agentId);
    } catch (err) {
      release();
      logErr("getPendingPermissions", err);
      return toast("error", "查询审批状态失败，请稍后重试");
    }
    const found = pendings.find((p) => p.requestId === requestId);
    if (!found || !found.mappable) {
      state.decidedPermissions[requestId] = { decision: "resolved_elsewhere", at: now() };
      try {
        await enqueueSave();
      } catch (err) {
        logErr("save resolved_elsewhere", err);
      } finally {
        release();
      }
      return toast("info", "该请求已处理");
    }
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
            await safeSendText(targetChat, `审批未成功（${res.reason}），未重复提交，请到 Paseo 核对。`);
            return;
          }
          state.decidedPermissions[requestId] = { decision, at: now() };
          try {
            await enqueueSave();
          } catch (err) {
            logErr("save permission decision", err);
          }
          let title = "当前会话";
          try {
            const a = await paseo.refreshAgent(targetAgent);
            if (a?.title) title = a.title;
          } catch (err) {
            logErr(`refresh ${short(targetAgent)}`, err);
          }
          try {
            await feishu.updateCard(
              evt.messageId,
              cards.permissionResolved({ agentTitle: title, outcome: decision }),
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
    if (evt.operatorOpenId !== ownerOpenId) return toast("error", "无权限");
    const action = evt.action;
    switch (action.action) {
      case "select_agent":
        return handleSelect(evt, action.agentId, action.pickerRevision);
      case "open_picker":
        return handlePickerRefresh(evt, action.pickerRevision, 0);
      case "refresh_agents":
        return handlePickerRefresh(evt, action.pickerRevision, 0);
      case "refresh_current":
        return handleCurrentRefresh(evt, action.pickerRevision);
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
    const drain = (async () => {
      try {
        await saveChain;
      } catch {
        // save 错误已在各自调用处记录，这里只保证等待。
      }
      const inFlight = [...pending];
      if (inFlight.length > 0) await Promise.allSettled(inFlight);
      try {
        await saveChain;
      } catch {
        // 同上。
      }
    })();
    await Promise.race([
      drain,
      new Promise<void>((resolve) => {
        setTimeout(resolve, CLOSE_TIMEOUT_MS);
      }),
    ]);
  }

  const controller: SessionController = {
    handleText,
    handleCardAction,
    currentAgentId: () => state.binding?.agentId ?? null,
    currentChatId: () => state.binding?.chatId ?? null,
    markNotified,
    markPermissionDecided,
    close,
  };
  return controller;
}
