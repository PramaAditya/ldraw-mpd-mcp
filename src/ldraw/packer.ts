import * as fs from "node:fs";
import type { PackMpdResult } from "../types.js";
import type { LDrawLibrary } from "./library.js";
import { normalizeLDrawLoaderFileName } from "./library.js";

function extractPartRefs(text: string): string[] {
  const refs: string[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const l = raw.trim();
    if (!l.startsWith("1 ")) continue;
    const tokens = l.split(/\s+/);
    if (tokens.length < 15) continue;
    refs.push(normalizeLDrawLoaderFileName(tokens.slice(14).join(" ")));
  }
  return refs;
}

/**
 * Bundles an LDraw .ldr or .mpd model with `0 !COLOUR` definitions from LDConfig.ldr
 * and recursively inlines all referenced `.dat` parts, subparts (`parts/s/`), and
 * primitives (`p/`, `p/48/`) into a single 100% self-contained offline `.mpd` file.
 */
export function packLDrawMpdOffline(
  library: LDrawLibrary,
  inputLdrText: string,
  mainModelName = "main.ldr"
): PackMpdResult {
  const colourLines = library.getColourHeaderLines();

  const embeddedFiles = new Map<string, { canonicalName: string; content: string }>();
  let mainFileName = mainModelName;
  let mainFileLines: string[] = [];

  const rawLines = inputLdrText.replace(/\r\n/g, "\n").split("\n");
  if (rawLines.some((l) => l.trim().startsWith("0 FILE "))) {
    let curName: string | null = null;
    let buf: string[] = [];
    let isFirst = true;

    const commit = () => {
      if (!curName) return;
      const norm = normalizeLDrawLoaderFileName(curName);
      const body = buf.join("\n").trim();
      if (isFirst) {
        mainFileName = norm;
        mainFileLines = body.split("\n").filter((l) => !l.trim().startsWith("0 !COLOUR "));
        isFirst = false;
      } else {
        embeddedFiles.set(norm.toLowerCase(), { canonicalName: norm, content: body });
      }
    };

    for (const l of rawLines) {
      if (l.trim().startsWith("0 FILE ")) {
        commit();
        curName = l.trim().slice(7).trim();
        buf = [];
      } else {
        buf.push(l);
      }
    }
    commit();
  } else {
    mainFileLines = rawLines.filter((l) => !l.trim().startsWith("0 !COLOUR "));
  }

  const queue: string[] = [...extractPartRefs(mainFileLines.join("\n"))];
  for (const item of embeddedFiles.values()) {
    queue.push(...extractPartRefs(item.content));
  }

  const missingParts: string[] = [];
  while (queue.length > 0) {
    const next = queue.shift()!;
    const key = next.toLowerCase();
    if (embeddedFiles.has(key)) continue;

    if (key === "step_join.dat") {
      embeddedFiles.set(key, {
        canonicalName: "step_join.dat",
        content:
          "0 Subbuild Incorporation Marker\n0 Name: step_join.dat\n0 !LDRAW_ORG Part\n3 16 0 0 0 0.001 0 0 0 0.001 0",
      });
      continue;
    }

    const localPath = library.resolvePartPath(next);
    if (!localPath || !fs.existsSync(localPath)) {
      if (!missingParts.includes(next)) missingParts.push(next);
      continue;
    }

    const content = fs
      .readFileSync(localPath, "utf8")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((l) => !l.trim().startsWith("0 FILE ") && l.trim() !== "0 NOFILE")
      .join("\n")
      .trim();

    embeddedFiles.set(key, { canonicalName: next, content });
    for (const child of extractPartRefs(content)) {
      if (!embeddedFiles.has(child.toLowerCase())) {
        queue.push(child);
      }
    }
  }

  const outChunks: string[] = [];
  outChunks.push(`0 FILE ${mainFileName}`);
  outChunks.push(...colourLines);
  outChunks.push(...mainFileLines);

  for (const entry of embeddedFiles.values()) {
    let content = entry.content;
    if (!content.includes("!LDRAW_ORG")) {
      const orgType = entry.canonicalName.endsWith(".ldr")
        ? "Model"
        : entry.canonicalName.startsWith("parts/s/")
          ? "Subpart"
          : "Part";
      content = `0 !LDRAW_ORG ${orgType}\n${content}`;
    }
    outChunks.push(`\n0 FILE ${entry.canonicalName}\n${content}`);
  }

  return {
    mpdContent: outChunks.join("\n") + "\n",
    embeddedCount: embeddedFiles.size + 1,
    missingParts,
  };
}
