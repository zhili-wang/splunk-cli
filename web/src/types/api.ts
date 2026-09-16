/**
 * The API contract.
 *
 * These mirror the `toPublicDict()` output of the CLI's models.
 * They are read-only views: the frontend never constructs a result, only
 * renders one. Nullable fields are nullable for a specific reason — see
 * `OverviewMetrics`.
 */

/** The dashboard's own build identity, from `GET /api/version`. */
export interface VersionInfo {
  name: string
  version: string
}

export interface TimeRange {
  earliest: string
  latest: string
  duration_seconds?: number
}

export interface ErrorDetail {
  type: string
  message: string
  details?: Record<string, unknown>
}

export interface ErrorEnvelope {
  success: false
  error: ErrorDetail
}

export interface HealthReport {
  success: boolean
  connection: 'ok' | 'failed' | 'unknown'
  authentication: 'ok' | 'failed' | 'unknown'
  health?: string
  latency_ms?: number
  splunk?: {
    version?: string
    build?: string
    server_name?: string
    license_state?: string
    /**
     * The response is serialized by `HealthReport.toPublicDict()`, which drops
     * every `null` field — and that exclusion recurses into this nested block.
     * So `health` and `version`, the two `str` fields defaulting to the literal
     * "unknown", are the only ones always present; the other seven arrive only
     * when the server reports them, and the whole block is absent when `splunk`
     * is null. Hence every field is optional — reading one needs a guard, not a
     * bare access.
     */
    guid?: string
    health?: string
    os_name?: string
    cpu_arch?: string
    server_start_time?: string
  }
  license?: { status?: string; pools?: unknown[]; reason?: string }
  error?: ErrorDetail
}

export interface TimelinePoint {
  time: string
  count: number
}

export interface TimelineResult {
  success: true
  query: string
  spl: string
  span: string
  count: number
  total: number
  timeline: TimelinePoint[]
  time_range?: TimeRange
}

export interface StatRow {
  key: string | string[]
  count: number
}

export interface StatsResult {
  success: true
  query: string
  spl: string
  function: string
  by: string[]
  count: number
  rows: StatRow[]
  truncated: boolean
  time_range?: TimeRange
}

export interface SearchResult {
  success: true
  query: string
  time_range?: TimeRange
  sid?: string
  count: number
  truncated: boolean
  results: Record<string, unknown>[]
  /**
   * Present only when the backend knows the total (a non-zero value). Omitted
   * when zero, so it is optional rather than required.
   */
  total_available?: number
  /**
   * Present only when the result set carries a field list. Omitted when empty,
   * so it is optional rather than required.
   */
  fields?: string[]
  /**
   * The job the search ran as. Omitted only when the caller built a result set
   * offline, so the status bar has to tolerate its absence.
   */
  job?: JobInfo
}

/**
 * What Splunk reports about the job that produced a result set.
 *
 * Mirrors `SearchJob.toPublicDict()`. The two window fields are the point of it:
 * `earliest`/`latest` on the request are expressions (`@mon`, `now`), and these
 * are the instants Splunk actually resolved them to.
 */
export interface JobInfo {
  sid: string
  dispatch_state: string
  is_done: boolean
  is_failed: boolean
  is_finalized: boolean
  done_progress: number
  result_count: number
  event_count: number
  scan_count: number
  run_duration: number | null
  /** Epoch seconds; absent when the server did not report a resolved window. */
  search_earliest_time?: number
  search_latest_time?: number
  /** `"1"` means no sampling. Anything else makes the counts approximate. */
  sample_ratio?: string
}

export interface FiredAlert {
  name: string
  [key: string]: unknown
}

export interface AlertList {
  success: true
  source: string
  count: number
  alerts: FiredAlert[]
  truncated: boolean
  note?: string
  /**
   * Present only when `include_saved=true` and the account may read saved
   * searches. Declared because the endpoint returns them: a type that omits
   * them is a claim about the wire the compiler cannot check.
   */
  saved_searches?: Record<string, unknown>[]
  saved_count?: number
}

/**
 * Metrics derived by `POST /api/overview`.
 *
 * `null` means "the sub-query failed and we do not know"; `0` means "there is
 * genuinely nothing". The dashboard renders `null` as an em dash, never as a
 * zero — showing 0 where the truth is unknown would be a fabricated fact.
 */
export interface OverviewMetrics {
  events: number | null
  hosts: number | null
  services: number | null
  buckets: number | null
}

export interface OverviewResponse {
  success: boolean
  partial: boolean
  query: string
  time_range: TimeRange
  metrics: OverviewMetrics
  timeline: TimelineResult | null
  by_service: StatsResult | null
  by_host: StatsResult | null
  errors: Record<string, ErrorDetail>
}
