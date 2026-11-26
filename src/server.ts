import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { LDrawServerConfig } from "./types.js";
import { LDrawCatalog } from "./ldraw/catalog.js";
import { LDrawLibrary, getDefaultLDrawCacheDir } from "./ldraw/library.js";
import { packLDrawMpdOffline } from "./ldraw/packer.js";
import { isPngBuffer, stitchSideBySidePng } from "./ldraw/png.js";
import { renderLDrawToPngAndAnalyze } from "./ldraw/renderer.js";
import { resolveVisionConfig, verifyStepWithVision } from "./verifier/vision.js";

export const SERVER_VERSION = "0.1.1";

function guessImageMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function requireLDrawLibraryHint(library: LDrawLibrary): string | null {
  if (library.ldrawDir) return null;
  return (
    `No local LDraw parts library found. Run \`npx ldraw-mpd-mcp setup\` to download the official LDraw parts library to ${getDefaultLDrawCacheDir()}, ` +
    `or set LDRAW_DIR to your existing LDraw / BrickLink Studio 2.0 ldraw folder.`
  );
}

export function createLDrawMcpServer(config: LDrawServerConfig = {}): {
  server: McpServer;
  library: LDrawLibrary;
  catalog: LDrawCatalog;
} {
  const cwd = config.cwd || process.cwd();
  const library = new LDrawLibrary({
    ldrawDir: config.ldrawDir,
    colorDefPath: config.colorDefPath,
  });
  const catalog = new LDrawCatalog(library, config.catalogPath);

  const server = new McpServer({
    name: "ldraw-mpd-mcp",
    version: SERVER_VERSION,
  });

  server.tool(
    "ldraw_library_status",
    "Inspect the active LDraw parts library path, color table source, optional set catalog, and vision verifier configuration.",
    {},
    async () => {
      const libStatus = library.getStatus();
      const vision = resolveVisionConfig(config.vision);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                library: libStatus,
                catalog: {
                  catalogPath: catalog.catalogPath,
                  customPartCount: catalog.getCustomCatalogCount(),
                  defaultLookupSource: catalog.hasCustomCatalog() ? "catalog" : "library",
                },
                visionVerifier: {
                  configured: Boolean(vision.provider && vision.apiKey),
                  provider: vision.provider,
                  model: vision.model,
                },
                setupHint: requireLDrawLibraryHint(library),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "ldraw_lookup_part",
    "Search LEGO parts in the configured set catalog (if LDRAW_CATALOG_PATH is set) or across the entire local LDraw parts library by keyword, colour, or category.",
    {
      query: z
        .string()
        .optional()
        .describe("Search keyword (e.g. '1x12', '2x4', 'plate', 'gear', 'axle', '3001')"),
      colour: z
        .string()
        .optional()
        .describe("Filter by color name or LDraw color code (custom catalog mode)"),
      category: z
        .string()
        .optional()
        .describe("Filter by category (e.g. 'Brick', 'Plate', 'Technic', 'Slope')"),
      source: z
        .enum(["auto", "catalog", "library"])
        .optional()
        .default("auto")
        .describe("Search source: 'auto' prefers custom set catalog if loaded, otherwise full LDraw library"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(30)
        .describe("Maximum number of matching parts to return (default 30)"),
    },
    async ({ query, colour, category, source, limit }) => {
      if (source !== "catalog" && !catalog.hasCustomCatalog()) {
        const hint = requireLDrawLibraryHint(library);
        if (hint) {
          return { content: [{ type: "text", text: hint }], isError: true };
        }
      }

      const result = catalog.search({ query, colour, category, source, limit });
      return {
        content: [
          {
            type: "text",
            text: `Found ${result.totalMatches} matching part(s) in ${result.sourceUsed} (showing ${result.returnedCount}):\n${JSON.stringify(
              result.items,
              null,
              2
            )}`,
          },
        ],
      };
    }
  );

  server.tool(
    "ldraw_inspect_part",
    "Inspect a single LDraw .dat part at a given color and 3x3 rotation matrix. Returns its transformed LDU bounding box and a 2x-supersampled isometric 3D PNG with +X (Red), -Y Up (Green), and +Z (Blue) axis arrows.",
    {
      datFile: z.string().describe("LDraw .dat filename (e.g. '3001.dat', '3895.dat', '3709b.dat')"),
      colorCode: z.number().optional().default(15).describe("LDraw color code (default 15 White)"),
      matrix: z
        .string()
        .optional()
        .default("1 0 0 0 1 0 0 0 1")
        .describe("9-number 3x3 rotation matrix 'a b c d e f g h i' (default identity)"),
      yawDeg: z.number().optional().default(-35).describe("Camera azimuth angle in degrees (default -35)"),
      pitchDeg: z.number().optional().default(30).describe("Camera elevation angle in degrees (default 30)"),
    },
    async ({ datFile, colorCode, matrix, yawDeg, pitchDeg }, extra) => {
      const hint = requireLDrawLibraryHint(library);
      if (hint) {
        return { content: [{ type: "text", text: hint }], isError: true };
      }

      const cleanDat = datFile.trim();
      if (!library.resolvePartPath(cleanDat)) {
        return {
          content: [
            {
              type: "text",
              text: `Part '${cleanDat}' was not found in LDraw library (${library.ldrawDir}).`,
            },
          ],
          isError: true,
        };
      }

      const ldrLine = `1 ${colorCode} 0 0 0 ${matrix.trim()} ${cleanDat}`;
      const res = renderLDrawToPngAndAnalyze(library, ldrLine, {
        width: 560,
        height: 440,
        showAxes: true,
        yawDeg,
        pitchDeg,
        signal: extra?.signal,
      });

      const catEntry = catalog.findCustomByDatFile(cleanDat);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                datFile: cleanDat,
                matrix,
                worldBBoxAtOrigin: res.overallBBox,
                axisLegend: {
                  "+X (Red line)": "LDraw +X axis (1 stud = 20 LDU)",
                  "-Y (Green line UP)": "LDraw -Y axis points UP (1 plate = 8 LDU, 1 brick = 24 LDU)",
                  "+Z (Blue line)": "LDraw +Z axis (1 stud = 20 LDU)",
                },
                catalogMetadata: catEntry
                  ? {
                      ldrawDescription: catEntry.ldrawDescription,
                      unrotatedStuds: catEntry.studs,
                      unrotatedHoles: catEntry.holes,
                    }
                  : null,
              },
              null,
              2
            ),
          },
          {
            type: "image",
            mimeType: "image/png",
            data: res.pngBuffer.toString("base64"),
          },
        ],
      };
    }
  );

  server.tool(
    "ldraw_render_step",
    "Render an LDraw .ldr or .mpd model up to a specific stepNumber into a 2x-supersampled 3D isometric PNG with bounding-box diagnostics, optional side-by-side reference stitching, and Sub-Build Isolation (`0 FILE <submodel>.ldr`).",
    {
      ldrPath: z.string().optional().describe("Path to .ldr or .mpd file"),
      ldrContent: z.string().optional().describe("Inline LDraw content (if ldrPath not provided)"),
      stepNumber: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-based global step number to render up to (omit for final step)"),
      instructionImagePath: z
        .string()
        .optional()
        .describe("Optional path to reference instruction PNG to stitch side-by-side"),
      yawDeg: z.number().optional().default(-35).describe("Camera azimuth angle in degrees (default -35)"),
      pitchDeg: z.number().optional().default(30).describe("Camera elevation angle in degrees (default 30)"),
      showAxes: z
        .boolean()
        .optional()
        .default(true)
        .describe("Draw +X (Red), -Y Up (Green), +Z (Blue) axes from origin (0,0,0)"),
      isolateSubmodels: z
        .boolean()
        .optional()
        .default(true)
        .describe("Auto-hide main build when stepNumber is inside a submodel .ldr (default true)"),
      highlightCurrentStep: z
        .boolean()
        .optional()
        .default(false)
        .describe("Fade previous steps slightly so newly added parts in stepNumber stand out"),
      transparentBackground: z
        .boolean()
        .optional()
        .default(false)
        .describe("Render with transparent RGBA background instead of white"),
      savePngPath: z.string().optional().describe("Optional file path to save the rendered PNG on disk"),
    },
    async (
      {
        ldrPath,
        ldrContent,
        stepNumber,
        instructionImagePath,
        yawDeg,
        pitchDeg,
        showAxes,
        isolateSubmodels,
        highlightCurrentStep,
        transparentBackground,
        savePngPath,
      },
      extra
    ) => {
      const rawText = ldrPath
        ? fs.readFileSync(path.resolve(cwd, ldrPath), "utf8")
        : ldrContent || "";
      if (!rawText.trim()) {
        return {
          content: [{ type: "text", text: "Error: Provide either ldrPath or ldrContent." }],
          isError: true,
        };
      }

      const res = renderLDrawToPngAndAnalyze(library, rawText, {
        stepNumber,
        yawDeg,
        pitchDeg,
        showAxes,
        isolateSubmodels,
        highlightCurrentStep,
        transparentBackground,
        signal: extra?.signal,
      });

      let finalPng = res.pngBuffer;
      if (instructionImagePath) {
        const instrAbs = path.resolve(cwd, instructionImagePath);
        if (fs.existsSync(instrAbs)) {
          const instrBuf = fs.readFileSync(instrAbs);
          if (isPngBuffer(instrBuf)) {
            finalPng = stitchSideBySidePng(instrBuf, res.pngBuffer, 540, extra?.signal);
          }
        }
      }

      if (savePngPath) {
        const outAbs = path.resolve(cwd, savePngPath);
        fs.mkdirSync(path.dirname(outAbs), { recursive: true });
        fs.writeFileSync(outAbs, finalPng);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                renderedStep: `${res.activeStep} / ${res.totalSteps}`,
                activeModelScope: res.activeModelScope,
                isIsolatedSubbuild: res.isIsolatedSubbuild,
                overallWorldBBox: res.overallBBox,
                activeStepPlacements: res.placements,
              },
              null,
              2
            ),
          },
          {
            type: "image",
            mimeType: "image/png",
            data: finalPng.toString("base64"),
          },
        ],
      };
    }
  );

  server.tool(
    "ldraw_verify_step",
    "Independently verify an LDraw step against a reference instruction image using a configured Vision LLM (Gemini or OpenAI-compatible). Returns compact JSON on PASS (zero image bloat) or LDU discrepancy diagnosis + side-by-side PNG on FAIL.",
    {
      ldrPath: z.string().optional().describe("Path to .ldr or .mpd file"),
      ldrContent: z.string().optional().describe("Inline LDraw content (if ldrPath not provided)"),
      stepNumber: z.number().int().min(1).describe("1-based global step number to verify"),
      instructionImagePath: z
        .string()
        .describe("Path to the reference LEGO instruction page PNG/JPG/WebP for this step"),
      yawDeg: z.number().optional().default(-35).describe("Camera azimuth angle in degrees (default -35)"),
      pitchDeg: z.number().optional().default(30).describe("Camera elevation angle in degrees (default 30)"),
      isolateSubmodels: z
        .boolean()
        .optional()
        .default(true)
        .describe("Auto-hide main build when stepNumber is inside a submodel .ldr (default true)"),
      alwaysReturnImage: z
        .boolean()
        .optional()
        .default(false)
        .describe("Attach side-by-side image even when status is PASS (default false to save context)"),
      extraRules: z
        .string()
        .optional()
        .describe("Optional model-specific or set-specific inspection rules appended to the QA prompt"),
    },
    async (
      {
        ldrPath,
        ldrContent,
        stepNumber,
        instructionImagePath,
        yawDeg,
        pitchDeg,
        isolateSubmodels,
        alwaysReturnImage,
        extraRules,
      },
      extra
    ) => {
      const rawText = ldrPath
        ? fs.readFileSync(path.resolve(cwd, ldrPath), "utf8")
        : ldrContent || "";
      if (!rawText.trim()) {
        return {
          content: [{ type: "text", text: "Error: Provide either ldrPath or ldrContent." }],
          isError: true,
        };
      }

      const instrAbs = path.resolve(cwd, instructionImagePath);
      if (!fs.existsSync(instrAbs)) {
        return {
          content: [{ type: "text", text: `Error: instructionImagePath not found: ${instrAbs}` }],
          isError: true,
        };
      }

      const instrBuf = fs.readFileSync(instrAbs);
      const rendered = renderLDrawToPngAndAnalyze(library, rawText, {
        stepNumber,
        yawDeg,
        pitchDeg,
        showAxes: false,
        isolateSubmodels,
        signal: extra?.signal,
      });

      const verdict = await verifyStepWithVision({
        instructionImageBuffer: instrBuf,
        instructionMimeType: guessImageMimeType(instrAbs),
        renderedPngBuffer: rendered.pngBuffer,
        stepNumber: rendered.activeStep,
        activeModelScope: rendered.activeModelScope,
        isIsolatedSubbuild: rendered.isIsolatedSubbuild,
        placements: rendered.placements,
        overallBBox: rendered.overallBBox,
        extraRules,
        config: config.vision,
        signal: extra?.signal,
      });

      if (verdict.status === "PASS" && !alwaysReturnImage) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "PASS",
                  step: `${rendered.activeStep} / ${rendered.totalSteps}`,
                  activeModelScope: rendered.activeModelScope,
                  isIsolatedSubbuild: rendered.isIsolatedSubbuild,
                  studAndHoleCheck: verdict.studAndHoleCheck,
                  modelUsed: verdict.modelUsed,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const sideBySideBuf = stitchSideBySidePng(instrBuf, rendered.pngBuffer, 540, extra?.signal);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...verdict,
                step: `${rendered.activeStep} / ${rendered.totalSteps}`,
                overallWorldBBox: rendered.overallBBox,
                activeStepPlacements: rendered.placements,
              },
              null,
              2
            ),
          },
          {
            type: "image",
            mimeType: "image/png",
            data: sideBySideBuf.toString("base64"),
          },
        ],
      };
    }
  );

  server.tool(
    "ldraw_pack_mpd",
    "Bundle an LDraw .ldr/.mpd file with LDConfig.ldr colours and all recursively referenced .dat parts/subparts/primitives into a single 100% offline-ready .mpd file compatible with Three.js LDrawLoader.",
    {
      inputLdrPath: z.string().describe("Path to source .ldr or .mpd file"),
      outputMpdPath: z.string().describe("Destination path for self-contained .mpd file"),
    },
    async ({ inputLdrPath, outputMpdPath }) => {
      const inAbs = path.resolve(cwd, inputLdrPath);
      if (!fs.existsSync(inAbs)) {
        return {
          content: [{ type: "text", text: `Error: inputLdrPath not found: ${inAbs}` }],
          isError: true,
        };
      }
      const outAbs = path.resolve(cwd, outputMpdPath);
      const rawText = fs.readFileSync(inAbs, "utf8");
      const packed = packLDrawMpdOffline(library, rawText, path.basename(inAbs));

      fs.mkdirSync(path.dirname(outAbs), { recursive: true });
      fs.writeFileSync(outAbs, packed.mpdContent, "utf8");
      const sizeKb = (Buffer.byteLength(packed.mpdContent, "utf8") / 1024).toFixed(1);

      return {
        content: [
          {
            type: "text",
            text: `Packed self-contained MPD written to ${outAbs} (${sizeKb} KB, ${packed.embeddedCount} embedded files, missing: ${
              packed.missingParts.length ? packed.missingParts.join(", ") : "none"
            })`,
          },
        ],
      };
    }
  );

  return { server, library, catalog };
}
