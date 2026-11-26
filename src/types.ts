export interface BBox3D {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface BBox3DWithSize extends BBox3D {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
}

export interface ColorInfo {
  code: number;
  name: string;
  rgb: [number, number, number];
  edgeRgb: [number, number, number];
  alpha: number;
}

export interface CatalogEntry {
  elementId?: string;
  designId?: string;
  blItemNo?: string;
  qty?: number;
  colour?: string;
  ldrawColorCode?: number;
  ldrawColorName?: string;
  colorHex?: string;
  category?: string;
  elementName?: string;
  ldrawDescription: string;
  datFile: string;
  bbox?: BBox3DWithSize;
  studCount?: number;
  studs?: [number, number, number][];
  holeCount?: number;
  holes?: [number, number, number][];
}

export interface StepPlacementSummary {
  step: number;
  ownerModel: string;
  line: string;
  part: string;
  colorCode: number;
  position: [number, number, number];
  worldBBox: BBox3D;
}

export interface LDrawRenderOptions {
  width?: number;
  height?: number;
  stepNumber?: number;
  showAxes?: boolean;
  yawDeg?: number;
  pitchDeg?: number;
  highlightCurrentStep?: boolean;
  isolateSubmodels?: boolean;
  transparentBackground?: boolean;
  signal?: AbortSignal;
}

export interface LDrawRenderResult {
  pngBuffer: Buffer;
  totalSteps: number;
  activeStep: number;
  activeModelScope: string;
  isIsolatedSubbuild: boolean;
  placements: StepPlacementSummary[];
  overallBBox: BBox3D;
}

export interface PackMpdResult {
  mpdContent: string;
  embeddedCount: number;
  missingParts: string[];
}

export interface StepVerificationResult {
  status: "PASS" | "FAIL";
  stepNumber: number;
  activeModelScope: string;
  isIsolatedSubbuild: boolean;
  studAndHoleCheck: string;
  discrepancies: string[];
  suggestedFixes: string[];
  modelUsed: string;
}

export interface VisionVerifierConfig {
  provider?: "gemini" | "openai";
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export interface LDrawServerConfig {
  ldrawDir?: string;
  catalogPath?: string;
  colorDefPath?: string;
  cwd?: string;
  vision?: VisionVerifierConfig;
}
