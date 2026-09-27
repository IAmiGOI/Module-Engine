---
title: Tracker
tags: tracker, trackers, track, field, fields, health, mood, stats, status, values, macro, macros, poll, json
anchors: module:module.tracker
---
The Tracker keeps named values (health, mood, location, anything) up to date by asking a model after or before replies, and exposes them as macros like {{tracker_health}} that can be used in prompts. Each tracker has fields, a trigger (after a reply, or before sending — then the reply waits for it), a model connection it is pinned to, and a sampler preset (Precise/Deterministic are best for strict JSON).
Values are also saved per message, so rerolling or going back shows the value of that moment. Turn it on in [Modules](stme:card:modules) with module id module.tracker.

## Fields on screen
Each tracker is one row; inside it:
- **Name** — the tracker's id. Its values become macros, so keep it short, lowercase, no spaces.
- **Model connection** — which connection answers the polls. A cheap fast one is fine; the answer is small JSON.
- **Fields** — the values to keep (health, mood, location…). Each has a name, a short "prompt" telling the model what to write there (e.g. "how hurt the hero is, 0–100") and a starting value. Clear prompts matter more than anything else here. **+ Add field** adds one.
- **Poll when** — what triggers an update: after every reply, every N replies, every N minutes, when the user sends a message, before the reply is generated, or only by hand ("Poll now").
- **Hold the generation until this tracker answers** — only with "before the reply": the reply waits so it already sees the fresh value. Slower, but the value is never a step behind.
- **Poll prompt** — the full text sent to the model. Empty = the engine's default, which is right almost always. `{fields}` inserts the field list.
- **Display template** — how the value is shown in the small state window, e.g. `❤ {health} · 📍 {location}`. Empty = a plain "name: value" list. Click a token to append it.
- **Show the floating state window** — the small always-on-screen panel with the current values.
- **Enabled** — off means it stops polling but keeps its settings.
- Buttons: **Save** writes the configuration (nothing takes effect until saved); **Poll now** runs one update right away using the saved settings; **Reset** puts the values of this chat back to their starting values; **Remove** deletes the tracker.
- Sampler sliders and reasoning options belong to this tracker, not to the connection: low temperature / deterministic presets suit strict JSON.
