---
title: Post-Turn Processor
tags: postprocess, post-processing, rewrite, polish, passes, style, fix reply, edit reply
anchors: card:modules
---
The Post-Turn Processor rewrites each fresh reply through a chain of independent model passes (for example: fix grammar, remove clichés, enforce a style) and replaces the reply with the final result. Each pass is its own prompt and model. Module id: module.postprocess.
