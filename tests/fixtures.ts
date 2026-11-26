import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function createTempFixtureLibrary(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ldraw-mpd-mcp-test-"));
  fs.mkdirSync(path.join(tmpDir, "parts", "s"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "p"), { recursive: true });

  fs.writeFileSync(
    path.join(tmpDir, "LDConfig.ldr"),
    [
      "0 !COLOUR Red CODE 4 VALUE #C91A09 EDGE #333333",
      "0 !COLOUR Yellow CODE 14 VALUE #F2CD37 EDGE #333333",
      "0 !COLOUR White CODE 15 VALUE #FFFFFF EDGE #333333",
      "0 !COLOUR Trans_Clear CODE 47 VALUE #FCFCFC EDGE #CCCCCC ALPHA 128",
    ].join("\n")
  );

  fs.writeFileSync(
    path.join(tmpDir, "p", "box.dat"),
    [
      "0 Simple Box Primitive",
      "0 !LDRAW_ORG Primitive",
      "4 16 -10 0 -10 10 0 -10 10 0 10 -10 0 10",
      "4 16 -10 24 -10 10 24 -10 10 24 10 -10 24 10",
      "4 16 -10 0 -10 10 0 -10 10 24 -10 -10 24 -10",
      "4 16 -10 0 10 10 0 10 10 24 10 -10 24 10",
      "2 24 -10 0 -10 10 0 -10",
    ].join("\n")
  );

  fs.writeFileSync(
    path.join(tmpDir, "parts", "s", "subcap.dat"),
    ["0 Subcap", "0 !LDRAW_ORG Subpart", "3 16 -10 0 -10 10 0 -10 0 -4 0"].join("\n")
  );

  fs.writeFileSync(
    path.join(tmpDir, "parts", "3005.dat"),
    [
      "0 Brick  1 x  1",
      "0 Name: 3005.dat",
      "0 !LDRAW_ORG Part",
      "0 !CATEGORY Brick",
      "1 16 0 0 0 1 0 0 0 1 0 0 0 1 box.dat",
      "1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\subcap.dat",
    ].join("\n")
  );

  fs.writeFileSync(path.join(tmpDir, "parts.lst"), "3005.dat  Brick  1 x  1\n");
  return tmpDir;
}
