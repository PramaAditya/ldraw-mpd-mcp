import type {
  BBox3D,
  LDrawRenderOptions,
  LDrawRenderResult,
  StepPlacementSummary,
} from "../types.js";
import type { LDrawLibrary } from "./library.js";
import { collectModelSteps, mulMat4, parseMpdDocument, transformPt } from "./parser.js";
import { encodePngRGBA } from "./png.js";

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("LDraw operation aborted.");
}

interface Tri {
  p1: [number, number, number];
  p2: [number, number, number];
  p3: [number, number, number];
  rgb: [number, number, number];
  alpha: number;
  step: number;
}

interface Edge {
  p1: [number, number, number];
  p2: [number, number, number];
  rgb: [number, number, number];
  step: number;
}

/**
 * Pure-TypeScript 2x-supersampled Z-buffered LDraw software renderer with:
 * - Three.js LDrawLoader DFS step numbering
 * - Sub-Build Isolation (`0 FILE <submodel>.ldr` + `step_join.dat`)
 * - World bounding-box analysis per part and overall assembly
 */
export function renderLDrawToPngAndAnalyze(
  library: LDrawLibrary,
  ldrText: string,
  options: LDrawRenderOptions = {}
): LDrawRenderResult {
  const colorTable = library.getColorTable();
  const outW = options.width || 720;
  const outH = options.height || 540;
  const ss = 2;
  const W = outW * ss;
  const H = outH * ss;
  const showAxes = options.showAxes ?? true;
  const yawDeg = options.yawDeg ?? -35;
  const pitchDeg = options.pitchDeg ?? 30;
  const highlightCurrentStep = options.highlightCurrentStep ?? false;
  const isolateSubmodels = options.isolateSubmodels ?? true;
  const transparentBackground = options.transparentBackground ?? false;

  const doc = parseMpdDocument(ldrText, options.signal);
  const { stepNodes, submodelStepRanges, totalSteps } = collectModelSteps(doc, options.signal);
  const targetStep = options.stepNumber
    ? Math.min(Math.max(1, options.stepNumber), totalSteps)
    : totalSteps;

  const activeStepNodes = stepNodes.filter((n) => n.step === targetStep);
  let activeModelScope = doc.mainModelName;
  let isIsolatedSubbuild = false;

  if (
    isolateSubmodels &&
    activeStepNodes.length > 0 &&
    activeStepNodes.every((n) => n.ownerModel !== doc.mainModelName)
  ) {
    const candidateSub = activeStepNodes[0].ownerModel;
    const range = submodelStepRanges.get(candidateSub);
    if (range && range.stepCount >= 1) {
      activeModelScope = candidateSub;
      isIsolatedSubbuild = true;
    }
  }

  const tris: Tri[] = [];
  const edges: Edge[] = [];
  const placements: StepPlacementSummary[] = [];

  const resolveColor = (code: number, inheritedColor: number): number => {
    if (code === 16) return inheritedColor;
    if (code === 24) {
      return colorTable[inheritedColor] ? -(inheritedColor + 10000) : 24;
    }
    return code;
  };

  const getRgb = (code: number, isEdge = false): [number, number, number] => {
    if (code < -9999) {
      const orig = -(code + 10000);
      return colorTable[orig]?.edgeRgb || [40, 40, 40];
    }
    const c = colorTable[code];
    if (!c) return isEdge ? [40, 40, 40] : [200, 200, 200];
    return isEdge ? c.edgeRgb : c.rgb;
  };

  const getLinesForFile = (fileName: string): string[] | null => {
    const clean = fileName.trim().replace(/\\/g, "/").toLowerCase();
    if (clean === "step_join.dat") return ["0 !LDRAW_ORG Part"];
    if (doc.embedded.has(clean)) return doc.embedded.get(clean)!;
    if (clean.startsWith("s/") && doc.embedded.has(`parts/${clean}`)) {
      return doc.embedded.get(`parts/${clean}`)!;
    }
    if (clean.startsWith("48/") && doc.embedded.has(`p/${clean}`)) {
      return doc.embedded.get(`p/${clean}`)!;
    }
    return library.readPartLines(fileName);
  };

  const walkGeometry = (
    lines: string[] | null,
    M: number[],
    inheritedCol: number,
    stepNum: number,
    depth: number,
    partBBox: BBox3D
  ) => {
    if (depth > 14 || !lines) return;
    const expandBBox = (pt: [number, number, number]) => {
      if (pt[0] < partBBox.minX) partBBox.minX = pt[0];
      if (pt[1] < partBBox.minY) partBBox.minY = pt[1];
      if (pt[2] < partBBox.minZ) partBBox.minZ = pt[2];
      if (pt[0] > partBBox.maxX) partBBox.maxX = pt[0];
      if (pt[1] > partBBox.maxY) partBBox.maxY = pt[1];
      if (pt[2] > partBBox.maxZ) partBBox.maxZ = pt[2];
    };

    for (const rawLine of lines) {
      throwIfAborted(options.signal);
      const l = rawLine.trim();
      if (!l || l.startsWith("0")) continue;
      const t = l.split(/\s+/);
      const type = t[0];
      const rawCol = parseInt(t[1], 10);
      const col = resolveColor(rawCol, inheritedCol);

      if (type === "1" && t.length >= 15) {
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
        const childM = [a, b, c, tx, d, e, f, ty, g, h, k, tz, 0, 0, 0, 1];
        walkGeometry(
          getLinesForFile(subFile),
          mulMat4(M, childM),
          col,
          stepNum,
          depth + 1,
          partBBox
        );
      } else if (type === "2" && t.length >= 8) {
        const p1 = transformPt(M, parseFloat(t[2]), parseFloat(t[3]), parseFloat(t[4]));
        const p2 = transformPt(M, parseFloat(t[5]), parseFloat(t[6]), parseFloat(t[7]));
        expandBBox(p1);
        expandBBox(p2);
        edges.push({ p1, p2, rgb: getRgb(col, true), step: stepNum });
      } else if (type === "3" && t.length >= 11) {
        const p1 = transformPt(M, parseFloat(t[2]), parseFloat(t[3]), parseFloat(t[4]));
        const p2 = transformPt(M, parseFloat(t[5]), parseFloat(t[6]), parseFloat(t[7]));
        const p3 = transformPt(M, parseFloat(t[8]), parseFloat(t[9]), parseFloat(t[10]));
        expandBBox(p1);
        expandBBox(p2);
        expandBBox(p3);
        tris.push({
          p1,
          p2,
          p3,
          rgb: getRgb(col, false),
          alpha: colorTable[col]?.alpha ?? 255,
          step: stepNum,
        });
      } else if (type === "4" && t.length >= 14) {
        const p1 = transformPt(M, parseFloat(t[2]), parseFloat(t[3]), parseFloat(t[4]));
        const p2 = transformPt(M, parseFloat(t[5]), parseFloat(t[6]), parseFloat(t[7]));
        const p3 = transformPt(M, parseFloat(t[8]), parseFloat(t[9]), parseFloat(t[10]));
        const p4 = transformPt(M, parseFloat(t[11]), parseFloat(t[12]), parseFloat(t[13]));
        expandBBox(p1);
        expandBBox(p2);
        expandBBox(p3);
        expandBBox(p4);
        const rgb = getRgb(col, false);
        const alpha = colorTable[col]?.alpha ?? 255;
        tris.push({ p1, p2, p3, rgb, alpha, step: stepNum });
        tris.push({ p1, p2: p3, p3: p4, rgb, alpha, step: stepNum });
      }
    }
  };

  for (const node of stepNodes) {
    throwIfAborted(options.signal);
    if (node.step > targetStep) continue;
    if (isIsolatedSubbuild && node.ownerModel !== activeModelScope) continue;

    const M = isIsolatedSubbuild ? node.localMatrix : node.worldMatrix;
    const bbox: BBox3D = {
      minX: Infinity,
      minY: Infinity,
      minZ: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
      maxZ: -Infinity,
    };
    walkGeometry(getLinesForFile(node.subFile), M, node.colorCode, node.step, 1, bbox);
    placements.push({
      step: node.step,
      ownerModel: node.ownerModel,
      line: node.line,
      part: node.subFile,
      colorCode: node.colorCode,
      position: [node.tx, node.ty, node.tz],
      worldBBox: bbox,
    });
  }

  let wMinX = Infinity;
  let wMinY = Infinity;
  let wMinZ = Infinity;
  let wMaxX = -Infinity;
  let wMaxY = -Infinity;
  let wMaxZ = -Infinity;

  for (const t of tris) {
    for (const p of [t.p1, t.p2, t.p3]) {
      if (p[0] < wMinX) wMinX = p[0];
      if (p[1] < wMinY) wMinY = p[1];
      if (p[2] < wMinZ) wMinZ = p[2];
      if (p[0] > wMaxX) wMaxX = p[0];
      if (p[1] > wMaxY) wMaxY = p[1];
      if (p[2] > wMaxZ) wMaxZ = p[2];
    }
  }

  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);

  const projectVec = ([x, y, z]: [number, number, number]): [number, number, number] => {
    const x1 = x * cy - z * sy;
    const z1 = x * sy + z * cy;
    const sx = x1;
    const syScreen = y * cp - z1 * sp;
    const szDepth = y * sp + z1 * cp;
    return [sx, syScreen, szDepth];
  };

  let minSX = Infinity;
  let minSY = Infinity;
  let maxSX = -Infinity;
  let maxSY = -Infinity;

  for (const t of tris) {
    for (const p of [t.p1, t.p2, t.p3]) {
      const [sx, syScreen] = projectVec(p);
      if (sx < minSX) minSX = sx;
      if (syScreen < minSY) minSY = syScreen;
      if (sx > maxSX) maxSX = sx;
      if (syScreen > maxSY) maxSY = syScreen;
    }
  }

  if (!Number.isFinite(minSX)) {
    minSX = -50;
    maxSX = 50;
    minSY = -50;
    maxSY = 50;
  }

  const pad = showAxes ? 0.72 : 0.84;
  const spanX = Math.max(maxSX - minSX, 20);
  const spanY = Math.max(maxSY - minSY, 20);
  const scale = Math.min((W * pad) / spanX, (H * pad) / spanY);
  const cxWorld = (minSX + maxSX) / 2;
  const cyWorld = (minSY + maxSY) / 2;

  const toScreen = (pt: [number, number, number]): [number, number, number] => {
    const [sx, syScreen, sz] = projectVec(pt);
    return [(sx - cxWorld) * scale + W / 2, (syScreen - cyWorld) * scale + H / 2, sz];
  };

  const rgba = Buffer.alloc(W * H * 4, transparentBackground ? 0 : 255);
  const zbuf = new Float32Array(W * H).fill(Infinity);
  const lx = -0.45;
  const ly = -0.75;
  const lz = -0.48;

  for (const t of tris) {
    throwIfAborted(options.signal);
    const ux = t.p2[0] - t.p1[0];
    const uy = t.p2[1] - t.p1[1];
    const uz = t.p2[2] - t.p1[2];
    const vx = t.p3[0] - t.p1[0];
    const vy = t.p3[1] - t.p1[1];
    const vz = t.p3[2] - t.p1[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    nx /= nlen;
    ny /= nlen;
    nz /= nlen;
    const dot = Math.abs(nx * lx + ny * ly + nz * lz);
    const shade = 0.68 + 0.35 * dot;
    let r = Math.min(255, Math.round(t.rgb[0] * shade));
    let g = Math.min(255, Math.round(t.rgb[1] * shade));
    let b = Math.min(255, Math.round(t.rgb[2] * shade));

    if (highlightCurrentStep && totalSteps > 1 && t.step < targetStep) {
      r = Math.round(r * 0.55 + 255 * 0.45);
      g = Math.round(g * 0.55 + 255 * 0.45);
      b = Math.round(b * 0.55 + 255 * 0.45);
    }

    const v1 = toScreen(t.p1);
    const v2 = toScreen(t.p2);
    const v3 = toScreen(t.p3);

    const x0 = Math.max(0, Math.floor(Math.min(v1[0], v2[0], v3[0])));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(v1[0], v2[0], v3[0])));
    const y0 = Math.max(0, Math.floor(Math.min(v1[1], v2[1], v3[1])));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(v1[1], v2[1], v3[1])));

    const denom = (v2[1] - v3[1]) * (v1[0] - v3[0]) + (v3[0] - v2[0]) * (v1[1] - v3[1]);
    if (Math.abs(denom) < 1e-5) continue;
    const invDenom = 1 / denom;

    for (let py = y0; py <= y1; py++) {
      throwIfAborted(options.signal);
      for (let px = x0; px <= x1; px++) {
        const w1 = ((v2[1] - v3[1]) * (px - v3[0]) + (v3[0] - v2[0]) * (py - v3[1])) * invDenom;
        const w2 = ((v3[1] - v1[1]) * (px - v3[0]) + (v1[0] - v3[0]) * (py - v3[1])) * invDenom;
        const w3 = 1 - w1 - w2;
        if (w1 >= -1e-4 && w2 >= -1e-4 && w3 >= -1e-4) {
          const z = w1 * v1[2] + w2 * v2[2] + w3 * v3[2];
          const idx = py * W + px;
          if (z < zbuf[idx]) {
            zbuf[idx] = z;
            const pIdx = idx * 4;
            if (t.alpha < 255) {
              const a = t.alpha / 255;
              const bgR = rgba[pIdx + 3] > 0 ? rgba[pIdx] : 255;
              const bgG = rgba[pIdx + 3] > 0 ? rgba[pIdx + 1] : 255;
              const bgB = rgba[pIdx + 3] > 0 ? rgba[pIdx + 2] : 255;
              rgba[pIdx] = Math.round(r * a + bgR * (1 - a));
              rgba[pIdx + 1] = Math.round(g * a + bgG * (1 - a));
              rgba[pIdx + 2] = Math.round(b * a + bgB * (1 - a));
              rgba[pIdx + 3] = Math.max(rgba[pIdx + 3], t.alpha);
            } else {
              rgba[pIdx] = r;
              rgba[pIdx + 1] = g;
              rgba[pIdx + 2] = b;
              rgba[pIdx + 3] = 255;
            }
          }
        }
      }
    }
  }

  const drawLine3D = (
    p1: [number, number, number],
    p2: [number, number, number],
    rgb: [number, number, number],
    thickness = 2,
    ignoreZ = false
  ) => {
    const s1 = toScreen(p1);
    const s2 = toScreen(p2);
    const dx = s2[0] - s1[0];
    const dy = s2[1] - s1[1];
    const steps = Math.max(Math.ceil(Math.hypot(dx, dy)), 1);
    for (let i = 0; i <= steps; i++) {
      const frac = i / steps;
      const x = Math.round(s1[0] + dx * frac);
      const y = Math.round(s1[1] + dy * frac);
      const z = s1[2] + (s2[2] - s1[2]) * frac - 1.5;
      for (let oy = -thickness + 1; oy < thickness; oy++) {
        for (let ox = -thickness + 1; ox < thickness; ox++) {
          const px = x + ox;
          const py = y + oy;
          if (px >= 0 && px < W && py >= 0 && py < H) {
            const idx = py * W + px;
            if (ignoreZ || z <= zbuf[idx]) {
              const pIdx = idx * 4;
              rgba[pIdx] = rgb[0];
              rgba[pIdx + 1] = rgb[1];
              rgba[pIdx + 2] = rgb[2];
              rgba[pIdx + 3] = 255;
            }
          }
        }
      }
    }
  };

  for (const e of edges) {
    throwIfAborted(options.signal);
    drawLine3D(e.p1, e.p2, e.rgb, 2, false);
  }

  if (showAxes) {
    drawLine3D([0, 0, 0], [80, 0, 0], [220, 38, 38], 3, true); // +X Red
    drawLine3D([0, 0, 0], [0, -80, 0], [22, 163, 74], 3, true); // -Y (Up) Green
    drawLine3D([0, 0, 0], [0, 0, 80], [37, 99, 235], 3, true); // +Z Blue
  }

  const finalRgba = Buffer.alloc(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    throwIfAborted(options.signal);
    for (let x = 0; x < outW; x++) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      for (let sy2 = 0; sy2 < ss; sy2++) {
        for (let sx2 = 0; sx2 < ss; sx2++) {
          const idx = ((y * ss + sy2) * W + (x * ss + sx2)) * 4;
          const a = rgba[idx + 3];
          sumR += rgba[idx] * a;
          sumG += rgba[idx + 1] * a;
          sumB += rgba[idx + 2] * a;
          sumA += a;
        }
      }
      const oIdx = (y * outW + x) * 4;
      if (sumA > 0) {
        finalRgba[oIdx] = Math.round(sumR / sumA);
        finalRgba[oIdx + 1] = Math.round(sumG / sumA);
        finalRgba[oIdx + 2] = Math.round(sumB / sumA);
        finalRgba[oIdx + 3] = transparentBackground ? Math.round(sumA / (ss * ss)) : 255;
      } else {
        finalRgba[oIdx] = transparentBackground ? 0 : 255;
        finalRgba[oIdx + 1] = transparentBackground ? 0 : 255;
        finalRgba[oIdx + 2] = transparentBackground ? 0 : 255;
        finalRgba[oIdx + 3] = transparentBackground ? 0 : 255;
      }
    }
  }

  const normalizeCoord = (n: number) => (Number.isFinite(n) ? +n.toFixed(1) : 0);

  return {
    pngBuffer: encodePngRGBA(outW, outH, finalRgba, options.signal),
    totalSteps,
    activeStep: targetStep,
    activeModelScope,
    isIsolatedSubbuild,
    placements: placements.filter((p) => p.step === targetStep),
    overallBBox: {
      minX: normalizeCoord(wMinX),
      minY: normalizeCoord(wMinY),
      minZ: normalizeCoord(wMinZ),
      maxX: normalizeCoord(wMaxX),
      maxY: normalizeCoord(wMaxY),
      maxZ: normalizeCoord(wMaxZ),
    },
  };
}
