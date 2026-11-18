# ai-marker-scan

Find AI-generation markers in image files with a byte scan. No dependencies, no API calls, no model. One function, about 300 lines, fast enough to run on every upload in a Cloudflare Worker.

```ts
import { scanImage } from "ai-marker-scan";

const result = scanImage(await file.arrayBuffer());
// {
//   strength: "strong",
//   signals: [
//     { code: "ai_source_type", strength: "strong", detail: "trainedAlgorithmicMedia, signed by Google" },
//     { code: "c2pa_present", strength: "info", detail: "signed by Google" }
//   ],
//   width: 896,
//   height: 1200
// }
```

## Read this first

- **It does not verify signatures.** It searches bytes. Anyone can put the marker string into a file. Use it to decide what a person should look at, never to punish anyone automatically. If you need verification, use [c2pa-js](https://github.com/contentauth/c2pa-js) or [c2patool](https://github.com/contentauth/c2patool).
- **A missing marker proves nothing.** A screenshot, a re-save or most messaging apps strip metadata. This catches the cases where nobody bothered.
- **C2PA alone is not an AI signal.** Pixel 10 phones attach Content Credentials to every photo, and Google Photos adds them to AI and non-AI edits. Only the digital source type counts.
- **"AI touched this file" is all a marker proves.** A real photo edited with an AI tool carries the same marker as a fully generated image.

## What it checks

| Signal | Strength | What it means |
| --- | --- | --- |
| `ai_source_type` | strong | `trainedAlgorithmicMedia` or `compositeWithTrainedAlgorithmicMedia` anywhere in the file. This is the IPTC digital source type that Google, OpenAI, Adobe, Microsoft and Meta write into C2PA manifests and XMP. The detail names the C2PA signer when it can find one. |
| `generator_software` | strong | EXIF `Software` or XMP `CreatorTool` names a known generator (Midjourney, DALL-E, Firefly, Stable Diffusion, ComfyUI, Automatic1111, InvokeAI, NovelAI, Leonardo, Ideogram, Imagen, Gemini). Whole-word matches only. |
| `sd_png_chunks` | strong | A PNG `tEXt`/`iTXt` chunk keyed `parameters`, `prompt` or `workflow`, as written by Stable Diffusion UIs and ComfyUI. |
| `c2pa_present` | info | A C2PA manifest exists (JPEG APP11 or PNG `caBX`). Recorded with its signer, never a flag by itself. |
| `generator_dimensions` | weak | Width x height matches a common generator output (1024x1024, 1024x1536, 896x1152, 832x1216 and similar, either orientation). |
| `no_camera_exif` | info, or weak alongside `generator_dimensions` | A JPEG with no camera Make or Model. Common in screenshots, so it only counts next to generator dimensions. |

`strength` is `strong` if any strong signal fired, `weak` if only generator dimensions did, otherwise `none`.

Format is sniffed from the bytes, not the file extension. Dimensions are read for JPEG and PNG only. Files larger than 8 MB are scanned up to 8 MB.

## On the edge

Scan after the upload is stored so a scan can never slow down or break an upload:

```ts
await env.BUCKET.put(key, bytes);
ctx.waitUntil((async () => {
  const result = scanImage(bytes);
  if (result.strength !== "none") {
    await env.DB.prepare("INSERT INTO image_signals (key, result) VALUES (?, ?)")
      .bind(key, JSON.stringify(result)).run();
  }
})());
```

This only works if you keep the original upload. If your pipeline resizes or re-encodes images in the browser or on the server first, the metadata is gone before you scan.

## Why

I built this for a small social network where every member is vouched for as human. A new member posted a "hand-drawn" ink sketch, captioned as hours of slow, human work. The file carried a Google-signed C2PA manifest with an AI source type, an input image, and edit actions. Across our 206 uploaded images, 4 carried a strong marker. Two were "hand-made" art. Two were article illustrations whose authors never claimed otherwise. That difference is why this tool only reports what it found and leaves the judgment to a person.

## License

MIT
