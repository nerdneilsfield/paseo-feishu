import { excerpt } from "./history.js";
import type {
  AgentStatus,
  AgentSummary,
  CardBuilders,
  FeishuCard,
} from "./contracts.js";

// 飞书 Card JSON Schema 2.0 卡片构造器。
// 只做展示（排序、分页、按钮 value 装配）；一切语义校验由 session 层完成。
// CardKit 真机渲染未验证，见最终报告。

const SCHEMA = "2.0";
const PAGE_SIZE = 5;

/** 审批卡按钮的去重 salt：同一请求重发新卡时按钮 value 不同，不撞 SDK 去重键。 */
let approvalSeq = 0;

const STATUS_TEXT: Record<AgentStatus, string> = {
  running: "运行中",
  idle: "空闲",
  error: "异常",
  closed: "已关闭",
  initializing: "启动中",
  unknown: "未知",
};

function md(content: string): Record<string, unknown> {
  return { tag: "markdown", content };
}

function button(
  content: string,
  value: Record<string, unknown>,
  type = "default",
): Record<string, unknown> {
  // Card JSON 2.0 回传按钮值的位置是 behaviors，不是 1.0 的顶层 value。
  // 顶层 value 不会出现在 card.action.trigger 里，按钮点了等于没带动作。
  return {
    tag: "button",
    text: { tag: "plain_text", content },
    type,
    behaviors: [{ type: "callback", value }],
  };
}

function actionRow(buttons: Array<Record<string, unknown>>): Record<string, unknown> {
  // 2.0 没有 action 容器；按钮放进 column_set，一行一个按钮。
  return {
    tag: "column_set",
    flex_mode: "none",
    columns: buttons.map((btn) => ({
      tag: "column",
      width: "auto",
      elements: [btn],
    })),
  };
}

function navigation(): Record<string, unknown> {
  return actionRow([
    button("选择会话", { action: "navigate", destination: "sessions" }),
    button("状态", { action: "navigate", destination: "status" }),
    button("历史", { action: "navigate", destination: "history" }),
    button("命令说明", { action: "navigate", destination: "commands" }),
  ]);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function formatTime(ts: number): string {
  if (ts <= 0) return "—";
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 当前绑定置顶，其余按 lastActivityAt 倒序、相同时间按 id 排序。 */
function sortAgents(agents: AgentSummary[], currentAgentId: string | null): AgentSummary[] {
  return [...agents].sort((a, b) => {
    const ac = a.id === currentAgentId ? 0 : 1;
    const bc = b.id === currentAgentId ? 0 : 1;
    if (ac !== bc) return ac - bc;
    if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function agentLine(a: AgentSummary): string {
  return `**${oneLine(a.title)}**\n${oneLine(a.provider)} · ${oneLine(a.cwdLabel)} · ${STATUS_TEXT[a.status]} · ${formatTime(a.lastActivityAt)}`;
}

export function createCardBuilders(): CardBuilders {
  return {
    reply(input) {
      return {
        schema: SCHEMA,
        header: { title: { tag: "plain_text", content: `Paseo · ${input.phase}` }, template: "grey" },
        body: { elements: [
          md(`**${oneLine(input.title).slice(0, 200)}** · ${input.phase} · 最近事件 ${formatTime(input.updatedAt)}`),
          ...(input.reason ? [md(`原因：${input.reason}`)] : []),
          md(input.text || "暂无公开助手内容"),
          ...(input.incomplete ? [md("进展不完整，请回 Paseo 核对完整内容。")] : []),
        ] },
      };
    },
    help({ commands }) {
      return {
        schema: SCHEMA,
        header: { title: { tag: "plain_text", content: commands ? "Paseo · 命令说明" : "Paseo · 控制台" }, template: "grey" },
        body: { elements: [
          md(commands ? "/help：打开控制台\n/sessions：选择会话\n/status：查看状态\n/history：最近历史\n/history more：更早历史\n绑定后普通文字会发送给当前 Agent。" : "/help 控制台 · /sessions 选择会话 · /status 状态\n/history 最近历史 · /history more 更早历史\n绑定后普通文字会发送给当前 Agent。"),
          navigation(),
        ] },
      };
    },
    history({ agent, messages, hasOlder }) {
      const heading = excerpt(agentLine(agent), 500);
      const elements = [md(heading)];
      for (const message of messages) {
        const label = `**${message.role === "user" ? "用户" : "助手"} · ${message.timestamp}**\n`;
        elements.push(md(label + message.text));
      }
      if (!messages.length) elements.push(md("本次扫描范围没有用户或助手消息。"));
      const value = { action: "history_page" };
      elements.push(actionRow([
        ...(hasOlder ? [button("更早", { latest: false, ...value })] : []),
        button("回到最新", { latest: true, ...value }),
      ]));
      elements.push(navigation());
      return { schema: SCHEMA, header: { title: { tag: "plain_text", content: "Paseo · 会话历史（摘录）" }, template: "grey" }, body: { elements } };
    },
    picker(input) {
      const { agents, page, pickerRevision, currentAgentId, connected } = input;
      const sorted = sortAgents(agents, currentAgentId);
      const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
      const safePage = Math.min(Math.max(0, page), totalPages - 1);
      const items = sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

      const elements: Array<Record<string, unknown>> = [];
      elements.push(
        md(connected ? `已连接 · ${agents.length} 个会话` : "⚠️ Paseo 未连接，操作不可用"),
      );
      if (currentAgentId !== null) {
        const cur = sorted.find((a) => a.id === currentAgentId);
        if (cur !== undefined) elements.push(md(`当前会话：${oneLine(cur.title)}`));
      }
      if (items.length === 0) {
        elements.push(md("目前没有可用的已有会话。请先在 Paseo 创建会话"));
      }
      for (const a of items) {
        const isCurrent = a.id === currentAgentId;
        elements.push(md(agentLine(a)));
        elements.push(
          actionRow([
            button(
              isCurrent ? "继续此会话" : "切换到此会话",
              { action: "select_agent", agentId: a.id, pickerRevision },
              "default",
            ),
          ]),
        );
      }
      const pager: Array<Record<string, unknown>> = [];
      if (safePage > 0) {
        pager.push(button("上一页", { action: "page_agents", page: safePage - 1, pickerRevision }));
      }
      if (safePage < totalPages - 1) {
        pager.push(button("下一页", { action: "page_agents", page: safePage + 1, pickerRevision }));
      }
      pager.push(button("刷新", { action: "refresh_agents", pickerRevision }));
      elements.push(actionRow(pager));
      elements.push(navigation());
      if (totalPages > 1) elements.push(md(`第 ${safePage + 1}/${totalPages} 页`));

      return {
        schema: SCHEMA,
        header: {
          title: { tag: "plain_text", content: "Paseo · 选择会话" },
          template: connected ? "grey" : "orange",
        },
        body: { elements },
      };
    },

    current(input) {
      const { agent } = input;
      return {
        schema: SCHEMA,
        header: {
          title: { tag: "plain_text", content: "Paseo · 当前会话" },
          template: "grey",
        },
        body: {
          elements: [
            md(`当前绑定（不代表任务完成）\n${agentLine(agent)}`),
            navigation(),
          ],
        },
      };
    },

    permission(input) {
      const { permission, agentTitle } = input;
      approvalSeq += 1;
      const cardRevision = approvalSeq;
      // 键顺序固定：requestId 必须落在 JSON 序列化后前 128 字符内，
      // 否则不同请求的审批按钮会撞 SDK 去重键。
      const approveValue = {
        action: "approve_permission",
        requestId: permission.requestId,
        agentId: permission.agentId,
        cardRevision,
      };
      const denyValue = {
        action: "deny_permission",
        requestId: permission.requestId,
        agentId: permission.agentId,
        cardRevision,
      };
      const shortId =
        permission.requestId.length > 12
          ? `…${permission.requestId.slice(-8)}`
          : permission.requestId;
      return {
        schema: SCHEMA,
        header: {
          title: { tag: "plain_text", content: "Paseo · 审批请求" },
          template: "orange",
        },
        body: {
          elements: [
            md(`**${oneLine(agentTitle)}** · ${oneLine(permission.title)}\n请求 ${shortId}`),
            // 只展示 summary：不带环境变量、完整输出或 Paseo 内部动作 ID。
            md(permission.summary),
            actionRow([
              button("允许", approveValue, "primary"),
              button("拒绝", denyValue, "danger"),
            ]),
          ],
        },
      };
    },

    permissionResolved(input) {
      const outcomeText =
        input.outcome === "allow"
          ? "已允许"
          : input.outcome === "deny"
            ? "已拒绝"
            : "已在 Paseo 处理";
      return {
        schema: SCHEMA,
        header: {
          title: { tag: "plain_text", content: "Paseo · 审批已处理" },
          template: "grey",
        },
        body: {
          elements: [md(`**${oneLine(input.agentTitle)}**\n${outcomeText}`)],
        },
      };
    },

    notice(input) {
      return {
        schema: SCHEMA,
        header: {
          title: { tag: "plain_text", content: input.title },
          template: "blue",
        },
        body: { elements: [md(input.text)] },
      };
    },
  };
}
