/**
 * model-icons — one glyph per model family, shared by job-titles (session titles) and the usage
 * sidebar / model list, so a model reads the same everywhere.
 */

export const GLYPH_WIDTH = 2

// First match wins, so the more specific names come first (muse-spark before spark, gpt-oss
// before gpt). Native 2-cell emoji where possible; the rest are padded by glyphCell().
export const MODEL_ICONS: Array<[RegExp, string]> = [
  [/opus/i, "🎵"],
  [/fable/i, "📜"],
  [/sonnet/i, "✒️"],
  [/haiku/i, "🌸"],
  [/muse/i, "✨"],
  [/gpt-oss/i, "⭕"],
  [/astra/i, "🪐"],
  [/sol/i, "🌞"],
  [/luna/i, "🌙"],
  [/terra/i, "🌍"],
  [/codex|spark/i, "⚡"],
  [/gpt/i, "🔘"],
  [/deepseek/i, "🐋"],
  [/qwen|qwq/i, "🐉"],
  [/kimi/i, "🚀"],
  [/glm/i, "🔷"],
  [/grok/i, "❌"],
  [/llama/i, "🦙"],
  [/gemma/i, "💎"],
  [/mistral/i, "🍃"],
  [/minimax/i, "🔀"],
  [/mimo/i, "🎭"],
  [/nemotron/i, "🟩"],
  [/longcat/i, "🐈"],
  [/(^|\/)hy\d/i, "⛅"],
  [/(^|\/)ling/i, "🔔"],
  [/granite/i, "🪨"],
  [/big-pickle/i, "🥒"],
  [/space-bunny/i, "🐇"],
]

export function displayWidth(g: string) {
  if (!g) return 0
  if (g.includes("\uFE0F")) return 2
  return (g.codePointAt(0) ?? 0) >= 0x1f300 ? 2 : 1
}

// Padding in FRONT, so a narrow glyph lines up with the right edge of a wide one.
export const glyphCell = (g: string) => " ".repeat(Math.max(0, GLYPH_WIDTH - displayWidth(g))) + g

export function modelIcon(modelID: string | undefined) {
  if (!modelID) return ""
  return MODEL_ICONS.find(([re]) => re.test(modelID))?.[1] ?? ""
}
