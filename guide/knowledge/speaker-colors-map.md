---
title: Speaker Colors and Map
tags: colors, color, speaker, dialogue, quotes, map, location, places, world map
anchors: module:module.speakerColors, module:module.map
---
**Speaker Colors** colors each character's dialogue by who speaks, detected locally; it never changes the text sent to the model (module.speakerColors).
**Map** is a floating, full-screen map window with a settings drawer, opened from its own draggable button (module.map).

## Fields on screen
**Speaker Colors**
- **Add character** — a name and a gender. The module only matches text against the cast you enter (names and pronouns), it does not guess who is speaking; each character on the list has its own colour.
- **Save current cast as preset** — stores the current list of characters and colours under a name; **Apply a saved preset** brings it back (Apply, Delete, Remove buttons manage presets).

**Map** (inside its settings drawer)
- **Map width / height (m)** — the real-world size the map stands for; distances and travel time are computed from it.
- **Walking speed (m/min)** with **Auto-calculate travel time** — travel time between places is worked out from distance and this speed.
- **Auto-connect distance (m)** — any two locations closer than this are connected even if their borders do not touch (blank = off).
- **Minimum traversable rank** — locations ranked below this are excluded from movement (blank = no ceiling).
- **Nested-level scale coefficient** — every nesting level without its own explicit size is this many times smaller than its parent.
- **Marker size** — size of location markers on the map.
- Per location: **Name**, **Description**, **Rank** (free-form abstraction level, lower = more abstract, blank = unranked), **Color** (blank = theme colour), **radius**; **+ Sub-region** nests a region inside one; **Delete location** removes it.
