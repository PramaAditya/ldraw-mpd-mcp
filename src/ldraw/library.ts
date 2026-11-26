import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ColorInfo } from "../types.js";
import {
  getBuiltinFallbackColors,
  parseLdConfigLines,
  parseStudioColorDefinitions,
} from "./colors.js";

export interface LDrawLibraryOptions {
  ldrawDir?: string;
  colorDefPath?: string;
}

export interface LDrawLibraryStatus {
  ldrawDir: string | null;
  exists: boolean;
  hasPartsDir: boolean;
  hasPrimitivesDir: boolean;
  colorSource: string;
  colorCount: number;
  indexedFileCount: number;
}

const SEARCH_SUBDIRS = [
  "parts",
  "p",
  "Unofficial/parts",
  "Unofficial/p",
  "UnOfficial/parts",
  "UnOfficial/p",
  "LEGO",
  "",
];

export function getDefaultLDrawCacheDir(): string {
  return path.join(os.homedir(), ".ldraw");
}

export function getCandidateLDrawDirs(explicitDir?: string): string[] {
  const home = os.homedir();
  const candidates: string[] = [];

  if (explicitDir?.trim()) candidates.push(path.resolve(explicitDir.trim()));
  if (process.env.LDRAW_DIR?.trim()) candidates.push(path.resolve(process.env.LDRAW_DIR.trim()));

  candidates.push(
    path.join(home, ".ldraw"),
    path.join(home, ".cache", "ldraw-mpd-mcp", "ldraw"),
    path.join(home, "ldraw")
  );

  if (process.platform === "win32") {
    candidates.push(
      "C:/Program Files/Studio 2.0/ldraw",
      "C:/Program Files (x86)/Studio 2.0/ldraw",
      "C:/Users/Public/Documents/LDraw",
      "C:/LDraw"
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Studio 2.0/ldraw",
      path.join(home, "Library", "Application Support", "LDraw"),
      "/Library/LDraw"
    );
  } else {
    candidates.push("/usr/share/ldraw", "/usr/local/share/ldraw");
  }

  return [...new Set(candidates)];
}

export function isValidLDrawDir(dirPath: string): boolean {
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return false;
    return (
      fs.existsSync(path.join(dirPath, "parts")) ||
      fs.existsSync(path.join(dirPath, "p")) ||
      fs.existsSync(path.join(dirPath, "LDConfig.ldr"))
    );
  } catch {
    return false;
  }
}

export function detectLDrawDir(explicitDir?: string): string | null {
  for (const cand of getCandidateLDrawDirs(explicitDir)) {
    if (isValidLDrawDir(cand)) return cand;
  }
  return null;
}

export function normalizeLDrawLoaderFileName(rawName: string): string {
  const cleaned = rawName.trim().replace(/\\/g, "/");
  if (cleaned.startsWith("s/") || cleaned.startsWith("S/")) return `parts/${cleaned.toLowerCase()}`;
  if (cleaned.startsWith("48/")) return `p/${cleaned}`;
  if (cleaned.startsWith("8/")) return `p/${cleaned}`;
  return cleaned;
}

export class LDrawLibrary {
  readonly ldrawDir: string | null;
  private readonly explicitColorDefPath?: string;
  private initialized = false;
  private cachedFileMap = new Map<string, string>();
  private scannedSubdirs = false;
  private colorTable: Record<number, ColorInfo> = {};
  private colourHeaderLines: string[] = [];
  private colorSource = "builtin-fallback";

  constructor(options: LDrawLibraryOptions = {}) {
    this.ldrawDir = detectLDrawDir(options.ldrawDir);
    this.explicitColorDefPath = options.colorDefPath;
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;

    if (this.ldrawDir) {
      // Load BrickLink Studio fast library index if available
      const studioCacheFile = path.join(this.ldrawDir, "cachedLibraryPath_0.txt");
      if (fs.existsSync(studioCacheFile)) {
        const lines = fs.readFileSync(studioCacheFile, "utf8").split(/\r?\n/);
        for (const line of lines) {
          const [key, relPath] = line.split("\t");
          if (key && relPath) {
            this.cachedFileMap.set(key.trim().toLowerCase(), relPath.trim());
          }
        }
      }
    }

    this.loadColors();
  }

  private loadColors(): void {
    const ldConfigPath = this.ldrawDir ? path.join(this.ldrawDir, "LDConfig.ldr") : null;
    if (ldConfigPath && fs.existsSync(ldConfigPath)) {
      const parsed = parseLdConfigLines(fs.readFileSync(ldConfigPath, "utf8").split(/\r?\n/));
      if (Object.keys(parsed.colorTable).length > 0) {
        this.colorTable = parsed.colorTable;
        this.colourHeaderLines = parsed.colourHeaderLines;
        this.colorSource = ldConfigPath;
        return;
      }
    }

    const studioColorCandidates = [
      this.explicitColorDefPath,
      this.ldrawDir ? path.join(this.ldrawDir, "..", "data", "StudioColorDefinition.txt") : undefined,
    ].filter(Boolean) as string[];

    for (const candidate of studioColorCandidates) {
      if (fs.existsSync(candidate)) {
        const parsed = parseStudioColorDefinitions(
          fs.readFileSync(candidate, "utf8").split(/\r?\n/)
        );
        if (Object.keys(parsed.colorTable).length > 0) {
          this.colorTable = parsed.colorTable;
          this.colourHeaderLines = parsed.colourHeaderLines;
          this.colorSource = candidate;
          return;
        }
      }
    }

    const fallback = getBuiltinFallbackColors();
    this.colorTable = fallback.colorTable;
    this.colourHeaderLines = fallback.colourHeaderLines;
    this.colorSource = "builtin-fallback";
  }

  private ensureCaseInsensitiveIndex(): void {
    if (this.scannedSubdirs || !this.ldrawDir) return;
    this.scannedSubdirs = true;

    const indexDir = (baseRel: string, prefixKey: string) => {
      const fullDir = path.join(this.ldrawDir!, baseRel);
      if (!fs.existsSync(fullDir)) return;
      try {
        for (const entry of fs.readdirSync(fullDir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const lowerName = entry.name.toLowerCase();
          const key = prefixKey ? `${prefixKey}/${lowerName}` : lowerName;
          if (!this.cachedFileMap.has(key)) {
            this.cachedFileMap.set(key, path.join(baseRel, entry.name));
          }
        }
      } catch {
        // ignore unreadable directories
      }
    };

    indexDir("parts", "");
    indexDir("parts/s", "s");
    indexDir("parts/s", "parts/s");
    indexDir("p", "");
    indexDir("p/48", "48");
    indexDir("p/48", "p/48");
    indexDir("p/8", "8");
    indexDir("p/8", "p/8");
    indexDir("Unofficial/parts", "");
    indexDir("Unofficial/parts/s", "s");
    indexDir("Unofficial/p", "");
    indexDir("Unofficial/p/48", "48");
    indexDir("UnOfficial/parts", "");
    indexDir("UnOfficial/parts/s", "s");
    indexDir("UnOfficial/p", "");
    indexDir("UnOfficial/p/48", "48");
    indexDir("LEGO", "");
  }

  getColorTable(): Record<number, ColorInfo> {
    this.ensureInitialized();
    return this.colorTable;
  }

  getColourHeaderLines(): string[] {
    this.ensureInitialized();
    return this.colourHeaderLines;
  }

  resolvePartPath(rawName: string): string | null {
    this.ensureInitialized();
    if (!this.ldrawDir) return null;

    const cleaned = rawName.trim().replace(/\\/g, "/");
    const lower = cleaned.toLowerCase();
    const candidates = [
      lower,
      lower.startsWith("parts/s/") ? lower.slice(6) : null,
      lower.startsWith("p/48/") ? lower.slice(2) : null,
      lower.startsWith("p/8/") ? lower.slice(2) : null,
      lower.startsWith("s/") ? `parts/${lower}` : null,
      lower.startsWith("48/") ? `p/${lower}` : null,
      lower.startsWith("8/") ? `p/${lower}` : null,
    ].filter(Boolean) as string[];

    for (const c of candidates) {
      const mapped = this.cachedFileMap.get(c);
      if (mapped) {
        const full = path.join(this.ldrawDir, mapped);
        if (fs.existsSync(full)) return full;
      }
    }

    for (const dir of SEARCH_SUBDIRS) {
      for (const c of candidates) {
        const full = dir ? path.join(this.ldrawDir, dir, c) : path.join(this.ldrawDir, c);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          this.cachedFileMap.set(c, path.relative(this.ldrawDir, full));
          return full;
        }
      }
    }

    // Fallback case-insensitive directory scan (essential for Linux/macOS)
    this.ensureCaseInsensitiveIndex();
    for (const c of candidates) {
      const mapped = this.cachedFileMap.get(c);
      if (mapped) {
        const full = path.join(this.ldrawDir, mapped);
        if (fs.existsSync(full)) return full;
      }
    }

    return null;
  }

  readPartLines(rawName: string): string[] | null {
    const resolved = this.resolvePartPath(rawName);
    if (!resolved) return null;
    return fs.readFileSync(resolved, "utf8").split(/\r?\n/);
  }

  getStatus(): LDrawLibraryStatus {
    this.ensureInitialized();
    return {
      ldrawDir: this.ldrawDir,
      exists: Boolean(this.ldrawDir && fs.existsSync(this.ldrawDir)),
      hasPartsDir: Boolean(this.ldrawDir && fs.existsSync(path.join(this.ldrawDir, "parts"))),
      hasPrimitivesDir: Boolean(this.ldrawDir && fs.existsSync(path.join(this.ldrawDir, "p"))),
      colorSource: this.colorSource,
      colorCount: Object.keys(this.colorTable).length,
      indexedFileCount: this.cachedFileMap.size,
    };
  }
}
