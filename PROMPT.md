# PROMPT.md

This library was built with an AI coding assistant. You don't need this repo: paste the prompt below into your own assistant and you'll get the same thing, adjusted to your stack.

It's a cleaned-up version of what I actually asked for, merged into one prompt. The original came out of a longer conversation about catching members who passed off AI-made images as their own work.

---

Write a TypeScript function `scanImage(data: Uint8Array | ArrayBuffer)` that looks for AI-generation markers in an image file. It must be pure (no I/O), have no dependencies, and run in Node, browsers and Cloudflare Workers. It must never throw, even on garbage bytes.

Don't use any ML model, AI detector or paid API. Only report markers that a tool deliberately wrote into the file. One false flag is worse than 100 misses, so only proof counts as strong.

Sniff the format from the bytes (JPEG or PNG), not the file extension. Scan at most the first 8 MB.

Return `{ strength: "strong" | "weak" | "none", signals: Array<{ code, strength, detail }>, width?, height? }`.

Strong signals (any one makes the result strong):

- `ai_source_type`: the string `trainedAlgorithmicMedia` or `compositeWithTrainedAlgorithmicMedia` anywhere in the file. This is the IPTC digital source type, and it shows up in both XMP and C2PA manifests. In the detail, name the C2PA signer (Google, OpenAI, Adobe, Microsoft, Meta) by searching only inside the C2PA data (JPEG APP11 segments, PNG `caBX` chunks), not the whole file, since ordinary XMP contains "Adobe". Otherwise say "unknown signer".
- `generator_software`: EXIF `Software` (read IFD0 properly) or XMP `CreatorTool` names a known generator: Midjourney, DALL-E, DALL·E, Firefly, Stable Diffusion, ComfyUI, Automatic1111, InvokeAI, NovelAI, Leonardo, Ideogram, Imagen, Gemini. Match whole words only, so "Imagenomic" doesn't match "Imagen".
- `sd_png_chunks`: a PNG `tEXt` or `iTXt` chunk keyed `parameters`, `prompt` or `workflow`.

Info only (recorded, never a flag on its own):

- `c2pa_present` with its signer. Pixel phones sign every real photo with C2PA, so presence alone means nothing.
- `no_camera_exif`: a JPEG with no EXIF Make and no Model.

Weak:

- `generator_dimensions`: width x height in either orientation matches 1024x1024, 1024x1536, 1024x1792, 896x1152, 832x1216, 768x1344 or 2048x2048. Read dimensions from JPEG SOF0/SOF2 and PNG IHDR.
- The result is weak only when generator dimensions fired and nothing strong did. When it's weak, show `no_camera_exif` as weak too, as supporting evidence.

Write tests with `node:test` using small synthetic byte fixtures for every signal, plus these negatives: a JPEG with C2PA but no AI source type (a phone photo) returns none, a JPEG with no metadata returns none, and garbage bytes return none.

Package it as an ES module with type declarations, MIT licensed, installable from GitHub (build on install). Write a README that leads with the limits: it doesn't verify signatures, a missing marker proves nothing because a screenshot strips it, C2PA alone isn't an AI signal, and a marker only proves an AI tool touched the file.
