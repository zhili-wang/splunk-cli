/**
 * 服务名册：本机由 `splunk-cli dashboard` 启动、仍在监听的 Web 服务清单。
 *
 * 用途只有一个——让 `splunk-cli stop-web` 知道该去找谁。它**不是事实来源**：
 * 进程扫描能重建同样的信息，所以这里的任何失败（文件损坏、写不进去）都只让停止
 * 变慢，不会让它停错或停不掉。
 *
 * 设计取舍：
 *   - **版本化**。文件写于一个进程、读于另一个进程，两者可能是不同版本的 CLI——
 *     这正是本项目刚踩过的坑。遇到不认识的版本，本模块返回空名册而**不尝试解释**：
 *     宁可漏掉，也不能按当前形状去曲解别人的文件、进而停掉不相干的进程。
 *   - **自清理挂在写上**。`registerServer` 会重排整个文件，顺手丢掉 pid 已结束的
 *     陈旧条目是免费的；`readRegistry` 则保持零副作用，读永远不会改盘。
 *   - **原子替换**。先写同目录临时文件再 `rename`，避免读到半截 JSON。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DIR_MODE, FILE_MODE, REGISTRY_FILE_NAME, registryFilePath, restrict } from '../config/paths'

/** 名册文件的格式版本。任何不兼容的字段变更都必须递增它。 */
export const REGISTRY_VERSION = 1

/** 名册里的一条服务记录。 */
export interface ServerEntry {
  /** 监听进程的 pid。**仅凭它不足以认定身份**，见 `process.kill` 的说明。 */
  readonly pid: number
  /** 监听端口。用于回连确认"这确实是我们的服务"。 */
  readonly port: number
  /** 启动时刻（ISO 8601）。供人分辨多个服务，不参与任何判断。 */
  readonly startedAt: string
}

/**
 * 读取名册。
 *
 * 文件不存在、不是合法 JSON、版本不认识、条目形状不对——全部收敛为
 * **返回能看懂的那部分**，绝不抛错。调用方在"损坏"与"本来就空"之间不需要做区分：
 * 两种情况下的正确行为是一样的。
 *
 * @param env 环境变量表；默认 `process.env`，测试可注入。
 */
export function readRegistry(env: NodeJS.ProcessEnv = process.env): ServerEntry[] {
  let raw: string
  try {
    raw = readFileSync(registryFilePath(env), 'utf8')
  } catch {
    // 没启动过 dashboard 的机器上没有这个文件，这是正常状态而非错误。
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }

  return entriesOf(parsed)
}

/**
 * 登记一个服务。
 *
 * 同 pid 覆盖；pid 已结束的旧条目就地丢弃。
 *
 * @param entry 要登记的记录。
 * @param env 环境变量表；默认 `process.env`。
 */
export function registerServer(entry: ServerEntry, env: NodeJS.ProcessEnv = process.env): void {
  const kept = readRegistry(env).filter(
    (existing) => existing.pid !== entry.pid && isRunning(existing.pid),
  )
  writeRegistry([...kept, entry], env)
}

/**
 * 注销一个服务。
 *
 * pid 不在名册里时**不触碰文件**：退出清理会被调用不止一次（正常退出与信号各一次），
 * 而一个从没启动过 dashboard 的机器不该因为一次清理就多出一个配置目录。
 *
 * @param pid 要移除的进程号。
 * @param env 环境变量表；默认 `process.env`。
 */
export function unregisterServer(pid: number, env: NodeJS.ProcessEnv = process.env): void {
  const existing = readRegistry(env)
  const kept = existing.filter((candidate) => candidate.pid !== pid)
  if (kept.length === existing.length) return

  writeRegistry(kept, env)
}

/** 从解析出的任意值里取出合法条目，非法的一律丢弃。 */
function entriesOf(parsed: unknown): ServerEntry[] {
  if (typeof parsed !== 'object' || parsed === null) return []

  const document = parsed as Record<string, unknown>
  // 版本不认识就当作"没有"。按当前形状去解释一个未来版本的文件，
  // 结果是读出一批我们并不理解的服务，然后照着它去发信号。
  if (document['version'] !== REGISTRY_VERSION) return []

  const servers = document['servers']
  if (!Array.isArray(servers)) return []

  return servers.filter(isEntry)
}

/** 形状校验：一条坏记录不该让其余可用的服务失去被停止的机会。 */
function isEntry(value: unknown): value is ServerEntry {
  if (typeof value !== 'object' || value === null) return false

  const candidate = value as Record<string, unknown>
  return (
    isPositiveInteger(candidate['pid']) &&
    isPositiveInteger(candidate['port']) &&
    typeof candidate['startedAt'] === 'string'
  )
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * pid 是否对应一个仍在运行的进程。
 *
 * **这是弱校验**：pid 会被系统回收给毫不相干的进程复用。它在这里只用于清理陈旧条目，
 * 而清理的代价仅仅是少一条线索。真正决定"要不要发信号"的判定在 `discovery.ts`，
 * 那里必须回连端口确认身份。
 */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 表示进程存在但不属于当前用户——那依然是"活着"，不该被清掉。
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 原子地覆盖名册。
 *
 * 写不进去就放弃：名册只是加速线索，扫描兜底仍在，为此让 `dashboard` 启动失败
 * 是本末倒置。
 */
function writeRegistry(entries: ServerEntry[], env: NodeJS.ProcessEnv): void {
  const path = registryFilePath(env)
  const directory = dirname(path)

  try {
    mkdirSync(directory, { recursive: true, mode: DIR_MODE })
    restrict(directory, DIR_MODE)
  } catch {
    return
  }

  // 同目录 rename 是原子操作；直接覆写会在另一个进程正好读取时留下半截 JSON。
  // 文件名带上 pid，避免两个 dashboard 同时登记时互相踩到对方的临时文件。
  const temporary = join(directory, `${REGISTRY_FILE_NAME}.${process.pid}.tmp`)
  try {
    writeFileSync(temporary, serialize(entries), { encoding: 'utf8', mode: FILE_MODE })
    // umask 可能削掉权限位，创建后再收紧一次（rename 保留临时文件的权限）。
    restrict(temporary, FILE_MODE)
    renameSync(temporary, path)
  } catch {
    rmSync(temporary, { force: true })
  }
}

function serialize(entries: ServerEntry[]): string {
  return `${JSON.stringify({ version: REGISTRY_VERSION, servers: entries }, null, 2)}\n`
}
