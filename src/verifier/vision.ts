import type {
  BBox3D,
  StepPlacementSummary,
  StepVerificationResult,
  VisionVerifierConfig,
} from "../types.js";

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("LDraw verification aborted.");
}

export interface VerifyStepParams {
  instructionImageBuffer: Buffer;
  instructionMimeType?: string;
  renderedPngBuffer: Buffer;
  stepNumber: number;
  activeModelScope: string;
  isIsolatedSubbuild: boolean;
  placements: StepPlacementSummary[];
  overallBBox: BBox3D;
  extraRules?: string;
  config?: VisionVerifierConfig;
  signal?: AbortSignal;
}

export function resolveVisionConfig(override?: VisionVerifierConfig): {
  provider: "gemini" | "openai" | null;
  apiKey: string | null;
  model: string;
  baseUrl?: string;
} {
  const providerEnv = (
    override?.provider ||
    process.env.LDRAW_VISION_PROVIDER ||
    ""
  )
    .trim()
    .toLowerCase();

  const geminiKey =
    (providerEnv === "gemini" ? override?.apiKey : undefined) ||
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    "";

  const openaiKey =
    (providerEnv === "openai" ? override?.apiKey : undefined) ||
    process.env.OPENAI_API_KEY?.trim() ||
    "";

  const explicitModel = override?.model?.trim() || process.env.LDRAW_VISION_MODEL?.trim();
  const baseUrl = override?.baseUrl?.trim() || process.env.LDRAW_VISION_BASE_URL?.trim();

  if (providerEnv === "openai" || (!providerEnv && !geminiKey && openaiKey)) {
    return {
      provider: openaiKey ? "openai" : null,
      apiKey: openaiKey || null,
      model: explicitModel || "gpt-4o",
      baseUrl: baseUrl || "https://api.openai.com/v1",
    };
  }

  return {
    provider: geminiKey ? "gemini" : null,
    apiKey: geminiKey || null,
    model: explicitModel || "gemini-2.5-flash",
    baseUrl,
  };
}

function buildQaPrompt(params: VerifyStepParams): string {
  const extraSection = params.extraRules?.trim()
    ? `\nAdditional Model/Set Rules:\n${params.extraRules.trim()}\n`
    : "";

  return `You are a strict LEGO LDraw 3D CAD Quality Assurance Inspector.
Compare Image 1 (Reference LEGO Instruction Step ${params.stepNumber}) and Image 2 (Our LDraw 3D Render for Step ${params.stepNumber}).

Active LDraw Step Metadata:
- Step: ${params.stepNumber}
- Active Model Scope: ${params.activeModelScope} (isIsolatedSubbuild: ${params.isIsolatedSubbuild})
- Overall World BBox: ${JSON.stringify(params.overallBBox)}
- Newly Added Parts on This Step:
${JSON.stringify(params.placements, null, 2)}

Coordinate & Unit Reference:
- 1 stud width = 20 LDU; half-stud = 10 LDU.
- 1 plate height = 8 LDU; 1 brick height = 24 LDU.
- In LDraw, -Y is UP (+Y is DOWN). In default isometric view (yaw=-35, pitch=30):
  * +X goes DOWN-RIGHT.
  * -X goes UP-LEFT.
  * +Z goes UP-RIGHT (towards the back).
  * -Z goes DOWN-LEFT (towards the front).

Inspection Rules:
1. Count the exposed studs and side holes on the left, middle, and right of every visible beam/plate/brick in Image 1 vs Image 2. Even a 1-stud (20 LDU) or 1-hole shift MUST be marked FAIL.
2. Check part orientations (slope direction, gear/axle alignment, asymmetric bevel gears, wheel dish vs spoke side, clips/hinges).
3. SEATED POSITION RULE FOR INSERTION ARROWS: LDraw .ldr/.mpd is an additive format where parts placed in Step N cannot move in Step N+1. When Image 1 shows an insertion arrow sliding a brick, axle, bush, pin, or gear into place, Image 2 MUST place that part at its final seated destination (at the tip of the arrow). Do NOT fail a step just because the part is already seated; verify it sits in the exact target hole/stud.
4. Check vertical layer height (e.g. y=-24 vs y=-48) and flag floating or colliding geometry.
5. Ignore instruction UI chrome (BOM callout box, step numbers, background color). Focus strictly on 3D brick geometry, colors, stud/hole counts, orientation, and relative positions.${extraSection}
Return ONLY valid JSON matching this exact schema:
{
  "status": "PASS" | "FAIL",
  "studAndHoleCheck": "Concise comparison of exposed stud/hole counts between Image 1 and Image 2",
  "discrepancies": ["List every geometric/position/rotation mismatch, or empty array if PASS"],
  "suggestedFixes": ["Exact LDU coordinate (x, y, z) or 3x3 matrix adjustments needed for specific lines, or empty array if PASS"]
}`;
}

function parseVerdictJson(
  rawText: string,
  params: VerifyStepParams,
  modelUsed: string
): StepVerificationResult {
  const cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned) as {
    status?: string;
    studAndHoleCheck?: string;
    discrepancies?: string[];
    suggestedFixes?: string[];
  };

  return {
    status: parsed.status === "PASS" ? "PASS" : "FAIL",
    stepNumber: params.stepNumber,
    activeModelScope: params.activeModelScope,
    isIsolatedSubbuild: params.isIsolatedSubbuild,
    studAndHoleCheck: parsed.studAndHoleCheck || "",
    discrepancies: Array.isArray(parsed.discrepancies) ? parsed.discrepancies : [],
    suggestedFixes: Array.isArray(parsed.suggestedFixes) ? parsed.suggestedFixes : [],
    modelUsed,
  };
}

export async function verifyStepWithVision(
  params: VerifyStepParams
): Promise<StepVerificationResult> {
  const cfg = resolveVisionConfig(params.config);
  if (!cfg.provider || !cfg.apiKey) {
    throw new Error(
      "No vision verifier API key configured. Set GEMINI_API_KEY (or OPENAI_API_KEY with LDRAW_VISION_PROVIDER=openai), or use `ldraw_render_step` to visually inspect steps directly with your host model."
    );
  }

  const prompt = buildQaPrompt(params);
  const instrMime = params.instructionMimeType || "image/png";

  if (cfg.provider === "openai") {
    throwIfAborted(params.signal);
    const endpoint = `${(cfg.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      signal: params.signal,
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:${instrMime};base64,${params.instructionImageBuffer.toString("base64")}`,
                },
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${params.renderedPngBuffer.toString("base64")}`,
                },
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI-compatible vision API HTTP ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawText = data.choices?.[0]?.message?.content || "";
    return parseVerdictJson(rawText, params, cfg.model);
  }

  // Gemini REST API
  const candidateModels = [...new Set([cfg.model, "gemini-2.5-flash", "gemini-2.5-pro"])];
  let lastErr = "";

  for (const modelName of candidateModels) {
    throwIfAborted(params.signal);
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": cfg.apiKey,
        },
        signal: params.signal,
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inline_data: {
                    mime_type: instrMime,
                    data: params.instructionImageBuffer.toString("base64"),
                  },
                },
                {
                  inline_data: {
                    mime_type: "image/png",
                    data: params.renderedPngBuffer.toString("base64"),
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
          },
        }),
      });

      if (!res.ok) {
        lastErr = `${modelName} HTTP ${res.status}: ${await res.text()}`;
        continue;
      }

      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return parseVerdictJson(rawText, params, modelName);
    } catch (err) {
      throwIfAborted(params.signal);
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }

  throw new Error(`All Gemini vision verifier models failed. Last error: ${lastErr}`);
}
