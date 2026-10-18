import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { emptyState, StoreCorruptError } from "../server/contracts.js";
import type { PersistedState } from "../server/contracts.js";
import { createFileStore } from "../server/store.js";

async function tmpFile(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-store-"));
  return path.join(dir, name);
}

function bigState(n: number): PersistedState {
  const s = emptyState();
  for (let i = 0; i < n; i++) {
    s.deliveries[`m${i}`] = { state: "accepted", at: i };
    s.notified.push({ key: `k${i}`, at: i });
    s.decidedPermissions[`r${i}`] = { decision: "allow", at: i };
  }
  return s;
}

describe("createFileStore", () => {
  it("missing file loads as emptyState", async () => {
    const p = await tmpFile("missing.json");
    expect(await createFileStore(p).load()).toEqual(emptyState());
  });

  it("round-trips a saved state", async () => {
    const p = await tmpFile("state.json");
    const store = createFileStore(p);
    const s = emptyState();
    s.binding = {
      chatId: "chat1",
      openId: "ou_1",
      agentId: "agent-1",
      bindingRevision: 3,
      pickerMessageId: "mid-1",
      pickerRevision: 2,
    };
    s.deliveries["m1"] = { state: "accepted", at: 7 };
    await store.save(s);
    expect(await store.load()).toEqual(s);
  });

  it("throws StoreCorruptError on invalid JSON", async () => {
    const p = await tmpFile("bad.json");
    await fs.writeFile(p, "{not json", "utf8");
    await expect(createFileStore(p).load()).rejects.toBeInstanceOf(StoreCorruptError);
  });

  it("throws StoreCorruptError on schema-invalid content", async () => {
    const p = await tmpFile("schema.json");
    await fs.writeFile(p, JSON.stringify({ version: 2, binding: null }), "utf8");
    await expect(createFileStore(p).load()).rejects.toBeInstanceOf(StoreCorruptError);

    const p2 = await tmpFile("schema2.json");
    await fs.writeFile(
      p2,
      JSON.stringify({ ...emptyState(), deliveries: { m: { state: "bogus", at: 1 } } }),
      "utf8",
    );
    await expect(createFileStore(p2).load()).rejects.toBeInstanceOf(StoreCorruptError);
  });

  it("never silently treats corrupt content as empty", async () => {
    const p = await tmpFile("corrupt.json");
    await fs.writeFile(p, "[1,2,3]", "utf8");
    const store = createFileStore(p);
    await expect(store.load()).rejects.toBeInstanceOf(StoreCorruptError);
    // 失败的 load 不得覆盖原文件。
    expect(await fs.readFile(p, "utf8")).toBe("[1,2,3]");
  });

  it("keeps the old file intact when a save fails mid-write", async () => {
    const p = await tmpFile("atomic.json");
    const store = createFileStore(p);
    const first = emptyState();
    first.binding = {
      chatId: "c",
      openId: "o",
      agentId: "a",
      bindingRevision: 1,
      pickerMessageId: null,
      pickerRevision: 1,
    };
    await store.save(first);

    // 让目录不可写，使下一次 save 在写入/改名阶段失败。
    await fs.chmod(path.dirname(p), 0o555);
    try {
      await expect(
        store.save({ ...emptyState(), deliveries: { m: { state: "accepted", at: 1 } } }),
      ).rejects.toThrow();
    } finally {
      await fs.chmod(path.dirname(p), 0o755);
    }
    expect(await store.load()).toEqual(first);
    const leftovers = (await fs.readdir(path.dirname(p))).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("writes the state file with mode 0600", async () => {
    const p = await tmpFile("perm.json");
    await createFileStore(p).save(emptyState());
    const st = await fs.stat(p);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("trims deliveries / notified / decidedPermissions to newest 500", async () => {
    const p = await tmpFile("trim.json");
    const store = createFileStore(p);
    await store.save(bigState(600));
    const loaded = await store.load();
    expect(Object.keys(loaded.deliveries)).toHaveLength(500);
    expect(loaded.notified).toHaveLength(500);
    expect(Object.keys(loaded.decidedPermissions)).toHaveLength(500);
    // 保留的是最新的条目（at 100..599）。
    expect(loaded.deliveries["m0"]).toBeUndefined();
    expect(loaded.deliveries["m599"]?.state).toBe("accepted");
    expect(loaded.notified[0]?.key).toBe("k100");
    expect(loaded.decidedPermissions["r0"]).toBeUndefined();
    expect(loaded.decidedPermissions["r599"]?.decision).toBe("allow");
  });
});
