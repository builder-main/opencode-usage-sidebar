import { expect, test } from "bun:test"
import { readSources, statusText } from "./poll"

const bucket = { type: "five_hour", utilization: 0.2, resetsAt: 1, observedAt: 1 }

test("a failed Claude request leaves Codex available and recovers on retry", async () => {
  let attempts = 0
  const fetchClaude = async () => {
    if (++attempts === 1) throw new Error("quota unavailable")
    return [bucket]
  }
  const fetchCodex = async () => [bucket]

  const first = await readSources(fetchClaude, fetchCodex)
  expect(first.claude).toEqual({ error: "quota unavailable" })
  expect(first.codex).toEqual({ buckets: [bucket] })

  const second = await readSources(fetchClaude, fetchCodex)
  expect(second.claude).toEqual({ buckets: [bucket] })
  expect(attempts).toBe(2)
})

test("empty results are reported as unavailable", async () => {
  const result = await readSources(async () => [], async () => [bucket])
  expect(result.claude).toEqual({ error: "no usage windows" })
})

test("startup and failed readings have visible labels", () => {
  expect(statusText("loading", true, 10)).toBe(" loading…")
  expect(statusText("error", true, 10)).toBe(" Unavailable, retry in 10s")
  expect(statusText("error", false, 1)).toBe(" Unavailable, retry in 1s")
  expect(statusText("retrying", true, 0)).toBe(" retrying")
  expect(statusText("ready", false, 0)).toBe(" ??")
  expect(statusText("ready", true, 0)).toBe("")
})
