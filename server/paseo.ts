import { createPaseoClient } from "@getpaseo/client";
import type { PaseoAgent, PaseoClient } from "@getpaseo/client";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type {
  AgentStatus,
  AgentSummary,
  ConnectablePaseoPort,
  PendingPermission,
  PermissionDecision,
  PluginConfig,
  SendResult,
} from "./contracts.js";

/** close() 的等待上限：宿主关闭只给约 4 秒，端口必须在此之前让出。 */
const CLOSE_TIMEOUT_MS = 3000;
/** 权限摘要上限：只给操作人看个大概，不带完整命令与输出。 */
const PERMISSION_SUMMARY_LIMIT = 300;
const AGENTS_PAGE_LIMIT = 200;

/** cwd 只保留末两级目录名，不暴露完整本机路径。 */
function cwdLabel(cwd: string): string {
  const parts = cwd.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return cwd || "/";
  return parts.slice(-2).join("/");
}

function mapStatus(status: PaseoAgent["status"]): AgentStatus {
  switch (status) {
    case "running":
    case "idle":
    case "error":
    case "closed":
    case "initializing":
      return status;
    default:
      return "unknown";
  }
}

function toAgentSummary(agent: PaseoAgent): AgentSummary {
  const parsed = Date.parse(agent.updatedAt);
  return {
    id: agent.id,
    title: agent.title ?? `Agent ${agent.id.slice(0, 8)}`,
    provider: agent.provider,
    cwdLabel: cwdLabel(agent.cwd),
    status: mapStatus(agent.status),
    archived: agent.archivedAt != null,
    lastActivityAt: Number.isNaN(parsed) ? 0 : parsed,
  };
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * 把 Paseo 权限请求映射成飞书侧的待审批项。
 * summary 只取 title/description 并截断；绝不碰 input/detail/metadata，
 * 那些字段可能携带环境变量、密钥或完整命令输出。
 */
export function toPendingPermission(
  agentId: string,
  request: AgentPermissionRequest,
): PendingPermission {
  const kind: PendingPermission["kind"] =
    request.kind === "tool" ||
    request.kind === "plan" ||
    request.kind === "question" ||
    request.kind === "mode"
      ? request.kind
      : "other";
  const actions = request.actions ?? [];
  const allows = actions.filter((a) => a.behavior === "allow");
  const denies = actions.filter((a) => a.behavior === "deny");
  const allowActionId = allows[0]?.id;
  const denyActionId = denies[0]?.id;
  // 仅当 kind 为 tool、且恰有一个 allow 与一个 deny 动作时才可映射成二选一按钮。
  const mappable =
    request.kind === "tool" &&
    actions.length === 2 &&
    allows.length === 1 &&
    denies.length === 1 &&
    typeof allowActionId === "string" &&
    allowActionId.length > 0 &&
    typeof denyActionId === "string" &&
    denyActionId.length > 0;
  const rawSummary =
    [request.title, request.description]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join("\n") ||
    request.name ||
    request.kind;
  const summary = truncate(rawSummary, PERMISSION_SUMMARY_LIMIT);
  if (mappable && allowActionId && denyActionId) {
    return {
      requestId: request.id,
      agentId,
      kind,
      title: request.title ?? request.name,
      summary,
      mappable: true,
      allowActionId,
      denyActionId,
    };
  }
  return {
    requestId: request.id,
    agentId,
    kind,
    title: request.title ?? request.name,
    summary,
    mappable: false,
  };
}

function sendErrorReason(err: unknown): "rejected" | "unknown" {
  // daemon 明确拒绝（accepted=false）时 SDK 抛错信息里带 rejected；
  // 超时/断线等一律视为结果不确定，调用方标记 unknown 且绝不自动重试。
  const message = err instanceof Error ? err.message : String(err);
  return /reject/i.test(message) ? "rejected" : "unknown";
}

export function createPaseoPort(
  config: Pick<PluginConfig, "paseoUrl" | "paseoPassword">,
): ConnectablePaseoPort {
  const client: PaseoClient = createPaseoClient({
    url: config.paseoUrl,
    ...(config.paseoPassword ? { password: config.paseoPassword } : {}),
    // 用 SDK 自带的重连机制，不自己另起重连循环。
    reconnect: { enabled: true },
  });
  let closed = false;

  function isConnected(): boolean {
    return client.getConnectionState().status === "connected";
  }

  function ensureReady(): void {
    if (!isConnected()) {
      throw new Error("paseo not connected");
    }
  }

  return {
    isReady(): boolean {
      return isConnected();
    },

    async connect(): Promise<void> {
      if (closed) return;
      try {
        await client.connect();
      } catch (err) {
        // 只记录，不抛：contribute 里是 void 调用的，未处理 rejection 会打崩插件进程。
        // 日志里只放 url 与错误，不放密码。
        console.error(
          `[paseo-feishu] paseo connect failed url=${config.paseoUrl}:`,
          err instanceof Error ? err.message : err,
        );
      }
    },

    async listAgents(): Promise<AgentSummary[]> {
      ensureReady();
      const out: AgentSummary[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await client.agents.list(
          cursor
            ? { page: { limit: AGENTS_PAGE_LIMIT, cursor } }
            : { page: { limit: AGENTS_PAGE_LIMIT } },
        );
        for (const entry of page.entries) {
          if (entry.agent.archivedAt != null) continue;
          out.push(toAgentSummary(entry.agent));
        }
        if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) break;
        cursor = page.pageInfo.nextCursor;
      }
      return out;
    },

    async refreshAgent(agentId: string): Promise<AgentSummary | null> {
      ensureReady();
      const handle = client.agents.ref(agentId);
      const result = await handle.refresh();
      if (!result) return null;
      return toAgentSummary(result.agent);
    },

    async send(agentId: string, text: string): Promise<SendResult> {
      if (!isConnected()) return { ok: false, reason: "not_connected" };
      const handle = client.agents.ref(agentId);
      let snapshot: PaseoAgent;
      try {
        const result = await handle.refresh();
        if (!result) return { ok: false, reason: "not_found" };
        snapshot = result.agent;
      } catch {
        // refresh 失败说明连通性本身有问题，结果不确定。
        return { ok: false, reason: "unknown" };
      }
      if (snapshot.archivedAt != null) return { ok: false, reason: "archived" };
      try {
        // 只发一次：不确定错误也不重试，避免重复执行。
        await handle.send(text);
        return { ok: true };
      } catch (err) {
        console.error(
          `[paseo-feishu] send failed agent=${agentId}:`,
          err instanceof Error ? err.message : err,
        );
        return { ok: false, reason: sendErrorReason(err) };
      }
    },

    async getPendingPermissions(agentId: string): Promise<PendingPermission[]> {
      // 查询失败必须抛错，不能返回 []：调用方会把“没找到”当成“已在别处处理”并永久记录。
      if (!isConnected()) throw new Error("paseo not connected");
      const handle = client.agents.ref(agentId);
      // ref() 之后 pendingPermissions 为 null，必须先 refresh() 再读。
      const result = await handle.refresh();
      if (!result) return [];
      return (handle.pendingPermissions ?? []).map((request) =>
        toPendingPermission(agentId, request),
      );
    },

    async respondToPermission(
      agentId: string,
      requestId: string,
      decision: PermissionDecision,
    ): Promise<{ ok: true } | { ok: false; reason: "not_pending" | "not_connected" | "failed" }> {
      if (!isConnected()) return { ok: false, reason: "not_connected" };
      const handle = client.agents.ref(agentId);
      let pending: readonly AgentPermissionRequest[];
      try {
        const result = await handle.refresh();
        if (!result) return { ok: false, reason: "not_pending" };
        pending = handle.pendingPermissions ?? [];
      } catch {
        return { ok: false, reason: "not_pending" };
      }
      const request = pending.find((r) => r.id === requestId);
      if (!request) return { ok: false, reason: "not_pending" };
      const selectedActionId = (request.actions ?? []).find(
        (a) => a.behavior === decision,
      )?.id;
      try {
        // SDK 的 respondToPermission 只把消息写进 socket 就返回，daemon 拒绝时不会抛。
        // 权威结果是随后 refresh 到的 pendingPermissions：请求还在就是没批准。
        await handle.respondToPermission({
          requestId,
          response:
            decision === "allow"
              ? {
                  behavior: "allow" as const,
                  ...(selectedActionId ? { selectedActionId } : {}),
                }
              : {
                  behavior: "deny" as const,
                  ...(selectedActionId ? { selectedActionId } : {}),
                },
        });
        const after = await handle.refresh();
        if (!after) return { ok: false, reason: "failed" };
        const stillPending = (handle.pendingPermissions ?? []).some((r) => r.id === requestId);
        if (stillPending) return { ok: false, reason: "failed" };
        return { ok: true };
      } catch (err) {
        console.error(
          `[paseo-feishu] respondToPermission failed agent=${agentId} request=${requestId}:`,
          err instanceof Error ? err.message : err,
        );
        return { ok: false, reason: "failed" };
      }
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        // 宿主只给约 4 秒，client.close()  hanging 也不能拖住 cleanup。
        await Promise.race([
          client.close(),
          new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
        ]);
      } catch (err) {
        console.error(
          "[paseo-feishu] paseo close failed:",
          err instanceof Error ? err.message : err,
        );
      }
    },
  };
}
