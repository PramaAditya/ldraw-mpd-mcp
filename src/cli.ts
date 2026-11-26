#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LDrawCatalog } from "./ldraw/catalog.js";
import { LDrawLibrary, getDefaultLDrawCacheDir } from "./ldraw/library.js";
import { setupLDrawLibrary } from "./ldraw/setup.js";
import { SERVER_VERSION, createLDrawMcpServer } from "./server.js";
import { resolveVisionConfig } from "./verifier/vision.js";

function parseArgs(argv: string[]) {
  let command: "serve" | "setup" | "doctor" | "help" | "version" = "serve";
  let ldrawDir: string | undefined;
  let catalogPath: string | undefined;
  let colorDefPath: string | undefined;
  let includeUnofficial = false;

  const args = [...argv];
  if (args[0] && !args[0].startsWith("-")) {
    const cmd = args.shift()!.toLowerCase();
    if (cmd === "setup" || cmd === "doctor" || cmd === "help" || cmd === "version" || cmd === "serve") {
      command = cmd;
    } else {
      throw new Error(`Unknown command: ${cmd}. Run \`ldraw-mpd-mcp --help\` for usage.`);
    }
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      command = "help";
    } else if (a === "--version" || a === "-v") {
      command = "version";
    } else if (a === "--ldraw-dir" || a === "--dir") {
      ldrawDir = args[++i];
    } else if (a === "--catalog") {
      catalogPath = args[++i];
    } else if (a === "--color-def") {
      colorDefPath = args[++i];
    } else if (a === "--unofficial") {
      includeUnofficial = true;
    } else {
      throw new Error(`Unknown flag: ${a}. Run \`ldraw-mpd-mcp --help\` for usage.`);
    }
  }

  return { command, ldrawDir, catalogPath, colorDefPath, includeUnofficial };
}

function printHelp(): void {
  process.stdout.write(`ldraw-mpd-mcp v${SERVER_VERSION}

Zero-native-dependency MCP server for LEGO LDraw (.ldr / .mpd) modeling,
3D step rendering, visual QA verification, and offline MPD packing.

Usage:
  ldraw-mpd-mcp [options]                 Start MCP server on stdio (default)
  ldraw-mpd-mcp setup [options]           Download official LDraw parts library (complete.zip)
  ldraw-mpd-mcp doctor [options]          Inspect detected LDraw library, catalog, and vision config

Options:
  --ldraw-dir, --dir <path>   Explicit LDraw library directory (overrides LDRAW_DIR)
  --catalog <path>            Optional custom set BOM catalog JSON (overrides LDRAW_CATALOG_PATH)
  --color-def <path>          Optional StudioColorDefinition.txt fallback path
  --unofficial                (setup) Also download & extract official LDraw unofficial parts
  -h, --help                  Show this help message
  -v, --version               Show version

Environment Variables:
  LDRAW_DIR                   Path to LDraw library (e.g. ~/.ldraw or Studio 2.0/ldraw)
  LDRAW_CATALOG_PATH          Optional custom set catalog JSON path
  GEMINI_API_KEY              API key for ldraw_verify_step (default provider: gemini)
  OPENAI_API_KEY              API key for OpenAI-compatible vision verification
  LDRAW_VISION_PROVIDER       'gemini' (default) or 'openai'
  LDRAW_VISION_MODEL          Override vision QA model (default: gemini-2.5-flash / gpt-4o)
  LDRAW_VISION_BASE_URL       Custom OpenAI-compatible base URL
`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command === "help") {
    printHelp();
    return;
  }

  if (parsed.command === "version") {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  if (parsed.command === "setup") {
    const result = await setupLDrawLibrary({
      targetDir: parsed.ldrawDir || getDefaultLDrawCacheDir(),
      includeUnofficial: parsed.includeUnofficial,
      onLog: (msg) => process.stderr.write(`${msg}\n`),
    });
    process.stdout.write(
      `LDraw library installed to ${result.targetDir} (${result.filesExtracted} files).\n`
    );
    return;
  }

  if (parsed.command === "doctor") {
    const library = new LDrawLibrary({
      ldrawDir: parsed.ldrawDir,
      colorDefPath: parsed.colorDefPath,
    });
    const catalog = new LDrawCatalog(library, parsed.catalogPath);
    const vision = resolveVisionConfig();
    process.stdout.write(
      JSON.stringify(
        {
          version: SERVER_VERSION,
          library: library.getStatus(),
          catalog: {
            catalogPath: catalog.catalogPath,
            customPartCount: catalog.getCustomCatalogCount(),
          },
          vision: {
            configured: Boolean(vision.provider && vision.apiKey),
            provider: vision.provider,
            model: vision.model,
          },
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  const { server } = createLDrawMcpServer({
    ldrawDir: parsed.ldrawDir,
    catalogPath: parsed.catalogPath,
    colorDefPath: parsed.colorDefPath,
  });

  const transport = new StdioServerTransport();
  const handleExit = () => {
    process.exit(0);
  };
  process.once("SIGINT", handleExit);
  process.once("SIGTERM", handleExit);
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(
    `[ldraw-mpd-mcp] Fatal error: ${err instanceof Error ? err.stack || err.message : String(err)}\n`
  );
  process.exit(1);
});
