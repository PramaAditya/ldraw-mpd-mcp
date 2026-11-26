# Changelog

All notable changes to `ldraw-mpd-mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [0.1.1] - 2026-11-26

### Changed
- Switched release pipeline to tokenless npm OIDC Trusted Publishing on Node 24.

## [0.1.0] - 2026-11-26

### Added
- Initial open-source release of `ldraw-mpd-mcp` (zero-native-dependency pure TypeScript MCP server).
- Six MCP tools: `ldraw_library_status`, `ldraw_lookup_part`, `ldraw_inspect_part`, `ldraw_render_step`, `ldraw_verify_step`, and `ldraw_pack_mpd`.
- Pure-TypeScript 2×-supersampled Z-buffered isometric software renderer with edge lines, transparency, and `+X / -Y Up / +Z` axis gizmos.
- Exact Three.js `LDrawLoader` DFS step numbering with Sub-Build Isolation (`0 FILE <submodel>.ldr` + `step_join.dat`).
- Recursive 100% offline `.mpd` bundler with `LDConfig.ldr` `0 !COLOUR` header injection.
- Cross-platform LDraw auto-detection (`LDRAW_DIR`, `~/.ldraw`, BrickLink Studio 2.0, standard LDraw paths) and pure-Node `setup` CLI (`complete.zip` + `--unofficial`) with Zip-Slip protection.
- Generic local LDraw library search (`parts.lst` / `parts/*.dat`) plus optional custom set BOM catalog (`LDRAW_CATALOG_PATH`).
- Configurable Vision QA verifier supporting Google Gemini and OpenAI-compatible vision APIs.
- Generic agent workflow skill in `skills/ldraw-mpd-maker/SKILL.md`.
- Cross-platform GitHub Actions CI (`ubuntu`, `macos`, `windows` × Node `20`, `22`), security audit, and tag-driven npm provenance release workflow.
