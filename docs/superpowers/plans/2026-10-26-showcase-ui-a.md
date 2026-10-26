# Showcase UI A Implementation Plan

**Goal:** Implement the approved light, compact library design with readable typography and CSS project artwork.

**Architecture:** Keep static HTML, CSS and the existing DOM rendering. Preserve GitHub authorization, upload, deletion, saved connections and deployment checks. No external assets or dependencies.

**Spec:** User approved direction A and the layout/flow in the conversation on 2026-10-26.

## Tasks
- [x] Back up existing source and adjust layout.css: content width near 1200px, compact sidebar, responsive 3/2/1 card columns.
- [x] Adjust app.css typography, colors, controls, dialogs and job states.
- [x] Adjust only card presentation in app.js: decorative browser artwork, initials, slug, clear actions and dates.
- [x] Verify desktop and mobile fixture UI, keyboard/dialog behavior, existing tests, build and diff check.

## Constraints and acceptance
- Keep Vietnamese copy and existing identifiers/events needed by application logic.
- Do not infer deployed state for older projects without recorded confirmation.
- No real preview iframe or thumbnail service in the admin page.
- Long project names and slugs must fit without page overflow.
- Controls remain visible and usable on touch screens, keyboard focus remains visible.
- No commit, push or deployment in this implementation scope.

## Verification
- Existing 47 tests pass; static Pages build passes.
- Fixture browser: desktop 3 columns, 900px tablet 2 columns, 390px mobile 1 column.
- 320px connection guide (both expanded), upload and delete dialogs have scrollWidth equal to clientWidth; Escape closes dialogs.
- Independent review identified long guide-button overflow; corrected wrapping and verified at 320px.
- Screenshots saved in task outputs. Browser uses disposable fixture token and in-memory GitHub, not a real PAT or production deployment.
