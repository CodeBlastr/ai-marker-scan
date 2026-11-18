import { test } from "node:test";
import assert from "node:assert/strict";
import { scanImage } from "../src/index.ts";


const enc = (s: string) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

function segment(marker: number, payload: number[]): number[] {
  return [0xff, marker, ...u16be(payload.length + 2), ...payload];
}

function sof0(width: number, height: number): number[] {
  return segment(0xc0, [8, ...u16be(height), ...u16be(width), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
}

// Big-endian TIFF with ASCII entries in IFD0.
function exifApp1(fields: Array<[number, string]>): number[] {
  const entries: number[] = [];
  const data: number[] = [];
  const dataStart = 8 + 2 + fields.length * 12 + 4;
  for (const [tag, value] of fields) {
    const bytes = [...enc(value), 0];
    entries.push(...u16be(tag), ...u16be(2), ...u32be(bytes.length));
    if (bytes.length <= 4) {
      entries.push(...bytes, ...Array(4 - bytes.length).fill(0));
    } else {
      entries.push(...u32be(dataStart + data.length));
      data.push(...bytes);
    }
  }
  const tiff = [...enc("MM"), 0, 42, ...u32be(8), ...u16be(fields.length), ...entries, 0, 0, 0, 0, ...data];
  return segment(0xe1, [...enc("Exif\0\0"), ...tiff]);
}

function jpeg(...segments: number[][]): Uint8Array {
  return new Uint8Array([0xff, 0xd8, ...segments.flat(), 0xff, 0xda, 0, 2, 0xff, 0xd9]);
}

function chunk(type: string, data: number[]): number[] {
  return [...u32be(data.length), ...enc(type), ...data, 0, 0, 0, 0];
}

function png(width: number, height: number, ...chunks: number[][]): Uint8Array {
  const ihdr = chunk("IHDR", [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]);
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...chunks.flat(), ...chunk("IEND", [])]);
}

const c2paPayload = (body: string) => [...enc("JP"), 0, 1, 0, 0, 0, 1, ...enc(`jumbc2pa${body}`)];

const codes = (r: ReturnType<typeof scanImage>) => r.signals.map((s) => s.code);

test("JPEG C2PA with an AI source type is strong with the signer", () => {
  const r = scanImage(
    jpeg(segment(0xeb, c2paPayload("c2pa.actions http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia Google C2PA Core Generator")), sof0(896, 1200)),
  );
  assert.equal(r.strength, "strong");
  const ai = r.signals.find((s) => s.code === "ai_source_type");
  assert.ok(ai);
  assert.match(ai.detail, /trainedAlgorithmicMedia, signed by Google/);
  assert.ok(codes(r).includes("c2pa_present"));
  assert.equal(r.width, 896);
  assert.equal(r.height, 1200);
});

test("PNG caBX with composite source type names OpenAI", () => {
  const r = scanImage(
    png(1402, 1122, chunk("caBX", enc("c2pa.claim compositeWithTrainedAlgorithmicMedia OpenAI"))),
  );
  assert.equal(r.strength, "strong");
  assert.match(r.signals[0].detail, /^compositeWithTrainedAlgorithmicMedia, signed by OpenAI/);
});

test("AI source type in plain XMP is strong without a signer", () => {
  const xmp = segment(0xe1, enc('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/>'));
  const r = scanImage(jpeg(xmp, sof0(800, 600)));
  assert.equal(r.strength, "strong");
  assert.match(r.signals[0].detail, /no C2PA manifest/);
});

test("C2PA signer is not taken from ordinary XMP outside the manifest", () => {
  const xmp = segment(0xe1, enc("http://ns.adobe.com/xap/1.0/\0Adobe XMP Core"));
  const r = scanImage(
    jpeg(xmp, segment(0xeb, c2paPayload("trainedAlgorithmicMedia")), sof0(800, 600)),
  );
  assert.match(r.signals[0].detail, /unknown signer/);
});

test("EXIF Software naming a generator is strong", () => {
  const r = scanImage(jpeg(exifApp1([[0x0131, "Stable Diffusion XL"]]), sof0(640, 480)));
  assert.equal(r.strength, "strong");
  assert.ok(codes(r).includes("generator_software"));
});

test("XMP CreatorTool naming a generator is strong", () => {
  const xmp = segment(0xe1, enc('http://ns.adobe.com/xap/1.0/\0<rdf:Description xmp:CreatorTool="Midjourney v6"/>'));
  const r = scanImage(jpeg(xmp, sof0(640, 480)));
  assert.equal(r.strength, "strong");
  assert.match(r.signals.find((s) => s.code === "generator_software")!.detail, /^Midjourney/);
});

test("generator names match whole words only", () => {
  const r = scanImage(jpeg(exifApp1([[0x010f, "Canon"], [0x0131, "Imagenomic Portraiture"]]), sof0(640, 480)));
  assert.equal(r.strength, "none");
});

test("PNG parameters / prompt / workflow text chunks are strong", () => {
  for (const key of ["parameters", "prompt", "workflow"]) {
    const r = scanImage(png(512, 768, chunk("tEXt", [...enc(key), 0, ...enc("a cat, steps: 20")])));
    assert.equal(r.strength, "strong", key);
    assert.ok(codes(r).includes("sd_png_chunks"));
  }
});

test("PNG iTXt chunks are read too", () => {
  const r = scanImage(png(512, 768, chunk("iTXt", [...enc("workflow"), 0, 0, 0, 0, 0, ...enc("{}")])));
  assert.equal(r.strength, "strong");
});

test("generator dimensions alone are weak, either orientation", () => {
  assert.equal(scanImage(png(1024, 1024)).strength, "weak");
  const r = scanImage(png(1536, 1024));
  assert.equal(r.strength, "weak");
  assert.deepEqual(codes(r), ["generator_dimensions"]);
});

test("a JPEG with generator dimensions and no camera EXIF is weak with both signals", () => {
  const r = scanImage(jpeg(sof0(832, 1216)));
  assert.equal(r.strength, "weak");
  assert.deepEqual(r.signals.map((s) => [s.code, s.strength]), [["generator_dimensions", "weak"], ["no_camera_exif", "weak"]]);
});

test("no camera EXIF alone is only recorded, never weak", () => {
  const r = scanImage(jpeg(sof0(1080, 1350)));
  assert.equal(r.strength, "none");
  assert.equal(r.signals.find((s) => s.code === "no_camera_exif")?.strength, "info");
});

test("dimensions are skipped for WebP", () => {
  const webp = new Uint8Array([...enc("RIFF"), 0, 0, 0, 0, ...enc("WEBPVP8 "), 0, 0, 0, 0]);
  const r = scanImage(webp);
  assert.equal(r.strength, "none");
  assert.equal(r.width, undefined);
});

test("negative: C2PA without an AI source type is none (phone-signed photo)", () => {
  const r = scanImage(
    jpeg(exifApp1([[0x010f, "Google"], [0x0110, "Pixel 9"]]), segment(0xeb, c2paPayload("c2pa.actions c2pa.created digitalCapture Google C2PA")), sof0(4080, 3072)),
  );
  assert.equal(r.strength, "none");
  assert.deepEqual(codes(r), ["c2pa_present"]);
});

test("negative: a JPEG with no metadata at all is none", () => {
  assert.equal(scanImage(jpeg(sof0(1200, 900))).strength, "none");
});

test("garbage bytes never throw", () => {
  assert.equal(scanImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff])).strength, "none");
  assert.equal(scanImage(new Uint8Array([])).strength, "none");
});
