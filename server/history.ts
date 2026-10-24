import type { BindingScope, HistoryMessage, PaseoPort, TimelinePage } from "./contracts.js";

/** Only displayable excerpts are retained; a fetch adds at most 50 to a <10-item buffer. */
export interface HistoryPosition {
  epoch: string | null;
  cursor: TimelinePage["startCursor"];
  hasOlder: boolean;
  boundary: number;
  buffer: HistoryMessage[];
}

export class HistoryReadError extends Error {
  constructor(message: string, readonly invalidCursor = false) {
    super(message);
  }
}

/** 单页读取上限。串行链上的等待必须有尽头，否则一次挂起的读取会担住后续每一次 /history。 */
const PAGE_TIMEOUT_MS = 10_000;

export function excerpt(text: string, limit: number): string {
  const marker = "\n[摘录已截断，请回 Paseo 查看完整内容]";
  return text.length > limit ? text.slice(0, limit - marker.length) + marker : text;
}

/** Builds a candidate; the caller commits it only after the card has been sent. */
export async function readHistory(
  paseo: PaseoPort,
  scope: BindingScope,
  previous: HistoryPosition | null,
  isCurrent: () => boolean,
): Promise<{ position: HistoryPosition; messages: HistoryMessage[] } | null> {
  const position: HistoryPosition = previous
    ? { ...previous, buffer: [...previous.buffer] }
    : { epoch: null, cursor: null, hasOlder: true, boundary: Infinity, buffer: [] };
  for (let count = 0; position.buffer.length < 10 && position.hasOlder && count < 5; count++) {
    // 调用方在串行链上等这个 promise：一页读不回来就不能让后续 /history 永远排队。
    const pending = paseo.readTimeline(scope.agentId, {
      direction: position.epoch === null ? "tail" : "before",
      ...(position.cursor ? { cursor: position.cursor } : {}),
      projection: "projected",
      limit: 50,
    });
    const TIMEOUT = Symbol("timeout");
    const page = await new Promise<TimelinePage | typeof TIMEOUT>((resolve, reject) => {
      const timer = setTimeout(() => resolve(TIMEOUT), PAGE_TIMEOUT_MS);
      pending.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error: unknown) => { clearTimeout(timer); reject(error); },
      );
    });
    if (page === TIMEOUT) throw new HistoryReadError("历史读取超时，请稍后重试。");
    if (!isCurrent()) return null;
    if (page.error) throw new HistoryReadError("历史读取失败，请稍后重试。");
    if (page.staleCursor || page.reset || (position.epoch !== null && position.epoch !== page.epoch)) {
      throw new HistoryReadError("历史游标已过期，请重新发送 /history。", true);
    }
    if (page.gap) throw new HistoryReadError("历史存在缺口，请回 Paseo 查看，并重新发送 /history。", true);
    const entries = [...page.entries].sort((a, b) => b.seqStart - a.seqStart || b.seqEnd - a.seqEnd);
    let boundary = position.boundary;
    for (const entry of entries) {
      // before may include its cursor. Sequence ranges, never text or message IDs, set the boundary.
      if (entry.seqEnd >= boundary) continue;
      boundary = entry.seqStart;
      const item = entry.item;
      if (item.type !== "user_message" && item.type !== "assistant_message") continue;
      position.buffer.push({
        role: item.type === "user_message" ? "user" : "assistant",
        timestamp: entry.timestamp,
        text: excerpt(item.text, 1000),
      });
    }
    if (page.hasOlder && (!page.startCursor || (position.cursor?.epoch === page.startCursor.epoch && position.cursor.seq === page.startCursor.seq))) {
      throw new HistoryReadError("历史分页未前进，请重新发送 /history。", true);
    }
    position.boundary = boundary;
    position.epoch = page.epoch;
    position.cursor = page.startCursor;
    position.hasOlder = page.hasOlder;
  }
  const messages = position.buffer.splice(0, 10).reverse();
  return { position, messages };
}
