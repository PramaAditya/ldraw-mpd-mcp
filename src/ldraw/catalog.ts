import * as fs from "node:fs";
import * as path from "node:path";
import type { CatalogEntry } from "../types.js";
import type { LDrawLibrary } from "./library.js";

export interface LibraryPartIndexEntry {
  datFile: string;
  description: string;
  category?: string;
}

export interface PartLookupOptions {
  query?: string;
  colour?: string;
  category?: string;
  source?: "auto" | "catalog" | "library";
  limit?: number;
}

export interface PartLookupResult {
  sourceUsed: "catalog" | "library";
  totalMatches: number;
  returnedCount: number;
  items: Array<Record<string, unknown>>;
}

export class LDrawCatalog {
  readonly catalogPath: string | null;
  private readonly library: LDrawLibrary;
  private customCatalog: CatalogEntry[] = [];
  private libraryIndex: LibraryPartIndexEntry[] | null = null;

  constructor(library: LDrawLibrary, catalogPath?: string) {
    this.library = library;
    const candidate = catalogPath?.trim() || process.env.LDRAW_CATALOG_PATH?.trim() || "";
    if (candidate && fs.existsSync(candidate)) {
      this.catalogPath = path.resolve(candidate);
      try {
        const parsed = JSON.parse(fs.readFileSync(this.catalogPath, "utf8"));
        if (Array.isArray(parsed)) {
          this.customCatalog = parsed as CatalogEntry[];
        }
      } catch {
        this.customCatalog = [];
      }
    } else {
      this.catalogPath = null;
    }
  }

  hasCustomCatalog(): boolean {
    return this.customCatalog.length > 0;
  }

  getCustomCatalogCount(): number {
    return this.customCatalog.length;
  }

  findCustomByDatFile(datFile: string): CatalogEntry | undefined {
    const clean = datFile.trim().toLowerCase();
    return this.customCatalog.find((c) => c.datFile.toLowerCase() === clean);
  }

  private ensureLibraryIndex(): LibraryPartIndexEntry[] {
    if (this.libraryIndex) return this.libraryIndex;
    const entries: LibraryPartIndexEntry[] = [];
    const seen = new Set<string>();
    const dir = this.library.ldrawDir;

    if (!dir) {
      this.libraryIndex = entries;
      return entries;
    }

    // 1. Fast path: official LDraw `parts.lst`
    const partsLst = path.join(dir, "parts.lst");
    if (fs.existsSync(partsLst)) {
      const lines = fs.readFileSync(partsLst, "utf8").split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const m = line.match(/^(\S+\.dat)\s+(.+)$/i);
        if (!m) continue;
        const datFile = m[1].trim();
        const key = datFile.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ datFile, description: m[2].trim() });
      }
    }

    // 2. Fallback / supplement: scan `parts/*.dat` headers (first few lines) when `parts.lst` is absent
    if (entries.length === 0) {
      const partsDirs = [
        path.join(dir, "parts"),
        path.join(dir, "Unofficial", "parts"),
        path.join(dir, "UnOfficial", "parts"),
      ];

      const buf = Buffer.alloc(512);
      for (const pDir of partsDirs) {
        if (!fs.existsSync(pDir)) continue;
        let files: fs.Dirent[];
        try {
          files = fs.readdirSync(pDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.isFile() || !f.name.toLowerCase().endsWith(".dat")) continue;
          const key = f.name.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);

          let description = f.name;
          let category: string | undefined;
          try {
            const fd = fs.openSync(path.join(pDir, f.name), "r");
            try {
              const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
              const head = buf.toString("utf8", 0, bytesRead).split(/\r?\n/);
              const first = (head[0] || "").trim();
              if (first.startsWith("0 ")) {
                description = first.slice(2).trim();
              }
              for (const h of head.slice(1, 10)) {
                const catMatch = h.trim().match(/^0\s+!CATEGORY\s+(.+)$/i);
                if (catMatch) {
                  category = catMatch[1].trim();
                  break;
                }
              }
            } finally {
              fs.closeSync(fd);
            }
          } catch {
            // keep filename fallback
          }

          entries.push({ datFile: f.name, description, category });
        }
      }
    }

    this.libraryIndex = entries;
    return entries;
  }

  search(options: PartLookupOptions): PartLookupResult {
    const q = (options.query || "").trim().toLowerCase();
    const col = (options.colour || "").trim().toLowerCase();
    const cat = (options.category || "").trim().toLowerCase();
    const limit = Math.min(Math.max(1, options.limit ?? 30), 100);
    const desiredSource = options.source ?? "auto";

    const useCustom =
      desiredSource === "catalog" || (desiredSource === "auto" && this.customCatalog.length > 0);

    if (useCustom) {
      const matches = this.customCatalog.filter((item) => {
        if (col) {
          const matchCol =
            (item.colour || "").toLowerCase().includes(col) ||
            (item.ldrawColorName || "").toLowerCase().includes(col) ||
            String(item.ldrawColorCode ?? "") === col;
          if (!matchCol) return false;
        }
        if (cat && !(item.category || "").toLowerCase().includes(cat)) return false;
        if (q) {
          const hay = [
            item.elementId,
            item.designId,
            item.blItemNo,
            item.datFile,
            item.elementName,
            item.ldrawDescription,
            item.category,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          const tokens = q.split(/\s+/);
          if (!tokens.every((tok) => hay.includes(tok))) return false;
        }
        return true;
      });

      const sliced = matches.slice(0, limit).map((m) => ({
        elementId: m.elementId,
        designId: m.designId,
        datFile: m.datFile,
        ldrawDescription: m.ldrawDescription,
        elementName: m.elementName,
        colour: m.colour,
        ldrawColorCode: m.ldrawColorCode,
        ldrawColorName: m.ldrawColorName,
        qtyInSet: m.qty,
        bbox: m.bbox,
        studCount: m.studCount,
        studsSample: m.studs?.slice(0, 8),
        holeCount: m.holeCount,
        holesSample: m.holes?.slice(0, 8),
      }));

      return {
        sourceUsed: "catalog",
        totalMatches: matches.length,
        returnedCount: sliced.length,
        items: sliced,
      };
    }

    const index = this.ensureLibraryIndex();
    const matches = index.filter((item) => {
      if (cat) {
        const hayCat = `${item.category || ""} ${item.description}`.toLowerCase();
        if (!hayCat.includes(cat)) return false;
      }
      if (q) {
        const hay = `${item.datFile} ${item.description} ${item.category || ""}`.toLowerCase();
        const tokens = q.split(/\s+/);
        if (!tokens.every((tok) => hay.includes(tok))) return false;
      }
      return true;
    });

    const sliced = matches.slice(0, limit).map((m) => ({
      datFile: m.datFile,
      ldrawDescription: m.description,
      category: m.category,
    }));

    return {
      sourceUsed: "library",
      totalMatches: matches.length,
      returnedCount: sliced.length,
      items: sliced,
    };
  }
}
