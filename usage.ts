/**
 * usage — subscription usage math, shared by the usage sidebar (TUI) and the sub-usage server
 * plugin (model list names).
 *
 * Sources, one reading each:
 *   claude   Meridian's GET <anthropic baseURL>/usage/quota (Claude Max). Buckets: five_hour,
 *            seven_day, and seven_day_<family> (opus, sonnet, fable...) when that family has its own cap.
 *   codex    ChatGPT's /backend-api/wham/usage with the Codex CLI login (~/.codex/auth.json), for
 *            the openai provider on a ChatGPT plan. Plans without a 5h window get one cell.
 *
 * Gauges and percents show what is LEFT: a full cell is an untouched window. Both sources are
 * stored as used share (utilization); the flip to remaining happens only when formatting.
 *
 * Per provider (usage sidebar), one row per window the provider reports:
 *   5h ▃ 32%   gauge and percent left (5h, week, then family caps such as Opus)
 *   ⇩55m       runway at the speed of the last ~30 min, only while going faster than an even
 *              spread over the window (×1)
 *   ↻ 2:25pm   the window's reset
 *   ⊘ ↻ Tue    the window is full; work resumes at its reset
 *   ??         no fresh reading
 *
 * Per model (model list):
 *   ▆81% ▅69%  5h session then 7d week (the tighter of seven_day / seven_day_<family>), gauge and
 *              percent left each; a window the plan lacks is left out (the list reloads on each % change)
 *   ⇩55m     as above; the tightest window wins, with its reset only when the runway ends before it
 *   ⊘↻Tue    a window is full; the latest reset among the full ones is when work resumes
 *   ??       no fresh reading
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

// ------------------------------------------------------------------ tunables

export const QUOTA_URL = "http://127.0.0.1:3456/v1/usage/quota"
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
const CODEX_AUTH = join(homedir(), ".codex", "auth.json")
export const POLL_MS = 60_000
const RATE_SPAN_MS = 30 * 60_000 // speed is measured over this much recent history
const RATE_MIN_SPAN_MS = 5 * 60_000 // below this there is no speed yet
export const STALE_MS = 30 * 60_000
const WARN_AT = 0.6
const CRIT_AT = 0.85
const REDLINE = 3 // speed above this is red
const SESSION_WEIGHT = 0.3
const WEEK_WEIGHT = 1 - SESSION_WEIGHT
const LOW_PRESSURE_AT = 1.5
const HIGH_PRESSURE_BELOW = 0.9
const PRESSURE_DECIMALS = 1

export const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 86400_000 }
const WINDOW_LABEL: Record<string, string> = { five_hour: "5h", seven_day: "week" }
const FAMILY_PREFIX = "seven_day_"

// ------------------------------------------------------------------ types

export type Source = "claude" | "codex"
export type Reading = Partial<Record<Source, Bucket[]>>
export type Bucket = { type: string; utilization: number; resetsAt: number; observedAt: number }
export type Sample = { at: number; u: number }
export type Samples = Record<string, Sample[]>
export type Level = "low" | "warn" | "crit" | "dim"
export type Piece = { text: string; level: Level }
export type Badge = { cells: Piece[]; percents?: Piece[]; extra?: Piece }
export type Row = { label: string; cell: Piece; percent: Piece; extra: Piece }

// Brand colours: Anthropic orange, ChatGPT green.
export const SOURCE_INFO: Record<Source, { icon: string; color: string; name: string }> = {
  claude: { icon: "●", color: "#D97757", name: "Claude" },
  codex: { icon: "●", color: "#10A37F", name: "Codex" },
}

// ------------------------------------------------------------------ data

export async function fetchQuota(url = QUOTA_URL, signal?: AbortSignal): Promise<Bucket[]> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`quota ${res.status}`)
  const body: any = await res.json()
  return (body?.buckets ?? []).filter(
    (b: any) => typeof b?.type === "string" && typeof b.utilization === "number" && typeof b.resetsAt === "number",
  )
}

// ChatGPT windows come as seconds; they map onto the same five_hour / seven_day buckets.
export async function fetchCodex(signal?: AbortSignal): Promise<Bucket[]> {
  const auth = JSON.parse(await readFile(CODEX_AUTH, "utf8"))
  const res = await fetch(CODEX_USAGE_URL, {
    signal,
    headers: {
      Authorization: `Bearer ${auth?.tokens?.access_token ?? ""}`,
      "chatgpt-account-id": auth?.tokens?.account_id ?? "",
      "User-Agent": "codex_cli_rs",
    },
  })
  if (!res.ok) throw new Error(`codex usage ${res.status}`)
  const limit: any = (await res.json())?.rate_limit ?? {}
  const now = Date.now()
  return [limit.primary_window, limit.secondary_window]
    .filter((w: any) => w && typeof w.used_percent === "number")
    .map((w: any) => ({
      type: w.limit_window_seconds <= 86400 ? "five_hour" : "seven_day",
      utilization: limit.limit_reached && w.used_percent >= 100 ? 1 : w.used_percent / 100,
      resetsAt: (w.reset_at ?? now / 1000 + (w.reset_after_seconds ?? 0)) * 1000,
      observedAt: now,
    }))
}

// Each source on its own: one failing leaves the other's reading in place.
export async function fetchAll(signal?: AbortSignal): Promise<Reading> {
  const [claude, codex] = await Promise.all([
    fetchQuota(QUOTA_URL, signal).catch(() => undefined),
    fetchCodex(signal).catch(() => undefined),
  ])
  return { ...(claude && { claude }), ...(codex && { codex }) }
}

const origin = (url: unknown) => {
  try {
    return new URL(String(url ?? "")).origin
  } catch {
    return ""
  }
}

// Which reading a provider's models are billed against, if any.
export function sourceOf(provider: { id: string; baseURL?: unknown; oauth?: boolean }): Source | undefined {
  if (origin(provider.baseURL) === origin(QUOTA_URL)) return "claude"
  if (provider.id === "openai" && provider.oauth !== false) return "codex" // unknown counts: only an API key opts out
  return undefined
}

// Keeps the recent history speed is read from. A drop in utilization is a reset: history restarts.
export function record(samples: Samples, buckets: Bucket[], now = Date.now()) {
  for (const b of buckets) {
    const list = (samples[b.type] ??= [])
    const last = list[list.length - 1]
    if (last && b.utilization < last.u) list.length = 0
    const at = b.observedAt || now
    if (!list.length || list[list.length - 1].at !== at) list.push({ at, u: b.utilization })
    while (list.length && list[0].at < now - RATE_SPAN_MS * 1.5) list.shift()
  }
}

// Utilization per ms over the last RATE_SPAN_MS, or undefined when the history is too short.
function rate(list: Sample[] | undefined, now: number) {
  if (!list || list.length < 2) return undefined
  const last = list[list.length - 1]
  const first = list.find((s) => s.at >= now - RATE_SPAN_MS) ?? list[0]
  const span = last.at - first.at
  if (span < RATE_MIN_SPAN_MS) return undefined
  return Math.max(0, (last.u - first.u) / span)
}

// ------------------------------------------------------------------ formatting

const BARS = "▁▂▃▄▅▆▇█"

const levelOf = (u: number): Level => (u >= CRIT_AT ? "crit" : u >= WARN_AT ? "warn" : "low")
const bar = (u: number) => BARS[Math.max(0, Math.min(7, Math.floor(u * 8)))]

function clock(ms: number) {
  const d = new Date(ms)
  const h = d.getHours() % 12 || 12
  const m = d.getMinutes()
  const ap = d.getHours() < 12 ? "am" : "pm"
  return m ? `${h}:${String(m).padStart(2, "0")}${ap}` : `${h}${ap}`
}

// Within a day: the clock time. Further: the weekday, with the time when it matters.
export function when(ms: number, now = Date.now(), withTime = false) {
  if (ms - now < 86400_000) return clock(ms)
  const day = new Date(ms).toLocaleDateString("en-US", { weekday: "short" })
  return withTime ? `${day} ${clock(ms)}` : day
}

// 5-minute steps under an hour, so the model list is not renamed every minute.
export function span(ms: number) {
  const m = Math.max(1, Math.round(ms / 60_000))
  if (m < 60) return m < 10 ? `${m}m` : `${Math.round(m / 5) * 5}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

// ------------------------------------------------------------------ badge

const cell = (b: Bucket): Piece => ({ text: bar(1 - b.utilization), level: levelOf(b.utilization) })
const percent = (b: Bucket): Piece => ({ text: `${Math.round((1 - b.utilization) * 100)}`, level: levelOf(b.utilization) })
const isStale = (buckets: Bucket[], now: number) => now - Math.max(...buckets.map((b) => b.observedAt || 0)) > STALE_MS

// Runway at the recent speed, only while going faster than an even spread over the window.
function pace(b: Bucket, samples: Samples, now: number) {
  const r = rate(samples[b.type], now)
  if (!r) return undefined
  const speed = r * (WINDOW_MS[b.type] ?? WINDOW_MS.seven_day)
  if (speed <= 1) return undefined
  return { runway: (1 - b.utilization) / r, speed }
}

const paceLevel = (speed: number): Level => (speed > REDLINE ? "crit" : "warn")

// seven_day_opus applies to opus models, and so on.
export function windowsFor(modelID: string, buckets: Bucket[]) {
  const id = modelID.toLowerCase()
  const session = buckets.find((b) => b.type === "five_hour")
  const weeks = buckets.filter(
    (b) => b.type === "seven_day" || (b.type.startsWith(FAMILY_PREFIX) && id.includes(b.type.slice(FAMILY_PREFIX.length))),
  )
  return { session, weeks }
}

export function badge(modelID: string, buckets: Bucket[], samples: Samples, now = Date.now()): Badge | undefined {
  const { session, weeks } = windowsFor(modelID, buckets)
  const week = weeks.reduce<Bucket | undefined>((a, b) => (!a || b.utilization > a.utilization ? b : a), undefined)
  const all = [session, ...weeks].filter((b): b is Bucket => !!b)
  if (!all.length) return undefined
  if (isStale(all, now)) return { cells: [{ text: "??", level: "dim" }] }

  const shown = [session, week].filter((b): b is Bucket => !!b)
  const cells = shown.map(cell)
  const percents = shown.map(percent)

  //full : the latest reset among full windows is when work can resume
  const full = all.filter((b) => b.utilization >= 1)
  if (full.length) {
    const until = Math.max(...full.map((b) => b.resetsAt))
    return { cells, percents, extra: { text: `⊘↻ ${when(until, now, true)}`, level: "crit" } }
  }

  //speeding : the window with the shortest runway, only above an even spread
  let pick: { runway: number; speed: number; reset: number } | undefined
  for (const b of all) {
    const p = pace(b, samples, now)
    if (p && (!pick || p.runway < pick.runway)) pick = { ...p, reset: b.resetsAt }
  }
  if (!pick) return { cells, percents }

  const reset = pick.runway < pick.reset - now ? ` ↻ ${when(pick.reset, now)}` : ""
  return { cells, percents, extra: { text: `⇩${span(pick.runway)}${reset}`, level: paceLevel(pick.speed) } }
}

// ------------------------------------------------------------------ provider rows

const WINDOW_ORDER = Object.keys(WINDOW_LABEL)
const orderOf = (type: string) => (WINDOW_ORDER.includes(type) ? WINDOW_ORDER.indexOf(type) : WINDOW_ORDER.length)

function labelOf(type: string) {
  const family = type.slice(FAMILY_PREFIX.length)
  return WINDOW_LABEL[type] ?? family.charAt(0).toUpperCase() + family.slice(1)
}

function extraOf(b: Bucket, samples: Samples, now: number): Piece {
  //pre-condition : full window
  if (b.utilization >= 1) return { text: `⊘ ↻ ${when(b.resetsAt, now, true)}`, level: "crit" }

  //operation : runway when speeding, reset always
  const reset = `↻ ${when(b.resetsAt, now)}`
  const p = pace(b, samples, now)
  return p ? { text: `⇩${span(p.runway)} ${reset}`, level: paceLevel(p.speed) } : { text: reset, level: "low" }
}

// One row per window the provider reports, in its order: 5h, week, family caps. Undefined when stale.
export function rows(buckets: Bucket[], samples: Samples, now = Date.now()): Row[] | undefined {
  //pre-condition : buckets, fresh reading
  if (!buckets.length) return []
  if (isStale(buckets, now)) return undefined

  //operation : gauge, percent left, runway or reset per window
  return [...buckets]
    .sort((a, b) => orderOf(a.type) - orderOf(b.type))
    .map((b) => ({ label: labelOf(b.type), cell: cell(b), percent: percent(b), extra: extraOf(b, samples, now) }))
}

// Each gauge followed by its own percent: ▆81% ▅69%.
export function plain(b: Badge) {
  const windows = b.cells.map((c, i) => (b.percents?.[i] ? `${c.text}${b.percents[i].text}%` : c.text))
  return windows.join(" ") + (b.extra ? " " + b.extra.text : "")
}

// ------------------------------------------------------------------ pressure

export function quotaEvidence(modelID: string, source: Source | undefined, reading: Reading, now = Date.now()) {
  //pre-condition : applicable subscription source
  if (!source) return { status: "unknown", source: null, pressure: null, windows: [] }
  const { session, weeks } = windowsFor(modelID, reading[source] ?? [])
  const applicable = [...(session ? [session] : []), ...weeks]

  //operation : each shared or family window, independent freshness
  //  pressure = remaining share / share of window time left; > 1 means budget expires unused at reset
  const windows = applicable.map(b => {
    const fresh = b.observedAt > 0 && now - b.observedAt <= STALE_MS && b.resetsAt > now
    const remaining = fresh ? Math.max(0, 1 - b.utilization) : null
    const timeLeft = (b.resetsAt - now) / (WINDOW_MS[b.type] ?? WINDOW_MS.seven_day)
    return { type: b.type, remaining, pressure: remaining === null ? null : remaining / timeLeft, resetsAt: b.resetsAt, observedAt: b.observedAt, status: fresh ? "fresh" : "unknown" }
  })

  //post-condition : unknown evidence, exhausted caps, weighted session and weekly pressure
  const fresh = windows.length > 0 && windows.every(w => w.status === "fresh")
  if (!fresh) return { status: "unknown", source, pressure: null, windows }
  const sessionPressure = session ? windows.find(w => w.type === session.type)!.pressure! : undefined
  const weekPressures = windows.filter(w => w.type !== session?.type).map(w => w.pressure!)
  const weekPressure = weekPressures.length ? Math.min(...weekPressures) : undefined
  const exhausted = windows.some(w => w.remaining === 0)
  const pressure = exhausted ? 0 : sessionPressure !== undefined && weekPressure !== undefined
    ? SESSION_WEIGHT * sessionPressure + WEEK_WEIGHT * weekPressure
    : (sessionPressure ?? weekPressure)!
  return { status: "fresh", source, pressure, windows }
}

// Provider heading uses shared caps (no model id, so no family cap); family caps keep their own rows.
export function providerPressureLabel(source: Source, reading: Reading, now = Date.now()) {
  //pre-condition : fresh reading
  const pressure = quotaEvidence("", source, reading, now).pressure
  if (pressure === null) return undefined

  //operation : inverse pace, muted Usage heading label, normal without qualifier
  const label = pressure >= LOW_PRESSURE_AT ? "low pressure" : pressure < HIGH_PRESSURE_BELOW ? "high pressure" : "pressure"
  const value = pressure === 0 ? "∞" : String(Number((1 / pressure).toFixed(PRESSURE_DECIMALS)))
  return `${label} ${value}`
}
