---
title: Model connections
tags: model, models, worker, workers, connection, api, key, endpoint, openai, openrouter, nanogpt, anthropic, gemini, local, sillytavern, parallel, check, unstable, down
anchors: card:models
---
[Model connections](stme:card:models) is the list of models the engine uses for its own calls. Each connection has a format (OpenAI-compatible fits most providers, plus Anthropic, Google Gemini, and "SillyTavern main connection"), an endpoint, an API key and a model name.
- **SillyTavern main connection** reuses exactly what SillyTavern is connected to right now — no key needed. Add it with the "+ SillyTavern main connection" button. It works with Chat Completion and Text Completion, not with Kobold Horde or NovelAI.
- **Parallel requests**: how many calls a connection takes at once — 1 for a local model, more for cloud APIs.
- Every connection is checked every 10 minutes when idle. The line under it shows Up / Unstable / Down, reliability, latency and the last error. Unstable connections get fewer requests automatically; a down one only gets requests when nothing else works.
- "Test" sends one tiny request; "Check now" / "Check all" run the health check.
Common endpoint mistakes: missing "/v1" at the end for OpenAI-compatible providers, a model name the provider does not know, an expired key (shows as "rejected").
