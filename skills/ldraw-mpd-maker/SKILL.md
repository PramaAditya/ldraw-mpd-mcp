---
name: ldraw-mpd-maker
description: Build 100% offline-ready LEGO LDraw Multi-Part Document (.mpd) 3D models step-by-step from instruction images using the ldraw-mpd-mcp server.
---

# ldraw-mpd-maker

Use this skill whenever the user asks to generate, reconstruct, verify, or pack an LDraw `.ldr` or `.mpd` 3D LEGO model from step-by-step instruction images.

## 1. MCP Tools (`ldraw-mpd-mcp`)

| Tool | Purpose | When to Use |
| :--- | :--- | :--- |
| `ldraw_library_status` | Verify the active `LDRAW_DIR`, color table, custom catalog, and vision verifier config. | At the start of a session if setup has not been confirmed. |
| `ldraw_lookup_part` | Search the configured set BOM catalog (`LDRAW_CATALOG_PATH`) or the full local LDraw parts library (`parts.lst` / `parts/*.dat`). | At the start of a step to identify `.dat` filenames for new parts in the callout box. |
| `ldraw_inspect_part` | Render a single `.dat` part with a given `colorCode` and 3×3 `matrix` plus `+X` (Red), `-Y Up` (Green), and `+Z` (Blue) axis arrows and its transformed LDU bounding box. | Before placing any asymmetric part (slopes, brackets, L-beams, gears, hinges, electronics) to verify local origin and orientation. |
| `ldraw_verify_step` | Independent Vision QA judge comparing `stepNumber` against `instructionImagePath`. Returns compact JSON (zero images) on `PASS`, or LDU discrepancies + side-by-side PNG on `FAIL`. | After every single step (`Step 1` .. `Step N`) when a vision API key is configured. |
| `ldraw_render_step` | Render a specific `stepNumber` (optionally stitched side-by-side with `instructionImagePath`) and return the PNG directly. | When visually debugging a placement, checking axes, or verifying steps directly with the host multimodal model. |
| `ldraw_pack_mpd` | Bundle the `.ldr` / `.mpd` file with `LDConfig.ldr` (`0 !COLOUR`) and recursively inline all `.dat`, `parts/s/*.dat`, `p/*.dat`, and `p/48/*.dat` dependencies. | After all steps pass verification, to produce a 100% self-contained offline `.mpd` for Three.js `LDrawLoader` or BrickLink Studio. |

## 2. Step-by-Step Workflow

1. **Confirm library:** Call `ldraw_library_status` once if unsure whether `LDRAW_DIR` is ready.
2. **One step at a time:** **NEVER** batch multiple unverified steps in one shot. A single 1-stud (`20 LDU`) error in Step 2 cascades into every subsequent step.
3. **Inspect asymmetric parts first:** Call `ldraw_lookup_part` and `ldraw_inspect_part` before guessing a part's local origin or rotation matrix.
4. **Verify every step:** Loop `Write Step N` -> `ldraw_verify_step` (or `ldraw_render_step` with `instructionImagePath`) -> fix coordinates/matrices until `PASS` -> add `0 STEP` and advance to `Step N+1`.
5. **Pack offline:** Once the final step passes, run `ldraw_pack_mpd`.

## 3. LDraw Coordinate System, Units (LDU), and Matrices

### Units & Axes
- **1 stud spacing (X or Z):** `20 LDU` (half-stud = `10 LDU`).
- **1 plate height (Y):** `8 LDU`.
- **1 standard brick height (Y):** `24 LDU` (`3 plates`).
- **Vertical axis (`-Y` is UP):** LDraw is right-handed with `-Y` pointing **UP** and `+Y` pointing **DOWN**. Stacking a brick on top of a surface at `y = 0` places it at `y = -24`, then `-48`, `-72`, etc.
- **Default isometric camera (`yawDeg = -35`, `pitchDeg = 30`):**
  - `+X` (Red): Down-Right
  - `-X`: Up-Left
  - `+Z` (Blue): Up-Right (back-right)
  - `-Z`: Down-Left (front-left)

### Standard Type-1 Line Format
```text
1 <colorCode> <x> <y> <z> <a> <b> <c> <d> <e> <f> <g> <h> <i> <partFile.dat>
```

### Common 3×3 Rotation Matrices (`a b c d e f g h i`)

| Orientation | Matrix (`a b c d e f g h i`) | Notes |
| :--- | :--- | :--- |
| **Identity (0° Yaw)** | `1 0 0 0 1 0 0 0 1` | Default upright orientation. |
| **+90° Yaw around Y** | `0 0 1 0 1 0 -1 0 0` | Maps `+X -> -Z` and `+Z -> +X`. |
| **180° Yaw around Y** | `-1 0 0 0 1 0 0 0 -1` | Flips `+X -> -X` and `+Z -> -Z`. |
| **-90° (270°) Yaw around Y** | `0 0 -1 0 1 0 1 0 0` | Maps `+X -> +Z` and `+Z -> -X`. |
| **Rotate +Y to +Z (90° around X)** | `1 0 0 0 0 -1 0 1 0` | Common for horizontal axles/gears running along Z. |

Always verify asymmetric parts with `ldraw_inspect_part` rather than assuming their default axis.

## 4. Sub-Build Isolation (`0 FILE <submodel>.ldr` + `step_join.dat`)

When an instruction booklet temporarily hides the main chassis to build a sub-assembly and later attaches it:

```ldraw
0 FILE main.ldr
0 Name: main.ldr
0 !LDRAW_ORG Model

0 // Steps 1..2: Main chassis
1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat
0 STEP

0 // Steps 3..4: Sub-build referenced at its final pose on main.ldr
1 16 40 -24 0 1 0 0 0 1 0 0 0 1 sub_module.ldr
0 STEP

0 // Step 5: Incorporation step (switches focus back to main.ldr + attached sub_module.ldr)
1 16 0 0 0 1 0 0 0 1 0 0 0 1 step_join.dat
0 STEP

0 FILE sub_module.ldr
0 Name: sub_module.ldr
0 !LDRAW_ORG Model
1 14 0 0 0 1 0 0 0 1 0 0 0 1 3020.dat
0 STEP
1 15 0 -8 0 1 0 0 0 1 0 0 0 1 3023.dat
```

- On steps belonging exclusively to `sub_module.ldr`, `isolateSubmodels: true` hides `main.ldr` and renders `sub_module.ldr` in local space.
- On the `step_join.dat` step, focus returns to `main.ldr` with `sub_module.ldr` attached.
- `ldraw_pack_mpd` automatically embeds a minimal `step_join.dat` marker so Three.js `LDrawLoader` preserves step counts offline.

## 5. Additive Seated Rule for Insertion Arrows

Instruction pages often show bricks, pins, axles, or gears mid-slide with an insertion arrow. Because `.ldr` / `.mpd` is strictly additive (parts placed in Step `N` cannot translate in Step `N+1`), always place each part at its **fully seated destination coordinate** on the step where it is introduced.
