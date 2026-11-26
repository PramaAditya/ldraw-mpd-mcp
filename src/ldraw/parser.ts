export const IDENTITY_MAT4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mulMat4(A: number[], B: number[]): number[] {
  const C = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      C[r * 4 + c] =
        A[r * 4 + 0] * B[0 * 4 + c] +
        A[r * 4 + 1] * B[1 * 4 + c] +
        A[r * 4 + 2] * B[2 * 4 + c] +
        A[r * 4 + 3] * B[3 * 4 + c];
    }
  }
  return C;
}

export function transformPt(
  M: number[],
  x: number,
  y: number,
  z: number
): [number, number, number] {
  return [
    +(M[0] * x + M[1] * y + M[2] * z + M[3]).toFixed(2),
    +(M[4] * x + M[5] * y + M[6] * z + M[7]).toFixed(2),
    +(M[8] * x + M[9] * y + M[10] * z + M[11]).toFixed(2),
  ];
}

export interface ParsedMpdDocument {
  mainModelName: string;
  mainLines: string[];
  embedded: Map<string, string[]>;
}

export function parseMpdDocument(ldrText: string, signal?: AbortSignal): ParsedMpdDocument {
  const embedded = new Map<string, string[]>();
  let mainModelName = "main.ldr";
  let mainLines: string[] = [];
  const allLines = ldrText.replace(/\r\n/g, "\n").split("\n");

  if (allLines.some((l) => l.trim().startsWith("0 FILE "))) {
    let curName: string | null = null;
    let buf: string[] = [];
    let isFirst = true;

    const commit = () => {
      if (!curName) return;
      const key = curName.toLowerCase().replace(/\\/g, "/");
      if (isFirst) {
        mainModelName = key;
        mainLines = buf.slice();
        isFirst = false;
      }
      embedded.set(key, buf.slice());
    };

    for (const l of allLines) {
      if (signal?.aborted) throw new Error("LDraw operation aborted.");
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
    mainLines = allLines;
    embedded.set(mainModelName, mainLines);
  }

  return { mainModelName, mainLines, embedded };
}

export interface StepNode {
  step: number;
  ownerModel: string;
  line: string;
  subFile: string;
  colorCode: number;
  tx: number;
  ty: number;
  tz: number;
  localMatrix: number[];
  worldMatrix: number[];
}

export interface SubmodelStepRange {
  startStep: number;
  endStep: number;
  stepCount: number;
}

export interface CollectedModelSteps {
  stepNodes: StepNode[];
  submodelStepRanges: Map<string, SubmodelStepRange>;
  totalSteps: number;
}

export function isSubmodelFile(embedded: Map<string, string[]>, fileName: string): boolean {
  const clean = fileName.trim().replace(/\\/g, "/").toLowerCase();
  if (!clean.endsWith(".ldr")) return false;
  const lines = embedded.get(clean);
  if (!lines) return false;
  if (lines.some((l) => l.includes("!LDCAD CONTENT") || l.includes("!LDCAD GENERATED"))) {
    return false;
  }
  return true;
}

/**
 * Assigns global 1-based step numbers across `main.ldr` and submodels in exact
 * Three.js LDrawLoader DFS order (`computeBuildingSteps`).
 */
export function collectModelSteps(
  doc: ParsedMpdDocument,
  signal?: AbortSignal
): CollectedModelSteps {
  const stepNodes: StepNode[] = [];
  const submodelStepRanges = new Map<string, SubmodelStepRange>();
  let globalStep = 1;
  let pendingStepIncrement = false;

  const walk = (
    modelName: string,
    lines: string[],
    parentWorldM: number[],
    inheritedCol: number
  ) => {
    for (const rawLine of lines) {
      if (signal?.aborted) throw new Error("LDraw operation aborted.");
      const l = rawLine.trim();
      if (!l) continue;
      if (l === "0 STEP") {
        pendingStepIncrement = true;
        continue;
      }
      if (l.startsWith("0")) continue;

      const t = l.split(/\s+/);
      if (t[0] !== "1" || t.length < 15) continue;

      const rawCol = parseInt(t[1], 10);
      const col = rawCol === 16 ? inheritedCol : rawCol;
      const tx = parseFloat(t[2]);
      const ty = parseFloat(t[3]);
      const tz = parseFloat(t[4]);
      const a = parseFloat(t[5]);
      const b = parseFloat(t[6]);
      const c = parseFloat(t[7]);
      const d = parseFloat(t[8]);
      const e = parseFloat(t[9]);
      const f = parseFloat(t[10]);
      const g = parseFloat(t[11]);
      const h = parseFloat(t[12]);
      const k = parseFloat(t[13]);
      const subFile = t.slice(14).join(" ");
      const cleanSub = subFile.trim().replace(/\\/g, "/").toLowerCase();

      const localM = mulMat4(IDENTITY_MAT4, [a, b, c, tx, d, e, f, ty, g, h, k, tz, 0, 0, 0, 1]);
      const worldM = mulMat4(parentWorldM, localM);

      if (pendingStepIncrement) {
        globalStep++;
        pendingStepIncrement = false;
      }

      if (isSubmodelFile(doc.embedded, cleanSub)) {
        const subLines = doc.embedded.get(cleanSub)!;
        const startStep = globalStep;
        walk(cleanSub, subLines, worldM, col);
        const endStep = globalStep;
        submodelStepRanges.set(cleanSub, {
          startStep,
          endStep,
          stepCount: endStep - startStep + 1,
        });
      } else {
        stepNodes.push({
          step: globalStep,
          ownerModel: modelName,
          line: l,
          subFile,
          colorCode: col,
          tx,
          ty,
          tz,
          localMatrix: localM,
          worldMatrix: worldM,
        });
      }
    }
  };

  walk(doc.mainModelName, doc.mainLines, IDENTITY_MAT4, 15);
  return {
    stepNodes,
    submodelStepRanges,
    totalSteps: Math.max(1, globalStep),
  };
}
