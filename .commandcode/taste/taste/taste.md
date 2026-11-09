# Taste
- Wants large multi-part work committed incrementally — one commit per plan block — and the agent to leave merging into the release branch (Dev-Version) to the user rather than doing it itself. Confidence: 0.8
- Verifies work without live provider traffic: no real model requests and credentials (API keys) never touched or printed — fakes and synthetic measurements are used instead. Confidence: 0.85
- Treats SillyTavern as a read-only reference: its code may be read to match the formats it expects, but it must not be edited. Confidence: 0.55
- When a change would break something that cannot be replaced, prefers the agent to stop and present the options rather than pick a substitute on its own. Confidence: 0.55
- Prefers brisk execution: minimal status narration between steps, keep working through the plan and report at the end ("Продолжай быстрее"). Confidence: 0.5
- When text is moved from a spec document into code or prompts, wants it copied word for word rather than paraphrased or "improved" ("дословно"). Confidence: 0.6
