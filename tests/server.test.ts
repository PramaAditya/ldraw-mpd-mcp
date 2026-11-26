import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  SERVER_VERSION,
  createLDrawMcpServer,
  encodePngRGBA,
  isPngBuffer,
  verifyStepWithVision,
} from "../dist/index.js";
import { createTempFixtureLibrary } from "./fixtures.js";

const CLI_PATH = path.resolve(process.cwd(), "dist", "cli.js");

function makeTinyPng(): Buffer {
  const rgba = Buffer.alloc(8 * 8 * 4, 255);
  return encodePngRGBA(8, 8, rgba);
}

describe("ldraw-mpd-mcp MCP server & CLI", () => {
  it("exposes all 6 MCP tools and executes end-to-end workflows over MCP transport", async () => {
    const fixtureDir = createTempFixtureLibrary();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ldraw-mcp-e2e-"));
    const catalogPath = path.join(workDir, "custom_catalog.json");

    fs.writeFileSync(
      catalogPath,
      JSON.stringify([
        {
          elementId: "300521",
          designId: "3005",
          colour: "Bright Red",
          ldrawColorCode: 4,
          ldrawColorName: "Red",
          category: "Bricks",
          elementName: "BRICK 1X1",
          ldrawDescription: "Brick 1 x 1",
          datFile: "3005.dat",
          qty: 2,
          studCount: 1,
          studs: [[0, 0, 0]],
          holeCount: 0,
          holes: [],
        },
      ])
    );

    const ldrPath = path.join(workDir, "model.ldr");
    const outMpdPath = path.join(workDir, "packed.mpd");
    const outPngPath = path.join(workDir, "step1.png");
    const instrPngPath = path.join(workDir, "instr1.png");
    fs.writeFileSync(instrPngPath, makeTinyPng());
    fs.writeFileSync(
      ldrPath,
      [
        "0 FILE main.ldr",
        "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3005.dat",
        "0 STEP",
        "1 14 0 -24 0 1 0 0 0 1 0 0 0 1 3005.dat",
      ].join("\n")
    );

    const { server } = createLDrawMcpServer({
      ldrawDir: fixtureDir,
      catalogPath,
      cwd: workDir,
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const { tools } = await client.listTools();
      const toolNames = tools.map((t) => t.name).sort();
      assert.deepEqual(toolNames, [
        "ldraw_inspect_part",
        "ldraw_library_status",
        "ldraw_lookup_part",
        "ldraw_pack_mpd",
        "ldraw_render_step",
        "ldraw_verify_step",
      ]);

      // 1. ldraw_library_status
      const statusRes = await client.callTool({ name: "ldraw_library_status", arguments: {} });
      const statusText = (statusRes.content as Array<{ type: string; text?: string }>)[0].text!;
      const statusJson = JSON.parse(statusText);
      assert.equal(statusJson.library.exists, true);
      assert.equal(statusJson.catalog.customPartCount, 1);

      // 2. ldraw_lookup_part (custom catalog + library fallback)
      const catLookup = await client.callTool({
        name: "ldraw_lookup_part",
        arguments: { query: "3005", colour: "Red" },
      });
      assert.ok(
        (catLookup.content as Array<{ type: string; text?: string }>)[0].text!.includes("in catalog")
      );

      const libLookup = await client.callTool({
        name: "ldraw_lookup_part",
        arguments: { query: "3005", source: "library" },
      });
      assert.ok(
        (libLookup.content as Array<{ type: string; text?: string }>)[0].text!.includes("in library")
      );

      // 3. ldraw_inspect_part (valid + missing)
      const inspectRes = await client.callTool({
        name: "ldraw_inspect_part",
        arguments: { datFile: "3005.dat", colorCode: 4 },
      });
      const inspectContent = inspectRes.content as Array<{
        type: string;
        text?: string;
        data?: string;
      }>;
      assert.equal(inspectContent.length, 2);
      assert.equal(inspectContent[1].type, "image");
      assert.equal(isPngBuffer(Buffer.from(inspectContent[1].data!, "base64")), true);

      const missingRes = await client.callTool({
        name: "ldraw_inspect_part",
        arguments: { datFile: "nonexistent_99999.dat" },
      });
      assert.equal(missingRes.isError, true);

      // 4. ldraw_render_step (with side-by-side stitching & savePngPath)
      const renderRes = await client.callTool({
        name: "ldraw_render_step",
        arguments: {
          ldrPath,
          stepNumber: 2,
          instructionImagePath: instrPngPath,
          savePngPath: outPngPath,
        },
      });
      const renderContent = renderRes.content as Array<{ type: string; text?: string; data?: string }>;
      assert.equal(renderContent.length, 2);
      assert.equal(fs.existsSync(outPngPath), true);
      assert.equal(isPngBuffer(fs.readFileSync(outPngPath)), true);

      // 5. ldraw_pack_mpd
      const packRes = await client.callTool({
        name: "ldraw_pack_mpd",
        arguments: { inputLdrPath: ldrPath, outputMpdPath: outMpdPath },
      });
      assert.equal(packRes.isError, undefined);
      assert.equal(fs.existsSync(outMpdPath), true);
      const packedText = fs.readFileSync(outMpdPath, "utf8");
      assert.ok(packedText.includes("0 FILE 3005.dat"));
      assert.ok(packedText.includes("0 FILE parts/s/subcap.dat"));
      assert.ok(packedText.includes("0 FILE box.dat"));
    } finally {
      await client.close();
      await server.close();
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("validates vision verifier error handling and Gemini / OpenAI-compatible parsing", async () => {
    const tinyPng = makeTinyPng();
    const baseParams = {
      instructionImageBuffer: tinyPng,
      renderedPngBuffer: tinyPng,
      stepNumber: 1,
      activeModelScope: "main.ldr",
      isIsolatedSubbuild: false,
      placements: [],
      overallBBox: { minX: -10, minY: -4, minZ: -10, maxX: 10, maxY: 24, maxZ: 10 },
    };

    const origFetch = globalThis.fetch;
    const origGemini = process.env.GEMINI_API_KEY;
    const origGoogle = process.env.GOOGLE_API_KEY;
    const origOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      await assert.rejects(
        () => verifyStepWithVision(baseParams),
        /No vision verifier API key configured/
      );

      // Mock Gemini PASS
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        status: "PASS",
                        studAndHoleCheck: "Exact 1x1 match",
                        discrepancies: [],
                        suggestedFixes: [],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )) as typeof fetch;

      const geminiVerdict = await verifyStepWithVision({
        ...baseParams,
        config: { provider: "gemini", apiKey: "test-key", model: "gemini-2.5-flash" },
      });
      assert.equal(geminiVerdict.status, "PASS");
      assert.equal(geminiVerdict.modelUsed, "gemini-2.5-flash");

      // Mock OpenAI-compatible FAIL
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    status: "FAIL",
                    studAndHoleCheck: "Shifted +20 LDU on X",
                    discrepancies: ["Brick offset by 1 stud"],
                    suggestedFixes: ["Change x from 20 to 0"],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )) as typeof fetch;

      const openaiVerdict = await verifyStepWithVision({
        ...baseParams,
        extraRules: "Verify stud alignment strictly.",
        config: {
          provider: "openai",
          apiKey: "test-key",
          model: "gpt-4o",
          baseUrl: "https://example.invalid/v1",
        },
      });
      assert.equal(openaiVerdict.status, "FAIL");
      assert.equal(openaiVerdict.discrepancies.length, 1);
      assert.equal(openaiVerdict.modelUsed, "gpt-4o");
    } finally {
      globalThis.fetch = origFetch;
      if (origGemini !== undefined) process.env.GEMINI_API_KEY = origGemini;
      if (origGoogle !== undefined) process.env.GOOGLE_API_KEY = origGoogle;
      if (origOpenAI !== undefined) process.env.OPENAI_API_KEY = origOpenAI;
    }
  });

  it("runs CLI flags (--version, --help, doctor) cleanly", () => {
    const fixtureDir = createTempFixtureLibrary();
    try {
      const ver = execFileSync(process.execPath, [CLI_PATH, "--version"], { encoding: "utf8" }).trim();
      assert.equal(ver, SERVER_VERSION);

      const help = execFileSync(process.execPath, [CLI_PATH, "--help"], { encoding: "utf8" });
      assert.ok(help.includes("ldraw-mpd-mcp setup"));

      const doctorRaw = execFileSync(
        process.execPath,
        [CLI_PATH, "doctor", "--ldraw-dir", fixtureDir],
        { encoding: "utf8" }
      );
      const doctor = JSON.parse(doctorRaw);
      assert.equal(doctor.version, SERVER_VERSION);
      assert.equal(doctor.library.exists, true);
      assert.equal(doctor.library.colorCount, 4);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
