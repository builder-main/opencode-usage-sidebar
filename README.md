# opencode-usage-sidebar

OpenCode V2 CLI plugin: Context and subscription Usage in the session sidebar.

### Preview in the side bar
<img width="296" height="180" alt="image" src="https://github.com/user-attachments/assets/d94d15f2-22e9-4aae-a7a4-467c09314605" />

### Example
```
Context
48,210 tokens
24% used

Usage
● Claude  low pressure 0.4
    5h     ▃  51%  ↻ 2:25pm
    week   ▆  59%  ↻ Tue
● Codex  pressure 1
    week   █  90%  ↻ Fri
```

- Gauges and percents show what is left in each window.
- `⇩55m` runway at the recent speed, shown only while going faster than an even spread.
- `↻` the window's reset; `⊘` the window is full.
- Pressure, beside each subscription: how fast the budget is used against the time left, 5h window weighted 30%, weekly 70%. `1` is on pace, above is ahead of pace (`high pressure` above ~1.1), below is budget left over at reset (`low pressure` below ~0.7).

## Install

Clone somewhere under your OpenCode config directory and add it to `~/.config/opencode/cli.json`:

```json
{
  "plugins": ["./packages/usage-sidebar", "-opencode.sidebar.context"]
}
```

`-opencode.sidebar.context` hides the built-in Context section, which this one replaces.

## Sources (both optional)

| Group | Needs |
|---|---|
| Claude | Meridian as the Anthropic provider, listening on `127.0.0.1:3456` (`QUOTA_URL` in `usage.ts`; edit it for another port) |
| Codex | the Codex CLI login (`~/.codex/auth.json`) and the `openai` provider on a ChatGPT plan |

A missing source hides its group; nothing else breaks.

## Files

- `tui.tsx` the sidebar section
- `usage.ts` readings, formatting, pressure
- `model-icons.ts` one glyph per model family

