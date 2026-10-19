import { AsyncLocalStorage } from "node:async_hooks";

type Fields = Record<string, string | number | boolean | null | undefined>;
const messageContext = new AsyncLocalStorage<string>();

export function withMessageLog<T>(messageId: string, run: () => T): T {
  return messageContext.run(messageId, run);
}

// 只输出诊断字段，不序列化 SDK/Axios 对象（其中可能含请求正文、请求头和凭证）。
function redact(text: string, sensitive: readonly string[] = []): string {
  for (const value of [process.env.FEISHU_APP_SECRET, process.env.PASEO_PASSWORD, ...sensitive]) {
    if (value) text = text.split(value).join("[redacted]");
  }
  return text
    .replace(/(?:https?|wss?):\/\/[^\s"<>]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return "[redacted-url]";
      }
    })
    .replace(/(Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/((?:app_secret|access_token|refresh_token|password)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[redacted]")
    .slice(0, 1500);
}

function write(level: "info" | "error", event: string, fields: Fields, sensitive: readonly string[] = []): void {
  const safe = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key, typeof value === "string" ? redact(value, sensitive) : value,
    ]),
  );
  const line = `[paseo-feishu] ${JSON.stringify({ event, sourceMessageId: messageContext.getStore(), ...safe })}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

export function logInfo(event: string, fields: Fields = {}): void {
  write("info", event, fields);
}

export function idHint(id: string | undefined): string | undefined {
  return id === undefined ? undefined : `…${id.slice(-6)}`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function scalar(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

export function logError(event: string, error: unknown, fields: Fields = {}, sensitive: readonly string[] = []): void {
  const err = record(error);
  const cause = record(err.cause);
  const response = record(err.response ?? cause.response);
  const data = record(response.data);
  const headers = record(response.headers);
  write("error", event, {
    ...fields,
    errorType: error instanceof Error ? error.name : typeof error,
    errorCode: scalar(err.code),
    errorMessage: scalar(err.message) ?? (typeof error === "string" ? error : undefined),
    causeCode: scalar(cause.code),
    causeMessage: scalar(cause.message),
    httpStatus: scalar(response.status),
    apiCode: scalar(data.code),
    apiMessage: scalar(data.msg),
    requestId: scalar(headers["x-tt-logid"] ?? data.log_id),
  }, sensitive);
}
