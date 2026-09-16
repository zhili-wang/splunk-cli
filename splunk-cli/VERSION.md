# 版本更新记录

<div style="margin: 8px 0 16px;">
  <span style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px; background: linear-gradient(135deg, #3b82f6, #8b5cf6); color: #fff; font-size: 12px; font-weight: 500; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; box-shadow: 0 2px 8px rgba(59,130,246,0.3);">
    <span style="width: 6px; height: 6px; border-radius: 50%; background: #fff;"></span>
    author: Alex
  </span>
</div>

`splunk-cli` 的版本更新历史。安装步骤见 [INSTALL.md](./INSTALL.md)，完整用法见 [USAGE.md](./USAGE.md)。

## 版本约定

* **版本号的单一来源是 `package.json`**：`splunk-cli --version` 与分发包名都从它读取。
* 版本号只升不降；功能增量升 minor，修缺陷不升。
* 每次发版在本文件追加一条记录，并在交付目录里同时更新 `INSTALL.md` / `USAGE.md`（如涉及行为变化）。

---

## [0.1.0] - 2026-09-16

首个版本：**只读、结构化、面向调用方**的 Splunk 日志读取工具。一条 `npm install -g`
装好 CLI 与本地调查面板，全程不写入 Splunk。

### Added

**核心链路**

- **Splunk REST 客户端（`SplunkClient`）**：直连官方 REST API，不依赖任何第三方 Splunk 客户端库。
  - `server_info()` → `GET /services/server/info`
  - `create_search_job()` → `POST /services/search/jobs`（返回 `sid`）
  - `get_search_job()` → `GET /services/search/jobs/{sid}`（读取 `dispatchState` / `isDone` / `isFailed` / `isFinalized` / `resultCount` / `eventCount`）
  - `get_search_results()` → `GET /services/search/jobs/{sid}/results`（支持 `count` / `offset`，自动分页）
  - `wait_for_search()`：轮询带三重保护——墙上时钟预算、最大轮询次数、轮询间隔，**绝不无限等待**；正确区分 `DONE` / `FAILED` / `CANCELLED`。

- **HTTP 传输层（`HttpClient`）**：超时、TLS 校验、Basic Auth、错误翻译、谨慎重试。
  - 重试仅限传输层故障与 `502/503/504`；**认证失败与 `400/401/403` 绝不重试**，最多 3 次指数退避。
  - 搜索 Job 轮询与 HTTP 重试是**两套独立机制**，互不混淆。

**CLI 命令（10 个）**

- `health`：连通性 + 认证 + 版本 + License 状态。用**真实业务端点** `/services/server/info` 验证认证，不依赖 `/services/auth/login`。
- `search`：只读 SPL 搜索，支持 `--earliest` / `--latest` / `--range` / `--limit` / `--timeout`。
  - 时间范围三种给法：`--earliest`+`--latest`（单端字面量）、`--range <名字>`（一个名字给出
    整个窗口，如 `last-month`、`this-week`）、`--range <时长>`（`7d` = `-7d → now`）。三者
    混用会被拒绝（退出码 6）而不是让其中一个静默生效。
  - 具名时间与面板「日历」预设同义：`today` / `yesterday` / `week`（= `@w`）/ `month`
    （= `@mon`）/ `year`（= `@y`），以及 `this-week` … `last-year` 八个整窗名字。
  - 文本摘要里给出 Job **实际执行**的时间窗（带本地时区偏移的 ISO-8601）、耗时，采样非
    1:1 时标注"近似值"；没有命中时同样报窗口。`stats` / `timeline` / `fields` 共用同一套
    时间范围选项。
- `stats`：`--by` 分组聚合，自动构造 `| stats count by <field> | sort - count | head N`；`--function` 支持 `count` / `dc` / `sum` / `avg` / `min` / `max`。
- `timeline`：`| timechart span=<span> count` 事件量趋势，文本输出附 unicode sparkline。
- `fields`：`| fieldsummary` 字段发现，`--details` 附出现次数 / 去重数 / 高频取值。
- `alerts`：只读列出已触发告警与（`--saved`）已保存搜索。
- `config`：查看生效配置（**密码永远脱敏为 `<set>` / `<unset>`**），`--check` 在配置不全时返回退出码 2。
- `limits`：查看当前生效的安全上限，并附带 Job 运行预算（`timeout` / `search_timeout` /
  `poll_interval`）；`search_timeout` 报的是 `max(SPLUNK_SEARCH_TIMEOUT, SPLUNK_TIMEOUT)` 的生效值。
- `init`：显式初始化全局配置目录。
- `dashboard`：启动本机只读调查面板（见下）。

**本地调查面板（`splunk-cli dashboard`）**

- 在 `127.0.0.1:8765` 启动面板，浏览器打开 `http://127.0.0.1:8765` 即可使用。
  `--port` / `-p` 可改端口（取值 1–65535）。**固定绑定回环地址**，不监听外部网卡。
- 标题栏图标：白色 mark 放在面板自己的最深底色（`#08090C` = `--ink-950`）上——白 mark 在
  浅色标签页里等于看不见。`web/assets/appIcon.png` 是 36×36 的透明底原图，
  `web/public/appIcon.png` 是 180×180 的成品（Vite 的 publicDir 会原样复制进 `dist/web`），
  `web/index.html` 同时声明 `rel="icon"` 与 `rel="apple-touch-icon"`，并用
  `theme-color` 让移动端浏览器 chrome 也保持这块黑。

  ```bash
  splunk-cli dashboard
  splunk-cli dashboard --port 9000
  ```

- **复用 Service 层，不是第二份实现**：每个端点只调用一个既有 Service
  （`SearchService` / `StatsService` / `TimelineService` / `AlertsService` /
  `HealthService`），返回该 Service 模型 `toPublicDict()` 的结果。因此页面上的数据与
  `splunk-cli ... --json` 一致（JSON 值相同）。路由层**不构造 SPL**，也**不直接触碰
  Splunk REST API**。

  | 方法 | 路径 | 职责 |
  | --- | --- | --- |
  | `GET` | `/api/health` | 连通性 / 认证 / 健康状态（`include_license=false` 省掉一次远端调用） |
  | `POST` | `/api/search` | 只读 SPL 搜索，返回结果集 |
  | `POST` | `/api/stats` | `\| stats` 分组聚合 |
  | `POST` | `/api/timeline` | `\| timechart` 时间分桶 |
  | `GET` | `/api/alerts` | 已触发告警（`include_saved=true` 附带已保存搜索） |
  | `POST` | `/api/overview` | 首屏聚合：时间线 + 两个分组分布 + 派生指标，一次往返 |
  | `GET` | `/api/version` | 面板自己这一版的版本号（读包元数据，**不读 Splunk**），页脚显示 |

  `/api/overview` 的三条子查询**并发执行且独立失败**：某一路失败只让该面板及其指标变成
  `null`，其余照常返回；时间线失败则整条响应视为失败（首屏不可用）。响应里的 `partial`
  字段如实说明是否有面板缺失——`null` 表示「没能查到」，`0` 表示「确实没有」。

- **前端面板（3 个视图）**：总览（时间范围选择器、查询框、指标卡、事件量时间线、
  按 `service` / `host` 分布）、查询（只读 SPL 搜索结果表格）、告警（已触发告警列表），
  外加顶部常驻的连接状态徽章（轮询 `/api/health`）。
  - 时间范围选择器分两组共 16 个预设：**最近**（`5m`…`7d`，全部在本地 7 天上限内）与
    **日历**（今天 / 昨天 / 本周 / 前一周 / 本月 / 上月 / 今年 / 上一年，写成 `@d`、
    `-1mon@mon` 这类 Splunk 对齐表达式）。日历窗口的宽度前端算不出来，因此显示
    「窗口宽度由 Splunk 端求值」，并且本地上限不参与判定——它的边界由 Splunk 自己兜底。
  - 「自定义」编辑器有两种模式：相对（数值 + 秒/分钟/小时/天，提交时机为失焦或回车）、
    绝对（本机时区的起始/结束时间 + 「此刻」），模式由当前范围反推，不额外存状态。
    从日历预设进入编辑器时不会把 `@mon` 这类写不进输入框的字面量带进去（那会让两个时间框
    空白且与摘要行自相矛盾），而是回落到默认的 `-1h → now`。
  - 时间线分桶：能算出宽度的窗口按 ≤120 桶选跨度；算不出宽度的（日历预设）固定用
    `1d`——细跨度会被后端 500 桶上限截断，导致柱状图只覆盖窗口开头、与下方事件表自相矛盾。
    桶数打满时表头会显式提示「可能未覆盖整个窗口」。
  - 时间线格式可在**柱状 / 折线 / 面积**之间切换，选择记在浏览器里（跨刷新保留）。折线与
    面积按**阶梯**绘制（每个值覆盖整列，而不是列起点的那一瞬间），因此图形与刷选命中的列严
    格对齐。鼠标移上任一列立即弹出工具提示（`{时间} · {N} 个事件`），不依赖浏览器 `title`
    的约一秒延迟。
  - 搜索完成后显示 **Job 状态栏**：状态（完成 / 进行中 x% / 失败）、事件数、**Splunk 实际
    执行的时间窗**（`@mon` 这类表达式落到哪两个瞬间）、耗时、扫描条数；采样不是「无采样」时
    显式警示「结果为近似值」。可展开「任务详情」查看 sid、调度状态、请求/实际时间窗、结果
    条数、事件数、扫描条数与运行时长。全部是只读元数据——**没有**暂停 / 停止 / 删除 / 编辑
    任务的入口。
  - 事件面板提供「导出 CSV」：只导出**当前页已渲染的可见列**（浏览器本地生成，不调用
    Splunk 的 `search/jobs/export`——那个端点会绕过结果条数上限，属于禁用项）。

**全局配置目录 `~/.splunk-cli`**

- 首次运行任意命令自动创建，并写入带注释的配置模板（`config.env`，`chmod 600`；目录 `chmod 700`）。
- **幂等且绝不覆盖已有配置**（`O_CREAT|O_EXCL`）；`$HOME` 不可写时优雅降级，不影响仅用环境变量的用户。
- 配置优先级：`SPLUNK_*` 环境变量 > `~/.splunk-cli/config.env` > `./.env` > 内置默认值。
- 位置可用 `SPLUNK_CONFIG_DIR` 覆盖。
- 连接地址按「主机 + 端口」分开配置：`SPLUNK_HOST` 不带协议与端口，`SPLUNK_PORT` 默认
  `8089`，工具自行拼出 `https://<host>:<port>`。`SPLUNK_URL` 保留为可选的完整 URL 覆盖
  （反代或带路径前缀的部署），设置后优先于 HOST/PORT，`config` 输出的 `url_source`
  会说明地址来源。模板中不预填任何具体环境地址。
- `SPLUNK_TRUST_ENV` 默认 `false`：不继承系统代理。Splunk 通常在内网，静默走开发机代理
  会产生难以排查的 `HTTP 502` 网关错误。

**输出契约**

- `--json` / `-j` 为一等能力，所有命令均支持，子命令前后位置均可。
- 成功信封 `{"success": true, ...}`；失败信封 `{"success": false, "error": {"type", "message", "details?"}}`。
- **稳定退出码**：`0` 成功、`1` 一般错误、`2` 配置、`3` 认证、`4` 连接、`5` 查询、`6` 安全限制、`7` 超时。
- `truncated` 字段显式告知调用方「服务端还有更多数据」，避免基于不完整分页下结论。
- 文本输出为对齐表格，CJK 宽度感知（东亚宽字符按 2 列计）。
- 数字格式由 `server/format.ts` 统一收敛（`%g` 风格，6 位有效数字）。

**Node API**

- 全部命令都有对应的 Node API，返回的模型提供 `toPublicDict()`，与 `--json` 输出完全一致，
  便于 MCP / 上层运行时直接复用服务层。分层：CLI 与 Web 都只调用 Service，Service
  只调用 `SplunkClient`，`SplunkClient` 只调用 `HttpClient`，依赖只能向下。

**安全限制（只读）**

- 端点白名单：仅 `/services/server/info`、`/services/licenser/pools`、`/services/search/jobs*`、`/services/saved/searches`、`/services/alerts/fired_alerts`。
- 始终拒绝 `DELETE` / `PUT` / `PATCH` / `HEAD`，以及 `/services/admin/*`、`/services/authentication/*`、`/services/authorization/*`、`/services/configs/*`、`/services/data/*`、`/services/apps/*`、`/services/cluster/*`、`/services/search/jobs/export` 等。
- 强制上限：结果数 5000、时间跨度 7d、查询长度 10000、搜索超时 60s。**超限直接拒绝，绝不静默改写用户参数。**
- SPL 词法黑名单（**不是解析器**）：仅在管道命令位置匹配，拒绝 `delete`、`collect`、`mcollect`、`tscollect`、`outputlookup`、`outputcsv`、`rest`、`script`、`sendalert`、`runshellscript`、`map` 等。其中 `| rest` 可调用任意端点（含写入 API），不封禁会让其余防护形同虚设。
- 密钥零泄漏：`sanitize_message()` 过滤所有进入错误信息的远端字符串；`Settings.redacted()` 是配置唯一渲染出口。**任何日志级别都不打印密码、Authorization 头、Session Token 或 Cookie。**

- **面板的额外边界**：
  - **Host 白名单**只接受 `127.0.0.1` / `localhost` / `::1`。仅绑定回环**挡不住** DNS
    Rebinding——`evil.com` 解析到 `127.0.0.1` 后浏览器会代攻击者发请求——因此额外校验
    `Host` 头，而浏览器无法伪造它。`Origin` 头作为纵深防御一并校验。非白名单请求返回
    `403` + 标准错误信封（`type: "ForbiddenOrigin"`）。
  - **凭据不下发到浏览器**：Splunk 用户名 / 密码 / Session Token 只存在于服务端进程内存。
  - **只读**：不能启用 / 停用 / 修改 / 删除告警——路由层根本没有对应端点，端点白名单是第二道独立屏障。
  - **同源**：前端由 API 自己的 origin 提供，因此不配置 CORS 规则。SPA 回退路由注册在
    API 路由**之后**，`/api/*` 永远归 API 所有，不会被 HTML 吞掉。
  - 静态资源服务对解析后的路径做校验，避免目录穿越。

### Packaging

- **单一跨平台安装包**：在交付目录里执行 `npm install -g ./splunk-cli.tgz`。前置依赖只有
  **Node.js >= 20**。

  ```text
  splunk-cli/
  ├── splunk-cli.tgz                        ← 安装包（单文件跨平台，已含前端产物）
  └── INSTALL.md / USAGE.md / VERSION.md
  ```

- 交付目录同时提供版本化 zip（`releases/splunk-cli-v0.1.0.zip`），内含三份指南与安装包本身。
- 归档里**只有压缩后的单文件 bundle 与前端静态资源**：没有 `server/**/*.ts` 源码、
  没有 source map、没有凭据，也没有构建链（`package.json` 的 `scripts` /
  `devDependencies` / `private` 会被删掉）。
- **可复现构建**：归档条目的 mtime 固定、条目名排序、gzip 的 mtime 归零，因此同一份源码
  两次构建产出**逐字节一致**。`npm run pack:verify` 会完整打包两次（各自重新构建）并比对
  sha256 自证这一点。
- 发布工作流（`.github/workflows/release.yml`）只有 **ubuntu 一个平台**：产物是纯
  JavaScript bundle，esbuild / Vite 的输出与平台无关，不需要 matrix 交叉编译。

### Testing

- **516 个单元测试全部通过，0 failed**：后端与 CLI 384 个，前端面板 132 个。
- **18 个集成测试**默认跳过，仅在 `RUN_SPLUNK_INTEGRATION_TESTS=1` 时执行；凭据只从环境变量读取，绝不硬编码。
- 单测不打桩到「函数级别」，而是留在**真实的 HTTP 边界**上：响应蓝本取自
  `test/fixtures/splunk/*.json`（从真实实例抓取并自动脱敏），传输层用注入的 `fetch` 驱动；
  CLI 层起一个真实的本地 `node:http` 服务端到端验证，于是退出码、stdout/stderr 分流、
  JSON 信封都能在进程级别断言。
- 覆盖要求的失败矩阵：成功、认证失败、连接失败、超时、Job 失败、Job 超时、空结果、畸形结果。
- **分档覆盖率门禁**由 `scripts/check-coverage.mjs` 判定：后端总体 ≥ 88%、
  `bin/splunk-cli.ts` ≥ 88%、`server/client/http.ts` ≥ 90%、`web/src/**` ≥ 95%。
  报告为机器可读的 `coverage-summary.json`，由门禁脚本读取。
- 门禁：`tsc --noEmit`（`strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`）
  与前端 typecheck 通过。
- `npm run verify:live` 是**对着真实实例**逐条执行的 19 项验收清单：认证走真实业务端点
  （用记录请求的本地转发代理实测，而不是读代码）、各命令对真实数据返回、超时与安全上限
  的退出码、面板六个 API 与 `Host` 防护、`--verbose` 全流程日志不含凭据、以及源码形态与
  打包形态行为一致。它默认不执行，需要已配置可用的 Splunk。

### Known Limitations

- 只读：无写入路径、不能删除 Job、不能修改告警。
- 面板是**单用户本机工具**：固定绑定回环地址，无认证、无多用户隔离。**不要**用端口转发或
  反向代理把它暴露到网络上——Host 白名单正是为此而设，绕过它等于放弃这层防护。
- 前端为单个 bundle（682 KB，gzip 228 KB），未做代码分割。
- 仅在静态可判定时校验时间范围；需服务端求值的表达式（如 `-1d@d`）交由 Splunk 自身限制兜底。
- `/services/alerts/fired_alerts` 在 Splunk 9.2 已移除且各 8.x 补丁版本行为不一；
  端点不可用时返回空列表 + `note`，退出码 0。
- 原始事件搜索的 `truncated` 恒为 `false`：Job 创建时以 `limit` 作为 `max_count`，
  因此「多要一行」的探测取不到数据。`stats` 一类转化型搜索不受影响。
  **调用方不应把原始事件搜索的 `truncated=false` 读成「已拿到完整结果集」。**
- 已验证环境为 Splunk Enterprise 8.0.2。

### Security

- 不使用第三方 Splunk 客户端库；直接基于官方 REST API 实现。
- 凭据不写入源码、README、测试、日志或异常。
- 面板的 Host / Origin 白名单抵御 DNS Rebinding；非白名单请求一律 `403`。
