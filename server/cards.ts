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

/** 只有这两个阶段是在跑；其余阶段没有正文就是真的没有。 */
const IN_PROGRESS = new Set(["处理中", "正在使用工具"]);

/** 回复卡标题配色只表达「要不要你动手」，其余保持中性。 */
const PHASE_TEMPLATE: Record<string, string> = {
  "处理中": "blue",
  "正在使用工具": "blue",
  "等待授权": "orange",
  "等待回答（请回 Paseo）": "orange",
  "已完成": "green",
  "失败": "red",
  "已取消": "grey",
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
    width: "fill",
    behaviors: [{ type: "callback", value }],
  };
}

function actionRows(buttons: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push({
      tag: "column_set",
      flex_mode: "none",
      columns: buttons.slice(i, i + 2).map(btn => ({
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [btn],
      })),
    });
  }
  return rows;
}

type NavigationDestination = "sessions" | "status" | "history" | "help" | "commands";

/** 本地导航行。不挂当前卡自己的入口：点了只会再发一张同样的卡。命令说明卡以「帮助」返回。 */
function navigation(current: NavigationDestination): Array<Record<string, unknown>> {
  const entries: Array<[string, NavigationDestination]> = [
    ["选择会话", "sessions"],
    ["状态", "status"],
    ["历史", "history"],
    [current === "commands" ? "帮助" : "命令说明", current === "commands" ? "help" : "commands"],
  ];
  return actionRows(
    entries
      .filter(([, destination]) => destination !== current)
      .map(([label, destination]) => button(label, { action: "navigate", destination })),
  );
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * fork 出来的 agent 标题就是它的第一条用户消息，也就是整段 <chat-history-summary> 原文。
 * 那种标题不能直接当卡片标题：既不是给人看的，又长到占满一屏。
 */
const SYNTHETIC_TITLE = /<(chat-history-summary|system)[^>]*>/i;
const TITLE_LIMIT = 60;

export function displayTitle(raw: string | null | undefined, fallback: string): string {
  const text = oneLine(raw ?? "");
  if (!text) return fallback;
  if (SYNTHETIC_TITLE.test(text)) return fallback;
  return text.length > TITLE_LIMIT ? `${text.slice(0, TITLE_LIMIT)}…` : text;
}

function formatTime(ts: number): string {
  if (ts <= 0) return "—";
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 活动时间读相对值：判断「新不新」时不需要换算日期。 */
function formatRelative(ts: number, now: number): string {
  if (ts <= 0) return "—";
  const diff = Math.max(0, now - ts);
  if (diff < 10_000) return "刚刚";
  if (diff < 60_000) return `${Math.floor(diff / 1_000)} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
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

function agentLine(a: AgentSummary, now: number): string {
  const title = displayTitle(a.title, a.id.slice(0, 8));
  return `**${title}**\n${oneLine(a.provider)} · ${STATUS_TEXT[a.status]}\n目录：${oneLine(a.cwdLabel)}\n最近活动：${formatRelative(a.lastActivityAt, now)}`;
}

/** 选择卡的一行：标题加元数据。一行一条，免得每个会话占两屏。 */
function agentRow(a: AgentSummary, now: number): string {
  const meta = [oneLine(a.provider), STATUS_TEXT[a.status], oneLine(a.cwdLabel), formatRelative(a.lastActivityAt, now)];
  return `**${displayTitle(a.title, a.id.slice(0, 8))}**\n${meta.join(" · ")}`;
}

function splitRow(content: Record<string, unknown>, action: Record<string, unknown>): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "none",
    columns: [
      { tag: "column", width: "weighted", weight: 4, elements: [content] },
      { tag: "column", width: "weighted", weight: 1, elements: [action] },
    ],
  };
}

export function createCardBuilders(now: () => number = Date.now): CardBuilders {
  return {
    reply(input) {
      const busy = IN_PROGRESS.has(input.phase);
      const empty = busy ? "等待公开进展…" : "暂无公开助手内容";
      return {
        schema: SCHEMA,
        header: {
          title: { tag: "plain_text", content: `Paseo · ${input.phase}` },
          template: PHASE_TEMPLATE[input.phase] ?? "grey",
        },
        body: {
          elements: [
            // 身份行在前、正文在后：手机上一眼就知道这是哪个会话的哪一轮。
            md(`**${displayTitle(input.title, "当前会话")}**`),
            ...(input.reason ? [md(`原因：${input.reason}`)] : []),
            md(input.text || empty),
            ...(input.incomplete ? [md("进展不完整，请回 Paseo 核对完整内容。")] : []),
            // 时间放到末尾：它不决定用户下一步做什么，不该占第一屏。
            md(`最近事件：${formatRelative(input.updatedAt, now())}`),
          ],
        },
      };
    },
    help({ commands }) {
      return {
        schema: SCHEMA,
        header: { title: { tag: "plain_text", content: commands ? "Paseo · 命令说明" : "Paseo · 帮助" }, template: "grey" },
        body: { elements: [
          // 一个块里写成列表：每个命令单独成块会在段落间拉出多余间距。
          ...(commands ? [md([
            "`/help` 打开帮助",
            "`/sessions` 选择会话",
            "`/status` 查看状态",
            "`/history` 最近历史",
            "`/history more` 更早历史",
          ].join("\n"))] : []),
          md("选择下方操作。绑定后，普通文字会发送到当前会话。"),
          ...navigation(commands ? "commands" : "help"),
        ] },
      };
    },
    history({ agent, messages, hasOlder }) {
      const heading = excerpt(agentLine(agent, now()), 500);
      const elements = [md(heading)];
      for (const message of messages) {
        const label = `**${message.role === "user" ? "用户" : "助手"}** · ${formatTime(Date.parse(message.timestamp))}\n`;
        elements.push(md(label + message.text));
      }
      if (!messages.length) elements.push(md("本次扫描范围没有用户或助手消息。"));
      const value = { action: "history_page" };
      // 「更早」是主操作，放在第一个；没有更早时只留「回到最新」。
      elements.push(...actionRows([
        ...(hasOlder ? [button("更早", { latest: false, ...value }, "primary")] : []),
        button("回到最新", { latest: true, ...value }),
      ]));
      elements.push(...navigation("history"));
      return {
        schema: SCHEMA,
        header: { title: { tag: "plain_text", content: "Paseo · 会话历史（摘录）" }, template: "grey" },
        body: { elements },
      };
    },
    picker(input) {
      const { agents, page, pickerRevision, currentAgentId, connected } = input;
      const sorted = sortAgents(agents, currentAgentId);
      const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
      const safePage = Math.min(Math.max(0, page), totalPages - 1);
      const items = sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

      const elements: Array<Record<string, unknown>> = [];
      if (!connected) elements.push(md("⚠️ Paseo 未连接，操作不可用"));
      else if (agents.length > 0) elements.push(md(`${agents.length} 个会话`));
      if (items.length === 0 && connected) {
        elements.push(md("目前没有可用的已有会话。请先在 Paseo 创建会话。"));
      }
      for (const a of items) {
        const isCurrent = a.id === currentAgentId;
        const row = md(agentRow(a, now()));
        // 同一栅格：当前会话不给按钮（点了只会重发同一张卡），但右列保留占位，否则标题会错位。
        elements.push(
          isCurrent
            ? splitRow(row, md("当前"))
            : splitRow(row, button(
                "切换",
                { action: "select_agent", agentId: a.id, pickerRevision },
                "primary",
              )),
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
      // 页码只说明已经拿到的范围，放按钮上方一行，不占一块。
      if (totalPages > 1) elements.push(md(`第 ${safePage + 1}/${totalPages} 页`));
      elements.push(...actionRows(pager));
      elements.push(...navigation("sessions"));

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
            md(agentLine(agent, now())),
            md("后续消息将发送到此会话。"),
            ...navigation("status"),
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
            md(`**${displayTitle(agentTitle, "当前会话")}**`),
            // 只展示 summary：不带环境变量、完整输出或 Paseo 内部动作 ID。
            md(permission.summary),
            ...actionRows([
              // 拒绝是安全退出，不该用红色 danger；把强调留给真正要执行的那一边。
              button("允许本次", approveValue, "primary"),
              button("拒绝", denyValue),
            ]),
            // 请求 ID 是排错线索，不是决策信息，放最后。
            md(`请求 ${shortId}`),
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
          elements: [md(`**${displayTitle(input.agentTitle, "当前会话")}**\n${outcomeText}`)],
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
