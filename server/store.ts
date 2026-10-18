import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { emptyState, StoreCorruptError } from "./contracts.js";
import type { PersistedState, Store } from "./contracts.js";

// 各幂等记录的上限：保存前裁剪，只保留 at 最新的条目。
export const MAX_DELIVERIES = 500;
export const MAX_NOTIFIED = 500;
export const MAX_DECIDED = 500;

const bindingSchema = z.object({
  chatId: z.string(),
  openId: z.string(),
  agentId: z.string().nullable(),
  bindingRevision: z.number().int().nonnegative(),
  pickerMessageId: z.string().nullable(),
  pickerRevision: z.number().int().nonnegative(),
});

const deliverySchema = z.object({
  state: z.enum(["claimed", "accepted", "rejected", "unknown"]),
  at: z.number(),
});

const stateSchema = z.object({
  version: z.literal(1),
  binding: bindingSchema.nullable(),
  deliveries: z.record(z.string(), deliverySchema),
  notified: z.array(z.object({ key: z.string(), at: z.number() })),
  decidedPermissions: z.record(
    z.string(),
    z.object({
      decision: z.enum(["allow", "deny", "resolved_elsewhere"]),
      at: z.number(),
    }),
  ),
});

function takeNewestRecord<T extends { at: number }>(
  rec: Record<string, T>,
  max: number,
): Record<string, T> {
  const entries = Object.entries(rec).sort((a, b) => a[1].at - b[1].at);
  return Object.fromEntries(entries.slice(-max));
}

function trimState(state: PersistedState): PersistedState {
  return {
    version: 1,
    binding: state.binding,
    deliveries: takeNewestRecord(state.deliveries, MAX_DELIVERIES),
    notified: [...state.notified].sort((a, b) => a.at - b.at).slice(-MAX_NOTIFIED),
    decidedPermissions: takeNewestRecord(state.decidedPermissions, MAX_DECIDED),
  };
}

let tmpSeq = 0;

export function createFileStore(filePath: string): Store {
  return {
    async load(): Promise<PersistedState> {
      let raw: string;
      try {
        raw = await fs.readFile(filePath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return emptyState();
        throw err;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new StoreCorruptError(filePath, err);
      }
      const checked = stateSchema.safeParse(parsed);
      if (!checked.success) throw new StoreCorruptError(filePath, checked.error);
      return checked.data;
    },

    async save(state: PersistedState): Promise<void> {
      const data = JSON.stringify(trimState(state));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.${tmpSeq++}.tmp`;
      try {
        await fs.writeFile(tmp, data, "utf8");
        await fs.chmod(tmp, 0o600);
        const fh = await fs.open(tmp, "r");
        try {
          await fh.sync();
        } finally {
          await fh.close();
        }
        await fs.rename(tmp, filePath);
      } catch (err) {
        await fs.unlink(tmp).catch(() => {});
        throw err;
      }
    },
  };
}
