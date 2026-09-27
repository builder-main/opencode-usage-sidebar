/** @jsxImportSource @opentui/solid */
/**
 * usage — Context and subscription Usage, in the built-in session sidebar, under Jobs.
 *
 *   Context
 *   48,210 tokens
 *   24% used
 *   $0.83 spent          only for pay-per-token models; hidden for subscription and self-hosted
 *
 *   Usage
 *   ✳ Claude
 *     5h     ▃  32%  ⇩55m ↻ 2:25pm
 *     week   ▆  69%  ↻ Thu
 *   ⚡ Codex
 *     week   █  90%  ↻ Fri
 *
 * Replaces the built-in opencode.sidebar.context (disabled in cli.json) so both sit together.
 * Usage shows each subscription the connected providers bill against, one row per window it
 * reports, as what is left; rows and extras are explained in usage.ts. Readings (Meridian
 * for Claude, the Codex CLI login for ChatGPT) come every POLL_MS.
 */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { glyphCell } from "./model-icons"
import { fetchAll, POLL_MS, providerPressureLabel, record, rows, SOURCE_INFO, sourceOf, type Level, type Reading, type Samples, type Source } from "./usage"

// ------------------------------------------------------------------ tunables

const LABEL_WIDTH = 6
const PERCENT_WIDTH = 3

// ------------------------------------------------------------------ helpers

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

const isLocal = (url: unknown) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(String(url ?? ""))

// Same token count as the built-in section: last assistant turn after the last compaction.
function contextUsage(messages: readonly any[], models: readonly any[] | undefined, boundary?: string) {
  const stop = boundary ? messages.findIndex((m) => m.id === boundary) : -1
  if (boundary && stop === -1) return undefined
  const end = stop === -1 ? messages.length : stop
  const compaction = messages.findLastIndex((m, i) => m.type === "compaction" && m.status === "completed" && i < end)
  const last = messages.findLast((m, i) => m.type === "assistant" && m.tokens !== undefined && i > compaction && i < end)
  if (!last) return undefined
  const t = last.tokens
  const tokens = t.input + t.output + t.reasoning + t.cache.read + t.cache.write
  if (tokens <= 0) return undefined
  const model = models?.find((m) => m.providerID === last.model.providerID && m.id === last.model.id)
  return { tokens, percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : undefined }
}

// ------------------------------------------------------------------ the sidebar section

function Sidebar(props: { sessionID: string }) {
  const context = usePlugin()
  const theme = context.theme as any
  const data = context.data

  const [live, setLive] = context.storage.memory("usage/v3", {
    initial: {
      reading: {} as Reading,
      samples: {} as Partial<Record<Source, Samples>>,
    },
  })
  const [now, setNow] = createSignal(Date.now())

  const session = createMemo(() => data.session.get(props.sessionID))
  const providers = createMemo(() => data.location.provider.list(session()?.location) ?? [])
  const models = createMemo(() => data.location.model.list(session()?.location) ?? [])

  const oauth = (provider: any) => {
    const integration: any = (data.location.integration.list(session()?.location) ?? []).find(
      (i) => i.id === provider.integrationID,
    )
    const credentials = (integration?.connections ?? []).filter((c: any) => c.type === "credential")
    return credentials.length ? credentials.some((c: any) => c.method === "oauth") : undefined
  }

  // Which usage reading each provider is billed against; none for API keys and self-hosted.
  const sources = createMemo(() => {
    const out = new Map<string, Source>()
    for (const p of providers() as any[]) {
      const source = sourceOf({ id: p.id, baseURL: p.settings?.baseURL, oauth: oauth(p) })
      if (source) out.set(p.id, source)
    }
    return out
  })

  // ---------------------------------------------------------------- context

  const state = createMemo(() =>
    contextUsage(data.session.message.list(props.sessionID), models(), session()?.revert?.messageID),
  )
  const cost = createMemo(() => data.session.cost(props.sessionID))

  // Spent means something only when paying per token: not on a subscription, not self-hosted.
  const paysPerToken = createMemo(() => {
    const providerID = session()?.model?.providerID
    const provider: any = providers().find((p) => p.id === providerID)
    if (!provider) return true
    if (isLocal(provider.settings?.baseURL)) return false
    return oauth(provider) !== true
  })

  // ---------------------------------------------------------------- usage

  async function poll() {
    //pre-condition : a fresh reading
    const reading = await fetchAll()

    //post-condition : shared memory holds the latest reading and its history
    setLive((d) => {
      d.reading ??= {}
      d.samples ??= {}
      for (const [source, buckets] of Object.entries(reading) as Array<[Source, NonNullable<Reading[Source]>]>) {
        d.reading[source] = buckets
        record((d.samples[source] ??= {}), buckets)
      }
    })
    setNow(Date.now())
  }

  const timer = setInterval(() => void poll(), POLL_MS)
  onCleanup(() => clearInterval(timer))
  void poll()

  // One group per subscription in use; rows undefined means the reading went stale.
  const groups = createMemo(() => {
    const t = now()
    const inUse = new Set(sources().values())
    return (Object.keys(SOURCE_INFO) as Source[])
      .filter((source) => inUse.has(source))
      .flatMap((source) => {
        const list = rows(live.reading[source] ?? [], live.samples[source] ?? {}, t)
        if (list?.length === 0) return []
        return [{ source, ...SOURCE_INFO[source], rows: list, pressure: providerPressureLabel(source, live.reading, t) }]
      })
  })

  const color = (level: Level) =>
    level === "crit"
      ? theme.text.feedback.error.base
      : level === "warn"
        ? theme.text.feedback.warning.base
        : level === "dim"
          ? theme.border.base
          : theme.text.muted

  const pad = (label: string) => (label.length > LABEL_WIDTH ? label.slice(0, LABEL_WIDTH - 1) + "…" : label.padEnd(LABEL_WIDTH))

  // ---------------------------------------------------------------- view

  return (
    <box flexDirection="column">
      <Show when={state() || (paysPerToken() && cost() > 0)}>
        <box>
          <text fg={theme.text.base}>
            <b>Context</b>
          </text>
          <Show when={state()}>
            {(value) => (
              <>
                <text fg={theme.text.muted}>{value().tokens.toLocaleString()} tokens</text>
                <Show when={value().percent !== undefined}>
                  <text fg={theme.text.muted}>{value().percent}% used</text>
                </Show>
              </>
            )}
          </Show>
          <Show when={paysPerToken() && cost() > 0}>
            <text fg={theme.text.muted}>{money.format(cost())} spent</text>
          </Show>
        </box>
      </Show>

      <Show when={groups().length}>
        <box paddingTop={1} flexDirection="column">
          <text fg={theme.text.base}>
            <b>Usage</b>
          </text>
          <For each={groups()}>
            {(group) => (
              <>
                <text fg={theme.text.base} wrapMode="none">
                  <span style={{ fg: group.color }}>{glyphCell(group.icon)}</span> {group.name}
                  <Show when={group.pressure}>
                    {(pressure) => <span style={{ fg: theme.text.muted }}>{"  " + pressure()}</span>}
                  </Show>
                  <Show when={!group.rows}>
                    <span style={{ fg: color("dim") }}> ??</span>
                  </Show>
                </text>
                <For each={group.rows ?? []}>
                  {(row) => (
                    <text fg={theme.text.base} wrapMode="none">
                      {"  "}
                      {pad(row.label)}{" "}
                      <span style={{ fg: color(row.cell.level) }}>{row.cell.text}</span>
                      <span style={{ fg: color(row.percent.level) }}>{" " + row.percent.text.padStart(PERCENT_WIDTH)}</span>
                      <span style={{ fg: theme.text.muted }}>%</span>
                      <span style={{ fg: color(row.extra.level) }}>{"  " + row.extra.text}</span>
                    </text>
                  )}
                </For>
              </>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "usage-sidebar",
  setup(context) {
    return context.ui.slot({
      prepend: "sidebar.content",
      render: ({ sessionID }) => <Sidebar sessionID={sessionID} />,
    })
  },
})
