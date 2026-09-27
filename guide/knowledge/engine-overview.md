---
title: Module Engine in one page
always: true
anchors: card:modules, card:models, card:engine
---
Module Engine is a SillyTavern extension built like a small operating system. **Cores** are the engine's own parts (models, trackers, summaries, lorebook, UI). **Modules** are features the user turns on or off in [Modules](stme:card:modules) — Tracker, RP Time, Notebook, Secrets, Post-Turn Processor, Music, Scene Painter, Speaker Colors, Map. Modules only reach what their rights allow, through gates — a module cannot touch the network or ST directly.
Most features make their own model calls on the side, separate from the roleplay reply. Those go to **model connections** ([Model connections](stme:card:models)). Without at least one working connection, trackers, summaries and pictures cannot work.
The main panel opens from the floating dock at the right edge of the screen; settings (preset, sync, updates, backgrounds) have their own screen.
