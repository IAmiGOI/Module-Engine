---
title: Scene Painter
tags: picture, pictures, image, images, paint, painter, art, illustration, generate image, nanogpt, pollinations, stable diffusion, a1111, reference, avatar
anchors: module:module.scenePainter
---
Scene Painter paints the current scene into the Picture window. A text model writes the image prompt from the last messages, an image backend draws it. The 🎨 Paint button sits under replies (or paint automatically after each reply).
Image backends: Pollinations (free, no key), OpenAI-compatible (OpenAI, NanoGPT and similar), Automatic1111/Forge. With NanoGPT, character avatars are sent as reference photos so the picture keeps their looks — use a model that accepts image input (nano-banana, seedream, flux-kontext, gpt-image). Mature scenes are described as written; a backup prompt writer is asked when the first one refuses. Module id: module.scenePainter.

## Fields on screen
- **Image backend** — which service draws (Pollinations is free; OpenAI-compatible needs a key; Automatic1111/Forge is your own machine). **+ Pollinations / + OpenAI-compatible / + Automatic1111** add one; **Save backends** stores them.
- **Prompt writer (text model)** — the text model that turns the last messages into an image prompt. **Backup prompt writer** is asked when the first one refuses.
- **Instruction for the prompt writer** — how the prompt should be written; the default is fine to start with.
- **Style (appended to every prompt)** — a fixed style tail such as "watercolor, soft light".
- **Negative prompt** — what to avoid. Used by Stable Diffusion and Pollinations; OpenAI ignores it.
- **Scene depth (last messages)** — how many recent messages the prompt writer reads.
- **Width / Height** — picture size in pixels; big sizes are slower and cost more.
- **Paint automatically after every reply** — otherwise use the 🎨 button under a reply.
- **Open the Picture window when a picture is ready** — off: the picture waits under its reply, 🖼 shows it.
- **Use character avatars as reference photos** — the picture keeps the characters' looks. Needs a backend that accepts image input (NanoGPT models like nano-banana, seedream, flux-kontext, gpt-image); others ignore it. **Also send the persona avatar** adds yours.
- **Describe mature scenes as written** — tells the prompt writer not to soften or refuse explicit scenes (all characters shown as adults). The image backend has its own filter.
