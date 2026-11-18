// ai-marker-scan: find AI-generation markers in image files with a byte scan.
// Pure, dependency-free, no I/O. Runs in Node, browsers, Workers and Deno.
// It does NOT verify C2PA signatures: treat results as triage, not proof.

export type ProvenanceStrength = "strong" | "weak" | "none";

export type ProvenanceSignalCode =
  | "ai_source_type"
  | "generator_software"
  | "sd_png_chunks"
  | "c2pa_present"
  | "generator_dimensions"
  | "no_camera_exif";

export type ProvenanceSignal = {
  code: ProvenanceSignalCode;
  strength: "strong" | "weak" | "info";
  detail: string;
};

export type ProvenanceResult = {
  strength: ProvenanceStrength;
  signals: ProvenanceSignal[];
  width?: number;
  height?: number;
};

export const MAX_SCAN_BYTES = 8 * 1024 * 1024;


export const AI_SOURCE_TYPES = ["compositeWithTrainedAlgorithmicMedia", "trainedAlgorithmicMedia"] as const;

export const GENERATOR_SOFTWARE_NAMES = [
  "Midjourney",
  "DALL-E",
  "DALL·E",
  "Firefly",
  "Stable Diffusion",
  "ComfyUI",
  "Automatic1111",
  "InvokeAI",
  "NovelAI",
  "Leonardo",
  "Ideogram",
  "Imagen",
  "Gemini",
] as const;

// Matched only inside the C2PA manifest, never the whole file: ordinary XMP
// says "Adobe XMP Core" and plenty of files contain "Metadata".
const C2PA_SIGNERS: Array<{ needle: string; org: string }> = [
  { needle: "Google C2PA", org: "Google" },
  { needle: "OpenAI", org: "OpenAI" },
  { needle: "Adobe", org: "Adobe" },
  { needle: "Microsoft", org: "Microsoft" },
  { needle: "Meta Platforms", org: "Meta" },
];

export const GENERATOR_DIMENSIONS: ReadonlyArray<readonly [number, number]> = [
  [1024, 1024],
  [1024, 1536],
  [1024, 1792],
  [896, 1152],
  [832, 1216],
  [768, 1344],
  [2048, 2048],
];

const SD_CHUNK_KEYS = new Set(["parameters", "prompt", "workflow"]);

type Format = "jpeg" | "png" | "other";

// Sniffed from the bytes, not the declared type: a .jpg can hold a PNG.
function detectFormat(bytes: Uint8Array): Format {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  return "other";
}

// latin1 keeps one char per byte, so indexOf positions match byte offsets.
function latin1(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return out;
}

function readU16(bytes: Uint8Array, offset: number, little: boolean): number {
  return little ? bytes[offset] | (bytes[offset + 1] << 8) : (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32(bytes: Uint8Array, offset: number, little: boolean): number {
  return little
    ? (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
    : ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

type ExifFields = { make?: string; model?: string; software?: string };

// Reads Make (0x010F), Model (0x0110) and Software (0x0131) from IFD0 of a TIFF
// block. Anything malformed just yields fewer fields.
function readTiffIfd0(tiff: Uint8Array): ExifFields {
  const fields: ExifFields = {};
  if (tiff.length < 8) return fields;
  const order = String.fromCharCode(tiff[0], tiff[1]);
  if (order !== "II" && order !== "MM") return fields;
  const little = order === "II";
  const ifdOffset = readU32(tiff, 4, little);
  if (ifdOffset + 2 > tiff.length) return fields;
  const count = readU16(tiff, ifdOffset, little);
  for (let i = 0; i < count; i++) {
    const entry = ifdOffset + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    const tag = readU16(tiff, entry, little);
    const type = readU16(tiff, entry + 2, little);
    const n = readU32(tiff, entry + 4, little);
    if (type !== 2 || n === 0) continue;
    const valueOffset = n <= 4 ? entry + 8 : readU32(tiff, entry + 8, little);
    if (valueOffset + n > tiff.length) continue;
    const value = latin1(tiff.subarray(valueOffset, valueOffset + n)).replace(/\0+$/, "").trim();
    if (!value) continue;
    if (tag === 0x010f) fields.make = value;
    else if (tag === 0x0110) fields.model = value;
    else if (tag === 0x0131) fields.software = value;
  }
  return fields;
}

type ParsedImage = {
  width?: number;
  height?: number;
  exif: ExifFields;
  hasExif: boolean;
  c2paRegions: Uint8Array[];
  pngText: Array<{ key: string; value: string }>;
};

function parseJpeg(bytes: Uint8Array): ParsedImage {
  const parsed: ParsedImage = { exif: {}, hasExif: false, c2paRegions: [], pngText: [] };
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0xd9 || marker === 0xda) break; // EOI or start of scan
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = readU16(bytes, offset + 2, false);
    if (length < 2 || offset + 2 + length > bytes.length) break;
    const segment = bytes.subarray(offset + 4, offset + 2 + length);
    if (marker === 0xe1 && segment.length > 6 && latin1(segment.subarray(0, 6)) === "Exif\0\0") {
      parsed.hasExif = true;
      parsed.exif = readTiffIfd0(segment.subarray(6));
    } else if (marker === 0xeb) {
      parsed.c2paRegions.push(segment);
    } else if ((marker === 0xc0 || marker === 0xc2) && segment.length >= 5 && parsed.width === undefined) {
      parsed.height = readU16(segment, 1, false);
      parsed.width = readU16(segment, 3, false);
    }
    offset += 2 + length;
  }
  return parsed;
}

function parsePng(bytes: Uint8Array): ParsedImage {
  const parsed: ParsedImage = { exif: {}, hasExif: false, c2paRegions: [], pngText: [] };
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset, false);
    const type = latin1(bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > bytes.length) break;
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === "IHDR" && data.length >= 8) {
      parsed.width = readU32(data, 0, false);
      parsed.height = readU32(data, 4, false);
    } else if (type === "caBX") {
      parsed.c2paRegions.push(data);
    } else if (type === "eXIf") {
      parsed.hasExif = true;
      parsed.exif = readTiffIfd0(data);
    } else if (type === "tEXt" || type === "iTXt") {
      const nul = data.indexOf(0);
      if (nul > 0) {
        const key = latin1(data.subarray(0, nul));
        let valueStart = nul + 1;
        // iTXt: compression flag, method, language\0, translated keyword\0
        if (type === "iTXt") {
          const compressed = data[valueStart] === 1;
          valueStart += 2;
          const langEnd = data.indexOf(0, valueStart);
          const transEnd = langEnd >= 0 ? data.indexOf(0, langEnd + 1) : -1;
          valueStart = transEnd >= 0 ? transEnd + 1 : data.length;
          if (compressed) valueStart = data.length;
        }
        parsed.pngText.push({ key, value: latin1(data.subarray(valueStart, Math.min(data.length, valueStart + 2000))) });
      }
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  return parsed;
}

function signersIn(regionText: string): string[] {
  const found: Array<{ org: string; at: number }> = [];
  for (const { needle, org } of C2PA_SIGNERS) {
    const at = regionText.indexOf(needle);
    if (at >= 0 && !found.some((f) => f.org === org)) found.push({ org, at });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.org);
}

function generatorNameIn(value: string): string | null {
  for (const name of GENERATOR_SOFTWARE_NAMES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`, "i").test(value)) return name;
  }
  return null;
}

function xmpCreatorTools(text: string): string[] {
  const tools: string[] = [];
  for (const m of text.matchAll(/CreatorTool="([^"]{1,200})"/g)) tools.push(m[1]);
  for (const m of text.matchAll(/<xmp:CreatorTool>([^<]{1,200})<\/xmp:CreatorTool>/g)) tools.push(m[1]);
  return tools;
}

function isGeneratorDimensions(width?: number, height?: number): boolean {
  if (!width || !height) return false;
  return GENERATOR_DIMENSIONS.some(([a, b]) => (width === a && height === b) || (width === b && height === a));
}

export function scanImage(data: Uint8Array | ArrayBuffer): ProvenanceResult {
  const input = data instanceof Uint8Array ? data : new Uint8Array(data);
  const bytes = input.length > MAX_SCAN_BYTES ? input.subarray(0, MAX_SCAN_BYTES) : input;
  const format = detectFormat(bytes);
  const text = latin1(bytes);
  const signals: ProvenanceSignal[] = [];

  const parsed: ParsedImage =
    format === "jpeg" ? parseJpeg(bytes)
      : format === "png" ? parsePng(bytes)
        : { exif: {}, hasExif: false, c2paRegions: [], pngText: [] };

  // C2PA lives in JPEG APP11 or PNG caBX. For other formats fall back to the
  // whole file when the c2pa label is present.
  const c2paText = parsed.c2paRegions.length > 0
    ? parsed.c2paRegions.map(latin1).join("\n")
    : format === "other" && text.includes("c2pa") ? text : "";
  const hasC2pa = c2paText.includes("c2pa");
  const signers = hasC2pa ? signersIn(c2paText) : [];
  const signerLabel = signers.length > 0 ? `signed by ${signers.join(" / ")}` : "unknown signer";

  const sourceType = AI_SOURCE_TYPES.find((value) => text.includes(value));
  if (sourceType) {
    signals.push({
      code: "ai_source_type",
      strength: "strong",
      detail: hasC2pa ? `${sourceType}, ${signerLabel}` : `${sourceType}, IPTC metadata (no C2PA manifest)`,
    });
  }

  const softwareValues = [
    parsed.exif.software,
    ...xmpCreatorTools(text),
    ...parsed.pngText.filter((t) => t.key === "Software").map((t) => t.value),
  ].filter((v): v is string => Boolean(v));
  for (const value of softwareValues) {
    const name = generatorNameIn(value);
    if (name) {
      signals.push({ code: "generator_software", strength: "strong", detail: `${name} (software field "${value.slice(0, 60)}")` });
      break;
    }
  }

  const sdKeys = Array.from(new Set(parsed.pngText.map((t) => t.key).filter((k) => SD_CHUNK_KEYS.has(k))));
  if (sdKeys.length > 0) {
    signals.push({ code: "sd_png_chunks", strength: "strong", detail: `PNG text chunk: ${sdKeys.join(", ")}` });
  }

  if (hasC2pa) {
    signals.push({ code: "c2pa_present", strength: "info", detail: signerLabel });
  }

  const measurable = format === "jpeg" || format === "png";
  const width = measurable ? parsed.width : undefined;
  const height = measurable ? parsed.height : undefined;
  const generatorDims = measurable && isGeneratorDimensions(width, height);
  if (generatorDims) {
    signals.push({ code: "generator_dimensions", strength: "weak", detail: `${width}x${height}` });
  }
  if (format === "jpeg" && !parsed.exif.make && !parsed.exif.model) {
    signals.push({ code: "no_camera_exif", strength: "info", detail: parsed.hasExif ? "EXIF without Make or Model" : "no EXIF" });
  }

  const strength: ProvenanceStrength = signals.some((s) => s.strength === "strong")
    ? "strong"
    : generatorDims ? "weak" : "none";

  // Once the result is weak, no_camera_exif supports it, so show it as weak.
  if (strength === "weak") {
    for (const s of signals) if (s.code === "no_camera_exif") s.strength = "weak";
  }

  return { strength, signals, width, height };
}
