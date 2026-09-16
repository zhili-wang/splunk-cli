/**
 * 通用数值格式化工具。
 *
 * 放在中立位置（而不是 `safety/limits.ts`）是为了避免 `client → safety` 这种
 * 反向依赖：`formatG` 既被安全策略的超限消息使用，也被传输层/客户端的超时消息使用。
 */

/**
 * 按 `%g` 语义的数值格式化。
 *
 * 为什么必须自己写：这些数字是**公开输出的一部分**，而 `%g` 语义下
 * `2592000.0` 得到 `2.592e+06`，JS 的默认 `String(2592000)` 得到 `2592000`。
 * 两者不同，对拍会失败。实测权威值见对拍报告（`search-read-timeout` 的
 * `request timed out after 1s`、`safety-time-range` 的 `2.592e+06s`）。
 *
 * 规则：指数 < -4 或 >= precision(6) 时用科学计数法，否则定点；两者都去掉多余的零。
 *
 * @param value 待格式化的数值。
 * @param precision 有效位数，默认 6（`%g` 的默认精度）。
 */
export function formatG(value: number, precision = 6): string {
  if (!Number.isFinite(value)) return String(value)
  if (value === 0) return '0'
  const exponent = Math.floor(Math.log10(Math.abs(value)))
  if (exponent < -4 || exponent >= precision) {
    const [mantissa = '', exp = ''] = value.toExponential(precision - 1).split('e')
    const sign = exp.startsWith('-') ? '-' : '+'
    const digits = exp.replace(/^[+-]/, '').padStart(2, '0')
    const trimmed = mantissa.includes('.') ? mantissa.replace(/0+$/, '').replace(/\.$/, '') : mantissa
    return `${trimmed}e${sign}${digits}`
  }
  const decimals = Math.max(0, precision - 1 - exponent)
  const fixed = value.toFixed(decimals)
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}
