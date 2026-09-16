import { defineConfig } from 'vitest/config'

/**
 * 后端测试配置。
 *
 * 两处刻意的选择：
 *   - `environment: "node"`：后端测试不该继承浏览器环境，
 *     否则"DOM 全局可用"这种假象会渗进测试；
 *   - 不设 `globals: true`：每个测试文件显式 import。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    /**
     * 单个用例的超时。
     *
     * 默认的 5s 对**大部分**用例绰绰有余（整个套件通常 700ms 跑完），但 `cli.test.ts`
     * 里的 `dashboard` 用例要真的绑一个内核分配的端口、等服务打印出监听地址、
     * 再发一次真实 HTTP 请求——它们是进程级与网络级的，天生比纯单元测试慢。
     *
     * 这个数字曾经造成一次**假失败**：在并行跑前端构建（CPU 满载）时，这类用例超过
     * 5s，报告出一个与被测代码无关的 `Test timed out in 5000ms`。把预算显式放宽，
     * 让真正卡住的测试仍然失败，同时不让"机器忙"变成红。
     */
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // ⚠ 必须显式声明 include：不声明时 vitest 只统计"被测试加载过"的文件，
      // `bin/splunk-cli.ts` 会**根本不进报告**（不是 0%，而是不可见），
      // Q10 定的"cli.ts ≥88%"就成了数字而不是门禁。
      include: ['server/**/*.ts', 'bin/**/*.ts'],
      // 门槛由 scripts/check-coverage.mjs 按 Q10 的分档执行——
      // 放在这里会导致单文件（如 bin/）未达标时整个测试套件失败，
      // 而我们希望门禁的判定逻辑显式、可读、可单独运行。
    },
  },
})
