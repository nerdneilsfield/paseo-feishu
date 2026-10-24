import { describe, expect, test } from "vitest";
import type { AgentSummary } from "../server/contracts.js";
import { excerpt } from "../server/history.js";
import { createCardBuilders, displayTitle } from "../server/cards.js";

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
    if (el["tag"] !== "column_set") continue;
    for (const col of el["columns"] as Array<Record<string, unknown>>) {
      for (const inner of col["elements"] as Array<Record<string, unknown>>) {
        if (inner["tag"] === "button") out.push(inner);
      }
    }
  }
  return out;
}

/** 飞书 2.0 回调值在 behaviors 里；按钮顶层 value 不会回到 card.action.trigger。 */
function callbackValue(button: Record<string, unknown>): unknown {
  const behaviors = button["behaviors"] as Array<Record<string, unknown>>;
  const callback = behaviors.find((b) => b["type"] === "callback");
  return callback?.["value"];
}

/** picker 把每条会话放进 column_set 的左侧列，这里一并收集，保持按文档顺序。 */
function collectMarkdown(card: Record<string, unknown>): string {
  const body = card["body"] as { elements: Array<Record<string, unknown>> };
  const out: string[] = [];
  const walk = (nodes: Array<Record<string, unknown>>): void => {
    for (const node of nodes) {
      if (node["tag"] === "markdown") out.push(node["content"] as string);
      else if (node["tag"] === "column_set") {
        for (const col of node["columns"] as Array<Record<string, unknown>>) {
          walk(col["elements"] as Array<Record<string, unknown>>);
        }
      }
    }
  };
  walk(body.elements);
  return out.join("\n");
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

    const current = builders.current({ agent: agent({ id: "a1" }) });
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
      (b) => (callbackValue(b) as { action: string }).action === "select_agent",
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
      (b) => (callbackValue(b) as { action: string }).action === "select_agent",
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
      (b) => (callbackValue(b) as { action: string }).action === "select_agent",
    );
    expect(selects).toHaveLength(1);
    expect(callbackValue(selects[0]!)).toMatchObject({
      action: "select_agent",
      agentId: "ax",
      pickerRevision: 7,
    });
  });

  test("2.0 按钮用 behaviors callback，没有 1.0 的 action 容器", () => {
    const card = builders.picker({
      agents: [agent({ id: "ax" })],
      page: 0,
      pickerRevision: 1,
      currentAgentId: null,
      connected: true,
    });
    const body = card["body"] as { elements: Array<Record<string, unknown>> };
    expect(body.elements.some((el) => el["tag"] === "action")).toBe(false);
    const btn = collectButtons(card)[0]!;
    expect(btn["tag"]).toBe("button");
    expect(btn["value"]).toBeUndefined();
    expect(callbackValue(btn)).toMatchObject({ action: "select_agent", agentId: "ax" });
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
      (b) => (callbackValue(b) as { action: string }).action === "approve_permission",
    );
    const deny = collectButtons(card).find(
      (b) => (callbackValue(b) as { action: string }).action === "deny_permission",
    );
    expect(approve).toBeDefined();
    expect(deny).toBeDefined();
    for (const btn of [approve, deny]) {
      const serialized = JSON.stringify(callbackValue(btn!));
      expect(serialized.slice(0, 128)).toContain(permInput.permission.requestId);
    }
  });

  test("不同请求生成不同 value（不撞 SDK 去重键）", () => {
    const c1 = builders.permission(permInput);
    const c2 = builders.permission(permInput);
    const v1 = JSON.stringify(
      callbackValue(
        collectButtons(c1).find(
          (b) => (callbackValue(b) as { action: string }).action === "approve_permission",
        )!,
      ),
    );
    const v2 = JSON.stringify(
      callbackValue(
        collectButtons(c2).find(
          (b) => (callbackValue(b) as { action: string }).action === "approve_permission",
        )!,
      ),
    );
    expect(v1).not.toBe(v2);
  });

  test("展示权限摘要", () => {
    const card = builders.permission({
      permission: { ...permInput.permission, summary: "仅展示这段摘要" },
      agentTitle: "我的会话",
    });
    expect(collectMarkdown(card)).toContain("仅展示这段摘要");
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


describe("local navigation cards", () => {
  test("help has four local navigation buttons and commands explain forwarding", () => {
    const help = builders.help({ commands: false });
    expect(collectButtons(help).map(callbackValue)).toEqual([
      { action: "navigate", destination: "sessions" },
      { action: "navigate", destination: "status" },
      { action: "navigate", destination: "history" },
      { action: "navigate", destination: "commands" },
    ]);
    const commands = collectMarkdown(builders.help({ commands: true }));
    for (const command of ["/help", "/sessions", "/status", "/history", "/history more"]) expect(commands).toContain(command);
    expect(commands).toContain("普通文字");
  });

  test("current binding and picker use neutral hierarchy and real state", () => {
    const current = builders.current({ agent: agent({ id: "a1", title: "Relay", cwdLabel: "work/relay", status: "running" }) });
    expect(collectMarkdown(current)).toContain("Relay");
    expect(collectMarkdown(current)).toContain("work/relay");
    expect(collectMarkdown(current)).toContain("运行中");
    expect(collectMarkdown(current)).toContain("后续消息将发送到此会话");
    expect(JSON.stringify(current)).not.toContain("bindingRevision");
    expect(current.header).toMatchObject({ template: "grey" });
    const picker = builders.picker({ agents: [agent({ id: "a1" })], page: 0, pickerRevision: 1, currentAgentId: "a1", connected: true });
    expect(collectButtons(picker).every((b) => b.type === "default")).toBe(true);
  });

  test("history retains all ten excerpts within the card text budget with explicit truncation", () => {
    const card = builders.history({ agent: agent({ id: "a1" }), hasOlder: true, messages: Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" as const : "user" as const, timestamp: "2026-10-19T10:00:00Z", text: excerpt("长".repeat(1400), 1000) })) });
    const md = collectMarkdown(card);
    expect(md.length).toBeLessThanOrEqual(12000);
    expect(md.match(/摘录已截断/g)).toHaveLength(10);
    expect(md.match(/10-19 \d{2}:\d{2}/g)).toHaveLength(10);
    expect(md).toContain("Paseo 查看完整内容");
    expect(collectButtons(card).map(callbackValue)).toEqual(expect.arrayContaining([
      { action: "history_page", latest: false },
      { action: "history_page", latest: true },
    ]));
  });
});

describe("reading hierarchy", () => {
  const NOW = Date.parse("2026-10-24T00:53:00Z");
  const at = createCardBuilders(() => NOW);
  const ago = (ms: number) => NOW - ms;

  test("reply puts identity and body before the timestamp", () => {
    const card = at.reply({
      title: "修复登录回调丢失",
      phase: "正在使用工具",
      updatedAt: ago(125_000),
      text: "已定位到登录回调。",
      incomplete: false,
    });
    const blocks = (card["body"] as { elements: Array<{ content: string }> }).elements.map((e) => e.content);
    expect(blocks[0]).toBe("**修复登录回调丢失**");
    expect(blocks[1]).toBe("已定位到登录回调。");
    expect(blocks.at(-1)).toBe("最近事件：2 分钟前");
  });

  test("reply header colour only flags states that need the user", () => {
    const template = (phase: string): unknown =>
      (at.reply({ title: "T", phase, updatedAt: NOW, text: "x", incomplete: false }) as {
        header: { template: string };
      }).header.template;
    expect(template("处理中")).toBe("blue");
    expect(template("等待授权")).toBe("orange");
    expect(template("等待回答（请回 Paseo）")).toBe("orange");
    expect(template("已完成")).toBe("green");
    expect(template("失败")).toBe("red");
    expect(template("没见过的阶段")).toBe("grey");
  });

  test("reply distinguishes waiting for first output from a genuinely empty result", () => {
    const blocks = (phase: string, text: string): string =>
      JSON.stringify(
        at.reply({ title: "T", phase, updatedAt: NOW, text, incomplete: false }),
      );
    expect(blocks("处理中", "")).toContain("等待公开进展");
    expect(blocks("已完成", "")).toContain("暂无公开助手内容");
  });

  test("picker shows one compact line per agent and only the current one lacks a switch button", () => {
    const card = at.picker({
      agents: [
        agent({ id: "a1", title: "甲", status: "running", cwdLabel: "a/b", lastActivityAt: ago(125_000) }),
        agent({ id: "a2", title: "乙", cwdLabel: "c/d", lastActivityAt: ago(60_000) }),
      ],
      page: 0,
      pickerRevision: 1,
      currentAgentId: "a1",
      connected: true,
    });
    const text = collectMarkdown(card);
    expect(text).toContain("codex · 运行中 · a/b · 2 分钟前");
    expect(text).toContain("codex · 空闲 · c/d · 1 分钟前");
    const selects = collectButtons(card).filter(
      (b) => (callbackValue(b) as { action: string }).action === "select_agent",
    );
    expect(selects).toHaveLength(1);
    expect(callbackValue(selects[0]!)).toMatchObject({ agentId: "a2" });
    expect((selects[0]!["text"] as { content: string }).content).toBe("切换");
  });

  test("person rows keep their button in the same column as the description", () => {
    const card = at.picker({
      agents: [agent({ id: "a1" }), agent({ id: "a2", lastActivityAt: 5 })],
      page: 0,
      pickerRevision: 1,
      currentAgentId: null,
      connected: true,
    });
    const body = card["body"] as { elements: Array<Record<string, unknown>> };
    // 会话行是「左列 markdown + 右列一个元素」，无论那个元素是按钮还是「当前」标记。
    const rows = body.elements.filter((el) => {
      if (el["tag"] !== "column_set") return false;
      const cols = el["columns"] as Array<{ elements: Array<Record<string, unknown>> }>;
      return cols.length === 2 && cols[0]?.elements[0]?.["tag"] === "markdown";
    });
    // 两个会话各一行，每行是「描述 + 按钮」，不是「描述」「按钮」两行。
    expect(rows).toHaveLength(2);
  });

  test("deny is not styled as a destructive action", () => {
    const card = at.permission({
      permission: { requestId: "r1", agentId: "a1", kind: "tool", title: "t", summary: "s", mappable: true },
      agentTitle: "会话",
    });
    const deny = collectButtons(card).find(
      (b) => (callbackValue(b) as { action: string }).action === "deny_permission",
    );
    expect(deny!["type"]).not.toBe("danger");
    const approve = collectButtons(card).find(
      (b) => (callbackValue(b) as { action: string }).action === "approve_permission",
    );
    expect((approve!["text"] as { content: string }).content).toBe("允许本次");
  });

  test("command reference stays one block so list lines do not gain paragraph spacing", () => {
    const card = at.help({ commands: true });
    const blocks = (card["body"] as { elements: Array<{ content: string }> }).elements.filter(
      (e) => typeof e.content === "string" && e.content.includes("/history more"),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.content.split("\n")).toHaveLength(5);
  });
});

describe("synthetic titles", () => {
  const FORKED = "<chat-history-summary> Chat history from a previous Paseo agent. Source agent: 你来接着搞";

  test("a forked agent's chat-history title is not shown as the session name", () => {
    const card = buildWithForkedTitle();
    const text = collectMarkdown(card);
    expect(text).not.toContain("chat-history-summary");
    expect(text).toContain("a1b2c3d4");
  });

  test("normal titles survive and long ones are shortened", () => {
    expect(displayTitle("修复登录回调丢失", "fb")).toBe("修复登录回调丢失");
    expect(displayTitle("", "fb")).toBe("fb");
    expect(displayTitle(null, "fb")).toBe("fb");
    expect(displayTitle("长".repeat(200), "fb")).toHaveLength(61);
  });

  function buildWithForkedTitle(): Record<string, unknown> {
    return createCardBuilders(() => 0).current({
      agent: {
        id: "a1b2c3d4-0000",
        title: FORKED,
        provider: "pi",
        cwdLabel: "oto/cpp",
        status: "idle",
        archived: false,
        lastActivityAt: 0,
      },
    });
  }
});
