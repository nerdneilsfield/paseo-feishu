# paseo-feishu

A Feishu (Lark) channel for **existing [Paseo](https://github.com/getpaseo/paseo) coding-agent sessions**.

**Status: design phase.** No working integration has been implemented or verified yet.

## What it does

Connect a Feishu enterprise-app bot to one existing Paseo daemon. In a private chat, select an existing agent from a card (for example, **KVMux · Relay 审阅**), send follow-up messages into the *same agent session*, receive completion notifications, and respond to supported permission requests.

The Feishu channel is a lightweight **remote client**, not a new coding-agent runtime.

## Documents

- [SPEC.md](./SPEC.md) — product behavior, scope, security constraints, and 16 acceptance scenarios (中文).
- [DESIGN.md](./DESIGN.md) — architecture, SDK interfaces, card/callback contract, concurrency, recovery, and pre-implementation checks (中文).

## Planned architecture

```text
Feishu private chat
       ↕
@larksuite/channel (WebSocket + CardKit)
       ↕
Paseo Server Plugin
       ↕
@getpaseo/client + Paseo lifecycle hooks
       ↕
Existing Paseo daemon / existing Agent ID
```

Planned technologies: **TypeScript, Node.js 22+, `@getpaseo/plugin`, `@getpaseo/client`, and `@larksuite/channel`**. The dependency versions must be validated against the installed Paseo daemon before implementation.

### v0.1 boundaries

- One daemon and one Feishu bot; **private chat only**.
- **Card-first selection** of existing agents, with direct text follow-ups.
- Completion / failure / cancellation notifications and supported allow/deny approvals.
- Local state for agent binding, idempotency, and best-effort notification recovery.
- No agent creation, worktree management, multi-host gateway, terminal emulation, full transcript mirroring, or independent harness.

## For coding agents

1. Read [SPEC.md](./SPEC.md) first, then [DESIGN.md](./DESIGN.md). Treat acceptance tests and non-goals as binding.
2. Validate the four SDK integration points in DESIGN §9 before expanding implementation.
3. Implement the smallest functioning v0.1; do not add functionality outside SPEC without a separately approved change.
4. Test the acceptance cases (A01–A16); distinguish mocked tests from actual Feishu + Paseo end-to-end verification.
5. Never commit application secrets, credentials, complete agent transcripts, or local runtime state.

## 中文

这是一个让**飞书直接接管并继续已有 Paseo Agent 会话**的单机插件项目。默认通过飞书卡片选择会话，不重新创建 Agent，不引入额外 Gateway。正式需求与实现设计请阅读 [SPEC.md](./SPEC.md) 和 [DESIGN.md](./DESIGN.md)。
