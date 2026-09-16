/**
 * Which page numbers the pager offers.
 *
 * A search can return 100 pages, and a button per page is noise. This follows
 * the shape paginated tables converge on: the two ends, the pages around where
 * you are, and a gap standing for everything skipped.
 */

/** A page index (0-based) or a gap marker. */
export type PageSlot = number | 'gap'

/**
 * @param current 0-based page in view.
 * @param total number of pages.
 * @param span how many neighbours to show on each side of `current`.
 */
export function pageWindow(current: number, total: number, span = 1): PageSlot[] {
  if (total <= 0) return []

  const last = total - 1
  const from = Math.max(0, current - span)
  const to = Math.min(last, current + span)

  const slots: PageSlot[] = [0]
  if (from > 1) slots.push('gap')
  for (let page = Math.max(1, from); page <= Math.min(last - 1, to); page += 1) slots.push(page)
  if (to < last - 1) slots.push('gap')
  if (last > 0) slots.push(last)

  return slots
}

/**
 * Turn a typed page number into a 0-based index.
 *
 * Returns `null` for anything that is not a page in range, rather than clamping:
 * quietly jumping somewhere the operator did not ask for is worse than refusing.
 */
export function parsePageNumber(input: string, total: number): number | null {
  const trimmed = input.trim()
  if (!/^\d+$/.test(trimmed)) return null

  const page = Number(trimmed)
  if (page < 1 || page > total) return null
  return page - 1
}
