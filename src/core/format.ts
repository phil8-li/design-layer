/**
 * The one formatter for each number and date shape the UI prints.
 *
 * Counts: plain under 1,000, grouped up to 9,999, compact past that ("12.3K").
 * Dates: "Sep 25", with the year only once it is more than a year old.
 * Fixed to en-US because every other word around these numbers is English.
 *
 * Each formatter is built on first use rather than at module scope: this file
 * evaluates inside the boot script, and constructing the four up front cost
 * ~3ms of the host's first render for shapes most sessions print later or never.
 */

let grouped: Intl.NumberFormat | undefined
let compact: Intl.NumberFormat | undefined
let monthDay: Intl.DateTimeFormat | undefined
let monthDayYear: Intl.DateTimeFormat | undefined

const YEAR_MS = 365 * 24 * 60 * 60 * 1000

/** `999`, `1,234`, `12.3K`. */
export function formatCount(count: number): string {
  if (Math.abs(count) < 10_000) return (grouped ??= new Intl.NumberFormat("en-US")).format(count)
  compact ??= new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
  return compact.format(count)
}

/** `1 note`, `3 notes`, `1,234 notes`. `many` defaults to `one` plus "s". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`
}

/** `Sep 25`, or `Sep 25, 2025` for a date more than a year before `now`. */
export function formatDate(time: number | Date, now: number = Date.now()): string {
  const date = time instanceof Date ? time : new Date(time)
  if (now - date.getTime() > YEAR_MS) {
    monthDayYear ??= new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" })
    return monthDayYear.format(date)
  }
  monthDay ??= new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" })
  return monthDay.format(date)
}
