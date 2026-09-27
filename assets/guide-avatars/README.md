# Mea's dynamic avatars

Drop files here with these exact names. Anything missing just shows a broken image until you add it — no code change needed, `cores/guide/avatar.js` only computes the path.

```
status-red.png            — an ME worker is down right now
status-green.png          — it just recovered (shown for 5 minutes, then fades to normal)
tier-1-full.png           — normal clothing (0–10h of cumulative open time)
tier-1-shorts.png         — shorter (10–25h) — she announces this herself in chat the moment it opens, see below
tier-1-topless.png        — topless (25h+) — same, announced herself
neko-tier-1-full.png      — same three tiers, cat-ears version (only shown once the first-start checklist is 4/4)
neko-tier-1-shorts.png
neko-tier-1-topless.png
chibi-<id>.png            — one file per pose in guide/chibi-poses.json (chibi-angry.png and chibi-happy.png are
                             reserved for ME's worker-health status, same red/green meaning as above, whenever a
                             chibi pose is otherwise active) — flat files, no chibi/ subfolder
```

Priority when several could apply (see `libraries/core/guide-avatar.js` for the exact rules): a matched chibi pose beats the normal tier, but ME's health status always wins over anything else already showing (a plain `status-*` image outside chibi, or `chibi-angry`/`chibi-happy` inside it).

No `neko-tier-*` file yet? The chat window falls back to the plain `tier-*` of the same level automatically (one retry on image error, then the engine's own static default if even that is missing).

Chibi poses are configured in [`guide/chibi-poses.json`](../../guide/chibi-poses.json) — empty by default, add entries there once the pose files exist.

When a new clothing tier opens (shorts at 10h, topless at 25h), she sends a message about it herself, first, unprompted — write those two lines in [`guide/tier-messages.json`](../../guide/tier-messages.json) (leave one blank and she just stays quiet for it).
