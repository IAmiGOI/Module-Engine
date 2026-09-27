---
title: Tracker
tags: tracker, trackers, track, field, fields, health, mood, stats, status, values, macro, macros, poll, json
anchors: card:modules
---
The Tracker keeps named values (health, mood, location, anything) up to date by asking a model after or before replies, and exposes them as macros like {{tracker_health}} that can be used in prompts. Each tracker has fields, a trigger (after a reply, or before sending — then the reply waits for it), a model connection it is pinned to, and a sampler preset (Precise/Deterministic are best for strict JSON).
Values are also saved per message, so rerolling or going back shows the value of that moment. Turn it on in [Modules](stme:card:modules) with module id module.tracker.
