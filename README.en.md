# Splunk CLI

> [中文文档](https://github.com/zhili-wang/splunk-cli/blob/main/README.md) | **English**

A **safe, stable, structured, caller-oriented** tool for reading Splunk logs.

`splunk-cli` provides both a convenient command line and a stable JSON contract, and both share the same core. Its reason for existing is to let Claude Code, Codex, and future MCP Servers query and analyze Splunk through **one read-only implementation** instead of each re-inventing its own HTTP client.

> **Phase 1 scope: reliably fetch and structure Splunk data.**
> Reasoning over that data is the caller's responsibility, not this tool's. This phase has no LLM, no RAG,
> no MCP Server, and no write path of any kind.

**This project does not depend on `cbrito/splunk-client`** (nor on any other Splunk client library);
it calls Splunk's official REST API directly over HTTPS.

---

## Table of Contents

1. [Why This Exists](#1-why-this-exists)
2. [Architecture](#2-architecture)
3. [Installation](#3-installation)
4. [Configuration](#4-configuration)
5. [Connecting to Splunk](#5-connecting-to-splunk)
6. [CLI Usage](#6-cli-usage)
7. [JSON Output](#7-json-output)
8. [Safety Limits](#8-safety-limits)
9. [Testing](#9-testing)
10. [Caller Integration Design](#10-caller-integration-design)
11. [MCP Roadmap](#11-mcp-roadmap)
12. [Known Limitations](#12-known-limitations)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Why This Exists

Splunk's REST API is powerful, but letting callers use it safely is awkward:

* Searches are asynchronous (create job → poll → fetch results → clean up);
* Responses are wrapped in Splunk-specific envelopes, and the format differs from one endpoint to another;
* It is easy to accidentally fire off an expensive query spanning 30 days, or to hit an admin endpoint that changes configuration;
* Failures are reported inconsistently, so callers cannot reliably branch on the failure type.

`splunk-cli` solves exactly these four problems and nothing else:

| Problem | Solution |
| --- | --- |
| The tedious asynchronous search flow | `SplunkClient` centrally handles job creation, polling, and paged result retrieval |
| Inconsistent response formats | zod models converge them into a single stable public JSON structure |
| Accidental destruction or high cost | A read-only whitelist plus enforced result-count / time-range / query-length limits |
| Opaque failure reasons | A named error hierarchy plus stable exit codes |

---

## 2. Architecture

The stack is **TypeScript on Node.js 20+**, with strict one-way layering: each layer knows only the layer below it.

```text
                  ┌──────────────┐
                  │     CLI      │   bin/splunk-cli.ts     argument parsing, rendering, exit codes
                  └──────┬───────┘
                         │
                  ┌──────▼───────┐
                  │   Services   │   server/services/      business flow, result shaping
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
                  │ SplunkClient │   server/client/splunk.ts   REST API, jobs, polling
                  └──────┬───────┘
                         │
                  ┌──────▼───────┐
                  │ HTTP Client  │   server/client/http.ts     timeout, TLS, auth, retries
                  └──────┬───────┘
                         │
                    HTTPS :8089
                         │
                  ┌──────▼───────┐
                  │    Splunk    │
                  └──────────────┘
```

Cross-cutting modules:

| Module | Responsibility |
| --- | --- |
| `server/config/settings.ts` | Layered config source merging, secret redaction |
| `server/config/paths.ts` | Creation, template, and permissions of the global config directory `~/.splunk-cli` |
| `server/errors.ts` | Error hierarchy (zero dependencies, importable from every layer) |
| `server/models/` | Data models: `search`, `result`, `alert`, `health` |
| `server/safety/` | `limits.ts` (policy, whitelist) and `validator.ts` (SPL validation) |
| `server/output/` | `envelope.ts` (envelope + exit codes) and `table.ts` (text tables) |
| `server/format.ts` | `%g`-style number formatting (`2.592e+06`, `604800.0`) — the numeric contract converges here |
| `server/logger.ts` | Zero-dependency stderr logging that never prints credentials at any level |

**Rules enforced during review (see `AGENTS.md`):** dependencies may only point downward; the CLI never
touches HTTP; Services never construct `undici` requests; `SplunkClient` never formats output and never
decides policy.

### Web Dashboard (`server/web/`)

`server/web/` is a **peer** of `bin/splunk-cli.ts`; both are callers of the Service layer. It must obey:

* Never import CLI modules (dependencies point downward only; Web and CLI do not depend on each other)
* Never import `undici`, and never construct Splunk REST requests directly
* Never assemble SPL by hand — all SPL is generated by the Service layer or by `safety/validator.ts`
* Return the Service models' public structures as-is (the sole exception is the aggregate envelope of
  `POST /api/overview`; its three sub-panels are still passed through untouched)
* Add no write endpoints; alert enable / disable / delete / update are never implemented

The frontend (`web/`) is React 18 + Vite, and its build output is served by the same Express app on the
**same origin** — so the browser calls `/api/...` directly, with no need for CORS and no credentials
anywhere in the page.

---

## 3. Installation

Requires **Node.js 20+**.

### Install from a distribution package (recommended)

```bash
npm install -g ./splunk-cli/splunk-cli.tgz
splunk-cli --help
splunk-cli --version
```

The `splunk-cli/` distribution directory contains only the compressed single-file bundle and the frontend
static assets; it ships no readable source and no build chain. See [Distribution](#distribution).

### Build from source

```bash
git clone <repository-url> splunk-cli
cd splunk-cli
npm install
npm run build                     # esbuild builds the backend bundle + Vite builds the frontend
node dist/bin/splunk-cli.mjs --help
```

Frontend and backend dependencies live in the single root `package.json` — `web/` has no manifest of its
own — so one `npm install` sets up both.

During development you don't need to build every time — use `npm run dev` to run the TypeScript source
directly.

On the first run of any command after installation, the global config directory is created at
`~/.splunk-cli` and a template is written into it (see [Configuration](#4-configuration)).

### Visual Dashboard

```bash
splunk-cli dashboard
```

Open `http://127.0.0.1:8765` in your browser.

A source checkout (`git clone`) does **not** contain the frontend build output — `npm run build` runs Vite
along the way, emitting the frontend to `dist/web`, which is where `dashboard` reads it from. There are two
paths to choose from:

**Dev server (fastest):** `dashboard` serves only the API, and the page is left to Vite:

```bash
npm run dev -- dashboard          # in a separate terminal
npm run dev:web                   # http://localhost:5173
```

Vite's `/api` proxy points at the local `dashboard`.

**Production build:** a single command at the **repository root** (it type-checks the frontend first, then
runs Vite):

```bash
npm run build
```

The output lands in `dist/web` — exactly where the server looks for it.

If you take neither path, opening the page yields `FrontendNotBuilt` (HTTP 503, with the remedy included in
the response).

---

## 4. Configuration

After installation and the first run, the CLI automatically creates the global configuration directory
`~/.splunk-cli` and writes a commented configuration template into it. **You only need to fill in
credentials once.**

```text
~/.splunk-cli/
└── config.env      SPLUNK_* connection settings and safety limits (chmod 600)
```

The directory permissions are `700` and the config file is `600`. The directory contains **only** the
single file `config.env` — no extra documentation is placed there, so nothing competes for attention with
the real configuration.

The first run prints a hint (to stderr, so it never pollutes the `--json` stdout):

```text
splunk-cli: initialized configuration directory /Users/you/.splunk-cli
splunk-cli: fill in SPLUNK_URL, SPLUNK_USERNAME and SPLUNK_PASSWORD in
             /Users/you/.splunk-cli/config.env
splunk-cli: then run `splunk-cli health` to verify the connection
```

Edit that file to fill in your credentials, then verify:

```bash
splunk-cli config     # show the effective configuration (secrets redacted)
splunk-cli health     # verify connectivity, TLS, and credentials
```

You can also initialize explicitly (idempotent, and it **never overwrites existing configuration**):

```bash
splunk-cli init
splunk-cli init --json
splunk-cli --version   # also shows the configuration directory in use
```

### Configuration precedence

```text
environment variables  >  ~/.splunk-cli/config.env  >  ./.env  >  built-in defaults
```

So you can override a single value for just one run:

```bash
SPLUNK_MAX_RESULTS=100 splunk-cli search "index=main | head 5"
```

To keep configuration somewhere else (for example an encrypted directory or an XDG layout):

```bash
export SPLUNK_CONFIG_DIR=/secure/path/splunk-cli
```

> The repository also keeps `.env.example` for reference, so you can run
> `cp .env.example .env` for local development. Regular use, however, is better served by the global
> configuration directory, which saves you from filling things in again in every working directory.

| Variable | Default | Description |
| --- | --- | --- |
| `SPLUNK_CONFIG_DIR` | `~/.splunk-cli` | Location of the global configuration directory |
| `SPLUNK_URL` | *(required)* | REST API address, e.g. `https://host:8089` |
| `SPLUNK_USERNAME` | *(required)* | Splunk user for Basic Auth |
| `SPLUNK_PASSWORD` | *(required)* | Splunk password |
| `SPLUNK_VERIFY_SSL` | `true` | Verify the TLS certificate (enabled by default). With the default self-signed certificate you need `SPLUNK_CA_BUNDLE`, or set this to `false` in development; see §5 TLS |
| `SPLUNK_CA_BUNDLE` | *(unset)* | Path to a PEM-format CA certificate (optional) |
| `SPLUNK_TIMEOUT` | `30` | Timeout for a single HTTP request (seconds) |
| `SPLUNK_MAX_RESULTS` | `5000` | Hard cap on the number of results per request |
| `SPLUNK_MAX_TIME_RANGE` | `7d` | Hard cap on the search time span |
| `SPLUNK_POLL_INTERVAL` | `1` | Search job polling interval (seconds) |
| `SPLUNK_SEARCH_TIMEOUT` | `60` | Wall-clock budget for a single search job |
| `SPLUNK_MAX_QUERY_LENGTH` | `10000` | Maximum SPL length |
| `SPLUNK_MAX_RETRIES` | `3` | Transport-layer retry count (4xx / auth failures are never retried) |
| `SPLUNK_RETRY_BACKOFF` | `0.5` | Exponential backoff base (seconds) |
| `SPLUNK_TRUST_ENV` | `false` | Whether to use proxy environment variables / system proxy settings |

You can inspect the effective configuration at any time, and **secrets are always redacted**:

```bash
splunk-cli config           # shows only `password  <set>` / `<unset>`, never plaintext
splunk-cli config --json
splunk-cli config --check   # exits with code 2 when a required value is missing
splunk-cli limits           # effective safety limits and job run budgets
```

> **About proxies.** `SPLUNK_TRUST_ENV` defaulting to `false` is deliberate. Splunk usually sits on an
> internal network, and silently routing its management API through a dev machine's system proxy only
> produces confusing gateway errors. Set it to `true` only when you really do need to reach Splunk through
> a proxy.

---

## 5. Connecting to Splunk

Use the **management port**, usually `8089` — not the Web UI's `8000`:

```bash
export SPLUNK_HOST="203.0.113.10"
export SPLUNK_PORT="8089"
export SPLUNK_USERNAME="splunk_user"
export SPLUNK_PASSWORD="..."            # prefer .env over shell history
export SPLUNK_VERIFY_SSL="false"        # template default; the connection stays encrypted, only identity verification is skipped (see §5 TLS)
```

Then:

```bash
splunk-cli health
```

### TLS

**Verification is enabled by default** (`SPLUNK_VERIFY_SSL=true`). The connection is **always encrypted**;
this switch only decides whether to additionally "prove the peer's identity".

Splunk Enterprise ships with a self-signed certificate (`SplunkServerDefaultCert`) issued by Splunk's own
CA and with **no SAN extension**, so verification always fails on a default installation. Two approaches:

```bash
# Recommended: trust the CA that issued the server certificate (include the whole chain; the leaf alone is not enough)
export SPLUNK_VERIFY_SSL=true
export SPLUNK_CA_BUNDLE=/path/to/splunk-ca.pem

# Development only: skip identity verification
export SPLUNK_VERIFY_SSL=false
```

Configuring a CA has two prerequisites: the bundle must contain **the CA that issued the server
certificate**, and the certificate must carry a SAN covering **the name you actually connect to** —
connecting by IP requires an `iPAddress` SAN, and the CN never participates in IP matching. Splunk's
default certificate has no SAN, so connecting by IP fails verification even with a CA configured.

### Authentication

Authentication is verified against a **real business endpoint**, `GET /services/server/info`, together with
Basic Auth — not `/services/auth/login`. A successful `splunk-cli health` therefore proves connectivity,
TLS, and credentials all at once.

---

## 6. CLI Usage

All commands accept `--json` (`-j`) and `--verbose` (`-v`), and these may appear before or after the
subcommand.

### `health`

```bash
splunk-cli health
splunk-cli health --json
splunk-cli health --no-license       # skip the License Pool query
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
splunk-cli search "index=app level=ERROR" --range last-month      # the whole previous month
splunk-cli search "index=_internal | head 10"
```

The summary line of the text output carries the time window the job **actually executed** over (only the
server knows which two instants expressions like `@mon` or `last-month` resolve to) along with the elapsed
time; the window is reported even when nothing matched. `--range`, `--earliest`, and `--latest` mean
exactly the same thing on `stats` / `timeline` / `fields`. For the complete set of time syntaxes and names,
see [`splunk-cli/USAGE.md`](splunk-cli/USAGE.md) §3.2.

| Option | Default | Description |
| --- | --- | --- |
| `--earliest`, `-e` | `-1h` | Start time: relative offset (`-30m`, `-7d`, `-1mon`, `-1y`), snap-to (`@d`, `@w0`, `@mon`, `@y`), a combination of the two (`-7d@w0`), named (`now`, `today`, `yesterday`, `week`, `month`, `year`), ISO-8601, epoch |
| `--latest`, `-l` | `now` | End time, same values as above |
| `--range`, `-r` | — | Gives the **entire window** at once: `today`, `yesterday`, `this-week`, `last-week`, `this-month`, `last-month`, `this-year`, `last-year`, or a duration (`7d` → `-7d → now`). Combining it with `-e`/`-l` is rejected |
| `--limit`, `-n` | `5000` | Maximum number of results (rejected outright if it exceeds `SPLUNK_MAX_RESULTS`) |
| `--timeout` | `60` | Search job budget (seconds) |
| `--json`, `-j` | off | Emit the stable JSON envelope |

### `stats`

```bash
splunk-cli stats "index=app level=ERROR" --by service
splunk-cli stats "index=app level=ERROR" --by service,host --function dc --limit 20 --json
```

Generates safe SPL using only validated identifiers:

```spl
index=app level=ERROR | stats count by service | sort - count | head 5000
```

`--function` supports `count`, `dc`, `sum`, `avg`, `min`, `max`; at most 4 group-by fields are allowed.

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

Field discovery for callers: understand an index's field structure before writing more SPL. Implemented
with `| fieldsummary`.

### `alerts`

```bash
splunk-cli alerts
splunk-cli alerts --saved --json
```

**Read-only.** Enabling, disabling, modifying, and deleting alerts are not implemented, and they are
blocked by the endpoint whitelist.

### `dashboard`

```bash
splunk-cli dashboard
splunk-cli dashboard --port 9000
```

Starts the investigation dashboard locally. The dashboard reads Splunk through **the same Service layer**,
so the data on the page is exactly the same as `splunk-cli ... --json` (identical JSON values, differing
only in indentation whitespace: the CLI uses `indent=2`, while HTTP responses are compact).

* **Read-only**: it never writes to Splunk and cannot enable, disable, modify, or delete alerts.
* **Local only**: it binds to `127.0.0.1` unconditionally and validates the `Host` header against DNS
  rebinding.
* **The frontend never touches credentials**: the browser never stores a Splunk password or session token.
* **The frontend cannot bypass limits**: time ranges and result-count caps are enforced by the Service
  layer, and anything over the limit is rejected outright.

After a successful start it registers itself in `~/.splunk-cli/servers.json` and unregisters on graceful
shutdown; `stop-web` uses that registry (plus a process scan as a fallback) to find it.

### `stop-web`

```bash
splunk-cli stop-web            # stop every locally running dashboard
splunk-cli stop-web --no-scan  # only stop servers recorded in the registry, don't scan the process table
splunk-cli stop-web --json
```

Stops every dashboard started by this CLI that is still listening. Each stop walks a **three-level
ladder**: first `POST /api/shutdown` asks it to shut down gracefully, then falls back to `SIGTERM`, and
after a timeout it **reports the failure honestly and never escalates to `SIGKILL`** — a hard kill would
skip the process's own cleanup (unregistering from the registry, releasing the port, flushing logs).

* **Two clues for locating**: it reads the `~/.splunk-cli/servers.json` registry first, then scans `ps`
  for processes whose command line contains `splunk-cli dashboard` (a fallback if the registry is lost).
  Every candidate must pass a loopback port probe to confirm its identity — it never touches a process
  that does not belong to this CLI.
* **No Splunk credentials needed**: this command deliberately does not read config or connect to Splunk —
  a user often wants to stop the dashboard precisely because Splunk is unreachable.
* **Exit codes**: 0 = all stopped / nothing was running; 1 = at least one failed to stop.

### `init`

```bash
splunk-cli init
splunk-cli init --json
```

Creates `~/.splunk-cli` and its configuration template. The first run of any command after installation
does this automatically; `init` makes it explicitly invocable. **Idempotent**: existing configuration is
never overwritten.

### `config` and `limits`

```bash
splunk-cli config            # show the effective configuration (secrets redacted) and the config directory
splunk-cli config --json
splunk-cli config --check    # exit code 2 when a required value is missing
splunk-cli limits --json     # effective safety limits and job run budgets
```

---

## 7. JSON Output

`--json` is a first-class capability, not a patch bolted on afterwards. The envelope structure is
**stable**, and callers can depend on it.

### Success

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

### Failure

```json
{
  "success": false,
  "error": {
    "type": "SplunkAuthenticationError",
    "message": "authentication failed (HTTP 401) for user splunk_user"
  }
}
```

Error objects may carry `details`, providing structured context: the HTTP status code, the request path,
the span that failed, or the limit that was breached.

**Never present in any output:** passwords, the `Authorization` header, session tokens, session keys,
Cookies. Every remote string that could end up in an error message goes through `sanitize_message()`, and
the only rendering path for configuration is `Settings.redacted()`.

### `truncated` matters

`"truncated": true` means the server holds more data than the number of results requested. In that case
the caller must narrow the query and retry, rather than drawing conclusions from an incomplete page.

### `job`: which window the expressions actually landed on

`earliest` / `latest` are **expressions** (`@mon`, `now`, `-1h`), and only Splunk knows which two instants
they each resolve to. The `job` block gives that answer as-is, and everything in it comes from the job
metadata that had to be read anyway when creating the search, with no additional request issued:

| Field | Meaning |
| --- | --- |
| `dispatch_state` / `is_done` / `is_failed` / `is_finalized` / `done_progress` | Job state |
| `result_count` / `event_count` / `scan_count` | Number of results / events / scanned records (execution cost) |
| `run_duration` | Run duration (seconds) |
| `search_earliest_time` / `search_latest_time` | **The time window actually executed**, in epoch seconds; the key is absent when the server does not provide it |
| `sample_ratio` | Event sampling ratio; `"1"` means no sampling. Sampling turns counts into approximations, so it must be visible |

Both of these are **additive fields** (`ResultSet.toPublicDict()` gains a `job` key, and `SearchJob` gains
three keys internally); the names and order of existing fields are unchanged, making this a non-breaking
change. The dashboard's job status bar reads this block directly.

### Exit codes

| Exit code | Meaning | Error type |
| --- | --- | --- |
| 0 | Success | — |
| 1 | General / unexpected error | `SplunkError` or another exception |
| 2 | Configuration error | `ConfigurationError` |
| 3 | Authentication error | `SplunkAuthenticationError` |
| 4 | Connection error | `SplunkConnectionError` |
| 5 | Query error | `SplunkQueryError`, `SplunkJobError`, `SplunkResultError` |
| 6 | Safety limit | `SafetyLimitError` |
| 7 | Timeout | `SplunkTimeoutError` |

---

## 8. Safety Limits

### The dashboard's security model

```text
Browser ──▶ Express Router ──▶ Services ──▶ SplunkClient ──▶ Splunk REST API
```

The browser **never** accesses the Splunk REST API directly. Credentials exist only in the Node process's
memory and are never sent down to the page.

| Defense line | Approach |
| --- | --- |
| Network | The CLI binds to `127.0.0.1` unconditionally; `dashboard` offers no option to change the binding |
| DNS rebinding | Validates the `Host` header, accepting only `127.0.0.1` / `localhost` / `::1` |
| Defense in depth | If a request carries an `Origin`, its host must be on the whitelist too |
| Parameter caps | Time range, result count, and SPL length are all enforced by the Service layer |
| Read-only | The endpoint whitelist is unchanged; alert write operations have no route and no API |
| Information leakage | Every error goes through `sanitize_message()`; response bodies never contain credentials |

The following request is rejected (HTTP 403):

```bash
curl -H "Host: evil.com" http://127.0.0.1:8765/api/health
```

Local commands without an `Origin` remain available at all times — `curl` and scripts were never subject
to the same-origin policy anyway, and their access is already protected by the binding and the `Host`
validation.

### Read-only by construction

Only the following endpoints may be accessed:

```text
GET  /services/server/info
GET  /services/licenser/pools
POST /services/search/jobs                 (creating a query is a read operation)
GET  /services/search/jobs/{sid}
GET  /services/search/jobs/{sid}/results
GET  /services/search/jobs/{sid}/messages
GET  /services/saved/searches
GET  /services/alerts/fired_alerts
```

Always rejected: `DELETE`, `PUT`, `PATCH`, `HEAD`, and any path outside the whitelist, such as
`/services/admin/*`, `/services/authentication/*`, `/services/authorization/*`, `/services/configs/*`,
`/services/data/*`, `/services/apps/*`, `/services/cluster/*`, `/services/deployment*`,
`/services/search/jobs/export`.

### Enforced limits

```text
max_results      = 5000      (SPLUNK_MAX_RESULTS)
max_time_range   = 7d        (SPLUNK_MAX_TIME_RANGE)
max_query_length = 10000     (SPLUNK_MAX_QUERY_LENGTH)
```

These three are **caps**: exceeding them is a rejection. `timeout` (per-request timeout), `search_timeout`
(the job wall-clock budget, whose effective value is `max(SPLUNK_SEARCH_TIMEOUT, SPLUNK_TIMEOUT)`), and
`poll_interval` (the job status polling interval) are not caps, but they are part of the "currently
effective guardrails" — `splunk-cli limits` prints both in the same table, so you can judge how long a
query may wait at most and how many status queries it will send to the server.

> **Exception (accepted by decision):** expressions containing `@` and whole calendar windows (e.g.
> `last-month` = `-1mon@mon → @mon`) are **not** constrained by `max_time_range`; their width is resolved
> by Splunk in the search user's time zone. See §12 for the reasoning and the cost.

When a limit is exceeded, the request is **rejected outright, and user parameters are never silently
rewritten**:

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

### SPL validation

`server/safety/validator.ts` is a conservative lexical **blacklist, not an SPL parser**. It only inspects
pipe-separated command positions — so a field that happens to be named `delete` still works — and rejects
all write or admin commands:

`delete`, `collect`, `mcollect`, `tscollect`, `meventcollect`, `dbinspect`, `outputlookup`, `outputcsv`,
`outputtext`, `rest`, `script`, `sendalert`, `runshellscript`, `map`.

Among these, `| rest` is especially critical: it can call arbitrary Splunk endpoints (**including write
APIs**), and leaving it unblocked would render every other protection meaningless.

**When in doubt, reject.** A false rejection is acceptable; a false acceptance is not.

### Retry policy

Retries apply only to transport-layer failures: connection resets, transient network failures, `502`,
`503`, `504`, and timeouts. At most 3 attempts, with exponential backoff. Authentication failures and
`400`/`401`/`403` are **never retried**. Search job polling is a separate mechanism with its own timeout
and maximum poll count.

---

## 9. Testing

```bash
npm test                 # all backend + CLI + frontend unit tests, no real Splunk required
npm run typecheck        # tsc --noEmit (strict + noUncheckedIndexedAccess)
npm run test:coverage    # two coverage reports + the Q10 tiered gate
```

Unit tests are not stubbed down to the "function level"; they stay at the **real HTTP boundary**:

* `test/fixtures/splunk/*.json` — response blueprints captured from a real Splunk 8.0.2 and automatically
  redacted. **The shapes are not hand-written**: hand-written responses amount to "constructing the API
  according to your own understanding", whereas real Splunk's field casing, null representations, and
  grouping often differ from intuition. Asserting against captured blueprints means asserting against real
  behavior.
* The Client / Service layers are driven against these blueprints with an injected `fetch`, covering the
  required failure matrix: success, authentication failure, connection failure, timeout, job failure, job
  timeout, empty results, malformed results.
* The CLI layer starts a **real local HTTP server** (`node:http`) that returns scripted responses, so exit
  codes, the stdout/stderr split, and the JSON envelope can all be asserted at the process level — rather
  than mocking the HTTP client and then asserting "it should have been called".

Behavior is guarded at three levels: unit/CLI tests, the real-instance checklist in `npm run verify:live`,
and a reproducible-build gate.

### Live verification

Run the acceptance checklist item by item against a real Splunk and record the **actually observed** exit
codes and output as a report:

```bash
npm run verify:live                     # requires a configured, working Splunk
npm run verify:live -- --json-out /tmp/live.json
```

It verifies that authentication goes through a real business endpoint (measured with a local forwarding
proxy that records requests, rather than by reading the code), that the six commands return real data, the
exit codes for timeouts and safety limits, the dashboard's six APIs and its `Host` protection, that the
full `--verbose` log contains no credentials, and that the source form and the packaged form behave
identically. There are 19 checks in total; use `--json-out <path>` to choose where the report is archived.

Verification against a real instance also has a **separate layer that does not run by default**:

```bash
export RUN_SPLUNK_INTEGRATION_TESTS=1
export SPLUNK_URL="https://203.0.113.10:8089"
export SPLUNK_USERNAME="splunk_user"
export SPLUNK_PASSWORD="..."            # never commit
export SPLUNK_VERIFY_SSL=false

npm run test:integration
```

When the switch is off, or credentials are incomplete, the cases in `test/integration/` show as
**skipped** (not failed), so the default `npm test` is always independent of any external environment.
Credentials are read only from environment variables; there are no hostname or password literals anywhere
in the code.

### Coverage gate

The thresholds are tiered (the Q10 decision), judged by `scripts/check-coverage.mjs`:

| Tier | Threshold |
| --- | --- |
| Backend overall | ≥ 88% |
| `bin/splunk-cli.ts` | ≥ 88% |
| `server/client/http.ts` | ≥ 90% |
| `web/src/**` (frontend) | ≥ 95% |

`npm run test:coverage` runs backend coverage first, then frontend coverage, and then reads **both**
reports to make its judgment — a missing report fails the gate immediately, preventing the "I only ran the
backend and assumed the gate passed" mistake.

---

## 10. Caller Integration Design

**The Service layer is the product.** It is the stable interface that a future MCP Server or higher-level
runtime should wrap — never the HTTP Client.

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
  const payload = result.toPublicDict()   // stable JSON identical to the CLI output
  process.stdout.write(dumps(payload))
} finally {
  await client.close()
}
```

Planned tool names and stable signatures:

| Tool | Service call |
| --- | --- |
| `splunk_search` | `SearchService.search(query, { earliest, latest, limit })` → `ResultSet` |
| `splunk_stats` | `StatsService.stats(query, { by, function, earliest, latest, limit })` → `StatsResult` |
| `splunk_timeline` | `TimelineService.timeline(query, { span, earliest, latest, limit })` → `TimelineResult` |
| `splunk_fields` | `FieldsService.fields(query, { earliest, latest, limit })` → `FieldList` |
| `splunk_alerts` | `AlertsService.alerts({ count, includeSaved })` → `AlertList` |
| `splunk_health` | `HealthService.health({ includeLicense })` → `HealthReport` |

They all return type-annotated models whose `toPublicDict()` matches the CLI's JSON exactly.

### Web API

The dashboard's HTTP interface is a thin adapter over the Service layer, returning each model's
`toPublicDict()` **as-is**:

| Method | Path | Request body | Response |
| --- | --- | --- | --- |
| GET | `/api/health` | `?include_license=true` | `HealthReport.toPublicDict()` |
| POST | `/api/search` | `{query, earliest?, latest?, limit?}` | `ResultSet.toPublicDict()` |
| POST | `/api/stats` | `{query, by?, function?, earliest?, latest?, limit?}` | `StatsResult.toPublicDict()` |
| POST | `/api/timeline` | `{query, span?, earliest?, latest?, limit?}` | `TimelineResult.toPublicDict()` |
| GET | `/api/alerts` | `?count=&include_saved=` | `AlertList.toPublicDict()` |
| POST | `/api/overview` | `{query, earliest?, latest?, span?}` | see below |
| GET | `/api/version` | — | `{name, version}`: the version of this dashboard build (reads package metadata, **does not read Splunk**) |

`GET /api/health` reports **probe failures** (Splunk unreachable, bad credentials) inside the envelope: the
HTTP status is still 200 with `success: false`, not a 5xx — monitoring scripts should read the fields rather
than looking only at the status code. The failure dimension is distinguished in the fields: authentication
failure → `connection: "ok"` + `authentication: "failed"`; non-authentication failure →
`connection: "failed"`, though that value is a fallback for this class and not a precise connectivity
indicator.

When the **request itself** is invalid, the probe is never reached: parameter validation failures such as
`?include_license=abc` → 422, and a `Host` header that is not a loopback address → 403. Both still use this
envelope, but neither is a probe failure.

The envelope's shape matches the CLI's:

```json
{"success": false, "error": {"type": "SafetyLimitError", "message": "..."}}
```

`POST /api/overview`'s degraded result is the exception: when a sub-query fails it returns 200 with no
top-level `error`, and relies on `errors` to say which sub-queries failed; when the timeline fails,
`success` is `false`, and when only sibling sub-queries fail, `success` remains `true` with `partial` set
to `true` (see below).

HTTP status code mapping: `SafetyLimitError` / `ValidationError` → 422 (the latter for request body or
query parameter validation failures), `SplunkQueryError` → 400, `SplunkAuthenticationError` /
`SplunkConnectionError` / `SplunkJobError` / `SplunkResultError` → 502, `SplunkTimeoutError` → 504,
`ForbiddenOrigin` → 403, `FrontendNotBuilt` → 503 (frontend not built), everything else → 500.

One exception: when a **path or method under `/api` matches no API route** (e.g. `GET /api/nope`,
`POST /api/health`), what comes back is `{"detail": "Not Found"}` / `{"detail": "Method Not Allowed"}`,
**not** this envelope.

`POST /api/overview` returns everything the first screen needs in one shot: the timeline, the distribution
by service, the distribution by host, and derived metrics. The three sub-queries run concurrently, with
**degradation on partial failure**:

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

The field for a failed sub-query is **`null`**, not `0` — `0` means "there really is no data", while `null`
means "unknown". When the timeline fails, the overall `success` is `false`.

### A typical investigation flow

This document merely describes the flow; **the project itself does not implement it** — the caller does:

```text
User: "Analyze the cause of API 500s in the last hour"

Caller:
  1. splunk_health                                          confirm access first
  2. splunk_timeline  "index=api status=500" --span 1m       find the anomalous time window
  3. splunk_stats     "index=api status=500" --by service    which service dominates
  4. splunk_search    "index=api status=500 service=payment" --earliest=<window> --limit 50
  5. splunk_stats     "index=api status=500 service=payment" --by host
  6. splunk_search    "index=api trace_id=<id>"              pull the full trace
  7. Analyze the root cause
```

Each step is a single CLI / MCP call returning structured data. The `truncated`, `count`, and `time_range`
in every response tell the caller whether the current evidence is sufficient to support a conclusion.

---

## 11. MCP Roadmap

Phase 1 deliberately stops at the core. The follow-up plan, in order:

1. **`splunk-mcp` Server** — a thin wrapper over the Service layer exposing the six tools above, with its
   JSON Schema generated from the zod models.
2. **Shared session management** — connection reuse and credential resolution inherited from
   `server/config/settings.ts`, never reimplemented.
3. **Pagination and streaming tools** for result sets larger than one page.
4. **Run saved searches by name** (still read-only).

Non-goals at every stage (unless explicitly decided otherwise): writing to Splunk, automatic alert
remediation, a built-in LLM.

---

## 12. Known Limitations

* **Read-only by design.** No write path, no job deletion, no alert modification.
* **Search jobs are not actively cleaned up.** Splunk's own job retention policy handles reclamation; this
  tool does not send `DELETE` (which is not on the read-only whitelist).
* **`fields` uses `| fieldsummary`,** which is accurate but not cheap on very large indexes — narrow the
  time range.
* **Alert endpoints differ across versions.** `/services/alerts/fired_alerts` was removed in Splunk 9.2,
  and behavior is also inconsistent across 8.x patch releases. When the endpoint is unavailable, the
  command returns an empty list plus a `note` and exits with code 0 — an honest structured answer instead
  of an unexplained failure.
* **`health` may be `unknown`.** Splunk 8.0.2's `/services/server/info` does not always return a `health`
  field; in that case the value is passed through as-is rather than invented.
* **Time ranges are validated only when statically determinable (accepted by decision).** Any expression
  containing `@` is excluded from the local span check, including whole named windows (`last-month` =
  `-1mon@mon → @mon`): `SPLUNK_MAX_TIME_RANGE` **does not apply** to them, and Splunk resolves their width
  in the search user's time zone. The CLI cannot obtain that time zone, and computing it locally would
  misjudge when time zones differ or daylight saving shifts, so this is an accepted gap, not a bug awaiting
  a fix. Windows that can be evaluated statically (such as `-30d`) are still rejected outright by the local
  cap (exit code 6). As a result, `--range last-year` may genuinely scan an entire year (measured on one
  instance at roughly 8.57 million events / 36 seconds); what catches it is the job wall-clock budget
  (`SPLUNK_SEARCH_TIMEOUT`, timeout exit code 7) together with Splunk's own `limits.conf` / role quotas.
* **`truncated` is conservative.** It is also `true` when exactly `limit` results are returned and there may
  be more. Read it as "needs a second look", not "there is definitely more".
* **The License Pool may be empty** — when the authenticated user lacks license-related capabilities;
  `health` then degrades gracefully instead of erroring.

---

## 13. Troubleshooting

| Symptom | Exit code | Cause and remedy |
| --- | --- | --- |
| `missing required configuration` | 2 | Export `SPLUNK_URL`, `SPLUNK_USERNAME`, `SPLUNK_PASSWORD`, or create a `.env` |
| `CERTIFICATE_VERIFY_FAILED` | 4 | Verification is on by default and Splunk's default certificate is self-signed: configure `SPLUNK_CA_BUNDLE`, or set `SPLUNK_VERIFY_SSL=false` in development (see §5 TLS) |
| `authentication failed (HTTP 401)` | 3 | Wrong credentials, or the user lacks permission to read `/services/server/info` |
| `HTTP 502` / gateway error | 5 | A system proxy intercepted the internal request; keep `SPLUNK_TRUST_ENV=false` |
| `did not finish within 60s` | 7 | Narrow the time range, append `\| head N`, or raise `SPLUNK_SEARCH_TIMEOUT` |
| `exceeds the maximum allowed range` | 6 | Narrow the window, or raise `SPLUNK_MAX_TIME_RANGE` with a clear understanding of the cost |
| `SPL command 'rest' is not permitted` | 6 | Read-only policy; use a supported command instead |
| Configured for port 8000 | — | 8000 is the Web UI; the REST API is on **8089** |

Use `--verbose` when debugging. Logs go to stderr, and no log level ever prints credential contents.

---

## Distribution

The distribution package is produced by `npm run pack`. The `splunk-cli/` delivery directory contains only
the guide documents and the install package:

```text
splunk-cli/                              ← delivery directory
├── INSTALL.md                           ← installation guide (committed to Git)
├── USAGE.md                             ← complete usage manual (committed to Git)
├── VERSION.md                           ← version changelog (committed to Git)
└── splunk-cli.tgz                       ← install package (build artifact, single cross-platform file)
```

```bash
npm install -g ./splunk-cli/splunk-cli.tgz
```

The packaging process:

```bash
npm run pack            # build + assemble + emit tgz/zip
npm run pack:verify     # additionally prove reproducibility: pack twice and compare sha256
```

`scripts/package.mjs` assembles the artifacts from `dist/` together with `package.json` and `README.md`
into `pack/splunk-cli/`, then produces two archives:

* `splunk-cli/splunk-cli.tgz` — install directly with `npm install -g`;
* `releases/splunk-cli-v<version>.zip` — the whole delivery directory (guides + install package) packaged
  for distribution.

**Why a single package can be cross-platform.** The artifacts are pure JavaScript: `bin/splunk-cli.ts`
together with all of our own code is compressed by esbuild into a single file, while `express` /
`compression` / `undici` are marked external and resolved per platform by the target machine's
`npm install`; the frontend is Vite's static output. There is no native compilation, so CI needs only a
single ubuntu runner.

**There is no source in the distribution.** The compressed single-file bundle cannot be turned back into a
readable implementation (no source maps are produced), the `scripts` and `devDependencies` in
`package.json` are removed, and `assertArchiveClean()` additionally rejects `.ts`, `.map`, `.env`, and test
fixtures one by one before archiving.

**Reproducible builds.** The archives are written in-process by `scripts/lib/archive.mjs`: entries are
sorted by path, all mtimes are fixed, and the gzip header carries no timestamp. The same `dist/` therefore
necessarily produces the same bytes, and `npm run pack:verify` turns that promise into a CI gate by
"packing twice and comparing sha256".

## Development

```bash
npm install
npm run typecheck && npm test && npm run test:coverage
npm run dev -- search "index=_internal | head 5"     # run the TS source directly, no build needed
```

Before contributing code, please read **`AGENTS.md`** first: it defines the layering rules, the read-only
whitelist, the safety and testing requirements, and the Definition of Done.

## License

MIT
