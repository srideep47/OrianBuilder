import fs from "node:fs";
import log from "electron-log";

const logger = log.scope("gguf-metadata");

const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian

const enum GGUFType {
  UINT8 = 0,
  INT8 = 1,
  UINT16 = 2,
  INT16 = 3,
  UINT32 = 4,
  INT32 = 5,
  FLOAT32 = 6,
  BOOL = 7,
  STRING = 8,
  ARRAY = 9,
  UINT64 = 10,
  INT64 = 11,
  FLOAT64 = 12,
}

export interface GgufMetadata {
  architecture: string | null;
  name: string | null;
  contextLength: number | null;
  blockCount: number | null;
  embeddingLength: number | null;
  feedForwardLength: number | null;
  attentionHeadCount: number | null;
  attentionHeadCountKv: number | null;
  attentionSlidingWindow: number | null;
  attentionSlidingWindowPattern: number | null;
  vocabSize: number | null;
  fileType: number | null;
  quantization: string | null;
  ropeFreqBase: number | null;
  ropeDimensionCount: number | null;
  tensorCount: number;
  metadataKeyValueCount: number;
}

const FILE_TYPES: Record<number, string> = {
  0: "F32",
  1: "F16",
  2: "Q4_0",
  3: "Q4_1",
  7: "Q8_0",
  8: "Q5_0",
  9: "Q5_1",
  10: "Q2_K",
  11: "Q3_K_S",
  12: "Q3_K_M",
  13: "Q3_K_L",
  14: "Q4_K_S",
  15: "Q4_K_M",
  16: "Q5_K_S",
  17: "Q5_K_M",
  18: "Q6_K",
  19: "IQ2_XXS",
  20: "IQ2_XS",
  21: "IQ3_XXS",
  22: "IQ1_S",
  23: "IQ4_NL",
  24: "IQ3_S",
  25: "IQ3_M",
  26: "IQ2_S",
  27: "IQ2_M",
  28: "IQ4_XS",
  29: "IQ1_M",
  30: "BF16",
};

class Reader {
  private buf: Buffer;
  private pos = 0;
  constructor(buf: Buffer) {
    this.buf = buf;
  }
  get position() {
    return this.pos;
  }
  readU8() {
    const v = this.buf.readUInt8(this.pos);
    this.pos += 1;
    return v;
  }
  readI8() {
    const v = this.buf.readInt8(this.pos);
    this.pos += 1;
    return v;
  }
  readU16() {
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  readI16() {
    const v = this.buf.readInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  readU32() {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  readI32() {
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  readF32() {
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }
  readF64() {
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }
  readU64() {
    const lo = this.buf.readUInt32LE(this.pos);
    const hi = this.buf.readUInt32LE(this.pos + 4);
    this.pos += 8;
    return hi * 0x1_0000_0000 + lo;
  }
  readI64() {
    const lo = this.buf.readUInt32LE(this.pos);
    const hi = this.buf.readInt32LE(this.pos + 4);
    this.pos += 8;
    return hi * 0x1_0000_0000 + lo;
  }
  readBool() {
    return this.readU8() !== 0;
  }
  readString() {
    const len = this.readU64();
    const s = this.buf.toString("utf8", this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
  readValue(type: number): unknown {
    switch (type) {
      case GGUFType.UINT8:
        return this.readU8();
      case GGUFType.INT8:
        return this.readI8();
      case GGUFType.UINT16:
        return this.readU16();
      case GGUFType.INT16:
        return this.readI16();
      case GGUFType.UINT32:
        return this.readU32();
      case GGUFType.INT32:
        return this.readI32();
      case GGUFType.FLOAT32:
        return this.readF32();
      case GGUFType.BOOL:
        return this.readBool();
      case GGUFType.STRING:
        return this.readString();
      case GGUFType.UINT64:
        return this.readU64();
      case GGUFType.INT64:
        return this.readI64();
      case GGUFType.FLOAT64:
        return this.readF64();
      case GGUFType.ARRAY: {
        const elemType = this.readU32();
        const count = this.readU64();
        // Walk past array elements without storing them (vocab arrays can be huge).
        if (elemType === GGUFType.STRING) {
          for (let i = 0; i < count; i++) {
            const len = this.readU64();
            this.pos += len;
          }
        } else {
          const elemBytes: Record<number, number> = {
            [GGUFType.UINT8]: 1,
            [GGUFType.INT8]: 1,
            [GGUFType.UINT16]: 2,
            [GGUFType.INT16]: 2,
            [GGUFType.UINT32]: 4,
            [GGUFType.INT32]: 4,
            [GGUFType.FLOAT32]: 4,
            [GGUFType.BOOL]: 1,
            [GGUFType.UINT64]: 8,
            [GGUFType.INT64]: 8,
            [GGUFType.FLOAT64]: 8,
          };
          const stride = elemBytes[elemType];
          if (stride) {
            this.pos += count * stride;
          } else {
            // Nested array or unknown — fall back to element-by-element walk.
            for (let i = 0; i < count; i++) this.readValue(elemType);
          }
        }
        return { _type: "array", elemType, count };
      }
      default:
        throw new Error(`Unknown GGUF type: ${type}`);
    }
  }
}

function _parseGgufBuffer(buf: Buffer): GgufMetadata {
  const r = new Reader(buf);
  const magic = r.readU32();
  if (magic !== GGUF_MAGIC)
    throw new Error(`Not a GGUF file (magic=0x${magic.toString(16)})`);

  const version = r.readU32();
  if (version < 2)
    throw new Error(`GGUF version ${version} < 2 is unsupported`);

  const tensorCount = r.readU64();
  const kvCount = r.readU64();

  const md: Record<string, unknown> = {};
  for (let i = 0; i < kvCount; i++) {
    const key = r.readString();
    const valueType = r.readU32();
    const value = r.readValue(valueType);
    md[key] = value;
  }

  const arch = (md["general.architecture"] as string | undefined) ?? null;
  const name = (md["general.name"] as string | undefined) ?? null;

  const archKey = (suffix: string) =>
    arch ? (md[`${arch}.${suffix}`] as number | undefined) : undefined;

  const fileType = (md["general.file_type"] as number | undefined) ?? null;
  const quantization =
    fileType != null ? (FILE_TYPES[fileType] ?? `FT${fileType}`) : null;

  return {
    architecture: arch,
    name,
    contextLength: archKey("context_length") ?? null,
    blockCount: archKey("block_count") ?? null,
    embeddingLength: archKey("embedding_length") ?? null,
    feedForwardLength: archKey("feed_forward_length") ?? null,
    attentionHeadCount: archKey("attention.head_count") ?? null,
    attentionHeadCountKv: archKey("attention.head_count_kv") ?? null,
    attentionSlidingWindow: archKey("attention.sliding_window") ?? null,
    attentionSlidingWindowPattern:
      archKey("attention.sliding_window_pattern") ?? null,
    vocabSize: archKey("vocab_size") ?? null,
    ropeFreqBase: archKey("rope.freq_base") ?? null,
    ropeDimensionCount: archKey("rope.dimension_count") ?? null,
    fileType,
    quantization,
    tensorCount,
    metadataKeyValueCount: kvCount,
  };
}

/**
 * Read GGUF header metadata without loading tensors.
 *
 * 27B+ models have tokenizer vocabularies embedded in the metadata (up to 30 MB),
 * so we start at 32 MB and double on buffer-overflow errors up to 128 MB.
 */
export async function readGgufMetadata(
  filePath: string,
): Promise<GgufMetadata> {
  const fd = await fs.promises.open(filePath, "r");
  try {
    const stat = await fd.stat();
    let readBytes = Math.min(32 * 1024 * 1024, stat.size);

    for (let attempt = 0; attempt <= 3; attempt++) {
      const buf = Buffer.alloc(readBytes);
      await fd.read(buf, 0, readBytes, 0);
      try {
        const md = _parseGgufBuffer(buf);
        if (attempt > 0)
          logger.info(
            `GGUF parsed on attempt ${attempt + 1} with ${(readBytes / 1024 / 1024).toFixed(0)} MB buffer`,
          );
        return md;
      } catch (err: any) {
        const isOverflow =
          err?.code === "ERR_OUT_OF_RANGE" ||
          err instanceof RangeError ||
          String(err?.message ?? err)
            .toLowerCase()
            .includes("out of range") ||
          String(err?.message ?? err)
            .toLowerCase()
            .includes("offset");

        if (
          !isOverflow ||
          readBytes >= stat.size ||
          readBytes >= 128 * 1024 * 1024
        ) {
          throw err;
        }
        readBytes = Math.min(readBytes * 2, 128 * 1024 * 1024, stat.size);
        logger.info(
          `GGUF buffer overflow on attempt ${attempt + 1}, expanding to ${(readBytes / 1024 / 1024).toFixed(0)} MB`,
        );
      }
    }
    // Should never reach here, but TypeScript needs a return.
    throw new Error("GGUF parse failed after all retries");
  } finally {
    await fd
      .close()
      .catch((err) => logger.warn("Failed to close GGUF fd:", err));
  }
}
