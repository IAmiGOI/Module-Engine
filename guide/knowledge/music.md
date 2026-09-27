---
title: Music
tags: music, audio, sound, tracks, playlist, background music, player
anchors: module:module.music
---
Music plays background music that matches the scene. Tracks are chosen locally by meaning (embeddings) — no model calls for picking. Tracks can be tagged by a model once, and direct audio links work. The player is a floating window, toggled from the dock. Module id: module.music.

## Fields on screen
- **Auto-switch with the scene** — after each reply the module compares the scene with the tracks and may change the music. Off means the music only changes by hand.
- **Scene depth (last messages)** — how many recent messages describe "the scene". More = steadier, fewer = reacts faster.
- **Min similarity** — how close a track must be to the scene to be played at all. Higher = pickier (may stay silent); lower = always plays something.
- **Switch margin** — how much better a new track must fit than the one playing before the music changes. Higher = fewer switches.
- **Describe new tracks with the model** — after importing, a model writes a one-line mood description for each track (in batches of 10) so choosing by meaning works even when file names say nothing.
- **Describe with the model** (button) — does that for tracks already in the library; descriptions you edited by hand are never overwritten.
- **Mood description** (per track) — the text the track is matched by. Editing it marks the track as yours. A badge shows where a description came from: AI, Edited, or Title only.
- **Import audio files** / **Add a direct audio link** — add your own files, or a link to an audio file or stream (.mp3, .ogg, .m4a, .flac…). Only the address of a link is stored, never the audio.
- **Save settings** stores the sliders and toggles. The player window (progress, seek, volume, mute) is opened from the dock.
