/**
 * 配置目录的解析与创建。
 *
 * 目录约定（README §4 与 AGENTS.md §4）：
 *   - 位置：`$SPLUNK_CONFIG_DIR`，否则 `~/.splunk-cli`；
 *   - 目录权限 `0700`、配置文件权限 `0600`；
 *   - **已有配置绝不覆盖**。
 *
 * 数据目录**必须**可经环境变量注入：顶层 `homedir()` 常量、无覆盖机制会让路由测试
 * 真的读用户真实目录；`AGENTS.md` §4 明确禁止读写真实的 `~/.splunk-cli`。
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { CONFIG_TEMPLATE } from './template'

/** 配置目录名（家目录下）。 */
export const CONFIG_DIR_NAME = '.splunk-cli'

/** 覆盖配置目录的环境变量。 */
export const CONFIG_DIR_ENV = 'SPLUNK_CONFIG_DIR'

/** 配置文件名。 */
export const CONFIG_FILE_NAME = 'config.env'

/** 目录权限：仅属主可读写执行。 */
export const DIR_MODE = 0o700

/** 配置文件权限：仅属主可读写。 */
export const FILE_MODE = 0o600

/** 解析后的配置目录状态。 */
export interface ConfigDirectory {
  /** 目录绝对路径。 */
  readonly dir: string
  /** 配置文件绝对路径。 */
  readonly configFile: string
  /** 目录当前是否存在。 */
  readonly exists: boolean
  /** 配置文件是否存在（存在即算已填充，不要求非空）。 */
  readonly isPopulated: boolean
  /** 本次调用是否创建了目录。 */
  readonly created?: boolean
  /** 本次调用是否创建了配置文件。 */
  readonly configCreated?: boolean
}

/** 展开开头的 `~`。 */
function expandUser(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * 返回配置目录路径，**不触碰文件系统**。
 *
 * @param env 环境变量表；默认 `process.env`，测试可注入。
 * @returns `$SPLUNK_CONFIG_DIR` 或 `~/.splunk-cli`。
 */
export function configDirPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env[CONFIG_DIR_ENV] ?? '').trim()
  if (override) return expandUser(override)
  return join(homedir(), CONFIG_DIR_NAME)
}

/**
 * 解析配置目录并报告其当前状态（不创建任何东西）。
 *
 * @param env 环境变量表；默认 `process.env`。
 */
export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): ConfigDirectory {
  const dir = configDirPath(env)
  const configFile = join(dir, CONFIG_FILE_NAME)
  return {
    dir,
    configFile,
    exists: existsSync(dir),
    // 存在即算已填充（不看是否非空）。
    isPopulated: existsSync(configFile),
  }
}

/**
 * 返回要加载的配置文件路径，无论它是否存在。
 *
 * @param env 环境变量表；默认 `process.env`。
 */
export function writableConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return resolveConfigDir(env).configFile
}

/**
 * 尽力收紧文件权限，失败不抛错。
 *
 * Windows 等平台不支持 POSIX 权限位；忽略失败而不是让命令失败。
 *
 * @param path 目标路径。
 * @param mode 权限位，如 `0o600`。
 */
export function restrict(path: string, mode: number): void {
  try {
    chmodSync(path, mode)
  } catch {
    // 权限收紧是尽力而为。
  }
}

/**
 * 创建配置目录并写入模板。
 *
 * 幂等：**已有的 `config.env` 绝不覆盖**，凭据不会被清掉。创建失败不抛错——
 * 只通过环境变量配置的用户不该因为 `$HOME` 只读就用不了 CLI。
 *
 * @param options.createConfig 是否写入 `config.env` 模板（默认 `true`）。**不写 README.md**：
 *   配置目录里只放配置本身，说明文档属于产品文档而不是用户的家目录。
 * @param options.env 环境变量表；默认 `process.env`。
 */
export function ensureConfigDir(
  options: { createConfig?: boolean; env?: NodeJS.ProcessEnv } = {},
): ConfigDirectory {
  const { createConfig = true, env = process.env } = options
  const existing = resolveConfigDir(env)
  let directoryCreated = false

  try {
    if (!existing.exists) {
      mkdirSync(existing.dir, { recursive: true, mode: DIR_MODE })
      directoryCreated = true
      restrict(existing.dir, DIR_MODE)
    }
  } catch {
    // 目录建不出来就返回现状，由调用方决定怎么办。
    return existing
  }

  let configCreated = false
  if (createConfig) {
    if (!existsSync(existing.configFile) && writeNew(existing.configFile, CONFIG_TEMPLATE)) {
      configCreated = true
    }
  }

  return { ...resolveConfigDir(env), created: directoryCreated, configCreated }
}

/** 只在文件不存在时写入，返回是否真的写了。 */
function writeNew(path: string, content: string): boolean {
  if (existsSync(path)) return false
  try {
    writeFileSync(path, content, { encoding: 'utf8', mode: FILE_MODE })
    restrict(path, FILE_MODE)
    return true
  } catch {
    return false
  }
}
