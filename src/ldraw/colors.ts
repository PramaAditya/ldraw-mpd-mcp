import type { ColorInfo } from "../types.js";

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, "").trim();
  if (clean.length < 6) return [200, 200, 200];
  return [
    parseInt(clean.slice(0, 2), 16) || 0,
    parseInt(clean.slice(2, 4), 16) || 0,
    parseInt(clean.slice(4, 6), 16) || 0,
  ];
}

export interface ParsedColorConfig {
  colorTable: Record<number, ColorInfo>;
  colourHeaderLines: string[];
}

const FALLBACK_LDCONFIG_LINES = [
  "0 !COLOUR Black CODE 0 VALUE #1B2A34 EDGE #595959",
  "0 !COLOUR Blue CODE 1 VALUE #0055BF EDGE #333333",
  "0 !COLOUR Green CODE 2 VALUE #257A3E EDGE #333333",
  "0 !COLOUR Dark_Turquoise CODE 3 VALUE #00838F EDGE #333333",
  "0 !COLOUR Red CODE 4 VALUE #C91A09 EDGE #333333",
  "0 !COLOUR Dark_Pink CODE 5 VALUE #C870A0 EDGE #333333",
  "0 !COLOUR Brown CODE 6 VALUE #583927 EDGE #1E1E1E",
  "0 !COLOUR Light_Gray CODE 7 VALUE #9BA19D EDGE #333333",
  "0 !COLOUR Dark_Gray CODE 8 VALUE #6D6E5C EDGE #333333",
  "0 !COLOUR Light_Blue CODE 9 VALUE #B4D2E3 EDGE #333333",
  "0 !COLOUR Bright_Green CODE 10 VALUE #4B9F4A EDGE #333333",
  "0 !COLOUR Light_Turquoise CODE 11 VALUE #55A5AF EDGE #333333",
  "0 !COLOUR Salmon CODE 12 VALUE #F2705E EDGE #333333",
  "0 !COLOUR Pink CODE 13 VALUE #FC97AC EDGE #333333",
  "0 !COLOUR Yellow CODE 14 VALUE #F2CD37 EDGE #333333",
  "0 !COLOUR White CODE 15 VALUE #FFFFFF EDGE #333333",
  "0 !COLOUR Main_Colour CODE 16 VALUE #7F7F7F EDGE #333333",
  "0 !COLOUR Light_Green CODE 17 VALUE #C2DAB8 EDGE #333333",
  "0 !COLOUR Light_Yellow CODE 18 VALUE #FBE696 EDGE #333333",
  "0 !COLOUR Tan CODE 19 VALUE #E4CD9E EDGE #333333",
  "0 !COLOUR Edge_Colour CODE 24 VALUE #7F7F7F EDGE #333333",
  "0 !COLOUR Orange CODE 25 VALUE #FE8A18 EDGE #333333",
  "0 !COLOUR Magenta CODE 26 VALUE #923978 EDGE #333333",
  "0 !COLOUR Lime CODE 27 VALUE #BBE90B EDGE #333333",
  "0 !COLOUR Dark_Tan CODE 28 VALUE #958A73 EDGE #333333",
  "0 !COLOUR Trans_Dark_Blue CODE 33 VALUE #0020A0 EDGE #000B38 ALPHA 128",
  "0 !COLOUR Trans_Green CODE 34 VALUE #237841 EDGE #174F2B ALPHA 128",
  "0 !COLOUR Trans_Red CODE 36 VALUE #C91A09 EDGE #660D05 ALPHA 128",
  "0 !COLOUR Trans_Light_Blue CODE 43 VALUE #AEE9EF EDGE #59C4CF ALPHA 128",
  "0 !COLOUR Trans_Yellow CODE 46 VALUE #F5CD2F EDGE #8E740E ALPHA 128",
  "0 !COLOUR Trans_Clear CODE 47 VALUE #FCFCFC EDGE #C3C3C3 ALPHA 128",
  "0 !COLOUR Reddish_Brown CODE 70 VALUE #582A12 EDGE #333333",
  "0 !COLOUR Light_Bluish_Gray CODE 71 VALUE #A0A5A9 EDGE #333333",
  "0 !COLOUR Dark_Bluish_Gray CODE 72 VALUE #6C6E68 EDGE #333333",
  "0 !COLOUR Bright_Light_Orange CODE 191 VALUE #F8BB3D EDGE #333333",
  "0 !COLOUR Dark_Blue CODE 272 VALUE #0A3463 EDGE #333333",
  "0 !COLOUR Dark_Green CODE 288 VALUE #184632 EDGE #333333",
  "0 !COLOUR Dark_Red CODE 320 VALUE #720E0F EDGE #333333",
  "0 !COLOUR Medium_Azure CODE 322 VALUE #36AEBF EDGE #333333",
];

export function parseLdConfigLines(lines: string[]): ParsedColorConfig {
  const colorTable: Record<number, ColorInfo> = {};
  const colourHeaderLines: string[] = [];

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("0 !COLOUR ")) continue;
    const match = trimmed.match(
      /^0 !COLOUR\s+(\S+)\s+CODE\s+(\d+)\s+VALUE\s+#([0-9A-Fa-f]{6})\s+EDGE\s+#([0-9A-Fa-f]{6})(?:.*?ALPHA\s+(\d+))?/i
    );
    if (!match) continue;
    const code = parseInt(match[2], 10);
    if (Number.isNaN(code)) continue;

    colourHeaderLines.push(trimmed);
    colorTable[code] = {
      code,
      name: match[1],
      rgb: hexToRgb(match[3]),
      edgeRgb: hexToRgb(match[4]),
      alpha: match[5] ? parseInt(match[5], 10) : 255,
    };
  }

  return { colorTable, colourHeaderLines };
}

export function parseStudioColorDefinitions(lines: string[]): ParsedColorConfig {
  const colorTable: Record<number, ColorInfo> = {};
  const colourHeaderLines: string[] = [];

  for (const line of lines.slice(1)) {
    const cols = line.split("\t");
    if (cols.length < 10) continue;
    const code = parseInt(cols[2], 10);
    if (Number.isNaN(code) || code in colorTable) continue;
    const name = (cols[6]?.trim() || cols[4]?.trim() || `Color_${code}`).replace(/\s+/g, "_");
    const hex = cols[8]?.trim() || "#CCCCCC";
    const alphaFloat = parseFloat(cols[9] || "1");
    const alpha = Math.round(Math.min(1, Math.max(0, Number.isNaN(alphaFloat) ? 1 : alphaFloat)) * 255);

    colorTable[code] = {
      code,
      name,
      rgb: hexToRgb(hex),
      edgeRgb: [51, 51, 51],
      alpha,
    };

    const alphaClause = alpha < 255 ? ` ALPHA ${alpha}` : "";
    colourHeaderLines.push(`0 !COLOUR ${name} CODE ${code} VALUE ${hex} EDGE #333333${alphaClause}`);
  }

  return { colorTable, colourHeaderLines };
}

export function getBuiltinFallbackColors(): ParsedColorConfig {
  return parseLdConfigLines(FALLBACK_LDCONFIG_LINES);
}
