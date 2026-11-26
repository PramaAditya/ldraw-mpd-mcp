# Contributing to ldraw-mpd-mcp

Contributions are welcome! Whether it's fixing a renderer edge case, improving LDraw part resolution, or adding tests, please follow these steps:

## Local Setup

```bash
git clone https://github.com/PramaAditya/ldraw-mpd-mcp.git
cd ldraw-mpd-mcp
npm install
npm run typecheck
npm test
```

All unit and end-to-end MCP tests use synthetic temporary LDraw fixtures, so you do **not** need an external BrickLink Studio or LDraw installation just to run the test suite.

## Guidelines

- **Keep zero native dependencies:** The core renderer, PNG codec, ZIP extractor, and MPD packer should remain pure TypeScript/Node.js so `npx ldraw-mpd-mcp` works everywhere without native builds.
- **Do not commit `.dat` part files or LEGO® copyrighted assets:** Tests should use minimal synthetic geometry fixtures.
- **Preserve LF line endings:** `.gitattributes` enforces LF so `dist/cli.js` works across Linux, macOS, and Windows.
- **Add tests for behavior changes:** Add coverage in `tests/ldraw.test.ts` or `tests/server.test.ts`.

## Releasing (Maintainers)

1. Bump `version` in `package.json` and update `CHANGELOG.md` (and `SERVER_VERSION` in `src/server.ts`).
2. Run `npm run prepublishOnly`.
3. Commit and push an annotated tag matching `package.json` (e.g., `git tag v0.1.0 && git push origin v0.1.0`).
4. GitHub Actions (`Release` workflow) will run verification, publish to npm with `--provenance`, and create a GitHub Release with the `.tgz` tarball.
