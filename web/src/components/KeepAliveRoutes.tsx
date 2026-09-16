/**
 * Tab host that keeps a visited tab mounted.
 *
 * Switching tabs used to unmount the previous page, so a submitted query, its
 * results and anything half-typed were thrown away on every navigation. Here a
 * tab is mounted on first visit and afterwards only hidden: state survives, and
 * `display: none` keeps the hidden page out of the accessibility tree and the
 * tab order.
 *
 * Mounting is **lazy on purpose**. Mounting all three tabs up front would fire
 * the overview query and the alerts query before the operator has looked at
 * either, which is both slower and a lie about what is being watched.
 *
 * The wrapper carries a `key`, so a tab keeps its identity (and therefore its
 * state) even when the set of mounted tabs changes around it.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'

export interface TabDefinition {
  /** Absolute path this tab owns, e.g. `/search`. */
  path: string
  element: ReactNode
}

interface Props {
  tabs: readonly TabDefinition[]
}

export function KeepAliveRoutes({ tabs }: Props): JSX.Element {
  const location = useLocation()
  const known = tabs.some((tab) => tab.path === location.pathname)
  // An unknown path falls back to the first tab — same behaviour the router's
  // catch-all `Navigate` used to provide.
  const active = known ? location.pathname : (tabs[0]?.path ?? '/')

  const [visited, setVisited] = useState<readonly string[]>([active])

  useEffect(() => {
    setVisited((previous) => (previous.includes(active) ? previous : [...previous, active]))
  }, [active])

  if (!known) return <Navigate to={active} replace />

  // Filter `tabs` rather than `visited`: the render order stays equal to the
  // declared order no matter which tab was opened first.
  return (
    <>
      {tabs
        .filter((tab) => visited.includes(tab.path))
        .map((tab) => {
          const isActive = tab.path === active
          return (
            <div key={tab.path} className={isActive ? undefined : 'hidden'} aria-hidden={!isActive}>
              {tab.element}
            </div>
          )
        })}
    </>
  )
}
