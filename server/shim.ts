// 宿主用 eval 执行插件 bundle，没有 CJS 的 __dirname。@larksuiteoapi/node-sdk 在模块顶层
// 读它来取自身版本号（lib/index.js 的 FALLBACK_UA），缺失会让整个插件加载失败。
// 必须是 index.server.ts 的第一个 import：esbuild 按 import 顺序初始化模块。
// 取不到版本时 SDK 自己回退到 "unknown"，只影响 User-Agent。
const g = globalThis as { __dirname?: string };
if (g.__dirname === undefined) g.__dirname = "/";
