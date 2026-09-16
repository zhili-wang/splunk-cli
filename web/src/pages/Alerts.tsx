import { fetchAlerts } from '../api/endpoints'
import { ErrorNote } from '../components/ErrorNote'
import { useAsync } from '../hooks/useAsync'
import { formatCount } from '../lib/format'

export function Alerts(): JSX.Element {
  const { data, error, loading } = useAsync(() => fetchAlerts(false), [])

  if (error !== null) return <ErrorNote error={error} />
  if (loading) return <p className="text-sm text-signal-muted">正在加载已触发的告警…</p>
  if (data === null) return <p className="text-sm text-signal-muted">无数据。</p>

  return (
    <div className="flex flex-col gap-4">
      <section className="panel">
        <header className="panel-header">
          <h2 className="panel-title">已触发的告警</h2>
          <span className="tnum text-xs text-signal-muted">
            {formatCount(data.count)} 条告警 · {data.source}
          </span>
        </header>

        {data.alerts.length === 0 ? (
          <p className="px-4 py-6 text-sm text-signal-muted">暂无告警触发。</p>
        ) : (
          <ul className="divide-y divide-ink-800">
            {data.alerts.map((alert, index) => (
              <li key={index} className="flex items-baseline justify-between gap-3 px-4 py-2">
                <span className="font-mono text-sm">{alert.name}</span>
              </li>
            ))}
          </ul>
        )}

        {data.note !== undefined ? (
          <p className="border-t border-ink-800 px-4 py-2 text-xs text-signal-warn">{data.note}</p>
        ) : null}
      </section>

      <p className="text-xs text-signal-muted">
        只读。启用、停用、编辑和删除告警均未实现，已在端点白名单处拦截。
      </p>
    </div>
  )
}
