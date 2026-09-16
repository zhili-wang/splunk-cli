#!/usr/bin/env node
/**
 * 性能基线采集。测法固定在 `docs/adr/0001-perf-baseline.md`，每次采集**逐条一致**，
 * 因此历次数字可以放在同一张表里比。
 *
 * 为什么测法必须一致：验收要求"不得出现回归"，而不同测法测出的数不可比。
 * 关键约定：
 *   - 离线指标用不可达地址 + 隔离配置目录，并**关闭重试**，否则 3.5s 退避会淹没
 *     200ms 级的启动开销，测出来的是重试策略而不是启动成本；
 *   - `--help` 冷启动与命令冷启动都跑 3 次取中位数，同时保留全样本；
 *   - JSON 微基准固定用 5000 行 / 1.06 MB 的同一份形状数据。
 *
 * 用法：
 *   node scripts/bench.mjs                     # 离线指标
 *   node scripts/bench.mjs --live              # 追加真实 Splunk 端到端
 *   node scripts/bench.mjs --out docs/adr/perf-baseline-node.json
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLI = join(ROOT, 'dist', 'bin', 'splunk-cli.mjs')
const OFFLINE_URL = 'https://127.0.0.1:1'

/** 与基线同形的命令矩阵。 */
const COMMANDS = [
  ['search', ['search', 'index=_internal | head 1']],
  ['config', ['config']],
  ['limits', ['limits']],
]

function parseArgs(argv) {
  const opts = { runs: 3, live: false, out: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--runs') opts.runs = Number(argv[++i])
    else if (arg === '--live') opts.live = true
    else if (arg === '--out') opts.out = argv[++i]
    else {
      process.stderr.write(`[bench] 未知参数: ${arg}\n`)
      process.exit(2)
    }
  }
  return opts
}

function baseEnv(configDir) {
  return {
    ...process.env,
    SPLUNK_CONFIG_DIR: configDir,
    SPLUNK_URL: OFFLINE_URL,
    SPLUNK_USERNAME: 'bench',
    SPLUNK_PASSWORD: 'bench-placeholder',
    SPLUNK_VERIFY_SSL: 'false',
    // 关掉重试：否则对不可达地址会先退避 0.5+1+2 = 3.5s，测到的是重试策略。
    SPLUNK_MAX_RETRIES: '0',
  }
}

function runOnce(args, env) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint()
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env, stdio: 'ignore' })
    child.on('close', (code) => {
      resolve({ ms: Number(process.hrtime.bigint() - started) / 1e6, code: code ?? -1 })
    })
    child.on('error', () => resolve({ ms: 0, code: -1 }))
  })
}

async function medianRun(args, env, runs) {
  const samples = []
  const codes = []
  for (let i = 0; i < runs; i += 1) {
    const { ms, code } = await runOnce(args, env)
    samples.push(ms)
    codes.push(code)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  return {
    median_ms: Number(median.toFixed(1)),
    min_ms: Number(Math.min(...samples).toFixed(1)),
    max_ms: Number(Math.max(...samples).toFixed(1)),
    samples_ms: samples.map((value) => Number(value.toFixed(1))),
    exit_codes: codes,
  }
}

function benchJson(rows = 5000) {
  const hex = '0123456789abcdef'
  const payloadRows = []
  for (let i = 0; i < rows; i += 1) {
    let trace = ''
    for (let k = 0; k < 32; k += 1) trace += hex[Math.floor(Math.random() * 16)]
    payloadRows.push({
      _time: '2026-09-14T08:31:21.000+00:00',
      host: `api-${String(i % 50).padStart(2, '0')}`,
      service: 'payment',
      level: 'ERROR',
      message: `database timeout ${'x'.repeat(40)}`,
      trace_id: trace,
    })
  }
  const payload = JSON.stringify({ success: true, count: rows, results: payloadRows })
  for (let i = 0; i < 5; i += 1) JSON.stringify(JSON.parse(payload))

  const iterations = 20
  let started = process.hrtime.bigint()
  let parsed
  for (let i = 0; i < iterations; i += 1) parsed = JSON.parse(payload)
  const parseMs = Number(process.hrtime.bigint() - started) / 1e6 / iterations

  started = process.hrtime.bigint()
  for (let i = 0; i < iterations; i += 1) JSON.stringify(parsed)
  const stringifyMs = Number(process.hrtime.bigint() - started) / 1e6 / iterations

  return {
    rows,
    payload_mb: Number((Buffer.byteLength(payload) / 1048576).toFixed(2)),
    loads_ms: Number(parseMs.toFixed(1)),
    dumps_ms: Number(stringifyMs.toFixed(1)),
  }
}

async function benchLive(runs) {
  // 真实实例是自签证书，按 README 的指引在开发环境关闭校验。
  const env = { ...process.env, SPLUNK_VERIFY_SSL: 'false' }
  return {
    health: null, // 离线地址下 health 必然失败，不在离线指标里采集
    search_end_to_end: await medianRun(['search', 'makeresults count=5', '--json'], env, runs),
    query: 'makeresults count=5',
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const configDir = mkdtempSync(join(tmpdir(), 'splunk-cli-bench-node-'))
  const env = baseEnv(configDir)

  try {
    const result = {
      meta: {
        measured_at: new Date().toISOString(),
        implementation: 'node',
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        cpu: process.env['BENCH_CPU'] ?? 'see docs/adr/0001-perf-baseline.md',
        offline_url: OFFLINE_URL,
        runs: opts.runs,
        note: '离线指标只覆盖不需要远端数据的命令',
      },
      help_cold_start: await medianRun(['--help'], env, opts.runs),
      command_cold_start_offline: {},
      json_micro: benchJson(),
    }

    for (const [name, args] of COMMANDS) {
      result.command_cold_start_offline[name] = await medianRun(args, env, opts.runs)
    }

    if (opts.live) result.live = await benchLive(opts.runs)

    const payload = `${JSON.stringify(result, null, 2)}\n`
    if (opts.out) {
      writeFileSync(join(ROOT, opts.out), payload)
      process.stdout.write(`[bench] 写入 ${opts.out}\n`)
    }
    process.stdout.write(payload)
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`[bench] 失败: ${error.message}\n`)
  process.exit(1)
})
