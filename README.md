# Splunk CLI

> **English README:** [README.en.md](https://github.com/zhili-wang/splunk-cli/blob/main/README.en.md)

一个**安全、稳定、结构化、面向调用方**的 Splunk 日志读取工具。

`splunk-cli` 既有顺手的命令行，也有稳定的 JSON 契约，两者共用同一套内核。
它的存在意义是：让 Claude Code、Codex 以及未来的 MCP Server
通过**同一份只读实现**去查询和分析 Splunk，而不是各自重复造一个 HTTP 客户端。

> **Phase 1 范围：可靠地获取并结构化 Splunk 数据。**
> 对这些数据进行推理是上层调用方的职责，不是本工具的职责。本阶段没有 LLM、没有 RAG、
> 没有 MCP Server，也没有任何写入路径。

**本项目不依赖 `cbrito/splunk-client`**（也不依赖任何其他 Splunk 客户端库），
而是直接通过 HTTPS 调用 Splunk 官方 REST API。

---

## 目录

1. [为什么需要它](#1-为什么需要它)
2. [架构](#2-架构)
3. [安装](#3-安装)
4. [配置](#4-配置)
5. [连接 Splunk](#5-连接-splunk)
6. [CLI 用法](#6-cli-用法)
7. [JSON 输出](#7-json-输出)
8. [安全限制](#8-安全限制)
9. [测试](#9-测试)
10. [调用方集成设计](#10-调用方集成设计)
11. [MCP 路线图](#11-mcp-路线图)
12. [已知限制](#12-已知限制)
13. [故障排查](#13-故障排查)

---

## 1. 为什么需要它

Splunk 的 REST API 很强大，但让调用方安全地使用它却很别扭：

* 搜索是异步的（创建 Job → 轮询 → 取结果 → 清理）；
* 响应被包在 Splunk 特有的信封里，不同端点的格式还不统一；
* 很容易误发一个覆盖 30 天的昂贵查询，或者误触一个会改配置的管理端点；
* 错误上报不一致，调用方无法可靠地根据失败类型做分支处理。

`splunk-cli` 只解决这四个问题，不做别的：

| 问题 | 解决方式 |
| --- | --- |
| 异步搜索的繁琐流程 | `SplunkClient` 统一负责创建 Job、轮询、分页取结果 |
| 响应格式不一致 | 用 zod 模型收敛成唯一稳定的公开 JSON 结构 |
| 误操作导致破坏或高开销 | 只读白名单 + 强制的条数/时间范围/查询长度限制 |
| 失败原因不透明 | 具名错误体系 + 稳定退出码 |

---

## 2. 架构

技术栈是 **TypeScript on Node.js 20+**。严格的单向分层，每一层只知道它下面的一层：

```text
                  ┌──────────────┐
                  │     CLI      │   bin/splunk-cli.ts     参数解析、渲染、退出码
                  └──────┬───────┘
                         │
                  ┌──────▼───────┐
                  │   Services   │   server/services/      业务流程、结果整形
                  │              │
                  │ Search       │   search.ts
                  │ Stats        │   stats.ts
                  │ Timeline     │   timeline.ts
                  │ Fields       │   fields.ts
                  │ Alerts       │   alerts.ts
                  │ Health       │   health.ts
                  └──────┬───────┘
                         │
                  ┌──────▼───────┐
                  │ SplunkClient │   server/client/splunk.ts   REST API、Job、轮询
                  └──────┬───────┘
                         │
                  ┌──────▼───────┐
                  │ HTTP Client  │   server/client/http.ts     timeout、TLS、认证、重试
                  └──────┬───────┘
                         │
                    HTTPS :8089
                         │
                  ┌──────▼───────┐
                  │    Splunk    │
                  └──────────────┘
```

横切模块：

| 模块 | 职责 |
| --- | --- |
| `server/config/settings.ts` | 分层配置来源合并、密钥脱敏 |
| `server/config/paths.ts` | 全局配置目录 `~/.splunk-cli` 的创建、模板与权限 |
| `server/errors.ts` | 错误体系（零依赖，所有层都可导入） |
| `server/models/` | 数据模型：`search`、`result`、`alert`、`health` |
| `server/safety/` | `limits.ts`（策略、白名单）与 `validator.ts`（SPL 校验） |
| `server/output/` | `envelope.ts`（信封 + 退出码）与 `table.ts`（文本表格） |
| `server/format.ts` | `%g` 风格的数字格式化（`2.592e+06`、`604800.0`）——数字契约在此收敛 |
| `server/logger.ts` | 零依赖 stderr 日志，任何级别都不打印凭据 |

**评审时强制执行的规则（详见 `AGENTS.md`）：** 依赖只能向下；CLI 绝不接触 HTTP；
Service 绝不构造 `undici` 请求；`SplunkClient` 绝不格式化输出、绝不决定策略。

### Web 面板（`server/web/`）

`server/web/` 与 `bin/splunk-cli.ts` **平级**，都是 Service 层的调用方。它必须遵守：

* 绝不 import CLI 模块（依赖只能向下，Web 与 CLI 互不依赖）
* 绝不 import `undici`，绝不直接构造 Splunk REST 请求
* 绝不拼接 SPL —— 一切 SPL 由 Service 层或 `safety/validator.ts` 生成
* 响应原样返回 Service 模型的公开结构（唯一例外是 `POST /api/overview` 的聚合外壳；
  其中三个子面板仍原样透传）
* 不新增写端点；告警的 enable / disable / delete / update 永不实现

前端（`web/`）是 React 18 + Vite，构建产物由同一个 Express 应用在**同源**下提供——
所以浏览器直接调 `/api/...`，既不需要 CORS，页面里也没有任何凭据。

---

## 3. 安装

要求 **Node.js 20+**。

### 从分发包安装（推荐）

```bash
npm install -g ./splunk-cli/splunk-cli.tgz
splunk-cli --help
splunk-cli --version
```

分发目录 `splunk-cli/` 里只有压缩后的单文件 bundle 与前端静态资源，不含可读源码，
也不含构建链。详见[分发](#分发)。

### 从源码构建

```bash
git clone <repository-url> splunk-cli
cd splunk-cli
npm install
npm run build                     # esbuild 打后端 bundle + Vite 打前端
node dist/bin/splunk-cli.mjs --help
```

前后端依赖统一在仓库根的 `package.json` 里，`web/` 没有自己的包清单——一次 `npm install` 即可装好两边。

开发时不必每次构建，用 `npm run dev` 直接跑 TypeScript 源码。

安装后首次运行任意命令时，会在 `~/.splunk-cli` 创建全局配置目录并写入模板
（见[配置](#4-配置)）。

### 可视化面板

```bash
splunk-cli dashboard
```

浏览器打开 `http://127.0.0.1:8765`。

源码检出（`git clone`）**不含**前端构建产物——`npm run build` 会顺带运行 Vite，
把前端输出到 `dist/web`，`dashboard` 从那里读取。两条路可选：

**开发服务器（最快）**：`dashboard` 只提供 API，页面交给 Vite：

```bash
npm run dev -- dashboard          # 另开一个终端
npm run dev:web                   # http://localhost:5173
```

Vite 的 `/api` 代理指向本机的 `dashboard`。

**生产构建**：在仓库根目录执行一条命令即可（内部先类型检查前端，再用 Vite 构建）：

```bash
npm run build
```

产出落在 `dist/web`，正好是 server 查找的位置。

两条路都没走时打开页面会得到 `FrontendNotBuilt`（HTTP 503，响应里带着该怎么做）。

---

## 4. 配置

安装并首次运行后，CLI 会自动创建全局配置目录 `~/.splunk-cli`，并写入
一份带注释的配置模板。**你只需要填一次凭据。**

```text
~/.splunk-cli/
└── config.env      SPLUNK_* 连接设置与安全上限（chmod 600）
```

目录权限为 `700`，配置文件为 `600`。目录里**只有** `config.env` 一个文件——
不额外放说明文档，免得和真正的配置抢注意力。

首次运行会给出一条提示（输出到 stderr，因此不会污染 `--json` 的 stdout）：

```text
splunk-cli: initialized configuration directory /Users/you/.splunk-cli
splunk-cli: fill in SPLUNK_URL, SPLUNK_USERNAME and SPLUNK_PASSWORD in
             /Users/you/.splunk-cli/config.env
splunk-cli: then run `splunk-cli health` to verify the connection
```

编辑该文件填好凭据，然后验证：

```bash
splunk-cli config     # 查看生效配置（密钥脱敏）
splunk-cli health     # 验证连通性、TLS 与凭据
```

也可以显式初始化（幂等，**绝不会覆盖已有配置**）：

```bash
splunk-cli init
splunk-cli init --json
splunk-cli --version   # 同时显示当前使用的配置目录
```

### 配置优先级

```text
环境变量  >  ~/.splunk-cli/config.env  >  ./.env  >  内置默认值
```

因此可以只针对单次运行临时覆盖某个值：

```bash
SPLUNK_MAX_RESULTS=100 splunk-cli search "index=main | head 5"
```

若要把配置放在别处（例如加密目录或 XDG 布局）：

```bash
export SPLUNK_CONFIG_DIR=/secure/path/splunk-cli
```

> 项目仓库中也保留了 `.env.example` 作为参考，本地开发时可以用
> `cp .env.example .env`。但常规使用推荐全局配置目录，避免在每个工作目录重复填写。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SPLUNK_CONFIG_DIR` | `~/.splunk-cli` | 全局配置目录位置 |
| `SPLUNK_URL` | *(必填)* | REST API 地址，例如 `https://host:8089` |
| `SPLUNK_USERNAME` | *(必填)* | 用于 Basic Auth 的 Splunk 用户 |
| `SPLUNK_PASSWORD` | *(必填)* | Splunk 密码 |
| `SPLUNK_VERIFY_SSL` | `true` | 校验 TLS 证书（默认开启）。对接默认自签证书时需配 `SPLUNK_CA_BUNDLE`，或开发环境设为 `false`，见 §5 TLS |
| `SPLUNK_CA_BUNDLE` | *(未设置)* | PEM 格式 CA 证书路径（可选） |
| `SPLUNK_TIMEOUT` | `30` | 单次 HTTP 请求超时（秒） |
| `SPLUNK_MAX_RESULTS` | `5000` | 单次请求结果条数硬上限 |
| `SPLUNK_MAX_TIME_RANGE` | `7d` | 搜索时间跨度硬上限 |
| `SPLUNK_POLL_INTERVAL` | `1` | 搜索 Job 轮询间隔（秒） |
| `SPLUNK_SEARCH_TIMEOUT` | `60` | 单个搜索 Job 的墙上时钟预算 |
| `SPLUNK_MAX_QUERY_LENGTH` | `10000` | SPL 最大长度 |
| `SPLUNK_MAX_RETRIES` | `3` | 传输层重试次数（4xx/认证失败绝不重试） |
| `SPLUNK_RETRY_BACKOFF` | `0.5` | 指数退避基数（秒） |
| `SPLUNK_TRUST_ENV` | `false` | 是否使用代理环境变量 / 系统代理设置 |

任何时候都可以查看生效配置，**密钥始终被脱敏**：

```bash
splunk-cli config           # 只显示 `password  <set>` / `<unset>`，绝不显示明文
splunk-cli config --json
splunk-cli config --check   # 必填项缺失时以退出码 2 结束
splunk-cli limits           # 生效中的安全上限与 Job 运行预算
```

> **关于代理。** `SPLUNK_TRUST_ENV` 默认为 `false` 是刻意设计。Splunk 通常位于内网，
> 若静默地把它的管理 API 走开发机的系统代理，只会得到令人困惑的网关错误。
> 只有确实需要经代理访问 Splunk 时才设为 `true`。

---

## 5. 连接 Splunk

请使用**管理端口**，通常是 `8089`——不是 Web UI 的 `8000`：

```bash
export SPLUNK_HOST="203.0.113.10"
export SPLUNK_PORT="8089"
export SPLUNK_USERNAME="splunk_user"
export SPLUNK_PASSWORD="..."            # 建议写进 .env，而不是 shell 历史
export SPLUNK_VERIFY_SSL="false"        # 模板默认值；连接仍加密，仅跳过身份校验（见 §5 TLS）
```

然后：

```bash
splunk-cli health
```

### TLS

**默认开启校验**（`SPLUNK_VERIFY_SSL=true`）。连接**始终是加密的**，这个开关只决定要不要
额外"证明对端身份"。

Splunk Enterprise 自带自签名证书（`SplunkServerDefaultCert`），由 Splunk 自己的 CA 签发、
且**没有 SAN 扩展**，所以在默认安装上校验一定失败。两种做法：

```bash
# 推荐：信任签发服务端证书的 CA（要放整条链，只放叶子无效）
export SPLUNK_VERIFY_SSL=true
export SPLUNK_CA_BUNDLE=/path/to/splunk-ca.pem

# 仅开发环境：跳过身份校验
export SPLUNK_VERIFY_SSL=false
```

配 CA 时有两个前提：CA 包要含**签发服务端证书的那个 CA**；证书要带覆盖**实际连接名字**的
SAN——按 IP 连接需要 `iPAddress` SAN，CN 永远不参与 IP 匹配。Splunk 默认证书没有 SAN，
所以按 IP 连接时配 CA 也无法通过校验。

### 认证

认证是拿**真实业务端点** `GET /services/server/info` 配合 Basic Auth 验证的，
而不是 `/services/auth/login`。因此一次成功的 `splunk-cli health`
就同时证明了连通性、TLS 和凭据三者都正常。

---

## 6. CLI 用法

所有命令都接受 `--json`（`-j`）与 `--verbose`（`-v`），且放在子命令前后都可以。

### `health`

```bash
splunk-cli health
splunk-cli health --json
splunk-cli health --no-license       # 跳过 License Pool 查询
```

```text
connection      ok
authentication  ok
health          green
version         8.0.2
server_name     splunk-dev-01
build           a7f645ddaf91
license_state   OK
license_pools   1
latency_ms      58.9
```

### `search`

```bash
splunk-cli search "index=app level=ERROR"
splunk-cli search "index=app level=ERROR" --earliest=-1h --latest=now --limit=100 --json
splunk-cli search "index=app level=ERROR" --range last-month      # 上月整月
splunk-cli search "index=_internal | head 10"
```

文本输出的摘要行会带上 Job **实际执行**的时间窗（`@mon`、`last-month` 这类表达式落到哪两个
瞬间，只有服务端知道）与耗时；没有命中时同样会报窗口。`--range`、`--earliest`、`--latest`
在 `stats` / `timeline` / `fields` 上含义完全相同。完整的时间写法与名字表见
[`splunk-cli/USAGE.md`](splunk-cli/USAGE.md) §3.2。

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `--earliest`, `-e` | `-1h` | 起始时间：相对偏移（`-30m`、`-7d`、`-1mon`、`-1y`）、对齐（`@d`、`@w0`、`@mon`、`@y`）、两者组合（`-7d@w0`）、具名（`now`、`today`、`yesterday`、`week`、`month`、`year`）、ISO-8601、epoch |
| `--latest`, `-l` | `now` | 结束时间，取值同上 |
| `--range`, `-r` | — | 一次给出**整个窗口**：`today`、`yesterday`、`this-week`、`last-week`、`this-month`、`last-month`、`this-year`、`last-year`，或时长（`7d` → `-7d → now`）。与 `-e`/`-l` 同时出现会被拒绝 |
| `--limit`, `-n` | `5000` | 最大结果条数（超过 `SPLUNK_MAX_RESULTS` 直接拒绝） |
| `--timeout` | `60` | 搜索 Job 预算（秒） |
| `--json`, `-j` | 关闭 | 输出稳定的 JSON 信封 |

### `stats`

```bash
splunk-cli stats "index=app level=ERROR" --by service
splunk-cli stats "index=app level=ERROR" --by service,host --function dc --limit 20 --json
```

只使用经过校验的标识符生成安全 SPL：

```spl
index=app level=ERROR | stats count by service | sort - count | head 5000
```

`--function` 支持 `count`、`dc`、`sum`、`avg`、`min`、`max`；最多允许 4 个分组字段。

### `timeline`

```bash
splunk-cli timeline "index=app level=ERROR" --span 5m --earliest=-6h
splunk-cli timeline "index=app" --span 1m --json
```

```text
span=5m  total=1240
▁▂▃▅▇█▇▅▃▂▁▂▄▆█▆▄▂▁

time                            count
2026-09-14T08:30:00.000+00:00   12
2026-09-14T08:35:00.000+00:00   38
```

### `fields`

```bash
splunk-cli fields "index=app"
splunk-cli fields "index=app" --details --json
```

为调用方提供的字段发现能力：在编写更多 SPL 之前先了解索引的字段结构。
实现方式为 `| fieldsummary`。

### `alerts`

```bash
splunk-cli alerts
splunk-cli alerts --saved --json
```

**只读。** 启用、停用、修改、删除告警均未实现，且被端点白名单拦截。

### `dashboard`

```bash
splunk-cli dashboard
splunk-cli dashboard --port 9000
```

在本机启动调查面板。面板通过**同一套 Service 层**读取 Splunk，因此页面上的数据与
`splunk-cli ... --json` 完全一致（JSON 值相同，仅缩进空白不同：CLI 使用 `indent=2`，
HTTP 响应为紧凑格式）。

* **只读**：不写入 Splunk，也不能启用、停用、修改或删除告警。
* **仅本机**：固定绑定 `127.0.0.1`，且校验 `Host` 头，抵御 DNS Rebinding。
* **前端不接触凭据**：浏览器从不保存 Splunk 密码或 Session Token。
* **前端无法绕过限制**：时间范围与条数上限由 Service 层强制，超限直接拒绝。

### `init`

```bash
splunk-cli init
splunk-cli init --json
```

创建 `~/.splunk-cli` 及其配置模板。安装后首次运行任意命令会自动完成这一步；
`init` 让它可以被显式调用。**幂等**：已存在的配置绝不覆盖。

### `config` 与 `limits`

```bash
splunk-cli config            # 显示生效配置（密钥脱敏）与配置目录
splunk-cli config --json
splunk-cli config --check    # 必填项缺失时退出码为 2
splunk-cli limits --json     # 生效中的安全上限与 Job 运行预算
```

---

## 7. JSON 输出

`--json` 是一等能力，而不是事后补丁。信封结构**稳定**，调用方可以依赖它。

### 成功

```json
{
  "success": true,
  "query": "index=app level=ERROR",
  "time_range": {"earliest": "-1h", "latest": "now", "duration_seconds": 3600.0},
  "sid": "1757843280.12345",
  "count": 2,
  "truncated": false,
  "job": {
    "sid": "1757843280.12345",
    "dispatch_state": "DONE",
    "is_done": true,
    "is_failed": false,
    "is_finalized": true,
    "done_progress": 1.0,
    "result_count": 2,
    "event_count": 2,
    "scan_count": 119,
    "run_duration": 0.05,
    "search_earliest_time": 1757839680,
    "search_latest_time": 1757843280,
    "sample_ratio": "1"
  },
  "results": [
    {
      "_time": "2026-09-14T08:31:21.000+00:00",
      "host": "api-01",
      "service": "payment",
      "level": "ERROR",
      "message": "database timeout"
    }
  ]
}
```

### 失败

```json
{
  "success": false,
  "error": {
    "type": "SplunkAuthenticationError",
    "message": "authentication failed (HTTP 401) for user splunk_user"
  }
}
```

错误对象可能带 `details`，提供结构化上下文：HTTP 状态码、请求路径、
出错的 span，或被突破的限制项。

**任何输出中都绝不出现：** 密码、`Authorization` 头、session token、
session key、Cookie。所有可能进入错误信息的远端字符串都会经过
`sanitize_message()` 处理，配置的唯一渲染出口是 `Settings.redacted()`。

### `truncated` 很重要

`"truncated": true` 表示服务端还有比请求条数更多的数据。
此时调用方必须缩小查询后重试，而不能基于不完整的一页就下结论。

### `job`：表达式真正落在哪个窗口

`earliest` / `latest` 是**表达式**（`@mon`、`now`、`-1h`），只有 Splunk 知道它们各自
落到哪两个瞬间。`job` 块把答案原样给出，内容全部来自创建搜索时本来就要读的那份 Job
元数据，不额外发起任何请求：

| 字段 | 含义 |
| --- | --- |
| `dispatch_state` / `is_done` / `is_failed` / `is_finalized` / `done_progress` | Job 状态 |
| `result_count` / `event_count` / `scan_count` | 结果条数 / 事件数 / 扫描条数（执行成本） |
| `run_duration` | 运行时长（秒） |
| `search_earliest_time` / `search_latest_time` | **实际执行的时间窗**，epoch 秒；服务端未给出时该键不出现 |
| `sample_ratio` | 事件采样比，`"1"` 表示未采样；采样会让计数变成近似值，所以必须可见 |

这两处都是**追加字段**（`ResultSet.toPublicDict()` 多一个 `job` 键，`SearchJob` 内部多三个
键），既有字段的名称与顺序未变，属于非破坏性变更。面板的 Job 状态栏直接读这个块。

### 退出码

| 退出码 | 含义 | 错误类型 |
| --- | --- | --- |
| 0 | 成功 | — |
| 1 | 一般错误 / 非预期错误 | `SplunkError` 或其他异常 |
| 2 | 配置错误 | `ConfigurationError` |
| 3 | 认证错误 | `SplunkAuthenticationError` |
| 4 | 连接错误 | `SplunkConnectionError` |
| 5 | 查询错误 | `SplunkQueryError`、`SplunkJobError`、`SplunkResultError` |
| 6 | 安全限制 | `SafetyLimitError` |
| 7 | 超时 | `SplunkTimeoutError` |

---

## 8. 安全限制

### Web 面板的安全模型

```text
Browser ──▶ Express Router ──▶ Services ──▶ SplunkClient ──▶ Splunk REST API
```

浏览器**绝不**直接访问 Splunk REST API。凭据只存在于 Node 进程内存中，
从不下发到页面。

| 防线 | 做法 |
| --- | --- |
| 网络 | CLI 固定绑定 `127.0.0.1`，`dashboard` 不提供修改绑定的选项 |
| DNS Rebinding | 校验 `Host` 头，只接受 `127.0.0.1` / `localhost` / `::1` |
| 纵深防御 | 若请求带 `Origin`，其 host 也必须在白名单内 |
| 参数上限 | 时间范围、条数、SPL 长度全部由 Service 层强制 |
| 只读 | 端点白名单不变；告警的写操作没有路由，也没有 API |
| 信息泄漏 | 一切错误经 `sanitize_message()`；响应体绝不含凭据 |

以下请求被拒绝（HTTP 403）：

```bash
curl -H "Host: evil.com" http://127.0.0.1:8765/api/health
```

而不带 `Origin` 的本地命令始终可用 —— `curl` 与脚本本就不受同源策略约束，
它们的访问已由绑定与 `Host` 校验保护。

### 结构上就是只读

允许访问的端点仅限以下这些：

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

始终拒绝：`DELETE`、`PUT`、`PATCH`、`HEAD`，以及任何非白名单路径，例如
`/services/admin/*`、`/services/authentication/*`、`/services/authorization/*`、
`/services/configs/*`、`/services/data/*`、`/services/apps/*`、
`/services/cluster/*`、`/services/deployment*`、`/services/search/jobs/export`。

### 强制限制

```text
max_results      = 5000      (SPLUNK_MAX_RESULTS)
max_time_range   = 7d        (SPLUNK_MAX_TIME_RANGE)
max_query_length = 10000     (SPLUNK_MAX_QUERY_LENGTH)
```

这三条是**上限**：超出即拒绝。`timeout`（单请求超时）、`search_timeout`（Job 墙钟
预算，实际生效值为 `max(SPLUNK_SEARCH_TIMEOUT, SPLUNK_TIMEOUT)`）与 `poll_interval`
（Job 状态轮询间隔）不是上限，但同属"当前生效的护栏"——`splunk-cli limits` 把两者打在
同一张表里，便于判断一次查询最多等多久、会向服务器发多少次状态查询。

> **例外（已决策接受）：** 含 `@` 的表达式与日历整窗（如 `last-month` = `-1mon@mon → @mon`）
> **不受** `max_time_range` 约束，宽度由 Splunk 按搜索用户时区解析，原因与代价见 §12。

超出限制时**直接拒绝，绝不静默修改用户参数**：

```bash
$ splunk-cli search "index=*" --earliest=-30d --json
```

```json
{
  "success": false,
  "error": {
    "type": "SafetyLimitError",
    "message": "requested time range of 2592000s exceeds the maximum allowed range of 604800s (earliest=-30d, latest=now)",
    "details": {
      "earliest": "-30d",
      "latest": "now",
      "requested_seconds": 2592000.0,
      "max_time_range_seconds": 604800.0
    }
  }
}
```

### SPL 校验

`server/safety/validator.ts` 是一份保守的词法**黑名单，而不是 SPL 解析器**。
它只检查以管道分隔的命令位置——因此一个恰好叫 `delete` 的字段名依然可用——
并拒绝所有写操作或管理类命令：

`delete`、`collect`、`mcollect`、`tscollect`、`meventcollect`、`dbinspect`、
`outputlookup`、`outputcsv`、`outputtext`、`rest`、`script`、`sendalert`、
`runshellscript`、`map`。

其中 `| rest` 尤其关键：它可以调用任意 Splunk 端点（**包括写入类 API**），
若不封禁就会让其他所有防护形同虚设。

**拿不准就拒绝。** 误拒是可接受的，误放不可接受。

### 重试策略

重试只针对传输层故障：连接重置、临时网络故障、`502`、`503`、`504` 以及超时。
最多 3 次，指数退避。认证失败与 `400`/`401`/`403` **绝不重试**。
搜索 Job 轮询是另一套机制，有自己的超时和最大轮询次数上限。

---

## 9. 测试

```bash
npm test                 # 后端 + CLI + 前端全部单元测试，无需真实 Splunk
npm run typecheck        # tsc --noEmit（strict + noUncheckedIndexedAccess）
npm run test:coverage    # 两份覆盖率报告 + Q10 分档门禁
```

单元测试不打桩到"函数级别"，而是留在**真实的 HTTP 边界**上：

* `test/fixtures/splunk/*.json` —— 从真实 Splunk 8.0.2 抓取并自动脱敏的响应蓝本。
  **形状不是手写的**：手写响应等于"按自己的理解构造 API"，而真实 Splunk 的字段大小写、
  空值表示、分组方式经常和直觉不一样。断言抓取来的蓝本，断言的才是真实行为。
* Client / Service 层用注入的 `fetch` 驱动这些蓝本，覆盖要求的失败矩阵：成功、
  认证失败、连接失败、超时、Job 失败、Job 超时、空结果、畸形结果。
* CLI 层起一个**真实的本地 HTTP 服务**（`node:http`）返回脚本化响应，
  于是退出码、stdout/stderr 分流、JSON 信封都能在进程级别断言，
  而不是把 HTTP 客户端 mock 掉再断言"它应该被调用过"。

行为由三层守着：单元/CLI 测试、`npm run verify:live` 的真机清单、以及可复现构建门禁。

### 真机验收

对着真实 Splunk 逐条执行验收清单，并把**实际观察到的**退出码与输出记录成报告：

```bash
npm run verify:live                     # 需要已配置可用的 Splunk
npm run verify:live -- --json-out /tmp/live.json
```

它会验证认证走的是真实业务端点（用一个记录请求的本地转发代理实测，而不是读代码）、
六条命令对真实数据返回、超时与安全上限的退出码、面板六个 API 与 `Host` 防护、
`--verbose` 全流程日志不含凭据、以及源码形态与打包形态行为一致。
共 19 项检查，用 `--json-out <路径>` 指定归档位置。

真实实例上的验证还有**独立且默认不执行**的一层：

```bash
export RUN_SPLUNK_INTEGRATION_TESTS=1
export SPLUNK_URL="https://203.0.113.10:8089"
export SPLUNK_USERNAME="splunk_user"
export SPLUNK_PASSWORD="..."            # 绝不提交
export SPLUNK_VERIFY_SSL=false

npm run test:integration
```

开关未打开、或凭据不全时，`test/integration/` 的用例显示为 **skipped**（而不是 fail），
因此默认的 `npm test` 始终与外部环境无关。凭据只从环境变量读取，代码里没有任何
主机名或密码字面量。

### 覆盖率门禁

门槛是分档的（Q10 决策），由 `scripts/check-coverage.mjs` 判定：

| 档位 | 门槛 |
| --- | --- |
| 后端总体 | ≥ 88% |
| `bin/splunk-cli.ts` | ≥ 88% |
| `server/client/http.ts` | ≥ 90% |
| `web/src/**`（前端） | ≥ 95% |

`npm run test:coverage` 会依次跑后端覆盖率、前端覆盖率，再读**两份**报告做判定——
缺任何一份都直接判不达标，避免"只跑了后端就以为门禁通过"。

---

## 10. 调用方集成设计

**Service 层才是产品。** 它是未来 MCP Server 或上层运行时应当包装的稳定接口，
而绝不是 HTTP Client。

```ts
import { SplunkClient } from './server/client/splunk'
import { loadSettings } from './server/config/settings'
import { SearchService } from './server/services/search'
import { dumps } from './server/output/envelope'

const client = new SplunkClient(loadSettings())
try {
  const result = await new SearchService(client).search('index=app level=ERROR', {
    earliest: '-1h',
    latest: 'now',
    limit: 100,
  })
  const payload = result.toPublicDict()   // 与 CLI 输出完全一致的稳定 JSON
  process.stdout.write(dumps(payload))
} finally {
  await client.close()
}
```

规划中的工具名与稳定签名：

| Tool | Service 调用 |
| --- | --- |
| `splunk_search` | `SearchService.search(query, { earliest, latest, limit })` → `ResultSet` |
| `splunk_stats` | `StatsService.stats(query, { by, function, earliest, latest, limit })` → `StatsResult` |
| `splunk_timeline` | `TimelineService.timeline(query, { span, earliest, latest, limit })` → `TimelineResult` |
| `splunk_fields` | `FieldsService.fields(query, { earliest, latest, limit })` → `FieldList` |
| `splunk_alerts` | `AlertsService.alerts({ count, includeSaved })` → `AlertList` |
| `splunk_health` | `HealthService.health({ includeLicense })` → `HealthReport` |

它们都返回带类型注解的模型，其 `toPublicDict()` 与 CLI 的 JSON 完全一致。

### Web API

面板的 HTTP 接口是 Service 层之上的一层薄适配，响应**原样**返回各模型的
`toPublicDict()`：

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/health` | `?include_license=true` | `HealthReport.toPublicDict()` |
| POST | `/api/search` | `{query, earliest?, latest?, limit?}` | `ResultSet.toPublicDict()` |
| POST | `/api/stats` | `{query, by?, function?, earliest?, latest?, limit?}` | `StatsResult.toPublicDict()` |
| POST | `/api/timeline` | `{query, span?, earliest?, latest?, limit?}` | `TimelineResult.toPublicDict()` |
| GET | `/api/alerts` | `?count=&include_saved=` | `AlertList.toPublicDict()` |
| POST | `/api/overview` | `{query, earliest?, latest?, span?}` | 见下 |
| GET | `/api/version` | — | `{name, version}`：面板自己这一版的版本号（读包元数据，**不读 Splunk**） |

`GET /api/health` 把**探针失败**（Splunk 连不上、凭据错误）报告在信封内：HTTP 状态仍是
200 加 `success: false`，不是 5xx —— 监控脚本应读字段而不是只看状态码。失败维度在字段里
区分：认证失败 → `connection: "ok"` + `authentication: "failed"`；非认证失败 →
`connection: "failed"`，但那是这一类的兜底值，不是精确的连接指示器。

**请求本身**非法时不会走到探针：`?include_license=abc` 这类参数校验失败 → 422，`Host` 头
不是回环地址 → 403。两者仍是本信封，但都不是探针失败。

本信封的形状与 CLI 一致：

```json
{"success": false, "error": {"type": "SafetyLimitError", "message": "..."}}
```

`POST /api/overview` 的降级结果是个例外：子查询失败时它返回 200，没有顶层 `error`，靠
`errors` 说明哪些子查询失败；时间线失败时 `success` 为 `false`，只有兄弟子查询失败时
`success` 仍为 `true`、`partial` 为 `true`（见下）。

HTTP 状态码映射：`SafetyLimitError` / `ValidationError` → 422（后者为请求体或查询参数校验失败），
`SplunkQueryError` → 400，`SplunkAuthenticationError` / `SplunkConnectionError` /
`SplunkJobError` / `SplunkResultError` → 502，`SplunkTimeoutError` → 504，
`ForbiddenOrigin` → 403，`FrontendNotBuilt` → 503（前端未构建），其余 → 500。

一个例外：`/api` 下**路径或方法没有被任何 API 路由匹配**时（如 `GET /api/nope`、
`POST /api/health`），拿到的是 `{"detail": "Not Found"}` /
`{"detail": "Method Not Allowed"}`，**不是**本信封。

`POST /api/overview` 一次返回首屏所需的时间线、按服务、按主机分布与派生指标。
三个子查询并发执行，**局部失败降级**：

```json
{
  "success": true,
  "partial": true,
  "metrics": {"events": 23521, "hosts": null, "services": 12, "buckets": 48},
  "timeline": {...},
  "by_service": {...},
  "by_host": null,
  "errors": {"by_host": {"type": "SplunkJobError", "message": "..."}}
}
```

失败的子查询对应字段为 **`null`**，不是 `0` —— `0` 是「确实没有数据」，
`null` 是「不知道」。时间线失败时整体 `success` 为 `false`。

### 典型的排查流程

本文档只描述该流程，**项目本身不实现它**——实现者是调用方：

```text
用户：「分析最近一小时 API 500 的原因」

调用方：
  1. splunk_health                                          先确认访问权限
  2. splunk_timeline  "index=api status=500" --span 1m       找出异常时间窗口
  3. splunk_stats     "index=api status=500" --by service    哪个服务占主导
  4. splunk_search    "index=api status=500 service=payment" --earliest=<窗口> --limit 50
  5. splunk_stats     "index=api status=500 service=payment" --by host
  6. splunk_search    "index=api trace_id=<id>"              拉取完整链路
  7. 综合分析根因
```

每一步都是一次 CLI / MCP 调用，返回结构化数据。每次响应中的 `truncated`、`count`、
`time_range` 都在告诉调用方：当前证据是否足以支撑结论。

---

## 11. MCP 路线图

Phase 1 有意止步于内核。后续计划，按顺序：

1. **`splunk-mcp` Server** —— 对 Service 层的薄封装，暴露上述六个工具，
   其 JSON Schema 由 zod 模型生成。
2. **共享会话管理** —— 连接复用与凭据解析继承自 `server/config/settings.ts`，绝不重复实现。
3. **分页与流式工具**，用于超过一页的结果集。
4. **按名称执行已保存搜索**（仍然只读）。

任何阶段都不做的非目标（除非有明确决策）：写入 Splunk、告警自动修复、内置 LLM。

---

## 12. 已知限制

* **设计上只读。** 无写入路径、不能删除 Job、不能修改告警。
* **搜索 Job 不会主动清理。** Splunk 自己的 Job 保留策略负责回收；本工具不发
  `DELETE`（那不在只读白名单里）。
* **`fields` 使用 `| fieldsummary`，** 结果准确但在超大索引上开销不低，请缩小时间范围。
* **告警端点存在版本差异。** `/services/alerts/fired_alerts` 在 Splunk 9.2 中已被移除，
  各 8.x 补丁版本行为也不一致。该端点不可用时，命令会返回空列表加一个 `note`，
  退出码为 0——给出一个诚实的结构化答案，而不是不明所以的失败。
* **`health` 可能为 `unknown`。** Splunk 8.0.2 的 `/services/server/info`
  并不总是返回 `health` 字段；此时如实透传，不臆造取值。
* **仅在静态可判定时校验时间范围（已决策接受）。** 任何含 `@` 的表达式都不在本地做跨度
  检查，包括具名整窗（`last-month` = `-1mon@mon → @mon`）：`SPLUNK_MAX_TIME_RANGE`
  对它们**不生效**，宽度由 Splunk 按搜索用户时区解析。CLI 拿不到那个时区，本地硬算会在
  时区不一致或夏令时切换时误判，所以这是一个已接受的缺口，不是待修的 bug。能静态求值的
  窗口（如 `-30d`）仍被本地上限直接拒绝（退出码 6）。因此 `--range last-year` 可能真扫
  一整年（某实例实测约 857 万事件 / 36 秒）；兜住它的是 Job 墙钟预算
  （`SPLUNK_SEARCH_TIMEOUT`，超时退出码 7）与 Splunk 自身的 `limits.conf` / 角色配额。
* **`truncated` 偏保守。** 恰好返回 `limit` 条且可能还有更多时也会是 `true`。
  请把它理解为「需要复查」，而不是「一定还有更多」。
* **License Pool 可能为空**——当认证用户缺少 license 相关能力时；
  此时 `health` 会优雅降级而不是报错。

---

## 13. 故障排查

| 现象 | 退出码 | 原因与处理 |
| --- | --- | --- |
| `missing required configuration` | 2 | 导出 `SPLUNK_URL`、`SPLUNK_USERNAME`、`SPLUNK_PASSWORD`，或创建 `.env` |
| `CERTIFICATE_VERIFY_FAILED` | 4 | 校验默认开启，而 Splunk 默认证书是自签的：配好 `SPLUNK_CA_BUNDLE`，或开发环境设 `SPLUNK_VERIFY_SSL=false`（见 §5 TLS） |
| `authentication failed (HTTP 401)` | 3 | 凭据错误，或该用户无权读取 `/services/server/info` |
| `HTTP 502` / 网关错误 | 5 | 系统代理拦截了内网请求；请保持 `SPLUNK_TRUST_ENV=false` |
| `did not finish within 60s` | 7 | 缩小时间范围、追加 `\| head N`，或调高 `SPLUNK_SEARCH_TIMEOUT` |
| `exceeds the maximum allowed range` | 6 | 缩小窗口，或在明确知晓代价的前提下调高 `SPLUNK_MAX_TIME_RANGE` |
| `SPL command 'rest' is not permitted` | 6 | 只读策略；请改用受支持的命令 |
| 配置成了 8000 端口 | — | 8000 是 Web UI，REST API 在 **8089** |

调试请使用 `--verbose`。日志输出到 stderr，任何日志级别都不会打印凭据内容。

---

## 分发

分发包由 `npm run pack` 生成。交付目录 `splunk-cli/` 里只有指南文档与安装包：

```text
splunk-cli/                              ← 交付目录
├── INSTALL.md                           ← 安装指南（提交 Git）
├── USAGE.md                             ← 完整使用手册（提交 Git）
├── VERSION.md                           ← 版本更新记录（提交 Git）
└── splunk-cli.tgz                       ← 安装包（构建产物，单文件跨平台）
```

```bash
npm install -g ./splunk-cli/splunk-cli.tgz
```

打包过程：

```bash
npm run pack            # 构建 + 组装 + 出 tgz/zip
npm run pack:verify     # 额外自证可复现：打包两次并比对 sha256
```

`scripts/package.mjs` 把 `dist/` 的产物与 `package.json`、`README.md` 组装到
`pack/splunk-cli/`，再生成两个归档：

* `splunk-cli/splunk-cli.tgz` —— `npm install -g` 直接安装；
* `releases/splunk-cli-v<版本>.zip` —— 整个交付目录（指南 + 安装包）打包分发。

**为什么一个包能跨平台。** 产物是纯 JavaScript：`bin/splunk-cli.ts` 连同我们自己的
全部代码被 esbuild 压成单文件，`express` / `compression` / `undici` 标记为 external
交由目标机的 `npm install` 按平台解析；前端是 Vite 的静态产物。没有原生编译，
所以 CI 只需要一个 ubuntu runner。

**分发物里没有源码。** 压缩后的单文件 bundle 无法还原成可读实现（不产出 source map），
`package.json` 里的 `scripts` 与 `devDependencies` 会被删掉，
`assertArchiveClean()` 还会在归档前逐条拒绝 `.ts`、`.map`、`.env`、测试夹具。

**可复现构建。** 归档由 `scripts/lib/archive.mjs` 在进程内写出：条目按路径排序、
所有 mtime 固定、gzip 头不带时间戳。因此同样的 `dist/` 必然产出同样的字节，
`npm run pack:verify` 用"打包两次比对 sha256"把这条承诺变成 CI 门禁。

## 开发

```bash
npm install
npm run typecheck && npm test && npm run test:coverage
npm run dev -- search "index=_internal | head 5"     # 直接跑 TS 源码，无需构建
```

贡献代码前请先阅读 **`AGENTS.md`**：其中定义了分层规则、只读白名单、
安全与测试要求，以及 Definition of Done。

## 许可证

MIT
