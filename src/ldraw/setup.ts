import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { getDefaultLDrawCacheDir } from "./library.js";

export const OFFICIAL_LDRAW_COMPLETE_ZIP_URL =
  "https://library.ldraw.org/library/updates/complete.zip";
export const UNOFFICIAL_LDRAW_ZIP_URL =
  "https://library.ldraw.org/library/unofficial/ldrawunf.zip";

export interface SetupLDrawOptions {
  targetDir?: string;
  includeUnofficial?: boolean;
  onLog?: (msg: string) => void;
}

export interface SetupLDrawResult {
  targetDir: string;
  filesExtracted: number;
  includedUnofficial: boolean;
}

/**
 * Pure-Node ZIP extractor supporting Store (0) and Deflate (8) entries
 * via Central Directory parsing, with Zip-Slip path traversal protection.
 */
export function extractZipBuffer(
  zipBuf: Buffer,
  destDir: string,
  options: { stripLeadingDir?: string } = {}
): number {
  // Locate End of Central Directory (EOCD) signature: 0x06054b50
  const minOffset = Math.max(0, zipBuf.length - 65557);
  let eocdOffset = -1;
  for (let i = zipBuf.length - 22; i >= minOffset; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("Invalid ZIP archive: End of Central Directory record not found.");
  }

  const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);
  const resolvedDest = path.resolve(destDir);
  fs.mkdirSync(resolvedDest, { recursive: true });

  let cursor = cdOffset;
  let extractedCount = 0;
  const stripPrefix = options.stripLeadingDir
    ? options.stripLeadingDir.replace(/\\/g, "/").replace(/\/?$/, "/").toLowerCase()
    : null;

  for (let i = 0; i < totalEntries; i++) {
    if (cursor + 46 > zipBuf.length || zipBuf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory entry at index ${i}.`);
    }

    const compressionMethod = zipBuf.readUInt16LE(cursor + 10);
    const compressedSize = zipBuf.readUInt32LE(cursor + 20);
    const fileNameLen = zipBuf.readUInt16LE(cursor + 28);
    const extraLen = zipBuf.readUInt16LE(cursor + 30);
    const commentLen = zipBuf.readUInt16LE(cursor + 32);
    const localHeaderOffset = zipBuf.readUInt32LE(cursor + 42);

    let entryName = zipBuf
      .subarray(cursor + 46, cursor + 46 + fileNameLen)
      .toString("utf8")
      .replace(/\\/g, "/");

    cursor += 46 + fileNameLen + extraLen + commentLen;

    if (stripPrefix && entryName.toLowerCase().startsWith(stripPrefix)) {
      entryName = entryName.slice(stripPrefix.length);
    }
    if (!entryName || entryName.endsWith("/")) continue;

    // Zip-Slip path traversal protection
    const outPath = path.resolve(resolvedDest, entryName);
    if (!outPath.startsWith(resolvedDest + path.sep) && outPath !== resolvedDest) {
      throw new Error(`Unsafe ZIP entry path blocked: ${entryName}`);
    }

    if (
      localHeaderOffset + 30 > zipBuf.length ||
      zipBuf.readUInt32LE(localHeaderOffset) !== 0x04034b50
    ) {
      throw new Error(`Invalid local file header for ZIP entry: ${entryName}`);
    }

    const localNameLen = zipBuf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compressedData = zipBuf.subarray(dataStart, dataStart + compressedSize);

    let fileData: Buffer;
    if (compressionMethod === 0) {
      fileData = compressedData;
    } else if (compressionMethod === 8) {
      fileData = zlib.inflateRawSync(compressedData);
    } else {
      throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${entryName}`);
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, fileData);
    extractedCount++;
  }

  return extractedCount;
}

async function downloadBuffer(url: string, onLog?: (msg: string) => void): Promise<Buffer> {
  onLog?.(`Downloading ${url} ...`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  const arrayBuf = await res.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  onLog?.(`Downloaded ${(buf.length / (1024 * 1024)).toFixed(1)} MB.`);
  return buf;
}

export async function setupLDrawLibrary(
  options: SetupLDrawOptions = {}
): Promise<SetupLDrawResult> {
  const targetDir = path.resolve(options.targetDir || getDefaultLDrawCacheDir());
  const log = options.onLog ?? ((msg: string) => process.stderr.write(`[setup] ${msg}\n`));

  const officialZip = await downloadBuffer(OFFICIAL_LDRAW_COMPLETE_ZIP_URL, log);
  log(`Extracting official LDraw parts library to ${targetDir} ...`);
  let totalExtracted = extractZipBuffer(officialZip, targetDir, { stripLeadingDir: "ldraw" });
  log(`Extracted ${totalExtracted} official files.`);

  if (options.includeUnofficial) {
    const unofficialZip = await downloadBuffer(UNOFFICIAL_LDRAW_ZIP_URL, log);
    const unofficialDir = path.join(targetDir, "Unofficial");
    log(`Extracting unofficial LDraw parts to ${unofficialDir} ...`);
    const unofCount = extractZipBuffer(unofficialZip, unofficialDir);
    totalExtracted += unofCount;
    log(`Extracted ${unofCount} unofficial files.`);
  }

  return {
    targetDir,
    filesExtracted: totalExtracted,
    includedUnofficial: Boolean(options.includeUnofficial),
  };
}
