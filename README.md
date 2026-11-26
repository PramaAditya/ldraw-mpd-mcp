# ldraw-mpd-mcp

A **zero-native-dependency** [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for building, 3D-rendering, visually verifying, and offline-packing LEGO® LDraw (`.ldr` / `.mpd`) models step-by-step with AI coding agents.

Everything — the Z-buffered 2×-supersampled isometric 3D rasterizer, PNG encoder/decoder/stitcher, DFS building-step engine, sub-build isolator, offline `.mpd` bundler, and official LDraw library installer — runs in pure TypeScript/Node.js with **no Blender, LDView, OpenGL, Python, or native C++ build dependencies**.

---

## Features

- **Pure-TS 3D Software Renderer (`ldraw_render_step`, `ldraw_inspect_part`)** — 2× SSAA Z-buffered rasterizer with edge lines, alpha transparency, optional `+X / -Y Up / +Z` axis gizmos, step-fade highlighting, and side-by-side reference PNG stitching.
- **Exact Three.js `LDrawLoader` Step Order + Sub-Build Isolation** — DFS global step numbering across `0 FILE <submodel>.ldr` blocks with automatic Sub-Build Focus Mode and `step_join.dat` incorporation markers.
- **100% Offline Self-Contained MPD Packer (`ldraw_pack_mpd`)** — Recursively inlines `LDConfig.ldr` `0 !COLOUR` headers and every referenced `.dat`, `parts/s/*.dat`, `p/*.dat`, and `p/48/*.dat` primitive into a single portable `.mpd` file.
- **Generic LDraw Search + Optional Set Catalog (`ldraw_lookup_part`)** — Works out-of-the-box against your entire local LDraw library (`parts.lst` / `parts/*.dat`), and optionally loads a custom JSON BOM catalog (`LDRAW_CATALOG_PATH`) for set-specific builds.
- **Independent Vision QA Judge (`ldraw_verify_step`)** — Optional step-by-step visual QA using Gemini or any OpenAI-compatible vision API. Returns compact JSON only (zero images) on `PASS` to keep agent context clean, and returns LDU discrepancies + a side-by-side PNG on `FAIL`.
- **One-Command Official LDraw Setup (`setup`)** — Automatically downloads and extracts the official LDraw Parts Library (`complete.zip`) from `library.ldraw.org` into `~/.ldraw`, or auto-detects an existing BrickLink Studio 2.0 / LDraw installation.

---

## Quick Start

### 1. Get the LDraw Parts Library (`.dat` files)

This package does **not** bundle `.dat` part files. You have two options:

- **Option A — One-command download from LDraw.org (recommended):**
  ```bash
  npx ldraw-mpd-mcp setup
  # Optional: include unofficial LDraw parts too
  npx ldraw-mpd-mcp setup --unofficial
  ```
  This downloads the official `complete.zip` (~75 MB) from `library.ldraw.org` and extracts it to `~/.ldraw`.

- **Option B — Use an existing BrickLink Studio 2.0 / LDraw install:**
  `ldraw-mpd-mcp` automatically searches `LDRAW_DIR`, `~/.ldraw`, BrickLink Studio 2.0 default directories (`C:/Program Files/Studio 2.0/ldraw`, `/Applications/Studio 2.0/ldraw`), and standard system LDraw paths.

Verify detection anytime with:
```bash
npx ldraw-mpd-mcp doctor
```

### 2. Configure Your MCP Client

Add `ldraw-mpd-mcp` to your MCP client config (Claude Desktop, Cursor, Claude Code, Antigravity, etc.):

```json
{
  "mcpServers": {
    "ldraw-mpd-mcp": {
      "command": "npx",
      "args": ["-y", "ldraw-mpd-mcp"],
      "env": {
        "LDRAW_DIR": "/path/to/your/ldraw",
        "GEMINI_API_KEY": "optional-for-ldraw_verify_step"
      }
    }
  }
}
```

> **Tip:** `LDRAW_DIR` is optional if you ran `npx ldraw-mpd-mcp setup` (installs to `~/.ldraw`) or installed BrickLink Studio 2.0 in its default location. `GEMINI_API_KEY` is only needed if you use `ldraw_verify_step` — the other 5 tools work 100% offline with zero API keys.

---

## MCP Tools

| Tool | Description |
| :--- | :--- |
| `ldraw_library_status` | Reports detected `LDRAW_DIR`, color table source (`LDConfig.ldr`), catalog mode, and vision verifier status. |
| `ldraw_lookup_part` | Searches parts by keyword, colour, or category across a custom set BOM catalog (`LDRAW_CATALOG_PATH`) or the full local LDraw library. |
| `ldraw_inspect_part` | Renders a single `.dat` part at a given color & 3×3 matrix with `+X` (Red), `-Y Up` (Green), and `+Z` (Blue) axis arrows plus its world bounding box in LDU. |
| `ldraw_render_step` | Renders an `.ldr` / `.mpd` file up to `stepNumber` into a 2×-supersampled PNG, optionally stitched side-by-side with a reference instruction PNG. |
| `ldraw_verify_step` | Runs an independent Vision LLM QA check comparing a rendered step against a reference instruction image. Returns text-only JSON on `PASS` or discrepancy diagnostics + side-by-side PNG on `FAIL`. |
| `ldraw_pack_mpd` | Packs an `.ldr` / `.mpd` file with `0 !COLOUR` definitions and all recursively referenced parts/subparts/primitives into a 100% offline `.mpd`. |

---

## Configuration & Environment Variables

| Variable | CLI Flag | Description |
| :--- | :--- | :--- |
| `LDRAW_DIR` | `--ldraw-dir` | Path to local LDraw library containing `parts/`, `p/`, and `LDConfig.ldr`. |
| `LDRAW_CATALOG_PATH` | `--catalog` | Optional path to a custom JSON BOM catalog (array of part objects with `datFile`, `ldrawDescription`, optional `colour`, `ldrawColorCode`, `bbox`, `studs`, `holes`). |
| `GEMINI_API_KEY` | — | API key for `ldraw_verify_step` using Google Gemini (default model: `gemini-2.5-flash`). |
| `OPENAI_API_KEY` | — | API key for `ldraw_verify_step` with OpenAI or any OpenAI-compatible vision endpoint. |
| `LDRAW_VISION_PROVIDER` | — | `gemini` (default) or `openai`. |
| `LDRAW_VISION_MODEL` | — | Override the vision QA model (e.g. `gemini-2.5-pro`, `gpt-4o`). |
| `LDRAW_VISION_BASE_URL` | — | Custom OpenAI-compatible base URL (e.g. LiteLLM, OpenRouter, Ollama). |

---

## Bundled Agent Skill

A ready-to-use agent workflow guide (coordinate conventions, 3×3 rotation matrices, Sub-Build Isolation pattern, and verification loop) is included in [`skills/ldraw-mpd-maker/SKILL.md`](./skills/ldraw-mpd-maker/SKILL.md).

---

## Development

```bash
npm install
npm run build
npm test
```

Run locally against a custom Studio 2.0 library:
```bash
LDRAW_DIR="C:/Program Files/Studio 2.0/ldraw" npm run doctor
```

---

## License & Legal Notice

- **Code:** [MIT License](./LICENSE).
- **LDraw Parts Library:** Parts downloaded via `setup` are sourced directly from [LDraw.org](https://www.ldraw.org/) and are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) by the LDraw.org contributors.
- **Disclaimer:** LEGO® is a trademark of the LEGO Group of companies, which does not sponsor, authorize, or endorse this project. BrickLink® and Studio are trademarks of BrickLink Limited.
