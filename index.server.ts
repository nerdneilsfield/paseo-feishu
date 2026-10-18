import type { PluginServerContext } from "@getpaseo/plugin/server";

// 骨架：集成由主 agent 在三个模块完成后装配。
export default function contribute(_server: PluginServerContext): () => void {
  return () => {};
}
