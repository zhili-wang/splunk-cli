# AGENTS.md — Splunk CLI

> **修改本项目之前必须先读这份文件。** 它定义了所有贡献者都必须遵守的契约。如果某项改动与本文档冲突，请停下并把它作为架构决策提出，
> 而不是悄悄改变设计。

---

## 1. 项目目标

构建一套**安全、稳定、结构化、面向调用方**的 Splunk 日志读取方式，
使上层——Claude Code、Codex、MCP Server 等——能够通过同一份共享内核
查询和分析 Splunk。

本项目的职责被刻意收窄：

> **可靠地获取并结构化 Splunk 数据。**

对这些数据进行推理是上层调用方的职责，不是本项目的职责。

---

## 2. 不可协商的原则

1. **不使用第三方 Splunk 客户端库。** 直接对接 Splunk REST API。
   不得依赖任何封装库——只用 `undici` 这一层通用 HTTP 客户端。
2. **Phase 1 严格只读。**
3. 绝不修改 Splunk 配置。
4. 绝不删除数据。
5. 绝不创建或修改用户。
6. 绝不调用任意 Splunk 管理 API。
7. 每条命令都同时支持文本输出与 JSON 输出。
8. 提供给调用方的数据必须是结构化的，不能是散文。
9. 核心业务逻辑不得与 CLI 命令耦合。
10. 为未来的 MCP / 工具层保留稳定的 Service 层。
11. 所有网络请求必须有超时。
12. 所有搜索都必须在结果条数与时间范围上受限。
13. 凭据与 Token 绝不能出现在源码、日志、错误信息或测试中。
14. 任何输出都不得包含密码、`Authorization` 头、Session Token 或 Cookie。
15. 所有测试都必须能脱离真实 Splunk 环境运行。
16. 真实 Splunk 集成测试必须隔离且默认不执行。
17. 绝不为让测试通过而修改生产行为。

---

## 3. 架构（分层是强制约束）

```text
CLI          bin/splunk-cli.ts
 │
 ▼
Services     server/services/*         业务流程、结果整形
 │
 ▼
SplunkClient server/client/splunk.ts   REST API、搜索 Job、轮询
 │
 ▼
HttpClient   server/client/http.ts     HTTP、超时、TLS、认证、重试
 │
 ▼
Splunk REST API (HTTPS :8089)
```

规则：

* 依赖**只能向下**。Service 绝不导入 CLI 模块；Service 绝不导入 `undici`；
  Client 绝不知道 CLI 的存在。
* `SplunkClient` 绝不格式化输出，也绝不决定策略。
* Service 绝不构造 `undici` 请求，也绝不轮询原始 HTTP。
* CLI 绝不构造 SPL，除非该 SPL 由 Service 暴露的构造函数生成。

### 模块地图

| 层 | 路径 | 职责 |
| --- | --- | --- |
| CLI | `bin/splunk-cli.ts` | 参数解析、渲染、退出码 |
| Config | `server/config/settings.ts` | zod 校验、分层来源合并、脱敏 |
| Config dir | `server/config/paths.ts` | `~/.splunk-cli` 创建、模板、权限 |
| 错误体系 | `server/errors.ts` | 零依赖错误类型（各层共用，避免循环导入） |
| Services | `server/services/` | `search`、`stats`、`timeline`、`fields`、`alerts`、`health`、`base` |
| Client | `server/client/` | `http.ts`（传输）、`splunk.ts`（REST） |
| Models | `server/models/` | `search`、`result`、`alert`、`health` |
| Safety | `server/safety/` | `limits.ts`（策略）、`validator.ts`（SPL 校验） |
| Output | `server/output/` | `envelope.ts`（信封与退出码）、`table.ts`（文本表格） |
| 数字契约 | `server/format.ts` | `%g` 风格格式化；数字契约在此收敛，勿在别处另写一套 |
| 日志 | `server/logger.ts` | 零依赖 stderr 日志（模块名定宽），绝不打印凭据 |
| Web | `server/web/` | Express 路由、静态资源、SPA 兜底 |
| 前端 | `web/src/` | React 18 + Vite；只经 `/api` 与后端通信 |
| 国际化 | `web/src/locales/` | 文案目录（`zh-CN.json` 为事实来源）；`lib/i18n.ts` 给 `t()` 与语言 store |

### Web 层（`server/web/`）

`server/web/` 与 `bin/splunk-cli.ts` **平级**，都是 Service 层的调用方。它必须遵守：

* 绝不 import CLI 模块（依赖只能向下，Web 与 CLI 互不依赖）
* 绝不 import `undici`，绝不直接构造 Splunk REST 请求
* 绝不拼接 SPL —— 一切 SPL 由 Service 层或 `safety/validator.ts` 生成
* 响应必须原样返回 Service 模型的 `toPublicDict()`，不得构造平行格式（三个例外：
  `POST /api/overview` 的聚合外壳，其中三个子面板仍原样透传；`GET /api/version` 只回
  本地包元数据（`name` / `version`）；`POST /api/shutdown` 只回
  `{success, stopping, message}` —— 后两者都**不读 Splunk、不是 Splunk 数据的第二份视图**）
* 不新增写端点；告警的 enable / disable / delete / update 永不实现。
  这条管的是**绝不写 Splunk**。`POST /api/shutdown`（页面上的「停止服务」）不违反它：
  它不碰任何 Splunk 资源，关的是这个进程自己，走的是 `dashboard` 收到 SIGTERM 时
  **同一条** `RunningServer.close()`，因此也**不会绕过**下面的只读白名单。
  今后再加端点的判据是"它改不改 Splunk 状态"，不是"它是不是 POST"

本条约束有一个前提：**面板只服务回环地址**（`server/server.ts` 固定绑定 `127.0.0.1`，
不做成选项）。`/api/shutdown` 的防护就是这条 —— 非回环 `Origin` 在进入路由前已被
`originGuard` 403 掉，所以不需要额外令牌。**若将来有人把它反代到公网，这个前提即失效，
该端点必须补鉴权。**

前端构建产物与 API **同源**（由同一个 Express 应用提供 `dist/web`），因此不需要
CORS 规则，页面里也没有任何凭据。`dashboard` 是 CLI 对 Web 的全部认知。

### 国际化（`web/src/locales/`）

用户可见文案一律经 `t()` 取，**不得写在组件里**：

* 文案只存在 `src/locales/zh-CN.json`（事实来源）与 `en-US.json`。两者 key 集合与占位符
  必须完全一致，`src/locales/locales.test.ts` 会在 CI 里强制这条 —— 漏翻译是**测试失败**，
  不是线上冒出一个 `job.events`
* `MessageKey` 由中文目录递归推导，拼错的 key 是**编译错误**
* 复数写在同一个 key 下的 `one` / `other`，由 `Intl.PluralRules` 选形；`count` 只用于选形，
  要显示的数字用 `value`（用 `counted()` 一次拿齐两个）
* `lib/format.ts`、`lib/timeRange.ts`、`api/client.ts` 是纯模块，拿不到 React 上下文，
  它们经 `getLocale()` 读当前语言；需要固定语言时传 `locale` 参数
* 默认语言是中文，且**不跟随浏览器语言** —— 这是明确的产品决策，不是遗漏

---

## 4. 安全规则

### 只读白名单

仅允许以下端点：

```text
GET  /services/server/info
GET  /services/licenser/pools
POST /services/search/jobs                 （创建查询属于读取行为）
GET  /services/search/jobs/{sid}
GET  /services/search/jobs/{sid}/results
GET  /services/search/jobs/{sid}/messages
GET  /services/saved/searches
GET  /services/alerts/fired_alerts
```

始终禁止：

```text
DELETE / PUT / PATCH / HEAD
GET|POST /services/admin/*, /services/authentication/*, /services/authorization/*
GET|POST /services/configs/*, /services/data/*
         /services/apps/*, /services/cluster/*, /services/shcluster/*
         /services/deployment*, /services/search/jobs/export
```

新增任何端点都必须同时登记到 `server/safety/limits.ts` 的 `ALLOWED_ENDPOINTS`，
**并且**在 README 中说明其只读性。

### 密钥与配置目录

* 配置来源与优先级（高 → 低）：
  `SPLUNK_*` 环境变量 → `~/.splunk-cli/config.env` → 项目内 `./.env` → 内置默认值。
* 全局配置目录由 CLI 在首次运行时自动创建并写入模板
  （`server/config/paths.ts` 的 `ensureConfigDir()`），目录 `0700`、
  配置文件 `0600`。**已有配置绝不覆盖。**
* 目录里**只有 `config.env`**，不额外写说明文档。
* 目录位置可用 `SPLUNK_CONFIG_DIR` 覆盖（测试必须这样做，绝不能读写真实的 `~/.splunk-cli`）。
* 绝不提交凭据；`.env.example` 中只放占位符。
* `Settings.redacted()` 是渲染配置的唯一途径。
* 任何进入错误信息的远端字符串都必须先经 `sanitizeMessage()`。
* 任何日志级别都不得打印请求头、Cookie、Session Key 或密码。
* 不要把凭据放在命令行参数里，只用环境变量。

### TLS

* `SPLUNK_VERIFY_SSL` 默认 `true`。
* `false` 仅限开发环境对接自签名证书；它只跳过"证明对端身份"这一步，连接**始终加密**。
* 开启校验且证书非公共 CA 签发时，**必须同时配 `SPLUNK_CA_BUNDLE`**；CA 包要含**签发服务端
  证书的那个 CA**（只放叶子证书无效），且证书要带覆盖实际连接名字的 SAN（按 IP 连需
  `iPAddress` SAN，CN 不参与 IP 匹配）。
* 绝不硬编码 `verify: false`，绝不默认关闭校验。

### 安全上限

| 限制 | 环境变量 | 默认值 |
| --- | --- | --- |
| 单次请求最大结果数 | `SPLUNK_MAX_RESULTS` | `5000` |
| 搜索时间跨度上限 | `SPLUNK_MAX_TIME_RANGE` | `7d` |
| 搜索 Job 预算 | `SPLUNK_SEARCH_TIMEOUT` | `60s` |
| SPL 最大长度 | `SPLUNK_MAX_QUERY_LENGTH` | `10000` |

**绝不要静默改写用户参数。** 一律以 `SafetyLimitError` 加结构化信息拒绝。

`splunk-cli limits` 是这张表的可执行形式：它会一并打印上述上限/预算与运行参数
（`timeout`、`search_timeout`、`poll_interval`，其中 `search_timeout` 报 `max(search_timeout, timeout)`
的生效值）。改动其中任何一项，输出契约（`README.md`、`splunk-cli/USAGE.md`）与它的测试必须同步更新。

### SPL 安全

`server/safety/validator.ts` 是词法黑名单，**不是解析器**。它检查以管道分隔的命令位置，
拒绝所有写入或管理类命令（`delete`、`collect`、`mcollect`、`tscollect`、
`outputlookup`、`outputcsv`、`outputtext`、`rest`、`script`、`sendalert`、
`runshellscript`、`map` 等）。

原则：**拿不准就拒绝。** 误拒可接受，误放不可接受。

---

## 5. 错误体系与退出码

```text
SplunkError
├── ConfigurationError          退出码 2
├── SplunkAuthenticationError   退出码 3
├── SplunkConnectionError       退出码 4
├── SplunkQueryError            退出码 5
├── SplunkJobError              退出码 5
├── SplunkResultError           退出码 5
├── SafetyLimitError            退出码 6
└── SplunkTimeoutError          退出码 7
```

退出码：`0` 成功，`1` 一般/非预期错误，`2` 配置，`3` 认证，`4` 连接，
`5` 查询，`6` 安全限制，`7` 超时。

规则：

* 绝不静默吞掉异常。
* 绝不使用裸 `catch {}` 吞掉错误——要么处理，要么包成 `SplunkError` 重抛。
* 保留上下文：重抛时用 `{ cause: error }`，不要丢掉原始错误。
* 错误信息必须不含密钥，且足够稳定以便调用方做分支判断。

---

## 6. JSON 契约（稳定）

成功：

```json
{"success": true, "query": "...", "time_range": {"earliest": "-1h", "latest": "now"},
 "count": 2, "results": [{"_time": "...", "host": "api-01"}]}
```

失败：

```json
{"success": false, "error": {"type": "SplunkAuthenticationError", "message": "..."}}
```

* 字段名属于公开契约。任何改名都是破坏性变更，必须在 README 中明确标注。
* JSON 模式下绝不输出只有散文的错误。
* 绝不输出 `password`、`Authorization`、`token`、`session key`、`Cookie`。

---

## 7. 测试规则

* 单元测试不得依赖真实 Splunk。响应蓝本取自 `test/fixtures/splunk/*.json`
  （从真实实例抓取并自动脱敏），传输层用注入的 `fetch` 驱动；CLI 层用真实的
  本地 `node:http` 服务端到端验证。
* 必须覆盖场景：成功、认证失败、连接失败、超时、Job 失败、Job 超时、
  空结果、畸形结果。
* 集成测试放在 `test/integration/`，仅在 `RUN_SPLUNK_INTEGRATION_TESTS=1` 时执行；
  条件不满足时显示为 skipped，绝不 fail。
* 集成测试从环境变量读取凭据，绝不硬编码。
* 绝不放宽断言、绝不修改生产代码来让测试通过——要么修行为，要么修测试的预期。
* 覆盖率门槛是**分档**的（Q10），由 `scripts/check-coverage.mjs` 判定，见 README §9。
  不得为了让门禁通过而排除文件；确实要排除必须在配置里写明理由。
* 任何改动完成前必须通过：

```bash
npm run typecheck        # tsc --noEmit（strict + noUncheckedIndexedAccess）
npm test                 # 根 vitest（后端 + CLI）+ web/ vitest（前端）
npm run test:coverage    # 两份覆盖率报告 + 分档门禁
```

三者必须全绿。

---

## 8. 工具层设计

Service 层就是未来的工具面。以下签名必须保持稳定：

```ts
SearchService.search(query, { earliest, latest, limit })             // -> ResultSet
StatsService.stats(query, { by, function, earliest, latest, limit }) // -> StatsResult
TimelineService.timeline(query, { span, earliest, latest, limit })   // -> TimelineResult
FieldsService.fields(query, { earliest, latest, limit })             // -> FieldList
AlertsService.alerts({ count, includeSaved })                        // -> AlertList
HealthService.health({ includeLicense })                             // -> HealthReport
```

规划中的工具名：`splunk_search`、`splunk_stats`、`splunk_timeline`、
`splunk_fields`、`splunk_alerts`、`splunk_health`。

**MCP 层绝不能直接访问 HttpClient 或 `SplunkClient`**，它只包装 Service。

---

## 9. Phase 1 禁止事项

未经明确批准，不得加入以下任何内容：

* MCP Server
* AI/LLM 分析、RAG、Embedding、向量数据库
* 自动根因分析
* 告警自动修复
* 任何写入 Splunk 的路径
* 新的重量级依赖或框架

### 9.1 已批准的运行时依赖（白名单，新增须走同一流程）

以下依赖已明确批准，是当前唯一的运行时依赖；**新增任何一个都要先写成决策记录**，
不得以"顺手用一下"的方式引入。

| 依赖 | 用途 | 为什么它不算"绕过原则 1" |
| --- | --- | --- |
| `commander` | CLI 参数解析 | 与 Splunk 无关的通用 CLI 框架 |
| `express` | `dashboard` 的 HTTP 服务 | 通用 Web 框架，且只做薄适配 |
| `compression` | HTTP 响应压缩 | 通用中间件 |
| `undici` | HTTP 传输 | **Node 官方维护**的通用 HTTP 客户端，不是 Splunk 客户端库；原则 1 禁止的是 Splunk 封装库 |
| `zod` | 配置与请求体校验 | 通用 schema 校验；配置校验语义统一由它表达 |

开发期依赖不进分发物：`scripts/package.mjs` 会删掉整个 `devDependencies`。这里既包括后端工具链
（`typescript`、`vitest`、`esbuild`、`tsx`、`supertest`、`@vitest/coverage-v8`、`@types/*`），
也包括前端构建链与其运行时库（`vite`、`@vitejs/plugin-react`、`react` / `react-dom` /
`react-router-dom`、`echarts`、`tailwindcss` / `postcss` / `autoprefixer`、`jsdom`、
`@testing-library/*`）。前端库之所以能放 `devDependencies`，是因为它们在构建时已被 Vite
打进 `dist/web`——终端用户不需要再安装 React 或 ECharts。

### 9.2 已知的工具缺口（已决策接受）

* **没有 ESLint / Prettier / Biome。** 静态检查只保留 `tsc --noEmit`
  （`strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`）。
  这比 lint 弱，但没有引入第二套会各自演进的规则集；格式一致性靠评审。
* **覆盖率门槛不高。** 分档门槛见 README §9。它是下限而不是目标，
  别把"刚好过线"当作可以停止补测试的信号。
* **含 `@` 的时间表达式不受本地时间跨度上限约束（已决策接受）。**
  `check_time_range()` 在宽度不可静态计算时放行：`@d`/`@mon`/`@y` 这类对齐写法与全部
  日历整窗（`last-month` = `-1mon@mon → @mon`）都由 Splunk 按**搜索用户的时区**求值，
  而 CLI 只知道本机时区——本地硬算会在两者不一致或夏令时切换时误判，且会把默认 7d 下的
  日历预设全部变成退出码 6。**因此不要"顺手补上"这个校验**：真要收紧，必须先按
  `docs/adr/` 的流程记录策略变更（放大默认上限或加显式开关），再同步改 3.2 与已知限制。
  当前兜底是 Job 墙钟预算（`SPLUNK_SEARCH_TIMEOUT`）与 Splunk 侧 `limits.conf` / 角色配额。

---

## 10. Definition of Done

一项改动算完成，需同时满足：

* [ ] 遵守分层（无向上导入，无跨层调用）。
* [ ] `npm run typecheck`、`npm test`、`npm run test:coverage` 全部通过。
* [ ] 新行为有单元测试，包含其失败路径。
* [ ] 任何日志、错误或 JSON 输出都不可能泄漏密钥。
* [ ] JSON 输出字段未变；若变更，已在文档中说明。
* [ ] 任何新增查询路径都强制执行安全上限。
* [ ] 公共 API 有 TSDoc 注释；所有函数有类型注解，不出现 `any`（确需逃逸要写明理由）。
* [ ] 行为变化时，同步更新文档（`README.md`、本文件）。
* [ ] 涉及打包产物时，`npm run pack:verify` 仍然可复现。

---

## 11. 开发工作流

```bash
npm install

# 首次运行会创建并填充 ~/.splunk-cli/config.env：
npm run dev -- init
npm run dev -- config       # 确认配置（密钥脱敏）
# 也可以只用项目内 .env：
cp .env.example .env      # 然后编辑；绝不提交 .env

npm run typecheck
npm test
npm run test:coverage

# 直接跑 TS 源码（无需构建）：
npm run dev -- search "index=_internal | head 5"

# 需要真实 Splunk 时（默认不执行）：
RUN_SPLUNK_INTEGRATION_TESTS=1 npm run test:integration

# 对着真实实例逐条跑验收清单（19 项，产出可归档的报告）：
npm run verify:live

# 打包（含可复现性自证）：
npm run pack:verify
```

### 目录约定

```text
bin/       CLI 入口
server/    后端实现（分层见 §3）
web/       前端源码 + Vite / vitest 配置（依赖统一在根 package.json）
test/      后端与 CLI 测试、真实响应夹具、真机集成测试（默认 skip）
scripts/   构建 / 打包 / 覆盖率门禁 / 真机验收（构建工具，不是业务代码）
dist/      构建产物（不提交）
pack/      打包 staging（不提交）
releases/  版本化 zip（不提交）
splunk-cli/ 交付目录：指南文档提交 Git，安装包不提交
docs/adr/  架构决策记录（属于 docs/ 本地草稿区，不提交）
```

### Splunk 环境说明

* REST API：`https://<host>:8089`；Web UI：`http://<host>:8000`。
* 已在 Splunk Enterprise 8.0.2 上验证。
* 默认证书由 Splunk 自己的 CA 签发、且**没有 SAN 扩展**，因此对接默认安装时要么配置
  `SPLUNK_CA_BUNDLE`，要么在开发环境设 `SPLUNK_VERIFY_SSL=false`（见 §4 TLS）。
* 认证通过**真实业务端点**（`/services/server/info`）验证，
  而不是 `/services/auth/login`。
* 当真实 API 行为与假设不一致时：**不允许猜测。** 必须查看真实响应、
  调整 Client、补充测试，并记录兼容性说明。
