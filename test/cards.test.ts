import { describe, expect, test } from "vitest";
import type { AgentSummary } from "../server/contracts.js";
import { createCardBuilders } from "../server/cards.js";

const builders = createCardBuilders();

function agent(over: Partial<AgentSummary> & { id: string }): AgentSummary {
  return {
    title: "测试会话",
    provider: "codex",
    cwdLabel: "proj",
    status: "idle",
    archived: false,
    lastActivityAt: 1000,
    ...over,
  };
}

function collectButtons(card: Record<string, unknown>): Array<Record<string, unknown>> {
  const body = card["body"] as { elements: Array<Record<string, unknown>> };
  const out: Array<Record<string, unknown>> = [];
  for (const el of body.elements) {
    if (el["tag"] === "action") out.push(...(el["actions"] as Array<Record<string, unknown>>));
  }
  return out;
}

function collectMarkdown(card: Record<string, unknown>): string {
  const body = card["body"] as { elements: Array<Record<string, unknown>> };
  return body.elements
    .filter((el) => el["tag"] === "markdown")
    .map((el) => el["content"] as string)
    .join("\n");
}

describe("schema 2.0", () => {
  test("全部卡片顶层 schema 为 2.0", () => {
    const picker = builders.picker({
      agents: [agent({ id: "a1" })],
      page: 0,
      pickerRevision: 1,
      currentAgentId: null,
      connected: true,
    });
    expect(picker["schema"]).toBe("2.0");

    const current = builders.current({ agent: agent({ id: "a1" }), pickerRevision: 1 });
    expect(current["schema"]).toBe("2.0");

    const perm = builders.permission({
      permission: {
        requestId: "r1",
        agentId: "a1",
        kind: "tool",
        title: "t",
        summary: "s",
        mappable: true,
      },
      agentTitle: "会话",
    });
    expect(perm["schema"]).toBe("2.0");

    const resolved = builders.permissionResolved({ agentTitle: "会话", outcome: "allow" });
    expect(resolved["schema"]).toBe("2.0");

    const notice = builders.notice({ title: "提示", text: "内容" });
    expect(notice["schema"]).toBe("2.0");
  });
});

describe("picker 排序与分页", () => {
  test("当前绑定置顶，其余按 lastActivityAt 倒序、相同时间按 id", () => {
    const agents = [
      agent({ id: "b", title: "B", lastActivityAt: 300 }),
      agent({ id: "a2", title: "A2", lastActivityAt: 200 }),
      agent({ id: "a1", title: "A1", lastActivityAt: 200 }),
      agent({ id: "old", title: "旧", lastActivityAt: 100 }),
    ];
    const card = builders.picker({
      agents,
      page: 0,
      pickerRevision: 1,
      currentAgentId: "old",
      connected: true,
    });
    const text = collectMarkdown(card);
    const idxOld = text.indexOf("旧");
    const idxB = text.indexOf("**B**");
    const idxA1 = text.indexOf("A1");
    const idxA2 = text.indexOf("A2");
    expect(idxOld).toBeGreaterThanOrEqual(0);
    expect(idxOld).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxA1);
    expect(idxA1).toBeLessThan(idxA2);
  });

  test("每页最多 5 条，翻页按钮按边界出现", () => {
    const agents = Array.from({ length: 7 }, (_, i) =>
      agent({ id: `a${i}`, title: `T${i}`, lastActivityAt: 1000 - i }),
    );
    const p0 = builders.picker({
      agents,
      page: 0,
      pickerRevision: 1,
      currentAgentId: null,
      connected: true,
    });
    const selects0 = collectButtons(p0).filter(
      (b) => (b["value"] as { action: string }).action === "select_agent",
    );
    expect(selects0).toHaveLength(5);
    const labels0 = collectButtons(p0).map((b) => (b["text"] as { content: string }).content);
    expect(labels0).toContain("下一页");
    expect(labels0).not.toContain("上一页");

    const p1 = builders.picker({
      agents,
      page: 1,
      pickerRevision: 1,
      currentAgentId: null,
      connected: true,
    });
    const selects1 = collectButtons(p1).filter(
      (b) => (b["value"] as { action: string }).action === "select_agent",
    );
    expect(selects1).toHaveLength(2);
    const labels1 = collectButtons(p1).map((b) => (b["text"] as { content: string }).content);
    expect(labels1).toContain("上一页");
    expect(labels1).not.toContain("下一页");
  });

  test("connected=false 显示离线", () => {
    const card = builders.picker({
      agents: [],
      page: 0,
      pickerRevision: 1,
      currentAgentId: null,
      connected: false,
    });
    expect(collectMarkdown(card)).toContain("未连接");
  });

  test("空列表提示去 Paseo 创建，不在飞书创建", () => {
    const card = builders.picker({
      agents: [],
      page: 0,
      pickerRevision: 1,
      currentAgentId: null,
      connected: true,
    });
    expect(collectMarkdown(card)).toContain("Paseo");
  });

  test("select 按钮携带 agentId 与 pickerRevision", () => {
    const card = builders.picker({
      agents: [agent({ id: "ax", title: "X", lastActivityAt: 5 })],
      page: 0,
      pickerRevision: 7,
      currentAgentId: null,
      connected: true,
    });
    const selects = collectButtons(card).filter(
      (b) => (b["value"] as { action: string }).action === "select_agent",
    );
    expect(selects).toHaveLength(1);
    expect(selects[0]?.["value"]).toMatchObject({
      action: "select_agent",
      agentId: "ax",
      pickerRevision: 7,
    });
  });
});

describe("审批卡", () => {
  const permInput = {
    permission: {
      requestId: "req-abc-123-xyz-000",
      agentId: "agent-1",
      kind: "tool" as const,
      title: "运行命令",
      summary: "仅展示这段摘要",
      mappable: true,
    },
    agentTitle: "我的会话",
  };

  test("requestId 落在 value 序列化后前 128 字符内", () => {
    const card = builders.permission(permInput);
    const approve = collectButtons(card).find(
      (b) => (b["value"] as { action: string }).action === "approve_permission",
    );
    const deny = collectButtons(card).find(
      (b) => (b["value"] as { action: string }).action === "deny_permission",
    );
    expect(approve).toBeDefined();
    expect(deny).toBeDefined();
    for (const btn of [approve, deny]) {
      const serialized = JSON.stringify(btn?.["value"]);
      expect(serialized.slice(0, 128)).toContain(permInput.permission.requestId);
    }
  });

  test("不同请求生成不同 value（不撞 SDK 去重键）", () => {
    const c1 = builders.permission(permInput);
    const c2 = builders.permission(permInput);
    const v1 = JSON.stringify(
      collectButtons(c1).find(
        (b) => (b["value"] as { action: string }).action === "approve_permission",
      )?.["value"],
    );
    const v2 = JSON.stringify(
      collectButtons(c2).find(
        (b) => (b["value"] as { action: string }).action === "approve_permission",
      )?.["value"],
    );
    expect(v1).not.toBe(v2);
  });

  test("只展示 summary，不含环境变量/完整输出", () => {
    const secret = "AKIA-SECRET-XYZ-DO-NOT-SHOW";
    const card = builders.permission({
      permission: { ...permInput.permission, summary: "仅展示这段摘要" },
      agentTitle: "我的会话",
    });
    expect(JSON.stringify(card)).not.toContain(secret);
    expect(collectMarkdown(card)).toContain("仅展示这段摘要");
    expect(JSON.stringify(card)).not.toContain("allowActionId");
  });

  test("标题文案为中文", () => {
    const card = builders.permission(permInput);
    const header = card["header"] as { title: { content: string } };
    expect(header.title.content).toContain("审批");
    const labels = collectButtons(card).map((b) => (b["text"] as { content: string }).content);
    expect(labels).toContain("允许");
    expect(labels).toContain("拒绝");
  });

  test("已处理卡区分 allow/deny/resolved_elsewhere", () => {
    const a = builders.permissionResolved({ agentTitle: "T", outcome: "allow" });
    const d = builders.permissionResolved({ agentTitle: "T", outcome: "deny" });
    const e = builders.permissionResolved({ agentTitle: "T", outcome: "resolved_elsewhere" });
    expect(collectMarkdown(a)).toContain("已允许");
    expect(collectMarkdown(d)).toContain("已拒绝");
    expect(collectMarkdown(e)).toContain("Paseo");
  });
});
