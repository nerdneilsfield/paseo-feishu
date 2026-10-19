import type { PaseoAgentTimelineHandle, PaseoAgentTimelineEvent, PaseoAgentTimelineSubscription } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";

export interface BindingScope {
  readonly generation: number;
  readonly agentId: string;
  readonly chatId: string;
}

export type TimelineReadOptions = NonNullable<Parameters<PaseoAgentTimelineHandle["refetch"]>[0]>;
export type TimelinePage = Awaited<ReturnType<PaseoAgentTimelineHandle["refetch"]>>;

export type TimelineEvent = PaseoAgentTimelineEvent;
export type TimelineSubscription = PaseoAgentTimelineSubscription;

export interface ReplyView {
  title: string;
  phase: string;
  reason?: string;
  updatedAt: number;
  text: string;
  incomplete: boolean;
}

export interface LiveFinish {
  finish(view: ReplyView, reminder: string): Promise<void>;
}

export interface LiveReplies {
  bind(scope: BindingScope | null): void;
  /** Failed observations retry only for explicit submissions, not startup completion. */
  ensureReady(scope: BindingScope, retryFailed?: boolean): Promise<boolean>;
  seal(scope: BindingScope, turnId: string | null): LiveFinish | null;
  waiting(scope: BindingScope, question: boolean): void;
  close(): void;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  timestamp: string;
  text: string;
}

export interface Binding {
  chatId: string;
  openId: string;
  agentId: string | null;
  /** 每次成功切换 +1，用于并发检查。 */
  bindingRevision: number;
  pickerMessageId: string | null;
  /** 每次发出新的选择卡 +1；旧版本卡片的点击一律拒绝。 */
  pickerRevision: number;
}

/** claimed: 已占位未发送；accepted: Paseo 已受理；rejected: Paseo 明确拒绝；unknown: 结果不确定，禁止自动重发。 */
export type DeliveryState = "claimed" | "accepted" | "rejected" | "unknown";

export interface NotifiedMarker {
  /** `${agentId}:${turnId}` 或权限请求的去重键。 */
  key: string;
  at: number;
}

/** 持久化的全部内容。不得包含 transcript、权限命令全文、密码、App Secret。 */
export interface PersistedState {
  version: 1;
  binding: Binding | null;
  /** messageId → 投递状态；有上限，超出时丢弃最旧的。 */
  deliveries: Record<string, { state: DeliveryState; at: number }>;
  /** 已发送过通知的幂等键；有上限。 */
  notified: NotifiedMarker[];
  /** 已处理过的审批 requestId → 终态；有上限。 */
  decidedPermissions: Record<string, { decision: "allow" | "deny" | "resolved_elsewhere"; at: number }>;
}

export function emptyState(): PersistedState {
  return { version: 1, binding: null, deliveries: {}, notified: [], decidedPermissions: {} };
}

export interface Store {
  /** 文件不存在 → emptyState()。文件损坏 → 抛 StoreCorruptError，不得静默覆盖。 */
  load(): Promise<PersistedState>;
  /** 临时文件写入 + rename，原子。 */
  save(state: PersistedState): Promise<void>;
}

export class StoreCorruptError extends Error {
  constructor(
    readonly path: string,
    cause?: unknown,
  ) {
    super(`state file is corrupt: ${path}`, { cause });
    this.name = "StoreCorruptError";
  }
}

// ───────── Paseo 端口 ─────────
// 只暴露本项目用到的操作；不暴露整个 PaseoApi，防止绕过 session 层直接动 Agent。
// 严禁在端口里出现 create / archive / detach / stop。

export type AgentStatus = "running" | "idle" | "error" | "closed" | "initializing" | "unknown";

export interface AgentSummary {
  id: string;
  title: string;
  provider: string;
  /** 已缩短的目录显示，不带用户名等敏感前缀。 */
  cwdLabel: string;
  status: AgentStatus;
  archived: boolean;
  /** epoch ms，用于排序。 */
  lastActivityAt: number;
}

/** 只有 kind==="tool" 且恰有一个 allow 与一个 deny 动作时 mappable 才为 true。 */
export interface PendingPermission {
  requestId: string;
  agentId: string;
  kind: "tool" | "plan" | "question" | "mode" | "other";
  title: string;
  /** 已安全截断的摘要，不含环境变量或完整命令输出。 */
  summary: string;
  mappable: boolean;
}

export type PermissionDecision = "allow" | "deny";

export type SendResult =
  | { ok: true }
  | { ok: false; reason: "not_connected" | "not_found" | "archived" | "rejected" }
  /** 请求已发出但结果不确定（超时/断线）。调用方必须标记 unknown 且不得自动重发。 */
  | { ok: false; reason: "unknown" };

export interface PaseoPort {
  /** client 当前是否已连通。未连通时所有操作应被调用方拒绝，而不是排队。 */
  isReady(): boolean;
  listAgents(): Promise<AgentSummary[]>;
  subscribeTimeline(agentId: string, handler: (event: TimelineEvent) => void): TimelineSubscription;
  readTimeline(agentId: string, options: TimelineReadOptions): Promise<TimelinePage>;
  /** 返回 null 表示不存在。内部必须先 refresh()。 */
  refreshAgent(agentId: string): Promise<AgentSummary | null>;
  send(agentId: string, text: string): Promise<SendResult>;
  respondToPermission(
    agentId: string,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<{ ok: true } | { ok: false; reason: "not_pending" | "not_connected" | "failed" }>;
  close(): Promise<void>;
}

// ───────── 飞书端口 ─────────
// 只表达本项目需要的发送与更新，不做通用 Channel Adapter。

export type FeishuCard = Record<string, unknown>;

export interface FeishuPort {
  sendText(chatId: string, text: string): Promise<void>;
  /** 返回新卡片的 messageId，供 pickerMessageId 使用。 */
  sendCard(chatId: string, card: FeishuCard): Promise<string>;
  updateCard(messageId: string, card: FeishuCard): Promise<void>;
}

// ───────── 卡片构造器（cards.ts 实现；session.ts / notifications.ts 注入使用，测试用 fake）─────────
// 所有按钮 value 只带指示性字段（action / agentId / requestId / revision），服务端必须重新校验。

export interface CardBuilders {
  reply(input: ReplyView): FeishuCard;
  help(input: { commands: boolean }): FeishuCard;
  history(input: { agent: AgentSummary; messages: HistoryMessage[]; hasOlder: boolean }): FeishuCard;
  picker(input: {
    agents: AgentSummary[];
    page: number;
    pickerRevision: number;
    currentAgentId: string | null;
    connected: boolean;
  }): FeishuCard;
  current(input: { agent: AgentSummary }): FeishuCard;
  /** 仅当 permission.mappable 为 true 时调用；否则调用 notice。 */
  permission(input: { permission: PendingPermission; agentTitle: string }): FeishuCard;
  permissionResolved(input: {
    agentTitle: string;
    outcome: "allow" | "deny" | "resolved_elsewhere";
  }): FeishuCard;
  notice(input: { title: string; text: string }): FeishuCard;
}

// ───────── 卡片动作（channel.ts 解析后交给 session.ts）─────────
// value 里的 agentId / requestId / revision 只是待校验的指示，不是信任凭据。

export type CardAction =
  | { action: "navigate"; destination: "sessions" | "status" | "history" | "help" | "commands" }
  | { action: "history_page"; latest: boolean }
  | { action: "select_agent"; agentId: string; pickerRevision: number }
  | { action: "refresh_agents"; pickerRevision: number }
  | { action: "page_agents"; page: number; pickerRevision: number }
  | { action: "approve_permission"; agentId: string; requestId: string; cardRevision?: number }
  | { action: "deny_permission"; agentId: string; requestId: string; cardRevision?: number };

/** channel 已完成鉴权、私聊及消息类型校验。 */
export interface IncomingText {
  messageId: string;
  chatId: string;
  text: string;
}

export interface IncomingCardAction {
  messageId: string;
  chatId: string;
  action: CardAction;
}

/** 卡片点击的同步响应：必须在 3 秒内由 channel.ts 返回，耗时工作放后台。 */
export type ToastType = "success" | "info" | "error" | "warning" | "loading";
// type 而非 interface：SDK 的 CardActionResponse 是 Record<string, unknown>，interface 没有索引签名，赋不过去。
export type CardResponse = { toast: { type: ToastType; content: string } };

// ───────── session 层对外接口（channel.ts / index.server.ts 调用）─────────

export interface SessionController {
  /** 必须快速返回，不得等待 Agent turn。回复通过 FeishuPort 发出。 */
  handleText(msg: IncomingText): Promise<void>;
  /** 同步给出即时 toast；耗时处理自行放后台，完成后用 FeishuPort.updateCard 写回。 */
  handleCardAction(evt: IncomingCardAction): Promise<CardResponse>;
  /** 供 notifications.ts 判断事件是否属于当前绑定。 */
  liveReplies: LiveReplies;
  /** Startup connection completion only; session remains the observation owner. */
  resumeObservation(): void;
  currentScope(): BindingScope | null;
  isCurrentScope(scope: BindingScope): boolean;
  /** 通知/审批幂等记录。返回 true 表示首次（应当发送），false 表示已处理过。 */
  markNotified(key: string): Promise<boolean>;
  markPermissionDecided(
    requestId: string,
    decision: "allow" | "deny" | "resolved_elsewhere",
  ): Promise<boolean>;
  /** 停止接收新事务并等待在途写盘完成。 */
  close(): Promise<void>;
}

export interface FeishuChannel {
  port: FeishuPort;
  /** 注册 message / cardAction 监听并 connect()。session 就绪后才会被调用。 */
  start(session: SessionController): Promise<void>;
  /** 注销监听并 disconnect()。必须幂等，重复调用不报错。 */
  stop(): Promise<void>;
}

export interface ConnectablePaseoPort extends PaseoPort {
  /** 发起连接。由 index.server.ts 以 void 调用，失败需内部记录且 isReady() 保持 false，不得抛出未处理的 rejection。 */
  connect(): Promise<void>;
}

export interface SessionDeps {
  ownerOpenId: string;
  store: Store;
  paseo: PaseoPort;
  feishu: FeishuPort;
  cards: CardBuilders;
  /** 测试注入时钟。 */
  now?: () => number;
}

export interface NotificationDeps {
  /** session 尚未就绪时返回 null，此时 hook 直接忽略事件。 */
  session: () => SessionController | null;
  feishu: FeishuPort;
  cards: CardBuilders;
}

// ───────── 配置（index.server.ts 读取并注入）─────────

export interface PluginConfig {
  feishuAppId: string;
  feishuAppSecret: string;
  /** 省略时为国内 Feishu；"lark" 为国际版；其余按完整 URL 处理。 */
  feishuDomain?: string;
  ownerOpenId: string;
  paseoUrl: string;
  paseoPassword?: string;
  stateFile: string;
}
