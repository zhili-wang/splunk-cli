/**
 * 发现要停止的服务。
 *
 * 两条线索合并：**名册**（准确但可能过时）与**进程扫描**（过时不了但信息少）。
 *
 * 无论如何，每个候选都必须过同一道身份验证：该端口上 `GET /api/version` 回的是
 * 我们的形状。只验证 pid 存活是不够的——pid 会被系统回收给毫不相干的进程，
 * 照着一条过时的 pid 发信号，杀掉的是用户另一个程序。
 */

import { execFileSync } from 'node:child_process'

import { DEFAULT_PORT } from './defaults'
import { probeVersion } from './probe'
import { readRegistry } from './registry'

/** 一条已确认身份、可以安全停止的服务。 */
export interface DiscoveredServer {
  /** 监听进程的 pid。 */
  readonly pid: number
  /** 监听端口，已由探针确认。 */
  readonly port: number
  /** 来自哪条线索。仅用于诊断，不参与判断。 */
  readonly source: 'registry' | 'scan'
}

/** 探测某端口上是不是我们的面板。注入以便测试。 */
export type VersionProbe = (port: number) => Promise<boolean>

/** 读进程表原始输出（`ps -eo pid=,args=` 的 stdout）。注入以便测试。 */
export type ProcessListReader = () => string

/** `discoverServers` 的可注入依赖。 */
export interface DiscoveryOptions {
  /** 环境变量表；默认 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv
  /** 端口探针；默认连真实的回环端口。 */
  readonly probe?: VersionProbe
  /** 进程表读取器；默认执行 `ps`。 */
  readonly readProcessList?: ProcessListReader
  /** 目标平台；默认 `process.platform`。仅用于"是否支持扫描"。 */
  readonly platform?: NodeJS.Platform
  /**
   * 是否扫描进程表；默认 `true`。
   *
   * 关掉它只剩名册线索。用户可能会想关（共享机器上只停自己登记的），
   * 测试则**必须**关——否则一条用例会扫到开发机上真实跑着的面板并把它停掉。
   */
  readonly scan?: boolean
}

/**
 * 找出当前可安全停止的面板服务。
 *
 * 返回的每一条都已通过端口身份验证；未能确认的一律不返回，由调用方如实报告
 * "没有找到"，而不是猜。
 *
 * @param options 可注入依赖。
 */
export async function discoverServers(
  options: DiscoveryOptions = {},
): Promise<DiscoveredServer[]> {
  const { env = process.env, probe = probeVersion, platform = process.platform } = options

  const found = new Map<number, DiscoveredServer>()

  await collectFromRegistry(found, env, probe)
  if (options.scan !== false) {
    await collectFromProcesses(found, options, probe, platform)
  }

  return [...found.values()]
}

/** 名册线索：条目自带端口，逐个探针确认。 */
async function collectFromRegistry(
  found: Map<number, DiscoveredServer>,
  env: NodeJS.ProcessEnv,
  probe: VersionProbe,
): Promise<void> {
  for (const entry of readRegistry(env)) {
    // 探针本身就是身份验证：它同时排除了"pid 已经死了""pid 被复用给了别的程序"
    // "端口被别的程序接管了"三种情况，无需分别判断存活性。
    if (await probe(entry.port)) {
      found.set(entry.pid, { pid: entry.pid, port: entry.port, source: 'registry' })
    }
  }
}

/** 扫描线索：名册可能丢了，进程表还在。 */
async function collectFromProcesses(
  found: Map<number, DiscoveredServer>,
  options: DiscoveryOptions,
  probe: VersionProbe,
  platform: NodeJS.Platform,
): Promise<void> {
  // Windows 没有 `ps -eo pid=,args=` 这种调用方式。跳过而不是报错：
  // 名册线索在那边照常工作，用户不该因为平台差异收到一条失败。
  if (platform === 'win32') return

  const reader = options.readProcessList ?? readProcessList
  let output: string
  try {
    output = reader()
  } catch {
    // `ps` 不可用（精简容器等）只是一种线索缺失，名册线索仍然有效。
    return
  }

  for (const candidate of parseProcessList(output)) {
    if (found.has(candidate.pid)) continue
    // 绝不把自己算进去：`stop-web` 的命令行同样含 `splunk-cli`。
    if (candidate.pid === process.pid) continue
    if (await probe(candidate.port)) {
      found.set(candidate.pid, { pid: candidate.pid, port: candidate.port, source: 'scan' })
    }
  }
}

/** `ps -eo pid=,args=` 的输出：每行 `  1234 <command line>`。 */
export function readProcessList(): string {
  return execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
}

/** 解析后的进程表条目。 */
export interface ProcessInfo {
  readonly pid: number
  readonly port: number
}

/**
 * 从进程表里挑出 dashboard 进程，并推断它们的端口。
 *
 * 命令行里能读出 `--port` 就用它；读不出来（用户只写了 `splunk-cli dashboard`）
 * 就按默认端口推断。推断错了也不会误杀——紧接着的端口探针会否掉它。
 */
export function parseProcessList(output: string): ProcessInfo[] {
  const result: ProcessInfo[] = []

  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match?.[1] === undefined || match[2] === undefined) continue

    const pid = Number(match[1])
    const args = match[2]
    if (!isDashboard(args)) continue

    result.push({ pid, port: portFromArgs(args, DEFAULT_PORT) })
  }

  return result
}

/**
 * 命令行是否在跑 dashboard 子命令。
 *
 * 要求同时出现可执行文件名与子命令名：只匹配 `splunk-cli` 会把 `stop-web` 自己
 * 也算进来，只匹配 `dashboard` 会误伤任何名字里带这个词的程序。
 */
function isDashboard(args: string): boolean {
  return /(^|[/\\])splunk-cli(\.mjs|\.js|\.ts)?(\s|$)/.test(args) && /(^|\s)dashboard(\s|$)/.test(args)
}

/** 从命令行里取 `--port` / `-p`，取不到则用 `fallback`。 */
function portFromArgs(args: string, fallback: number): number {
  const match = /(?:^|\s)(?:--port|-p)[=\s]+(\d+)(?=\s|$)/.exec(args)
  if (match?.[1] === undefined) return fallback

  const port = Number(match[1])
  // `--port 0` 是"让系统挑一个"，命令行上看不到真实端口；名册线索负责这种情况。
  return port > 0 ? port : fallback
}
