import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { emptyState, StoreCorruptError } from "./contracts.js";
import type { PersistedState, Store } from "./contracts.js";

const RECORD_LIMIT = 500;

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

function takeNewestRecord<T>(
  rec: Record<string, T>,
): Record<string, T> {
  return Object.fromEntries(Object.entries(rec).slice(-RECORD_LIMIT));
}

function trimState(state: PersistedState): PersistedState {
  return {
    version: 1,
    binding: state.binding,
    deliveries: takeNewestRecord(state.deliveries),
    notified: state.notified.slice(-RECORD_LIMIT),
    decidedPermissions: takeNewestRecord(state.decidedPermissions),
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
        const fh = await fs.open(tmp, "w", 0o600);
        try {
          await fh.writeFile(data, "utf8");
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
