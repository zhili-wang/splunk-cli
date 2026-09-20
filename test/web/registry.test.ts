/**
 * 服务名册（`~/.splunk-cli/servers.json`）的读写契约。
 *
 * 名册是 `stop-web` 找到"要停谁"的第一手线索，所以它必须在**坏输入下也不炸**：
 * 一个被手工编辑坏、或被磁盘写了一半的文件，不能让停止命令整个失败——那时用户
 * 恰恰最需要它跑起来。因此本套测试里"损坏 → 空名册"和"正常读写"同等重要。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { registryFilePath, REGISTRY_FILE_NAME } from '../../server/config/paths'
import {
  REGISTRY_VERSION,
  type ServerEntry,
  readRegistry,
  registerServer,
  unregisterServer,
} from '../../server/web/registry'

const ENTRY: ServerEntry = {
  pid: 4242,
  port: 8765,
  startedAt: '2026-09-20T11:00:00.000Z',
}

let root: string
let env: NodeJS.ProcessEnv
let spawned: ChildProcess[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'splunk-cli-registry-'))
  env = { SPLUNK_CONFIG_DIR: join(root, 'cfg') }
  spawned = []
})

afterEach(() => {
  for (const child of spawned) child.kill('SIGKILL')
  rmSync(root, { recursive: true, force: true })
})

/**
 * 一个确定已经结束的 pid。
 *
 * `spawnSync` 会等到子进程退出并回收它，所以返回的 pid 此刻是死的。用它来构造
 * "名册里躺着一条陈旧记录"的场景，比硬编码一个数字可靠。
 */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  if (child.pid === undefined) throw new Error('无法启动一次性进程')
  return child.pid
}

/**
 * 一个确定还活着的 pid。
 *
 * `registerServer` 会清掉 pid 已结束的条目（见其文档），所以凡是断言"两条记录并存"
 * 的用例都必须用真实存活的进程——拿假 pid 去测，测到的是清理而不是并存。
 */
function alivePid(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: 'ignore',
  })
  if (child.pid === undefined) throw new Error('无法启动驻留进程')
  spawned.push(child)
  return child.pid
}

/** 直接落盘一个名册，绕过写入路径——用来构造它可能遇到的坏文件。 */
function plant(content: string): void {
  const path = registryFilePath(env)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

function plantEntries(entries: unknown[], version: number = REGISTRY_VERSION): void {
  plant(JSON.stringify({ version, servers: entries }))
}

describe('readRegistry', () => {
  it('名册还不存在时返回空名册，而不是抛错', () => {
    // 从没启动过 dashboard 的机器上，`stop-web` 必须优雅地说"没有要停的"。
    // 抛错会让用户以为命令坏了。
    expect(readRegistry(env)).toEqual([])
  })

  it('读回已登记的条目', () => {
    registerServer(ENTRY, env)

    expect(readRegistry(env)).toEqual([ENTRY])
  })

  it('文件不是合法 JSON 时返回空名册', () => {
    plant('{ 这不是 JSON')

    expect(readRegistry(env)).toEqual([])
  })

  it('文件被截断时返回空名册', () => {
    // 写一半就被断电／被 kill 的典型形态：JSON 前缀合法、结尾缺失。
    plant('{"version":1,"servers":[{"pid":4242,')

    expect(readRegistry(env)).toEqual([])
  })

  it('顶层不是对象时返回空名册', () => {
    plant('[]')

    expect(readRegistry(env)).toEqual([])
  })

  it('丢弃形状不对的条目，保留合法条目', () => {
    // 一条坏记录不该让其余可用的服务失去被停止的机会。
    plantEntries([
      { pid: '4242', port: 8765, startedAt: ENTRY.startedAt },
      { pid: 1, port: '8765', startedAt: ENTRY.startedAt },
      { pid: 2, port: 8765 },
      { pid: 0, port: 8765, startedAt: ENTRY.startedAt },
      { pid: -1, port: 8765, startedAt: ENTRY.startedAt },
      { pid: 3, port: 0, startedAt: ENTRY.startedAt },
      { pid: 4.5, port: 8765, startedAt: ENTRY.startedAt },
      null,
      'nope',
      ENTRY,
    ])

    expect(readRegistry(env)).toEqual([ENTRY])
  })

  it('version 字段缺失或不是本版本时返回空名册', () => {
    // 这是本项目刚踩过的坑：新旧版本共用同一份状态。不认识的名册宁可当作"没有"，
    // 也不能按当前版本的形状去解释它——那会读出根本没有的服务。
    plant(JSON.stringify({ servers: [ENTRY] }))
    expect(readRegistry(env)).toEqual([])

    plantEntries([ENTRY], REGISTRY_VERSION + 1)
    expect(readRegistry(env)).toEqual([])
  })

  it('servers 不是数组时返回空名册', () => {
    plant(JSON.stringify({ version: REGISTRY_VERSION, servers: { pid: 4242 } }))

    expect(readRegistry(env)).toEqual([])
  })
})

describe('registerServer', () => {
  it('目录不存在时连目录一起创建，权限 0700', () => {
    registerServer(ENTRY, env)

    const dir = join(root, 'cfg')
    expect(statSync(dir).isDirectory()).toBe(true)
    // Windows 不支持 POSIX 权限位；本项目在 macOS / Linux 上跑，这里断言真实行为。
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('名册文件权限是 0600', () => {
    registerServer(ENTRY, env)

    expect(statSync(registryFilePath(env)).mode & 0o777).toBe(0o600)
  })

  it('同一个 pid 再登记是替换，不会留下两行', () => {
    // dashboard 用同一个进程反复登记（比如重启监听）时不能把名册撑大。
    registerServer(ENTRY, env)
    registerServer({ ...ENTRY, port: 9999 }, env)

    expect(readRegistry(env)).toEqual([{ ...ENTRY, port: 9999 }])
  })

  it('多个不同的服务并存', () => {
    const first: ServerEntry = { pid: alivePid(), port: 8765, startedAt: ENTRY.startedAt }
    const second: ServerEntry = { pid: alivePid(), port: 8846, startedAt: ENTRY.startedAt }

    registerServer(first, env)
    registerServer(second, env)

    expect(readRegistry(env)).toEqual([first, second])
  })

  it('登记时就地清掉 pid 已经结束的陈旧条目', () => {
    // 自清理挂在"写"上而不是"读"上：写会重排整个文件，顺手过滤是免费的；
    // 读则要保持无副作用。名册因此不会随着崩溃次数无限增长。
    plantEntries([{ pid: deadPid(), port: 9999, startedAt: ENTRY.startedAt }])

    registerServer(ENTRY, env)

    expect(readRegistry(env)).toEqual([ENTRY])
  })

  it('不会误清还活着的条目', () => {
    const alive: ServerEntry = { pid: alivePid(), port: 9999, startedAt: ENTRY.startedAt }
    plantEntries([alive])

    registerServer(ENTRY, env)

    expect(readRegistry(env)).toEqual([alive, ENTRY])
  })

  it('名册损坏时从零重建，而不是放弃登记', () => {
    // 否则一份坏文件会让此后每一次 dashboard 启动都无法再被 stop-web 发现。
    plant('{ 坏掉了')

    registerServer(ENTRY, env)

    expect(readRegistry(env)).toEqual([ENTRY])
  })

  it('写入的是合法 JSON，且带版本号', () => {
    registerServer(ENTRY, env)

    expect(JSON.parse(readFileSync(registryFilePath(env), 'utf8'))).toEqual({
      version: REGISTRY_VERSION,
      servers: [ENTRY],
    })
  })

  it('不留下任何临时文件', () => {
    // 原子写会先写同目录的临时文件再 rename。残留的 `.tmp` 不会被读走，
    // 但会在用户的配置目录里越积越多——每次启动 dashboard 一个。
    registerServer(ENTRY, env)

    expect(readdirSync(join(root, 'cfg'))).toEqual([REGISTRY_FILE_NAME])
  })
})

describe('unregisterServer', () => {
  it('只移除指定的 pid，其余保留', () => {
    const first: ServerEntry = { pid: alivePid(), port: 8765, startedAt: ENTRY.startedAt }
    const second: ServerEntry = { pid: alivePid(), port: 8846, startedAt: ENTRY.startedAt }
    registerServer(first, env)
    registerServer(second, env)

    unregisterServer(first.pid, env)

    expect(readRegistry(env)).toEqual([second])
  })

  it('移除最后一个条目后名册为空', () => {
    registerServer(ENTRY, env)

    unregisterServer(ENTRY.pid, env)

    expect(readRegistry(env)).toEqual([])
  })

  it('对不在名册里的 pid 是无操作，且不创建文件', () => {
    // 退出清理可能被调用多次（SIGTERM 与正常退出各一次）。一个不存在的 pid
    // 不该凭空造出一个配置目录——那会让"我从没跑过 dashboard"的机器多出垃圾。
    unregisterServer(4242, env)

    expect(readRegistry(env)).toEqual([])
    expect(() => statSync(registryFilePath(env))).toThrow()
  })

  it('名册损坏时静默收场，不抛错', () => {
    // 注销发生在进程退出的关键路径上；此时抛错只会让退出码变脏，
    // 而文件本身已经不合法、没有什么可失去的。
    plant('{ 坏掉了')

    expect(() => unregisterServer(4242, env)).not.toThrow()
  })
})
