import { createPaseoClient } from "@getpaseo/client";
import type { PaseoAgent, PaseoClient } from "@getpaseo/client";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { logError, logInfo } from "./log.js";
import type {
  AgentSummary,
  ConnectablePaseoPort,
  PendingPermission,
  PermissionDecision,
  PluginConfig,
  SendResult,
} from "./contracts.js";

/** 权限摘要上限：只给操作人看个大概，不带完整命令与输出。 */
const PERMISSION_SUMMARY_LIMIT = 300;
const AGENTS_PAGE_LIMIT = 200;
/** 分页上限：游标不自进时，无限循环会把等待中的飞书 handler 一起拖住。 */
const AGENTS_PAGE_MAX = 20;

/** cwd 只保留末两级目录名，不暴露完整本机路径。 */
function cwdLabel(cwd: string): string {
  const parts = cwd.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return cwd || "/";
  return parts.slice(-2).join("/");
}

function toAgentSummary(agent: PaseoAgent): AgentSummary {
  const parsed = Date.parse(agent.updatedAt);
  return {
    id: agent.id,
    title: agent.title ?? `Agent ${agent.id.slice(0, 8)}`,
    provider: agent.provider,
    cwdLabel: cwdLabel(agent.cwd),
    status: agent.status,
    archived: agent.archivedAt != null,
    lastActivityAt: Number.isNaN(parsed) ? 0 : parsed,
  };
}

function toolActions(request: AgentPermissionRequest): { allow: string; deny: string } | null {
  const actions = request.actions;
  if (request.kind !== "tool" || actions?.length !== 2) return null;
  const allow = actions.find(a => a.behavior === "allow")?.id;
  const deny = actions.find(a => a.behavior === "deny")?.id;
  return allow && deny && allow !== deny ? { allow, deny } : null;
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
  const rawSummary =
    [request.title, request.description]
      .filter(Boolean)
      .join("\n") ||
    request.name ||
    request.kind;
  const summary = rawSummary.slice(0, PERMISSION_SUMMARY_LIMIT);
  return {
    requestId: request.id,
    agentId,
    kind,
    title: request.title ?? request.name,
    summary,
    mappable: toolActions(request) !== null,
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
      logInfo("paseo.connect.started");
      try {
        await client.connect();
        logInfo("paseo.connected", { status: client.getConnectionState().status });
      } catch (err) {
        // 只记录，不抛：contribute 里是 void 调用的，未处理 rejection 会打崩插件进程。
        // 日志里只放 url 与错误，不放密码。
        logError("paseo.connect.failed", err, {}, [config.paseoPassword ?? ""]);
      }
    },

    subscribeTimeline(agentId, handler) {
      ensureReady();
      return client.agents.ref(agentId).timeline.subscribe(handler);
    },

    async readTimeline(agentId, options) {
      ensureReady();
      return client.agents.ref(agentId).timeline.refetch(options);
    },

    async listAgents(): Promise<AgentSummary[]> {
      ensureReady();
      const out: AgentSummary[] = [];
      let cursor: string | undefined;
      let pages = 0;
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
        // 游标不前进或返回异常多页就不该继续转：调用方在飞书 handler 里等它。
        if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) break;
        if (page.pageInfo.nextCursor === cursor) break;
        if (++pages >= AGENTS_PAGE_MAX) break;
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
        return { ok: false, reason: "failed" };
      }
      const request = pending.find((r) => r.id === requestId);
      if (!request) return { ok: false, reason: "not_pending" };
      const actions = toolActions(request);
      if (!actions) return { ok: false, reason: "failed" };
      try {
        // SDK 的 respondToPermission 只把消息写进 socket 就返回，daemon 拒绝时不会抛。
        // 权威结果是随后 refresh 到的 pendingPermissions：请求还在就是没批准。
        await handle.respondToPermission({
          requestId,
          response: { behavior: decision, selectedActionId: actions[decision] },
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
      await client.close();
    },
  };
}
