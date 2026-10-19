import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreatePaseoClient } = vi.hoisted(() => ({
  mockCreatePaseoClient: vi.fn(),
}));

vi.mock("@getpaseo/client", () => ({
  createPaseoClient: mockCreatePaseoClient,
}));

import { createPaseoPort, toPendingPermission } from "../server/paseo.js";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";

function fakePermissionRequest(
  overrides: Partial<AgentPermissionRequest> = {},
): AgentPermissionRequest {
  return {
    id: "req-1",
    provider: "codex",
    name: "exec",
    kind: "tool",
    title: "Run command",
    description: "ls -la",
    actions: [
      { id: "a-allow", label: "Allow", behavior: "allow" },
      { id: "a-deny", label: "Deny", behavior: "deny" },
    ],
    ...overrides,
  };
}

function fakeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    provider: "codex",
    cwd: "/home/user/projects/myproj",
    status: "idle",
    title: "My Agent",
    updatedAt: "2026-10-19T00:00:00.000Z",
    archivedAt: null,
    pendingPermissions: [],
    ...overrides,
  };
}

interface FakeHandle {
  timeline: { refetch: ReturnType<typeof vi.fn> };
  refresh: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  respondToPermission: ReturnType<typeof vi.fn>;
  pendingPermissions: unknown;
}

function setupClient(state: "connected" | "disconnected" = "connected") {
  const handles = new Map<string, FakeHandle>();
  const client = {
    agents: {
      list: vi.fn(),
      ref: vi.fn((id: string) => {
        let h = handles.get(id);
        if (!h) {
          h = {
            timeline: { refetch: vi.fn() },
            refresh: vi.fn(),
            send: vi.fn(),
            respondToPermission: vi.fn(),
            pendingPermissions: null,
          };
          handles.set(id, h);
        }
        return h;
      }),
    },
    connect: vi.fn(),
    close: vi.fn(),
    getConnectionState: vi.fn(() =>
      state === "connected" ? { status: "connected" as const } : { status: "disconnected" as const },
    ),
  };
  mockCreatePaseoClient.mockReturnValue(client);
  return { client, handles };
}

function refHandle(client: { agents: { ref: (id: string) => FakeHandle } }, id: string): FakeHandle {
  // ref() 懒创建 handle：先调 ref 拿到它，再配 mock。
  return client.agents.ref(id);
}

beforeEach(() => {
  mockCreatePaseoClient.mockReset();
});

describe("toPendingPermission", () => {
  it("tool + allow/deny 各一 → mappable", () => {
    const p = toPendingPermission("a1", fakePermissionRequest());
    expect(p.mappable).toBe(true);
    expect(p.allowActionId).toBe("a-allow");
    expect(p.denyActionId).toBe("a-deny");
  });

  it("plan/question/mode/other 一律 mappable=false", () => {
    for (const kind of ["plan", "question", "mode", "other"] as const) {
      const p = toPendingPermission("a1", fakePermissionRequest({ kind }));
      expect(p.mappable).toBe(false);
      expect(p.allowActionId).toBeUndefined();
      expect(p.denyActionId).toBeUndefined();
    }
  });

  it("缺 actions / 只有一个 / 两个都是 allow → mappable=false", () => {
    expect(
      toPendingPermission("a1", fakePermissionRequest({ actions: undefined })).mappable,
    ).toBe(false);
    expect(
      toPendingPermission(
        "a1",
        fakePermissionRequest({
          actions: [{ id: "x", label: "A", behavior: "allow" }],
        }),
      ).mappable,
    ).toBe(false);
    expect(
      toPendingPermission(
        "a1",
        fakePermissionRequest({
          actions: [
            { id: "x1", label: "A1", behavior: "allow" },
            { id: "x2", label: "A2", behavior: "allow" },
          ],
        }),
      ).mappable,
    ).toBe(false);
    expect(
      toPendingPermission(
        "a1",
        fakePermissionRequest({
          actions: [
            { id: "x1", label: "A1", behavior: "allow" },
            { id: "x2", label: "A2", behavior: "deny" },
            { id: "x3", label: "A3", behavior: "allow" },
          ],
        }),
      ).mappable,
    ).toBe(false);
  });

  it("summary 截断到 300 字符且只用 title/description", () => {
    const long = "x".repeat(500);
    const p = toPendingPermission(
      "a1",
      fakePermissionRequest({ title: long, description: long }),
    );
    expect(p.summary.length).toBeLessThanOrEqual(300);
    expect(p.summary).not.toContain("SECRET");
    const withSecretInput = fakePermissionRequest({
      input: { PASSWORD: "s3cret" } as never,
      detail: { command: "rm -rf /" } as never,
    });
    const q = toPendingPermission("a1", withSecretInput);
    expect(q.summary).not.toContain("s3cret");
    expect(q.summary).not.toContain("rm -rf");
  });
});

describe("createPaseoPort", () => {
  it("未就绪时 isReady false 且 send 返回 not_connected", async () => {
    setupClient("disconnected");
    const port = createPaseoPort({ paseoUrl: "ws://127.0.0.1:6767/ws" });
    expect(port.isReady()).toBe(false);
    expect(await port.send("a1", "hi")).toEqual({ ok: false, reason: "not_connected" });
  });

  it("connect 失败不抛，isReady 保持 false", async () => {
    const { client } = setupClient("disconnected");
    client.connect.mockRejectedValue(new Error("refused"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const port = createPaseoPort({ paseoUrl: "ws://127.0.0.1:6767/ws" });
      await port.connect();
      expect(port.isReady()).toBe(false);
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it("listAgents 过滤已归档且 cwd 只留末两级", async () => {
    const { client } = setupClient();
    client.agents.list.mockResolvedValue({
      entries: [
        { agent: fakeSnapshot({ id: "a1", cwd: "/home/u/work/projA" }) },
        { agent: fakeSnapshot({ id: "a2", archivedAt: "2026-01-01" }) },
      ],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    const port = createPaseoPort({ paseoUrl: "ws://x" });
    const agents = await port.listAgents();
    expect(agents.map((a) => a.id)).toEqual(["a1"]);
    expect(agents[0]!.cwdLabel).toBe("work/projA");
  });

  it("refreshAgent 先 refresh，null 表示不存在", async () => {
    const { client } = setupClient();
    const port = createPaseoPort({ paseoUrl: "ws://x" });
    refHandle(client, "a1").refresh.mockResolvedValue(null);
    expect(await port.refreshAgent("a1")).toBeNull();
    refHandle(client, "a2").refresh.mockResolvedValue({
      agent: fakeSnapshot({ id: "a2" }),
      project: null,
    });
    expect((await port.refreshAgent("a2"))?.id).toBe("a2");
  });

  it("send：不存在/已归档/unknown 不重试", async () => {
    const { client } = setupClient();
    const port = createPaseoPort({ paseoUrl: "ws://x" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      refHandle(client, "missing").refresh.mockResolvedValue(null);
      expect(await port.send("missing", "hi")).toEqual({ ok: false, reason: "not_found" });

      const old = refHandle(client, "old");
      old.refresh.mockResolvedValue({
        agent: fakeSnapshot({ id: "old", archivedAt: "2026-01-01" }),
        project: null,
      });
      expect(await port.send("old", "hi")).toEqual({ ok: false, reason: "archived" });
      expect(old.send).not.toHaveBeenCalled();

      const flaky = refHandle(client, "flaky");
      flaky.refresh.mockResolvedValue({ agent: fakeSnapshot({ id: "flaky" }), project: null });
      flaky.send.mockRejectedValue(new Error("connection timeout"));
      expect(await port.send("flaky", "hi")).toEqual({ ok: false, reason: "unknown" });
      expect(flaky.send).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
    }
  });

  it("getPendingPermissions 必须先 refresh 再读", async () => {
    const { client } = setupClient();
    const port = createPaseoPort({ paseoUrl: "ws://x" });
    const h = refHandle(client, "a1");
    const req = fakePermissionRequest();
    h.refresh.mockImplementation(async () => {
      h.pendingPermissions = [req];
      return { agent: fakeSnapshot(), project: null };
    });
    const perms = await port.getPendingPermissions("a1");
    expect(h.refresh).toHaveBeenCalled();
    expect(perms).toHaveLength(1);
    expect(perms[0]!.requestId).toBe("req-1");
  });

  it("getPendingPermissions 查询失败或未连接时抛错，不返回 []", async () => {
    const { client } = setupClient();
    const port = createPaseoPort({ paseoUrl: "ws://x" });
    const h = refHandle(client, "a1");
    h.refresh.mockRejectedValue(new Error("boom"));
    await expect(port.getPendingPermissions("a1")).rejects.toThrow("boom");
  });

  it("respondToPermission：不在 pending 返回 not_pending，用对应 behavior 的 actionId", async () => {
    const { client } = setupClient();
    const port = createPaseoPort({ paseoUrl: "ws://x" });
    const h = refHandle(client, "a1");
    // 前两次 refresh 是提交前核对；第三次是提交后的确认，请求已离开 pending。
    let refreshes = 0;
    h.refresh.mockImplementation(async () => {
      refreshes += 1;
      h.pendingPermissions = refreshes < 3 ? [fakePermissionRequest()] : [];
      return { agent: fakeSnapshot(), project: null };
    });
    expect(await port.respondToPermission("a1", "nope", "allow")).toEqual({
      ok: false,
      reason: "not_pending",
    });
    expect(h.respondToPermission).not.toHaveBeenCalled();

    expect(await port.respondToPermission("a1", "req-1", "deny")).toEqual({ ok: true });
    expect(h.respondToPermission).toHaveBeenCalledWith({
      requestId: "req-1",
      response: { behavior: "deny", selectedActionId: "a-deny" },
    });
  });

  it("respond 返回后请求仍在 pending 则记为 failed，不能当成已批准", async () => {
    const { client } = setupClient();
    const port = createPaseoPort({ paseoUrl: "ws://x" });
    const h = refHandle(client, "a1");
    const req = fakePermissionRequest();
    // SDK 的 respondToPermission 只把消息写进 socket 就返回；daemon 拒绝时不会抛。
    // 权威结果是随后 refresh 到的 pendingPermissions。
    h.refresh.mockImplementation(async () => {
      h.pendingPermissions = [req];
      return { agent: fakeSnapshot(), project: null };
    });
    expect(await port.respondToPermission("a1", "req-1", "allow")).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(h.refresh.mock.calls.length).toBeGreaterThan(1);
  });

  it("close 幂等且 hang 住也能返回", async () => {
    const { client } = setupClient();
    client.close.mockImplementation(() => new Promise(() => {}));
    const port = createPaseoPort({ paseoUrl: "ws://x" });
    const t0 = Date.now();
    await port.close();
    expect(Date.now() - t0).toBeLessThan(4000);
    await port.close();
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});


describe("timeline read port", () => {
  it("preserves SDK page identity and all failure/cursor metadata", async () => {
    const { client } = setupClient();
    const handle = refHandle(client, "a1");
    const page = { error: "read failed", reset: true, staleCursor: true, gap: true, epoch: "new", entries: [], startCursor: { epoch: "new", seq: 3 } };
    handle.timeline.refetch.mockResolvedValue(page);
    const options = { direction: "before" as const, cursor: { epoch: "old", seq: 50 }, limit: 50, projection: "projected" as const };
    const port = createPaseoPort({ paseoUrl: "ws://x" });
    expect(await port.readTimeline("a1", options)).toBe(page);
    expect(handle.timeline.refetch).toHaveBeenCalledWith(options);
    handle.timeline.refetch.mockRejectedValueOnce(new Error("rpc failure"));
    await expect(port.readTimeline("a1", options)).rejects.toThrow("rpc failure");
    expect(handle.send).not.toHaveBeenCalled();
  });

  it("does not enqueue a read while disconnected", async () => {
    const { client } = setupClient("disconnected");
    const port = createPaseoPort({ paseoUrl: "ws://x" });
    await expect(port.readTimeline("a1", { direction: "tail" })).rejects.toThrow("not connected");
    expect(client.agents.ref).not.toHaveBeenCalled();
  });
});
