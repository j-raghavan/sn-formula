# Formula Plugin for Supernote

> # 🚧 WORK IN PROGRESS — DO NOT INSTALL 🚧
>
> **Status:** Phase-1 spike complete · v1 path under redesign
>
> This plugin is **not ready for end-users**. The current build can crash the
> Supernote host window state, drop pen input until reboot, and produce
> incorrect typeset output for anything beyond simple linear equations.
>
> Built-in Chauvet OCR turned out to be a single-line prose recognizer with
> no model of math layout — fractions, super/subscripts, summation,
> integrals, chemistry, and Greek-as-math all fail. We're scoping a v2 that
> bundles an offline math-OCR model with a verification UX. Until that lands,
> **expect bugs, breakage, and missing features.**
>
> Track progress: see commit history on `feat/mvp`. File issues with logs.

---

![Tests](https://img.shields.io/badge/tests-38%20passed-brightgreen)
![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)
![Lint](https://img.shields.io/badge/lint-passing-brightgreen)
![Platform](https://img.shields.io/badge/platform-Supernote-blue)
![Status](https://img.shields.io/badge/status-WIP--not--ready-orange)
![License](https://img.shields.io/badge/license-MIT-blue)

A Supernote plugin that adds a **Formula** option to the lasso menu. Lasso
handwritten math, tap *Formula*, and the strokes are replaced with typeset
text in place.

## What works today (Phase-1 spike)

- Type-2 lasso button registers cleanly with an icon.
- End-to-end pipeline: capture lasso → delete strokes → recognize → insert
  typeset text → close plugin host overlay.
- Width-bounded font sizing so output doesn't wrap inside the rect.
- Reentrancy guard, lifecycle cleanup, plugin-view release on every tap.
- 38 unit tests, 100% coverage on the orchestrator.

## What does NOT work today

| Input | Outcome |
|---|---|
| Single-line algebra (`2x+3=7`) | ✅ Works |
| Stacked fractions (`(a+b)/c`) | ❌ Recognizer flattens to gibberish |
| Summation / integral notation (`Σᵢ₌₁ⁿ xᵢ²`) | ❌ Sub/superscripts lost |
| Chemistry (`H₂SO₄ + 2NaOH`) | ❌ Subscripts read as letters (`Has 04+2 NaOH`) |
| Prose with inline math (`x² = 25`) | ❌ Even simple superscripts corrupt |

The plugin scaffolding is sound. The blocker is the recognition engine
itself — the built-in OCR is not a math recognizer.

## Roadmap (proposed)

- **v2**: bundled offline math-OCR model (pix2tex / MyScript SDK), preview-and-accept
  verification UX so user-acceptance rate hits ≥99%, LaTeX → Unicode for simple
  formulas + LaTeX → image fallback for complex layouts.

## Building

This repo is for plugin developers, not end-users. To build:

```bash
npm install
./buildPlugin.sh
```

Output: `sn-formula.snplg` for sideload. Do not distribute.

## License

MIT
