/**
 * 回环绑定地址与默认端口。
 *
 * 单独成一个**零依赖的叶子模块**，而不是留在 `server.ts` 里。
 *
 * 原因是可以量化的：`probe.ts` / `discovery.ts` 只需要这两个常量，从 `../server`
 * 取却会把 `express` 与 `compression` 一并拖进每一次 CLI 调用——实测每次多花
 * 40~80ms（裸 node 30ms → 带这两个包 70~110ms），而 `search`、`health`、`config`
 * 这些命令根本用不到 web 层。`dashboard` 早已为同一个理由改成懒加载。
 *
 * 让"两个整数"住在一个不背依赖的地方，比提醒后来者"记得懒加载"更可靠。
 */

/** 固定监听地址；刻意不做成可配置项（ADR §3.4 D1：面板只服务本机）。 */
export const DEFAULT_HOST = '127.0.0.1'

/** 默认端口。 */
export const DEFAULT_PORT = 8765
