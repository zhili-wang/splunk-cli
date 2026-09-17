/**
 * 运行时依赖清单：**哪些第三方包不进 bundle、因而必须由目标机的 `npm install` 提供**。
 *
 * 这份清单是两处事实的唯一来源：
 *   - `build.mjs` 把它交给 esbuild 当 `external` —— 这些包的代码不内联；
 *   - `package.mjs` 用它裁剪发出去的 `dependencies` —— 只有这些包需要声明。
 *
 * 分开写会出事，而且是无声的那种：
 *   - 内联进 bundle 的包若仍被声明，用户白装一份永远不会被 `import` 的代码
 *     （`commander` 与 `zod` 就在安装包里这样躺了很久，占了安装的依赖树）；
 *   - 漏声明一个 external，用户装完一跑就崩，而打包本机一切正常 —— 这个更难发现。
 *
 * 放在同一个文件里，这两种错位至少需要有人刻意复制一份清单才会发生。
 *
 * 由此还推出一条仓库级不变式：**根 `package.json` 的 `dependencies` 恰好等于这份清单**。
 * 会被打进产物的（react、echarts、commander、zod……）一律归 `devDependencies` ——
 * 前端那边一直是这么做的，后端这两个曾经不是，直到 `npm install -g` 的依赖树里
 * 冒出一个永远不会被 import 的 `zod`。`test/runtime-deps.test.ts` 会把这条钉住。
 */

/**
 * 交给 esbuild 当 `external` 的包：代码不进 bundle。
 *
 * 判断依据是"内联它值不值"：
 *   - `express` / `compression` 是服务端框架，依赖树大且以 CJS 为主，内联没有收益；
 *   - `undici` 带原生加速、按平台分发预编译产物，内联会锁死平台。
 * 其余运行时依赖（`commander`、`zod`）是纯 JS，内联进单文件反而省掉一次安装。
 */
export const EXTERNAL_DEPENDENCIES = Object.freeze(['express', 'compression', 'undici'])

/**
 * 从仓库根的 `dependencies` 里裁出**发布包该声明的**那些。
 *
 * 只做两件事：按 `EXTERNAL_DEPENDENCIES` 挑选、原样沿用版本区间。不返回入参本身，
 * 也不改动入参 —— 调用方拿到的是一份独立副本。
 *
 * 缺少某个 external 依赖时**抛错**而不是跳过：静默地少声明一个，发布出去的包会在
 * 用户机器上解析失败，而打包本机一切正常。
 *
 * @param {Record<string, string>} dependencies 根 `package.json` 的 dependencies。
 * @returns {Record<string, string>} 只含 external 依赖的新对象。
 */
export function publishedDependencies(dependencies) {
  const published = {}
  for (const name of EXTERNAL_DEPENDENCIES) {
    const range = dependencies[name]
    if (range === undefined) {
      throw new Error(
        `external 依赖 ${name} 不在根 package.json 的 dependencies 里：` +
          '发布包会缺少这个依赖，目标机解析失败。请检查 scripts/lib/runtime-deps.mjs 与根 package.json 是否同步。',
      )
    }
    published[name] = range
  }
  return published
}
