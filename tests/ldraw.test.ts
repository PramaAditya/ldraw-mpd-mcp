import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as zlib from "node:zlib";
import {
  LDrawCatalog,
  LDrawLibrary,
  collectModelSteps,
  decodePngToRGBA,
  encodePngRGBA,
  extractZipBuffer,
  getBuiltinFallbackColors,
  isPngBuffer,
  packLDrawMpdOffline,
  parseLdConfigLines,
  parseMpdDocument,
  renderLDrawToPngAndAnalyze,
  stitchSideBySidePng,
} from "../dist/index.js";
import { createTempFixtureLibrary } from "./fixtures.js";

function buildMinimalZip(entries: Array<{ name: string; content: string; deflate?: boolean }>): Buffer {
  const localParts: Buffer[] = [];
  const cdParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const rawBuf = Buffer.from(entry.content, "utf8");
    const compBuf = entry.deflate ? zlib.deflateRawSync(rawBuf) : rawBuf;
    const method = entry.deflate ? 8 : 0;

    const lfh = Buffer.alloc(30 + nameBuf.length);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(compBuf.length, 18);
    lfh.writeUInt32LE(rawBuf.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(lfh, 30);

    localParts.push(lfh, compBuf);

    const cdh = Buffer.alloc(46 + nameBuf.length);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(compBuf.length, 20);
    cdh.writeUInt32LE(rawBuf.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    nameBuf.copy(cdh, 46);
    cdParts.push(cdh);

    offset += lfh.length + compBuf.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

describe("ldraw-mpd-mcp core engine", () => {
  it("encodes, decodes, and stitches PNG buffers in pure TypeScript", () => {
    const rgba = Buffer.alloc(4 * 4 * 4, 255);
    rgba[0] = 200;
    rgba[1] = 20;
    rgba[2] = 10;
    rgba[3] = 255;

    const png = encodePngRGBA(4, 4, rgba);
    assert.equal(isPngBuffer(png), true);

    const decoded = decodePngToRGBA(png);
    assert.equal(decoded.width, 4);
    assert.equal(decoded.height, 4);
    assert.equal(decoded.rgba[0], 200);
    assert.equal(decoded.rgba[1], 20);
    assert.equal(decoded.rgba[2], 10);

    const stitched = stitchSideBySidePng(png, png, 16);
    const decodedStitched = decodePngToRGBA(stitched);
    assert.equal(decodedStitched.height, 16);
    assert.equal(decodedStitched.width, 16 + 12 + 16);
  });

  it("parses LDConfig colors and provides builtin fallback", () => {
    const fallback = getBuiltinFallbackColors();
    assert.ok(fallback.colorTable[4]);
    assert.equal(fallback.colorTable[4].name, "Red");

    const parsed = parseLdConfigLines([
      "0 !COLOUR Trans_Red CODE 36 VALUE #C91A09 EDGE #660D05 ALPHA 128",
    ]);
    assert.equal(parsed.colorTable[36].alpha, 128);
    assert.deepEqual(parsed.colorTable[36].rgb, [201, 26, 9]);
  });

  it("supports DFS step numbering, Sub-Build Isolation, rendering, and offline MPD packing", () => {
    const fixtureDir = createTempFixtureLibrary();
    try {
      const library = new LDrawLibrary({ ldrawDir: fixtureDir });
      assert.equal(library.getStatus().hasPartsDir, true);

      const mpd = [
        "0 FILE main.ldr",
        "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3005.dat",
        "0 STEP",
        "1 16 40 -24 0 1 0 0 0 1 0 0 0 1 sub.ldr",
        "0 STEP",
        "1 16 0 0 0 1 0 0 0 1 0 0 0 1 step_join.dat",
        "0 FILE sub.ldr",
        "1 14 0 0 0 1 0 0 0 1 0 0 0 1 3005.dat",
        "0 STEP",
        "1 15 0 -24 0 1 0 0 0 1 0 0 0 1 3005.dat",
      ].join("\n");

      const doc = parseMpdDocument(mpd);
      const collected = collectModelSteps(doc);
      assert.equal(collected.totalSteps, 4);

      const subRender = renderLDrawToPngAndAnalyze(library, mpd, {
        width: 160,
        height: 120,
        stepNumber: 3,
      });
      assert.equal(subRender.isIsolatedSubbuild, true);
      assert.equal(subRender.activeModelScope, "sub.ldr");
      assert.equal(isPngBuffer(subRender.pngBuffer), true);
      assert.equal(subRender.overallBBox.minX, -10);
      assert.equal(subRender.overallBBox.maxX, 10);
      assert.equal(subRender.overallBBox.minY, -28);
      assert.equal(subRender.overallBBox.maxY, 24);

      const joinRender = renderLDrawToPngAndAnalyze(library, mpd, {
        width: 160,
        height: 120,
        stepNumber: 4,
      });
      assert.equal(joinRender.isIsolatedSubbuild, false);
      assert.equal(joinRender.activeModelScope, "main.ldr");
      assert.equal(joinRender.overallBBox.maxX, 50);

      const packed = packLDrawMpdOffline(library, mpd, "main.ldr");
      assert.deepEqual(packed.missingParts, []);
      assert.ok(packed.mpdContent.includes("0 FILE 3005.dat"));
      assert.ok(packed.mpdContent.includes("0 FILE parts/s/subcap.dat"));
      assert.ok(packed.mpdContent.includes("0 FILE box.dat"));
      assert.ok(packed.mpdContent.includes("0 FILE step_join.dat"));
      assert.ok(packed.mpdContent.includes("0 !COLOUR Red CODE 4"));

      const catalog = new LDrawCatalog(library);
      const lookup = catalog.search({ query: "brick 1 x 1" });
      assert.equal(lookup.sourceUsed, "library");
      assert.equal(lookup.totalMatches, 1);
      assert.equal(lookup.items[0].datFile, "3005.dat");
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("extracts Store and Deflate ZIP entries safely and blocks Zip-Slip paths", () => {
    const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "ldraw-zip-test-"));
    try {
      const okZip = buildMinimalZip([
        {
          name: "ldraw/LDConfig.ldr",
          content: "0 !COLOUR Red CODE 4 VALUE #C91A09 EDGE #333333",
          deflate: true,
        },
        { name: "ldraw/parts/3005.dat", content: "0 Brick 1 x 1\n", deflate: false },
      ]);

      const count = extractZipBuffer(okZip, tmpOut, { stripLeadingDir: "ldraw" });
      assert.equal(count, 2);
      assert.equal(fs.existsSync(path.join(tmpOut, "LDConfig.ldr")), true);
      assert.equal(fs.existsSync(path.join(tmpOut, "parts", "3005.dat")), true);

      const evilZip = buildMinimalZip([{ name: "../../evil.txt", content: "nope" }]);
      assert.throws(() => extractZipBuffer(evilZip, tmpOut), /Unsafe ZIP entry path blocked/);
    } finally {
      fs.rmSync(tmpOut, { recursive: true, force: true });
    }
  });
});
