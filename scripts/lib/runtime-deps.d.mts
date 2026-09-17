/**
 * `scripts/lib/runtime-deps.mjs` 的类型声明。
 *
 * 与 `archive.d.mts`、`coverage-tiers.d.mts` 同样的理由：实现刻意写成 `.mjs`
 * （构建工具，不是要发布的服务端代码），不在 `tsconfig.json` 的 `include` 里，
 * 但它的判定逻辑值得被测试直接断言，所以补一份手写声明让测试能在 strict 模式下 import。
 *
 * 声明与实现必须同步：实现里新增导出时，这里也要加。
 */

/** 交给 esbuild 当 `external` 的包：代码不进 bundle，由目标机安装。 */
export declare const EXTERNAL_DEPENDENCIES: readonly string[]

/**
 * 从根 `dependencies` 裁出发布包该声明的那些，版本区间原样沿用。
 *
 * @param dependencies 根 `package.json` 的 dependencies。
 * @throws 当某个 external 依赖不在 `dependencies` 里。
 */
export declare function publishedDependencies(
  dependencies: Record<string, string>,
): Record<string, string>
