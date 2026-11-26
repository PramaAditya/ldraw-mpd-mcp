import * as zlib from "node:zlib";

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("LDraw operation aborted.");
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

export function encodePngRGBA(
  width: number,
  height: number,
  rgba: Buffer,
  signal?: AbortSignal
): Buffer {
  const rawData = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    throwIfAborted(signal);
    const rowStart = y * (width * 4 + 1);
    rawData[rowStart] = 0;
    rgba.copy(rawData, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(rawData, { level: 6 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", compressed),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function decodePngToRGBA(
  pngBuf: Buffer,
  signal?: AbortSignal
): { width: number; height: number; rgba: Buffer } {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idatChunks: Buffer[] = [];
  let palette: Buffer | null = null;

  while (offset + 12 <= pngBuf.length) {
    const len = pngBuf.readUInt32BE(offset);
    const type = pngBuf.toString("ascii", offset + 4, offset + 8);
    const data = pngBuf.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + len;
  }

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const stride = width * bpp;
  const recon = Buffer.alloc(height * stride);

  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  for (let y = 0; y < height; y++) {
    throwIfAborted(signal);
    const filter = raw[y * (stride + 1)];
    const srcStart = y * (stride + 1) + 1;
    const dstStart = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[srcStart + i];
      const a = i >= bpp ? recon[dstStart + i - bpp] : 0;
      const b = y > 0 ? recon[dstStart - stride + i] : 0;
      const c = y > 0 && i >= bpp ? recon[dstStart - stride + i - bpp] : 0;
      let val = x;
      if (filter === 1) val = (x + a) & 0xff;
      else if (filter === 2) val = (x + b) & 0xff;
      else if (filter === 3) val = (x + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) val = (x + paeth(a, b, c)) & 0xff;
      recon[dstStart + i] = val;
    }
  }

  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i++) {
    if (i % 4096 === 0) throwIfAborted(signal);
    if (colorType === 6) {
      rgba[i * 4] = recon[i * 4];
      rgba[i * 4 + 1] = recon[i * 4 + 1];
      rgba[i * 4 + 2] = recon[i * 4 + 2];
      rgba[i * 4 + 3] = recon[i * 4 + 3];
    } else if (colorType === 2) {
      rgba[i * 4] = recon[i * 3];
      rgba[i * 4 + 1] = recon[i * 3 + 1];
      rgba[i * 4 + 2] = recon[i * 3 + 2];
    } else if (colorType === 3 && palette) {
      const idx = recon[i] * 3;
      rgba[i * 4] = palette[idx];
      rgba[i * 4 + 1] = palette[idx + 1];
      rgba[i * 4 + 2] = palette[idx + 2];
    } else {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = recon[i * bpp];
    }
  }
  return { width, height, rgba };
}

export function isPngBuffer(buf: Buffer): boolean {
  return (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  );
}

export function stitchSideBySidePng(
  leftPngBuf: Buffer,
  rightPngBuf: Buffer,
  targetH = 540,
  signal?: AbortSignal
): Buffer {
  if (!isPngBuffer(leftPngBuf)) {
    return rightPngBuf;
  }
  const left = decodePngToRGBA(leftPngBuf, signal);
  const right = decodePngToRGBA(rightPngBuf, signal);
  const leftW = Math.max(1, Math.round((left.width / left.height) * targetH));
  const rightW = Math.max(1, Math.round((right.width / right.height) * targetH));
  const gap = 12;
  const totalW = leftW + gap + rightW;
  const out = Buffer.alloc(totalW * targetH * 4, 255);

  for (let y = 0; y < targetH; y++) {
    throwIfAborted(signal);
    for (let x = leftW; x < leftW + gap; x++) {
      const idx = (y * totalW + x) * 4;
      out[idx] = 30;
      out[idx + 1] = 41;
      out[idx + 2] = 59;
      out[idx + 3] = 255;
    }
  }

  const blit = (
    src: { width: number; height: number; rgba: Buffer },
    dstX0: number,
    dstW: number
  ) => {
    for (let y = 0; y < targetH; y++) {
      throwIfAborted(signal);
      const sy = Math.min(src.height - 1, Math.floor((y / targetH) * src.height));
      for (let x = 0; x < dstW; x++) {
        const sx = Math.min(src.width - 1, Math.floor((x / dstW) * src.width));
        const sIdx = (sy * src.width + sx) * 4;
        const dIdx = (y * totalW + (dstX0 + x)) * 4;
        out[dIdx] = src.rgba[sIdx];
        out[dIdx + 1] = src.rgba[sIdx + 1];
        out[dIdx + 2] = src.rgba[sIdx + 2];
        out[dIdx + 3] = 255;
      }
    }
  };

  blit(left, 0, leftW);
  blit(right, leftW + gap, rightW);
  return encodePngRGBA(totalW, targetH, out, signal);
}
