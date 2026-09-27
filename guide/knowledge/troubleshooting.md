---
title: Troubleshooting
tags: error, errors, broken, not working, doesnt work, fail, failed, failing, slow, stuck, nothing happens, problem, help
anchors: card:models, card:modules
---
First look at the live state: most problems are a model connection that is down or rejected — its last error is shown under it in [Model connections](stme:card:models).
- "HTTP 401/403" — wrong or expired API key. "HTTP 404" — wrong endpoint or model name. "HTTP 429" — rate limit, add another connection or raise nothing, it recovers. "Failed to fetch" — the endpoint is unreachable or blocks the browser (CORS).
- A feature does nothing: check its module is on in [Modules](stme:card:modules) and that it has a connection selected.
- Replies wait before generating: a tracker set to run before sending is polling; a slow connection makes the whole reply wait.
