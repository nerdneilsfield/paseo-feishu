import type { PluginServerContext } from "@getpaseo/plugin/server";
import type {
  BindingScope,
  NotificationDeps,
  PendingPermission,
} from "./contracts.js";
import { excerpt } from "./history.js";
import { logError } from "./log.js";
import { toPendingPermission } from "./paseo.js";

/** 记住审批卡位置供 resolved 时更新；有上限，重启后丢失可接受（best-effort）。 */
const approvalCards = new Map<string, { chatId: string; messageId: string; scope: BindingScope }>();
const APPROVAL_CARDS_LIMIT = 500;

function rememberApprovalCard(
  requestId: string,
  location: { chatId: string; messageId: string; scope: BindingScope },
): void {
  if (approvalCards.size >= APPROVAL_CARDS_LIMIT) {
    const oldest = approvalCards.keys().next();
    if (!oldest.done) approvalCards.delete(oldest.value);
  }
  approvalCards.set(requestId, location);
}

function lastAssistantText(
  timeline: readonly { type: string; text?: string }[],
): string | null {
  // Hook timeline includes earlier conversation. Skip only trailing non-message
  // items, then retain the latest contiguous assistant group, stopping at a user/tool.
  let end = timeline.length - 1;
  while (end >= 0 && timeline[end]?.type !== "assistant_message" && timeline[end]?.type !== "user_message") end--;
  if (end < 0 || timeline[end]?.type !== "assistant_message") return null;
  const parts: string[] = [];
  for (let i = end; i >= 0; i--) {
    const item = timeline[i];
    if (!item || item.type !== "assistant_message" || typeof item.text !== "string") break;
    parts.push(item.text);
  }
  return parts.length ? excerpt(parts.reverse().join(""), 12000) : null;
}

export function registerNotifications(server: PluginServerContext, deps: NotificationDeps): void {
  server.on("agent.turn_ended", async (event) => {
    const session = deps.session();
    if (!session) return;
    if (session.currentAgentId() !== event.agent.id) return;
    const scope = session.currentScope();
    if (!scope || !event.turnId) return;
    const key = `${event.agent.id}:${event.turnId}`;
    const finish = session.liveReplies.seal(scope, event.turnId);
    if (!finish) return;
    if (!(await session.markNotified(key)) || !session.isCurrentScope(scope)) return;
    const title = event.agent.title ?? event.agent.id.slice(0, 8);
    const text = lastAssistantText(event.timeline) ?? "";
    const phase = event.outcome.kind === "completed" ? "已完成" : event.outcome.kind === "failed" ? "失败" : "已取消";
    const rawReason = event.outcome.kind === "failed" ? event.outcome.error.message : event.outcome.kind === "canceled" ? event.outcome.reason : null;
    // Take only the protocol string; never serialize diagnostics or unknown objects.
    const reason = typeof rawReason === "string" ? excerpt(rawReason.replace(/[\u0000-\u001f\u007f]/g, " ").trim(), 300).replace(/\s+/g, " ") : "";
    const reminder = `${title} · ${phase}${reason ? `：${reason}` : ""}`;
    void finish.finish({ title, phase, reason, updatedAt: Date.now(), text, incomplete: false }, reminder)
      .catch((err) => logError("turn_ended notify failed", err));
  });

  server.on("agent.permission_requested", async (event) => {
    const session = deps.session();
    if (!session) return;
    if (session.currentAgentId() !== event.agent.id) return;
    const chatId = session.currentChatId();
    if (!chatId) return;
    const scope = session.currentScope();
    if (!scope) return;
    const permission: PendingPermission = toPendingPermission(event.agent.id, event.request);
    session.liveReplies.waiting(scope, permission.kind === "question");
    if (!(await session.markNotified(`perm:${permission.requestId}`))) return;

    const agentTitle = event.agent.title ?? event.agent.id.slice(0, 8);
    void (async () => {
      if (!session.isCurrentScope(scope)) return;
      if (permission.mappable) {
        const messageId = await deps.feishu.sendCard(
          chatId,
          deps.cards.permission({ permission, agentTitle }),
        );
        if (session.isCurrentScope(scope)) rememberApprovalCard(permission.requestId, { chatId, messageId, scope });
      } else {
        // 无法映射成 allow/deny 的请求不生成二选一按钮，只提示回 Paseo 处理。
        await deps.feishu.sendCard(
          chatId,
          deps.cards.notice({
            title: `${agentTitle} · 需要审批`,
            text: `有一条权限请求（${permission.kind}）无法在飞书安全表达，请回 Paseo 处理。`,
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
    if (!location || !session.isCurrentScope(location.scope) || !session.isCurrentScope(scope)) return;
    const agentTitle = event.agent.title ?? event.agent.id.slice(0, 8);
    void (async () => {
      if (!session.isCurrentScope(scope)) return;
      await deps.feishu.updateCard(
        location.messageId,
        deps.cards.permissionResolved({ agentTitle, outcome: "resolved_elsewhere" }),
      );
    })().catch((err) => logError("permission_resolved card update failed", err));
  });

  server.on("agent.archived", async (event) => {
    const session = deps.session();
    if (!session) return;
    if (session.currentAgentId() !== event.agent.id) return;
    const chatId = session.currentChatId();
    if (!chatId) return;
    const scope = session.currentScope();
    if (!scope) return;
    const title = event.agent.title ?? event.agent.id.slice(0, 8);
    void (async () => {
      if (!session.isCurrentScope(scope)) return;
      await deps.feishu.sendText(
        chatId,
        `${title} 已归档，当前绑定不可用，请重新选择会话。`,
      );
    })().catch((err) => logError("archived notify failed", err));
    // 不清除绑定：绑定归 session 层处理。
  });
}
