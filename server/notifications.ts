import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type {
  BindingScope,
  NotificationDeps,
  PendingPermission,
} from "./contracts.js";
import { excerpt } from "./history.js";
import { logError, logInfo } from "./log.js";
import { toPendingPermission } from "./paseo.js";

/** 记住审批卡位置供 resolved 时更新；有上限，重启后丢失可接受（best-effort）。 */
const approvalCards = new Map<string, { messageId: string; scope: BindingScope }>();
const APPROVAL_CARDS_LIMIT = 500;

function rememberApprovalCard(
  requestId: string,
  location: { messageId: string; scope: BindingScope },
): void {
  if (approvalCards.size >= APPROVAL_CARDS_LIMIT) {
    const oldest = approvalCards.keys().next();
    if (!oldest.done) approvalCards.delete(oldest.value);
  }
  approvalCards.set(requestId, location);
}

function lastAssistantText(
  timeline: readonly AgentTimelineItem[],
): string {
  // Skip only trailing non-message items, then retain the latest contiguous
  // assistant group, stopping at a user/tool item (earlier dialogue excluded).
  let end = timeline.length - 1;
  while (end >= 0 && timeline[end]!.type !== "assistant_message" && timeline[end]!.type !== "user_message") end--;
  const parts: string[] = [];
  for (let i = end; i >= 0; i--) {
    const item = timeline[i]!;
    if (item.type !== "assistant_message") break;
    parts.push(item.text);
  }
  return excerpt(parts.reverse().join(""), 12000);
}

/**
 * 0.13 起 agent.turn_ended 的 timeline 恒为空，最终答复要按 turnId 自己回读。
 * shortcut: 最多向前翻 10 页（1000 条）；更长的轮次只取到尾部那部分答复。
 */
async function readFinalText(
  paseo: PaseoApi,
  agentId: string,
  turnId: string,
): Promise<string> {
  const timeline = paseo.agents.ref(agentId).timeline;
  const own = new Map<number, AgentTimelineItem>();
  // 同一页会混入 turnId 缺失的条目：fork、历史回放、压缩都产生过。
  // 本轮没有正文时拿它们兑底，否则卡片会显示「暂无公开助手内容」。
  const idless = new Map<number, AgentTimelineItem>();
  let cursor: { epoch: string; seq: number } | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await timeline.refetch({
      direction: cursor ? "before" : "tail",
      ...(cursor ? { cursor } : {}),
      projection: "projected",
      limit: 100,
    });
    if (result.error) throw new Error(result.error);
    const entries = result.entries;
    const matched = entries.filter((entry) => entry.turnId === turnId);
    for (const entry of matched) own.set(entry.seqStart, entry.item);
    if (own.size === 0) {
      for (const entry of entries) {
        if (entry.turnId == null) idless.set(entry.seqStart, entry.item);
      }
    }
    // 已经拿到本轮的条目，再往前一页全不匹配，说明已经跨过本轮起点。
    if (own.size > 0 && matched.length === 0) break;
    if (!result.hasOlder || !result.startCursor) break;
    if (cursor && cursor.epoch === result.startCursor.epoch && cursor.seq === result.startCursor.seq) {
      throw new Error("timeline cursor did not advance");
    }
    cursor = result.startCursor;
  }
  const ordered = (from: Map<number, AgentTimelineItem>): AgentTimelineItem[] =>
    [...from.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  const text = lastAssistantText(ordered(own));
  if (text) return text;
  // 本轮一条正文都没拿到：如实记录下来，别让下次只能靠猜。
  logInfo("turn_ended.read.empty", { agentId, turnId, matched: own.size, idless: idless.size });
  return lastAssistantText(ordered(idless));
}

export function registerNotifications(server: PluginServerContext, deps: NotificationDeps): void {
  server.on("agent.turn_ended", async (event, context) => {
    const session = deps.session();
    if (!session) return;
    const scope = session.currentScope();
    if (!scope || scope.agentId !== event.agent.id || !event.turnId) return;
    const agentId = event.agent.id;
    const turnId = event.turnId;
    const key = `${agentId}:${turnId}`;
    const finish = session.liveReplies.seal(scope, turnId);
    if (!(await session.markNotified(key)) || !session.isCurrentScope(scope)) return;
    const title = event.agent.title ?? agentId.slice(0, 8);
    const phase = event.outcome.kind === "completed" ? "已完成" : event.outcome.kind === "failed" ? "失败" : "已取消";
    const rawReason = event.outcome.kind === "failed" ? event.outcome.error.message : event.outcome.kind === "canceled" ? event.outcome.reason : null;
    // Take only the protocol string; never serialize diagnostics or unknown objects.
    const reason = rawReason?.replace(/\s+/g, " ").trim().slice(0, 300) ?? "";
    const reminder = `${title} · ${phase}${reason ? `：${reason}` : ""}`;
    // 回读走后台：hook 不能等一次 timeline RPC，卡片回调那边还有 3 秒预算。
    void (async () => {
      const text = await readFinalText(context.paseo, agentId, turnId).catch((err: unknown) => {
        logError("turn_ended read final text failed", err);
        return "";
      });
      // A late end event gets its own message; it must not seal or repaint the new turn.
      if (finish) {
        await finish.finish({ title, phase, reason, updatedAt: Date.now(), text, incomplete: false }, reminder);
      } else {
        await deps.feishu.sendText(scope.chatId, `${reminder}（轮次 ${turnId.slice(0, 8)}）${text ? `\n${text}` : ""}`);
      }
    })().catch((err) => logError("turn_ended notify failed", err));
  });

  server.on("agent.permission_requested", async (event) => {
    const session = deps.session();
    if (!session) return;
    const scope = session.currentScope();
    if (!scope || scope.agentId !== event.agent.id) return;
    const permission: PendingPermission = toPendingPermission(event.agent.id, event.request);
    session.liveReplies.waiting(scope, permission.kind === "question");
    if (!(await session.markNotified(`perm:${permission.requestId}`))) return;

    const agentTitle = event.agent.title ?? event.agent.id.slice(0, 8);
    void (async () => {
      if (!session.isCurrentScope(scope)) return;
      if (permission.mappable) {
        const messageId = await deps.feishu.sendCard(
          scope.chatId,
          deps.cards.permission({ permission, agentTitle }),
        );
        rememberApprovalCard(permission.requestId, { messageId, scope });
      } else {
        // 无法映射成 allow/deny 的请求不生成二选一按钮，只提示回 Paseo 处理。
        await deps.feishu.sendCard(
          scope.chatId,
          deps.cards.notice({
            title: permission.kind === "question" ? "Paseo · 需要回答" : "Paseo · 需要操作",
            text: `**${agentTitle}**\n\n${permission.summary}\n\n请回 Paseo ${permission.kind === "question" ? "回答" : "处理"}。`,
          }),
        );
      }
    })().catch((err) => logError("permission_requested notify failed", err));
  });

  server.on("agent.permission_resolved", async (event) => {
    const session = deps.session();
    if (!session) return;
    const scope = session.currentScope();
    if (!scope || scope.agentId !== event.agent.id) return;
    // host 不去重：先记终态，返回 false 说明已处理过，直接返回。
    if (!(await session.markPermissionDecided(event.requestId, "resolved_elsewhere"))) return;
    const location = approvalCards.get(event.requestId);
    approvalCards.delete(event.requestId);
    if (!location || !session.isCurrentScope(location.scope)) return;
    const agentTitle = event.agent.title ?? event.agent.id.slice(0, 8);
    void (async () => {
      await deps.feishu.updateCard(
        location.messageId,
        deps.cards.permissionResolved({ agentTitle, outcome: "resolved_elsewhere" }),
      );
    })().catch((err) => logError("permission_resolved card update failed", err));
  });

  server.on("agent.archived", async (event) => {
    const session = deps.session();
    if (!session) return;
    const scope = session.currentScope();
    if (!scope || scope.agentId !== event.agent.id) return;
    const title = event.agent.title ?? event.agent.id.slice(0, 8);
    void deps.feishu.sendText(scope.chatId, `${title} 已归档，当前绑定不可用，请重新选择会话。`)
      .catch((err) => logError("archived notify failed", err));
    // 不清除绑定：绑定归 session 层处理。
  });
}
