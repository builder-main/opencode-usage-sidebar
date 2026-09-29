import type { Bucket, Source } from "./usage"

type Result = { buckets: Bucket[] } | { error: string }
export type UsageStatus = "loading" | "ready" | "error" | "retrying"

export function statusText(status: UsageStatus, hasRows: boolean, seconds: number) {
  if (status === "loading") return " loading…"
  if (status === "error") return ` Unavailable, retry in ${seconds}s`
  if (status === "retrying") return " retrying"
  return hasRows ? "" : " ??"
}

export async function readSources(
  fetchClaude: (signal?: AbortSignal) => Promise<Bucket[]>,
  fetchCodex: (signal?: AbortSignal) => Promise<Bucket[]>,
  signal?: AbortSignal,
): Promise<Record<Source, Result>> {
  //operation : independent source requests, failure isolation
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000)
  const [claude, codex] = await Promise.allSettled([fetchClaude(requestSignal), fetchCodex(requestSignal)])
  const result = (settled: PromiseSettledResult<Bucket[]>): Result => {
    if (settled.status === "rejected") return { error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason) }
    if (!settled.value.length) return { error: "no usage windows" }
    return { buckets: settled.value }
  }

  return { claude: result(claude), codex: result(codex) }
}
