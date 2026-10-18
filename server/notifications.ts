import type { PluginServerContext } from "@getpaseo/plugin/server";
import type {
  NotificationDeps,
  PendingPermission,
} from "./contracts.js";
import { SUMMARY_LIMIT } from "./contracts.js";
import { toPendingPermission } from "./paseo.js";

/** 记住审批卡位置供 resolved 时更新；有上限，重启后丢失可接受（best-effort）。 */
const approvalCards = new Map<string, { chatId: string; messageId: string }>();
const APPROVAL_CARDS_LIMIT = 500;

function rememberApprovalCard(
  requestId: string,
  location: { chatId: string; messageId: string },
): void {
  if (approvalCards.size >= APPROVAL_CARDS_LIMIT) {
    const oldest = approvalCards.keys().next();
    if (!oldest.done) approvalCards.delete(oldest.value);
  }
  approvalCards.set(requestId, location);
}

function excerptKey(agentId: string, turnId: string | null, timelineLength: number): string {
  if (turnId) return `${agentId}:${turnId}`;
  // turnId 为 null 时用 timeline 长度代替：同一 agent 连续两个无 turnId 的 turn
  // 可能撞键（长度相同则后者被吞）。host 侧 turn_ended 通常带 turnId，这里只是兜底。
  return `${agentId}:${timelineLength}`;
}

function lastAssistantText(
  timeline: readonly { type: string; text?: string }[],
): string | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item && item.type === "assistant_message" && typeof item.text === "string") {
      return item.text.length > SUMMARY_LIMIT ? item.text.slice(0, SUMMARY_LIMIT) : item.text;
    }
  }
  return null;
}

function logError(msg: string, err: unknown): void {
  // 只记错误摘要；绝不记消息内容、权限命令全文、密码。
  console.error(`[paseo-feishu] ${msg}:`, err instanceof Error ? err.message : err);
}

export function registerNotifications(server: PluginServerContext, deps: NotificationDeps): void {
  server.on("agent.turn_ended", async (event) => {
    const session = deps.session();
    if (!session) return;
    if (session.currentAgentId() !== event.agent.id) return;
    const chatId = session.currentChatId();
    if (!chatId) return;
    const key = excerptKey(event.agent.id, event.turnId, event.timeline.length);
    if (!(await session.markNotified(key))) return;

    const title = event.agent.title ?? event.agent.id.slice(0, 8);
    const excerpt = lastAssistantText(event.timeline);
    let text: string;
    switch (event.outcome.kind) {
      case "completed":
        text = excerpt ? `${title} · 已完成\n${excerpt}` : `${title} · 已完成`;
        break;
      case "failed":
        text = excerpt
          ? `${title} · 失败：${event.outcome.error.message}\n${excerpt}`
          : `${title} · 失败：${event.outcome.error.message}`;
        break;
      case "canceled":
        text = `${title} · 已取消：${event.outcome.reason}`;
        break;
    }
    // hook 内不等待飞书网络：只做上面的轻量判断与幂等记录，发送放后台。
    void (async () => {
      await deps.feishu.sendText(chatId, text);
    })().catch((err) => logError("turn_ended notify failed", err));
  });

  server.on("agent.permission_requested", async (event) => {
    const session = deps.session();
    if (!session) return;
    if (session.currentAgentId() !== event.agent.id) return;
    const chatId = session.currentChatId();
    if (!chatId) return;
    const permission: PendingPermission = toPendingPermission(event.agent.id, event.request);
    if (!(await session.markNotified(`perm:${permission.requestId}`))) return;

    const agentTitle = event.agent.title ?? event.agent.id.slice(0, 8);
    void (async () => {
      if (permission.mappable) {
        const messageId = await deps.feishu.sendCard(
          chatId,
          deps.cards.permission({ permission, agentTitle }),
        );
        rememberApprovalCard(permission.requestId, { chatId, messageId });
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
    // host 不去重：先记终态，返回 false 说明已处理过，直接返回。
    if (!(await session.markPermissionDecided(event.requestId, "resolved_elsewhere"))) return;
    const location = approvalCards.get(event.requestId);
    approvalCards.delete(event.requestId);
    if (!location) return;
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
    if (session.currentAgentId() !== event.agent.id) return;
    const chatId = session.currentChatId();
    if (!chatId) return;
    const title = event.agent.title ?? event.agent.id.slice(0, 8);
    void (async () => {
      await deps.feishu.sendText(
        chatId,
        `${title} 已归档，当前绑定不可用，请重新选择会话。`,
      );
    })().catch((err) => logError("archived notify failed", err));
    // 不清除绑定：绑定归 session 层处理。
  });
}
