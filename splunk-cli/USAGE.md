# splunk-cli 使用手册

<div style="margin: 8px 0 16px;">
  <span style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px; background: linear-gradient(135deg, #3b82f6, #8b5cf6); color: #fff; font-size: 12px; font-weight: 500; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; box-shadow: 0 2px 8px rgba(59,130,246,0.3);">
    <span style="width: 6px; height: 6px; border-radius: 50%; background: #fff;"></span>
    author: Alex
  </span>
</div>

`splunk-cli` 是一套**只读**的 Splunk 日志读取工具：面向 Claude Code、Codex、MCP Server
这类调用方，提供**结构化**的查询结果。

它的职责被刻意收窄：**可靠地获取并结构化 Splunk 数据**。对这些数据做推理是调用方的事。

安装步骤见 [INSTALL.md](./INSTALL.md)，版本历史见 [VERSION.md](./VERSION.md)。

---

## 目录

- [0. 阅读指南](#0-阅读指南)
- [1. TL;DR](#1-tldr)
- [2. 连接与配置](#2-连接与配置)
- [3. 命令详解](#3-命令详解)
- [4. JSON 契约](#4-json-契约)
- [5. 安全限制](#5-安全限制)
- [6. 调用方集成](#6-调用方集成)
- [7. 已知限制](#7-已知限制)
- [8. 故障排查](#8-故障排查)

---

## 0. 阅读指南

| 你是 | 直接看 |
| --- | --- |
| 第一次用 | [1. TL;DR](#1-tldr) → [3. 命令详解](#3-命令详解) |
| 写调用方 / agent 工具 | [4. JSON 契约](#4-json-契约) → [6. 调用方集成](#6-调用方集成) |
| 做安全评审 | [5. 安全限制](#5-安全限制) |
| 排查连不上 | [2.3 TLS](#23-tls) → [8. 故障排查](#8-故障排查) |

---

## 1. TL;DR

### 1.1 定位

* **只读**：没有写入、删除、改配置的路径；告警的 enable/disable/delete 永不实现。
* **结构化**：每条命令都同时支持文本与 JSON，JSON 是稳定契约。
* **有界**：结果条数、时间跨度、SPL 长度都有上限，超限**直接拒绝**，绝不静默改写参数。
* **凭据零泄漏**：任何输出、日志、错误里都不会出现密码、`Authorization`、session key、Cookie。

### 1.2 命令速查表

| 命令 | 用途 | 典型用法 |
| --- | --- | --- |
| `health` | 连通性 / 认证 / 版本 / license | `splunk-cli health --json` |
| `search` | 只读搜索，取原始事件 | `splunk-cli search "index=app level=ERROR" --limit 50 --json` |
| `stats` | 分组聚合 | `splunk-cli stats "index=app" --by service --json` |
| `timeline` | 事件量趋势 | `splunk-cli timeline "index=app" --span 5m --json` |
| `fields` | 字段发现（摸 schema） | `splunk-cli fields "index=app" --details` |
| `alerts` | 已触发告警（只读） | `splunk-cli alerts --json` |
| `config` | 查看生效配置（密码脱敏） | `splunk-cli config` |
| `limits` | 查看安全上限与 Job 运行预算 | `splunk-cli limits` |
| `init` | 创建配置目录与模板 | `splunk-cli init` |
| `dashboard` | 本地可视化面板 | `splunk-cli dashboard` |

### 1.3 三十秒上手

```bash
splunk-cli health --json                                    # 先确认能用
splunk-cli timeline "index=app status=500" --span 1m --json # 找异常时间窗
splunk-cli stats "index=app status=500" --by service --json # 哪个服务占主导
splunk-cli search "index=app status=500 service=payment" --limit 50 --json  # 看明细
```

每一步都返回结构化数据；响应里的 `truncated`、`count`、`time_range` 告诉你当前证据是否足够。

---

## 2. 连接与配置

### 2.1 配置来源与优先级

由高到低：

```text
SPLUNK_* 环境变量
  ↓ 覆盖
~/.splunk-cli/config.env
  ↓ 覆盖
项目内 ./.env
  ↓ 覆盖
内置默认值
```

**逐字段合并**：高优先级来源只覆盖它显式设置的那些字段，其余字段继续沿用低优先级来源。

查看生效配置（密码只显示存在性）：

```bash
splunk-cli config
splunk-cli config --json
```

### 2.2 配置项全表

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SPLUNK_HOST` | 空 | 主机名或 IP，**不带协议、不带端口、不带路径**（示例：`splunk.internal` / `10.0.0.5`） |
| `SPLUNK_PORT` | `8089` | REST API 端口。**8000 是 Web UI 端口，不是 API** |
| `SPLUNK_URL` | 空 | 完整基地址，设置后**优先于** `HOST`/`PORT`（用于反向代理或带路径的部署） |
| `SPLUNK_INSECURE` | `false` | `true` 时用 `http://` 而非 `https://`（仅开发） |
| `SPLUNK_USERNAME` | 空 | Basic Auth 用户名（示例：`admin` / `ci_reader`） |
| `SPLUNK_PASSWORD` | 空 | Basic Auth 密码 |
| `SPLUNK_VERIFY_SSL` | `true` | 是否校验 TLS 证书。默认**开启**；对接 Splunk 默认自签证书时需配 `SPLUNK_CA_BUNDLE`，或设为 `false`（仅开发环境）。见 2.3 |
| `SPLUNK_CA_BUNDLE` | 空 | 可选 PEM CA 包路径（仅在开启校验时生效） |
| `SPLUNK_TRUST_ENV` | `false` | 是否遵循代理环境变量与系统代理 |
| `SPLUNK_TIMEOUT` | `30` | 单请求超时（秒），范围 `(0, 600]` |
| `SPLUNK_MAX_RESULTS` | `5000` | 单次最大结果数 |
| `SPLUNK_MAX_TIME_RANGE` | `7d` | 搜索时间跨度上限（需为固定时长，如 `30m`/`24h`/`7d`） |
| `SPLUNK_POLL_INTERVAL` | `1` | 搜索 Job 轮询间隔（秒） |
| `SPLUNK_SEARCH_TIMEOUT` | `60` | 搜索 Job 墙钟预算（秒） |
| `SPLUNK_MAX_QUERY_LENGTH` | `10000` | SPL 最大长度 |
| `SPLUNK_MAX_RETRIES` | `3` | 传输层重试次数（`0` 关闭） |
| `SPLUNK_RETRY_BACKOFF` | `0.5` | 指数退避基数（秒） |
| `SPLUNK_CONFIG_DIR` | `~/.splunk-cli` | 覆盖配置目录位置 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`，日志走 **stderr** |

> **`SPLUNK_TRUST_ENV` 默认 `false` 是刻意的**：Splunk 通常在内网，把管理 API 悄悄绕进
> 开发机的系统代理会得到莫名其妙的网关错误（502），而不是清晰的连接结果。

> **Job 预算是 `max(SPLUNK_SEARCH_TIMEOUT, SPLUNK_TIMEOUT)`**：只调小前者不会生效，
> 单请求超时会把它顶回去。

### 2.3 TLS

**默认开启校验**（`SPLUNK_VERIFY_SSL=true`）。注意连接**始终是加密的**，这个开关只决定要不要
额外"证明对端身份"。

Splunk 默认安装的证书（`CN=SplunkServerDefaultCert`）由 Splunk 自己的 CA 签发、且**没有 SAN
扩展**，所以在默认安装上校验**一定失败**。两个办法，办法二只用于开发环境：

```bash
# 办法一（推荐）：信任签发服务端证书的 CA
SPLUNK_VERIFY_SSL=true
SPLUNK_CA_BUNDLE=/path/to/splunk-ca.pem

# 办法二（仅开发环境）：跳过身份校验
SPLUNK_VERIFY_SSL=false
```

办法一有两个前提，缺一个都会失败：

| 前提 | 说明 |
| --- | --- |
| `SPLUNK_CA_BUNDLE` 要是**签发服务端证书的那个 CA** | 把服务端证书本身（叶子）放进去**不能**建立信任；要放服务端发出的**整条链** |
| 证书要带覆盖**实际连接名字**的 SAN | 按 IP 连接需要 `iPAddress` SAN——**CN 永远不参与 IP 匹配** |

取 CA 包（整条链）：

```bash
openssl s_client -connect <host>:8089 -showcerts </dev/null 2>/dev/null \
  | sed -n '/BEGIN CERTIFICATE/,/END CERTIFICATE/p' > splunk-ca.pem
```

Splunk 默认证书没有 SAN，因此在**不更换服务端证书**的前提下，只要按 IP 连接，
`SPLUNK_CA_BUNDLE` 就一定会撞上主机名校验：

```text
cannot reach Splunk at https://203.0.113.10:8089: Hostname/IP does not match certificate's altnames
```

此时要么换一张带 SAN 的证书，要么在开发环境用 `SPLUNK_VERIFY_SSL=false`。

### 2.4 认证如何被验证

认证走**真实业务端点** `GET /services/server/info`，而不是 `/services/auth/login`：
调用成功即同时证明连通性与凭据有效。

---

## 3. 命令详解

所有命令都支持 `--json/-j`（稳定 JSON 信封）与 `--verbose/-v`（stderr 上的 debug 日志）。

### 3.1 `health` — 健康检查

```bash
splunk-cli health [--no-license] [--json]
```

通常这是 agent 的**第一个调用**。连接失败与认证失败**在报告内呈现**（`connection` /
`authentication` 字段），而不是抛错——监控脚本拿到的是结构化答案。

```json
{
  "success": true,
  "splunk": {
    "version": "8.0.2", "build": "a7f645ddaf91", "server_name": "splunk-dev-01",
    "guid": "...", "license_state": "OK", "health": "unknown",
    "os_name": "Linux", "cpu_arch": "x86_64", "server_start_time": "2026-08-28T10:02:11+00:00"
  },
  "connection": "ok",
  "authentication": "ok",
  "health": "unknown",
  "license": { "status": "unknown", "reason": "SplunkAuthenticationError", "pools": [] },
  "latency_ms": 7.2
}
```

失败时套标准错误信封，退出码按维度区分：

| 情况 | `connection` | `authentication` | 退出码 |
| --- | --- | --- | --- |
| 认证失败 | `ok` | `failed` | 3 |
| 连不上 | `failed` | `unknown` | 4 |

### 3.2 `search` — 只读搜索

```bash
splunk-cli search <query> [-e|--earliest <time>] [-l|--latest <time>] [-r|--range <name>]
                         [-n|--limit <n>] [--timeout <s>] [--json]
```

默认 `--earliest=-1h --latest=now`。`--timeout` 覆盖本次的 Job 预算。

#### 时间范围怎么给

三种给法，**一次只用一种**：

| 写法 | 例子 | 说明 |
| --- | --- | --- |
| `--earliest` + `--latest` | `--earliest=-30m --latest=now` | 分别给两端，任何合法字面量 |
| `--range <名字>` | `--range last-month` | 一个名字给**整个窗口**，见下表 |
| `--range <时长>` | `--range 7d` | 等价于 `--earliest=-7d --latest=now` |

`--range` 与 `--earliest`/`--latest` **同时出现会被拒绝**（退出码 6），而不是让其中一个
静默生效：被忽略的那一半会给出一个"看起来完全正常"的错误窗口，这是最难发现的一类错。

`--earliest` / `--latest` 接受的写法：

| 类别 | 写法 | 说明 |
| --- | --- | --- |
| 相对偏移 | `-30m`、`-7d`、`-1mon`、`-1y`、`-1q` | 单位 `s` `m` `h` `d` `w` `mon` `y` `q`；不带符号的 `7d` 等同于 `-7d` |
| 对齐点（裸） | `@d`、`@w0`、`@mon`、`@y`、`@q` | 该周期的起点：今天零点、本周日、本月一日、今年元旦、本季度首日 |
| 组合 | `-7d@w0`、`-1d@d`、`-1mon@mon`、`-1y@y` | 先偏移再对齐 |
| 具名字面量 | `now`、`today`、`yesterday`、`week`、`month`、`year` | `week` = `@w`、`month` = `@mon`、`year` = `@y`，与面板「本周 / 本月 / 今年」一致 |
| 绝对时间 | `2026-09-16T14:00:00+08:00`、`2026-09-16` | ISO-8601 |
| epoch | `1789538945` | 秒 |
| 未来 | `+1d`、`+1d@d` | 保留符号，不会被反向成"一天前" |

`--range` 接受的名字（与面板「日历」预设一一对应）：

| 名字 | 展开为 |
| --- | --- |
| `today` | `@d` → `now` |
| `yesterday` | `-1d@d` → `@d` |
| `this-week` | `@w` → `now` |
| `last-week` | `-7d@w0` → `@w0` |
| `this-month` | `@mon` → `now` |
| `last-month` | `-1mon@mon` → `@mon` |
| `this-year` | `@y` → `now` |
| `last-year` | `-1y@y` → `@y` |

下划线与大小写都可以（`last_month`、`Last-Month` 等价）。名字写错时**直接拒绝**并列出
可用写法，不会退回默认窗口。

带 `@` 的写法（含所有日历窗口）只能在服务端求值，因此它的宽度**不参与本地 7 天上限判定**
——`SPLUNK_MAX_TIME_RANGE` 对它们不生效，宽度由 Splunk 按**搜索用户的时区**解析。CLI 拿不到
那个时区，本地硬算会在时区不一致或夏令时切换时误判，所以这是**已决策接受**的缺口，不是待修
的 bug。能静态求值的窗口（如 `-30d`）仍会被本地上限直接拒绝（退出码 6）。

代价要心里有数：`--range last-year` 可能真的扫完一整年（某实例实测约 857 万事件 / 36 秒）。
真正兜住它的是 Job 墙钟预算（`SPLUNK_SEARCH_TIMEOUT`，超时退出码 7）与 Splunk 自身的
`limits.conf` / 角色配额——不是本地的时间跨度上限。

#### 输出里怎么确认查了哪一段

**文本输出**的摘要行会带上 Job 实际执行的时间窗（带本地时区偏移的 ISO-8601）、耗时，
采样不是 1:1 时还会点名"近似值"。**没有命中时同样会报窗口**——先确认查的是不是那一段，
"真的没有"这个结论才成立：

```text
_time                host    message
2026-09-16T14:14:23  api-01  database timeout

2 result(s) · 实际时间窗 2026-08-01T00:00:00+08:00 → 2026-09-01T00:00:00+08:00 · 耗时 0.064s
```

```bash
splunk-cli search "index=app level=ERROR" --limit 50 --json
splunk-cli search "index=api status=500" --earliest=-15m --limit 20
splunk-cli search "index=api status=500" --range last-week
splunk-cli search "index=api" --earliest=@mon --latest=now      # 本月至今
```

```bash
$ splunk-cli search "index=api status=500" --range this-fortnight
error: SafetyLimitError: unknown range 'this-fortnight': expected one of today, yesterday,
this-week, last-week, this-month, last-month, this-year, last-year, or a duration such as
30m, 12h, 7d
```

```json
{
  "success": true,
  "query": "index=api status=500",
  "time_range": { "earliest": "-15m", "latest": "now", "duration_seconds": 900 },
  "sid": "1757843280.12345",
  "count": 2,
  "truncated": false,
  "total_available": 2,
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
  "fields": ["_time", "host", "message"],
  "results": [{ "_time": "2026-09-14T08:31:21.000+00:00", "host": "api-01" }]
}
```

`job` 是**追加**的执行元数据（既有字段未变）。其中两个时间窗值得单独说：请求里的
`earliest` / `latest` 是表达式，`search_earliest_time` / `search_latest_time`（epoch 秒）
才是 Splunk 实际执行的窗口——`@mon` 到底指哪一天，只有这里能回答。`sample_ratio` 不是
`"1"` 时，结果计数是抽样近似值。

### 3.3 `stats` — 分组聚合

```bash
splunk-cli stats <query> [--by <fields>] [-f|--function <name>] [-e] [-l] [-r|--range <name>] [-n] [--json]
```

`--function` 取 `count`（默认）/ `dc` / `sum` / `avg` / `min` / `max`；`--by` 最多 4 个字段。
生成的 SPL 只插值**已校验的标识符**，因此 `--by` 无法注入 SPL 命令。

时间范围选项（`-e` / `-l` / `-r`）与 `search` 完全相同，见 §3.2。

```bash
splunk-cli stats "index=app level=ERROR" --by service,host --json
```

```json
{
  "success": true,
  "query": "index=app level=ERROR",
  "spl": "index=app level=ERROR | stats count by service, host | sort - count | head 5000",
  "function": "count",
  "by": ["service", "host"],
  "count": 2,
  "rows": [{ "key": ["payment", "api-01"], "count": 128 }],
  "truncated": false,
  "time_range": { "earliest": "-1h", "latest": "now", "duration_seconds": 3600 }
}
```

未指定 `--by` 时返回单行总计，`key` 为 `"*"`。

### 3.4 `timeline` — 事件量趋势

```bash
splunk-cli timeline <query> [-s|--span <span>] [-e] [-l] [-r|--range <name>] [-n] [--json]
```

`--span` 默认 `5m`，必须是正的固定时长（`30s`/`5m`/`1h`/`1d`）。桶数上限 500。

时间范围选项（`-e` / `-l` / `-r`）与 `search` 完全相同，见 §3.2。

```json
{
  "success": true,
  "query": "index=app", "spl": "index=app | timechart span=5m count | head 500",
  "span": "5m", "count": 12, "total": 23521,
  "timeline": [{ "time": "2026-09-14T08:30:00.000+00:00", "count": 1024 }],
  "time_range": { "earliest": "-1h", "latest": "now", "duration_seconds": 3600 }
}
```

文本模式会先画一条 unicode sparkline，再给出每个桶的明细表。

### 3.5 `fields` — 字段发现

```bash
splunk-cli fields <query> [-e] [-l] [-r|--range <name>] [-n] [--details] [--json]
```

用 `| fieldsummary` 列出某查询可用的字段，按事件数降序。字段数上限 200。
`--details` 额外返回逐字段的 `count` / `distinct_count` / `modes`。

时间范围选项（`-e` / `-l` / `-r`）与 `search` 完全相同，见 §3.2。

```bash
splunk-cli fields "index=app" --details
```

```json
{ "success": true, "query": "index=app", "count": 2, "fields": ["host", "level"],
  "time_range": { "earliest": "-1h", "latest": "now", "duration_seconds": 3600 },
  "details": [{ "name": "host", "count": 1024, "distinct_count": 12, "modes": [{ "value": "api-01", "count": 512 }] }] }
```

### 3.6 `alerts` — 告警（只读）

```bash
splunk-cli alerts [-n|--count <n>] [--saved] [--json]
```

```json
{
  "success": true, "source": "fired_alerts", "count": 1,
  "alerts": [{ "name": "-", "severity": "unknown", "app": "search" }],
  "truncated": false
}
```

`--saved` 会额外列出已保存搜索（`source` 变为 `both`）。`fired_alerts` 端点在 **Splunk 9.2 已移除**，
不可用时降级为：

```json
{ "success": true, "source": "unavailable", "count": 0, "alerts": [], "truncated": false,
  "note": "the fired-alerts endpoint is unavailable on this Splunk instance (HTTP 404); no triggered alerts are reported" }
```

**退出码仍为 0**：这是一个诚实的结构化答案，而不是不明所以的失败。

### 3.7 `config` — 查看配置

```bash
splunk-cli config [--check] [--json]
```

```json
{
  "host": "203.0.113.10", "port": 8089, "url": "https://203.0.113.10:8089",
  "url_source": "SPLUNK_HOST/SPLUNK_PORT", "username": "splunk_user", "password": "<set>",
  "verify_ssl": false, "ca_bundle": null, "trust_env": false, "timeout": 30,
  "max_results": 5000, "max_time_range": "7d", "poll_interval": 1, "search_timeout": 60,
  "max_query_length": 10000, "max_retries": 3, "retry_backoff": 0.5,
  "configured": true, "config_dir": "/home/you/.splunk-cli",
  "config_file": "/home/you/.splunk-cli/config.env", "config_file_present": true
}
```

> 注意：`config --json` **没有** `success` 键（与其它命令不同）。这是既有契约，照实保留。

`--check` 在配置不完整时以退出码 2 失败，适合启动前的门禁。

### 3.8 `limits` — 查看生效中的护栏

```bash
splunk-cli limits [--json]
```

```text
max_results             5000
max_time_range_seconds  604800.0
max_query_length        10000
read_only               True
timeout                 30.0
search_timeout          60.0
poll_interval           1.0
```

```json
{ "success": true, "max_results": 5000, "max_time_range_seconds": 604800,
  "max_query_length": 10000, "read_only": true,
  "timeout": 30, "search_timeout": 60, "poll_interval": 1 }
```

前四个键是**上限与只读策略**：由 `safety/limits.ts` 的 `check_*` 强制执行，超限一律以
退出码 6 拒绝。后三个是运行参数，不由它校验，但同样决定一次查询要等多久、会给服务器
添多少负担：

* `timeout`：单次 HTTP 请求超时（秒）。
* `search_timeout`：Job 墙钟预算的**生效值**，即
  `max(SPLUNK_SEARCH_TIMEOUT, SPLUNK_TIMEOUT)`——只调小前者可能不生效。
* `poll_interval`：Job 状态轮询间隔（秒）。60 秒的搜索在默认值下约等于 60 次状态查询。

`limits` 只读本地配置：**不需要连上 Splunk**，也不涉及任何凭据。

### 3.9 `init` — 初始化配置目录

```bash
splunk-cli init [--json]
```

创建 `~/.splunk-cli/`（`700`）与 `config.env`（`600`）。**幂等**：已有配置绝不覆盖。
配置目录里**只放配置文件**，不写 README 之类的附加文档。

```json
{ "success": true, "config_dir": "/home/you/.splunk-cli", "config_file": ".../config.env",
  "directory_created": true, "config_file_created": true, "configured": false }
```

### 3.10 `dashboard` — 本地调查面板（只读）

```bash
splunk-cli dashboard [--port <n>]     # 默认 8765
```

浏览器里查看事件量时间线、分组分布与错误明细，含按服务/主机的下钻与告警视图。
面板与 CLI 共用同一套服务层，数据完全一致。

安全模型：

| 防线 | 做法 |
| --- | --- |
| 网络 | **固定绑定 `127.0.0.1`**，不提供修改绑定的选项 |
| DNS Rebinding | 校验 `Host` 头，只接受 `127.0.0.1` / `localhost` / `::1` |
| 纵深防御 | 若请求带 `Origin`，其 host 也必须在白名单内 |
| 信息泄漏 | 响应体绝不含凭据；错误信息统一脱敏 |
| 只读 | 端点白名单不变；告警的写操作没有路由，也没有 API |

### 3.11 全局选项

| 选项 | 说明 |
| --- | --- |
| `-j, --json` | 输出稳定 JSON 信封，而不是表格 |
| `-v, --verbose` | stderr 上打开 debug 日志（**stdout 始终只放机器载荷**） |
| `-V, --version` | 版本号 |
| `-h, --help` | 帮助（含每个命令的选项与默认值） |

---

## 4. JSON 契约

### 4.1 信封结构

成功：

```json
{ "success": true, "...命令特有键...": "..." }
```

失败：

```json
{ "success": false, "error": { "type": "SplunkAuthenticationError", "message": "...", "details": { "...": "..." } } }
```

* 字段名属于**公开契约**，改名是破坏性变更。
* `details` 只在存在时出现；内容是结构化上下文（HTTP 状态码、路径、被突破的限制项）。
* JSON 模式下绝不输出只有散文的错误。

### 4.2 退出码

| 退出码 | 含义 | 错误类型 |
| --- | --- | --- |
| 0 | 成功 | — |
| 1 | 一般 / 非预期错误 | `SplunkError` 或其它 |
| 2 | 配置错误 | `ConfigurationError` |
| 3 | 认证错误 | `SplunkAuthenticationError` |
| 4 | 连接错误 | `SplunkConnectionError` |
| 5 | 查询错误 | `SplunkQueryError` / `SplunkJobError` / `SplunkResultError` |
| 6 | 安全限制 | `SafetyLimitError` |
| 7 | 超时 | `SplunkTimeoutError` |
| 130 | 被中断（Ctrl-C） | — |

`health` 是例外：它把探针失败也表达为结构化报告，退出码取 3（认证）/ 4（连接）。

### 4.3 错误类型全集

`SplunkError`（基类）、`ConfigurationError`、`SplunkAuthenticationError`、
`SplunkConnectionError`、`SplunkQueryError`、`SplunkJobError`、`SplunkResultError`、
`SafetyLimitError`、`SplunkTimeoutError`。

调用方应当**按 `error.type` 分支**，而不是解析 `message` 文本。

### 4.4 `truncated` 的语义（调用方必须处理）

`"truncated": true` 表示服务端还有比本次返回更多的数据。此时调用方必须**缩小查询后重试**，
不能基于不完整的一页下结论。它偏保守：恰好返回 `limit` 条时也会是 `true`——请理解为
"需要复查"，而不是"一定还有更多"。

### 4.5 密钥零泄漏

任何输出、日志、错误里都不会出现：密码、`Authorization` 头、session key、
session token、Cookie。所有可能进入错误信息的远端字符串都会先经脱敏处理；
`config` 只显示密码的存在性。

---

## 5. 安全限制

### 5.1 只读端点白名单

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

始终拒绝 `DELETE` / `PUT` / `PATCH` / `HEAD`，以及任何非白名单路径（`/services/admin/*`、
`/services/authentication/*`、`/services/configs/*`、`/services/data/*`、`/services/apps/*`、
`/services/cluster/*`、`/services/deployment*`、`/services/search/jobs/export` 等）。

### 5.2 强制上限

```text
max_results      = 5000      (SPLUNK_MAX_RESULTS)
max_time_range   = 7d        (SPLUNK_MAX_TIME_RANGE)
max_query_length = 10000     (SPLUNK_MAX_QUERY_LENGTH)
```

这三条是**上限**，超出即拒绝。`timeout` / `search_timeout` / `poll_interval` 不是上限
（见 3.8），但由 `splunk-cli limits` 一并打印。

> **例外（已决策接受）：** 含 `@` 的表达式与日历整窗（如 `last-month` = `-1mon@mon → @mon`）
> **不受** `max_time_range` 约束，宽度由 Splunk 按搜索用户时区解析——原因与代价见 3.2 与 7。

超出限制时**直接拒绝，绝不静默修改用户参数**：

```json
{
  "success": false,
  "error": {
    "type": "SafetyLimitError",
    "message": "requested time range of 2.592e+06s exceeds the maximum allowed range of 604800s (earliest=-30d, latest=now)",
    "details": { "earliest": "-30d", "latest": "now", "requested_seconds": 2592000, "max_time_range_seconds": 604800 }
  }
}
```

### 5.3 SPL 校验边界

SPL 校验是**词法黑名单，不是解析器**：它只检查以管道分隔的命令位置，拒绝写入与管理类命令
（`delete`、`collect`、`meventcollect`、`dbinspect`、`sendalert`、`script`、`runshellscript`、
`rest`、`outputlookup`、`outputcsv`、`outputtext`、`mcollect`、`tscollect`、`map`）。

原则是**拿不准就拒绝**：误拒可接受，误放不可接受。字段名恰好叫 `delete`
（如 `| stats count by delete`）不受影响。

### 5.4 重试策略

| 情况 | 是否重试 |
| --- | --- |
| HTTP 502 / 503 / 504 | 是，按 `SPLUNK_MAX_RETRIES` 次、指数退避 |
| 超时 / 连接类错误 | 是 |
| HTTP 400 / 401 / 403 | **绝不**——认证失败必须快速失败 |
| 其它 4xx / 5xx | 否 |

---

## 6. 调用方集成

### 6.1 为什么 CLI 本身就够用

* 结构化 JSON 输出 + 稳定错误类型 + 明确退出码，足以让脚本与 agent 分支处理；
* stdout 只放机器载荷，诊断走 stderr，可直接管道给 `jq`；
* 不依赖任何 Splunk 客户端库，直接对接官方 REST API。

### 6.2 直接调用 CLI

```bash
splunk-cli stats "index=app level=ERROR" --by service --json | jq '.rows'
```

### 6.3 通过 Node API（推荐给 MCP / 上层运行时）

服务层就是未来的工具面，签名保持稳定：

```ts
import { SearchService } from 'splunk-cli/server/services/search'
```

```text
SearchService.search(query, { earliest, latest, limit })             -> ResultSet
StatsService.stats(query, { by, function, earliest, latest, limit }) -> StatsResult
TimelineService.timeline(query, { span, earliest, latest, limit })   -> TimelineResult
FieldsService.fields(query, { earliest, latest, limit })             -> FieldList
AlertsService.alerts({ count, includeSaved })                        -> AlertList
HealthService.health({ includeLicense })                             -> HealthReport
```

这些模型都提供 `toPublicDict()`，与 CLI 的 `--json` 输出**完全一致**。

### 6.4 典型的排查流程

本文档只描述该流程，**项目本身不实现它**——实现者是调用方：

```text
用户：「分析最近一小时 API 500 的原因」

调用方：
  1. splunk-cli health                                   先确认访问权限
  2. splunk-cli timeline "index=api status=500" --span 1m          找出异常时间窗口
  3. splunk-cli stats    "index=api status=500" --by service       哪个服务占主导
  4. splunk-cli search   "index=api status=500 service=payment" --limit 50
  5. splunk-cli stats    "index=api status=500 service=payment" --by host
  6. splunk-cli search   "index=api trace_id=<id>"                 拉取完整链路
  7. 综合分析根因
```

---

## 7. 已知限制

* **设计上只读。** 无写入路径、不能删除 Job、不能修改告警。
* **`fields` 使用 `| fieldsummary`**，结果准确但在超大索引上开销不低，请缩小时间范围。
* **告警端点存在版本差异。** `/services/alerts/fired_alerts` 在 Splunk 9.2 中已被移除，
  各 8.x 补丁版本行为也不一致。该端点不可用时返回空列表加一个 `note`、退出码为 0。
* **`health` 可能为 `unknown`。** Splunk 8.0.2 的 `/services/server/info` 并不总是返回
  `health` 字段；此时如实透传，不臆造取值。
* **仅在静态可判定时校验时间范围（已决策接受）。** 任何含 `@` 的表达式都不在本地做跨度
  检查，包括具名整窗（`last-month` = `-1mon@mon → @mon`）：`SPLUNK_MAX_TIME_RANGE`
  对它们**不生效**，宽度由 Splunk 按搜索用户时区解析——CLI 拿不到那个时区，本地硬算会在
  时区不一致或夏令时切换时误判。因此 `--range last-year` 可能真扫一整年（某实例实测约
  857 万事件 / 36 秒）；兜住它的是 Job 墙钟预算（`SPLUNK_SEARCH_TIMEOUT`，超时退出码 7）
  与 Splunk 侧配额，而不是本地上限。详见 3.2。
* **`truncated` 偏保守。** 恰好返回 `limit` 条且可能还有更多时也会是 `true`。
* **License Pool 可能为空**——当认证用户缺少 license 相关能力时；此时 `health` 会优雅降级
  而不是报错。
* **自签证书 + `SPLUNK_CA_BUNDLE` 未必可用**，取决于证书是否带 SAN（见 2.3）。

---

## 8. 故障排查

| 现象 | 退出码 | 原因与处理 |
| --- | --- | --- |
| `missing required configuration` | 2 | 导出 `SPLUNK_URL`、`SPLUNK_USERNAME`、`SPLUNK_PASSWORD`，或 `splunk-cli init` 后编辑配置 |
| `self-signed certificate in certificate chain` | 4 | 校验默认开启，而 Splunk 默认证书是自签的（`SplunkServerDefaultCert`）：按 2.3 配好 `SPLUNK_CA_BUNDLE`，或在开发环境设 `SPLUNK_VERIFY_SSL=false` |
| `Hostname/IP does not match certificate's altnames` | 4 | 证书没有覆盖你连接名字的 SAN（见 2.3）：按 IP 连接时配 CA 也没用，只能换带 SAN 的证书或设 `false` |
| `authentication failed (HTTP 401)` | 3 | 凭据错误，或该用户无权读取 `/services/server/info` |
| `HTTP 502` / 网关错误 | 5 | 系统代理拦了内网请求；保持 `SPLUNK_TRUST_ENV=false` |
| `did not finish within 60s` | 7 | 缩小时间范围、追加 `\| head N`，或调高 `SPLUNK_SEARCH_TIMEOUT` |
| `exceeds the maximum allowed range` | 6 | 缩小窗口，或在明确知晓代价的前提下调高 `SPLUNK_MAX_TIME_RANGE` |
| `SPL command 'rest' is not permitted` | 6 | 只读策略；请改用受支持的命令 |
| 配置成了 8000 端口 | — | 8000 是 Web UI，REST API 在 **8089** |

调试请使用 `--verbose`。日志输出到 stderr，任何日志级别都不会打印凭据内容。
