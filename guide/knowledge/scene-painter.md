---
title: Scene Painter
tags: picture, pictures, image, images, paint, painter, art, illustration, generate image, nanogpt, pollinations, stable diffusion, a1111, reference, avatar
anchors: card:modules
---
Scene Painter paints the current scene into the Picture window. A text model writes the image prompt from the last messages, an image backend draws it. The 🎨 Paint button sits under replies (or paint automatically after each reply).
Image backends: Pollinations (free, no key), OpenAI-compatible (OpenAI, NanoGPT and similar), Automatic1111/Forge. With NanoGPT, character avatars are sent as reference photos so the picture keeps their looks — use a model that accepts image input (nano-banana, seedream, flux-kontext, gpt-image). Mature scenes are described as written; a backup prompt writer is asked when the first one refuses. Module id: module.scenePainter.
