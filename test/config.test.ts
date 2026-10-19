import { describe, expect, test } from "vitest";
import { readConfig } from "../index.server.js";

const base = { FEISHU_APP_ID: "cli_x", FEISHU_APP_SECRET: "s", FEISHU_OWNER_OPEN_ID: "ou_x" };

describe("readConfig 的 FEISHU_DOMAIN", () => {
  test.each([
    [undefined, undefined],
    ["", undefined],
    ["feishu", undefined],
    ["Lark", "https://open.larksuite.com"],
    ["https://feishu.example.com", "https://feishu.example.com"],
  ])("%s -> %s", (input, expected) => {
    const cfg = readConfig({ ...base, ...(input === undefined ? {} : { FEISHU_DOMAIN: input }) });
    expect(cfg.feishuDomain).toBe(expected);
  });
});
