/**
 * 发布包依赖裁剪的测试。
 *
 * 这里守的是一条**无声的**错误：安装包里声明了已经内联进 bundle 的依赖，用户就会
 * 白装一份永远不会被 `import` 的代码。`commander` 与 `zod` 正是这样在安装包里躺了
 * 很久 —— 直到有人去看了一眼 `npm install -g` 拉下来的依赖树才发现。
 *
 * 最后一个用例直接拿真实的根 `package.json` 跑，所以清单与仓库漂移也会在这里失败。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { EXTERNAL_DEPENDENCIES, publishedDependencies } from '../scripts/lib/runtime-deps.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('publishedDependencies', () => {
  it('剔除已内联进 bundle 的依赖', () => {
    // Arrange：commander 与 zod 由 esbuild 内联，不该出现在安装包里。
    const rootDependencies = {
      commander: '^15.0.0',
      compression: '^1.8.2',
      express: '^5.2.1',
      undici: '^8.10.2',
      zod: '^4.6.5',
    }

    // Act
    const published = publishedDependencies(rootDependencies)

    // Assert
    expect(Object.keys(published).sort()).toEqual(['compression', 'express', 'undici'])
    expect(published).not.toHaveProperty('commander')
    expect(published).not.toHaveProperty('zod')
  })

  it('原样沿用根声明的版本区间', () => {
    const published = publishedDependencies({
      express: '^5.2.1',
      compression: '^1.8.2',
      undici: '^8.10.2',
    })

    expect(published).toEqual({
      express: '^5.2.1',
      compression: '^1.8.2',
      undici: '^8.10.2',
    })
  })

  it('返回新对象，不改动入参', () => {
    const rootDependencies = { express: '^5.2.1', compression: '^1.8.2', undici: '^8.10.2' }
    const snapshot = { ...rootDependencies }

    const published = publishedDependencies(rootDependencies)

    expect(published).not.toBe(rootDependencies)
    expect(rootDependencies).toEqual(snapshot)
  })

  it('external 依赖缺失时抛错，并在消息里点名是哪个', () => {
    const incomplete = { express: '^5.2.1', compression: '^1.8.2' } // 少了 undici

    expect(() => publishedDependencies(incomplete)).toThrow(/undici/)
  })

  it('空 dependencies 直接抛错，而不是返回空对象放过', () => {
    expect(() => publishedDependencies({})).toThrow(/express/)
  })

  it('根 package.json 的 dependencies 恰好等于 external 清单', () => {
    // Arrange：这条不变式是"构建期内联、运行期外链"这个设计的直接推论 ——
    // 凡是会被打进产物的（react、echarts、commander、zod……）一律归 devDependencies，
    // 只有真正要在目标机上解析的才留在 dependencies。它同时保证了
    // `npm install --omit=dev` 之后仍能跑起 dist/ —— 因为那正是产物需要的全部。
    const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

    // Act
    const declared = Object.keys(rootPkg.dependencies).sort()

    // Assert
    expect(declared).toEqual([...EXTERNAL_DEPENDENCIES].sort())
  })

  it('清单本身没有重复项', () => {
    expect(new Set(EXTERNAL_DEPENDENCIES).size).toBe(EXTERNAL_DEPENDENCIES.length)
  })
})
