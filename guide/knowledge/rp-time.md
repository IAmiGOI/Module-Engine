---
title: RP Time
tags: time, clock, date, day, night, rp time, in-world, calendar
anchors: module:module.time
---
RP Time works out the in-world time from the conversation and keeps it as a macro, and shows a time badge under replies. It can inject the current time before a reply is generated so the model keeps track of it. Module id: module.time.

## Fields on screen
- **Model connection** — which connection works out the time from the chat.
- **Preset** with **Apply preset** — fills the neighbouring fields (instruction, sampler) from a ready-made setup; nothing changes until Apply is pressed.
- **Starting time** — where the in-world clock starts before anything has been worked out yet.
- **Display template** — how the time is written in the badge and the floating window. Click a token to append it.
- **Show in chat** — the time badge under each reply. Turning it off only hides the badge; tracking keeps running.
- **Floating time window** — a small always-on-screen clock. Closing it with ✕ hides it, it does not turn tracking off; this switch brings it back.
- **Enabled** — the whole module on or off.
- **Advance now** — works the time out right now instead of waiting for the next reply. **Reset for this chat** forgets the time of this chat and starts again from the starting time.
