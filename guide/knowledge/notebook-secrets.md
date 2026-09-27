---
title: Notebook and Secrets
tags: notebook, notes, memory, plans, goals, secrets, secret, hidden, knows
anchors: module:module.notebook, module:module.secrets
---
**Notebook** is a private notebook the AI writes to and reads back — working memory for plans, secrets and goals across the chat (module.notebook).
**Secrets** is a list of hidden story facts, each tagged with who knows it, so characters don't reveal what they shouldn't know (module.secrets).

## Fields on screen
Notebook and Secrets share the same three settings:
- **Maximum notes / Maximum secrets** — how many entries are kept. When it is full, the oldest are cleared to make room.
- **Cleanup batch** — how many of the oldest entries are cleared at once (never more than the maximum), so cleaning does not happen on every single new entry.
- **Injection depth (@N)** — where the entries are placed in the prompt: N messages from the end. 0 = right at the end; larger = further back in the history.
- **New note / New secret** with **+ Add note / + Add secret** — add an entry by hand; the model adds its own with the tool. A secret is tagged with who knows it. **Delete** removes one. **Save settings** stores the sliders.
