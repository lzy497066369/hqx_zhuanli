# Patent generation data flow (updated 2026-10-12)

## Current product workflow

`src/App.tsx` mounts `ProductWorkflowWorkspace` for product inventions and utility patents. `UtilityNaming` saves the selected name and structure evidence; `createProductWorkflow` builds the initial selection.

The browser calls `/api/product/*` through `progressRequest`. `server/index.ts` mounts `createAiMiddleware`, which dispatches requests to `createProductWorkflowService` in `server/productWorkflowAi.ts`.

1. Review checks every selected feature and returns explicit conflict resolutions.
2. Brief produces the product description from the reviewed selection.
3. Preview generates four separate images from that same brief.
4. Explicit confirmation binds the current brief and all four preview images.
5. CAD produces one restricted FreeCAD script and a mesh, then projects four SVG views from the same model. Part identifiers are checked against the brief.
6. Materials use the confirmed brief and actual figure catalogue.
7. `createProductWordBlob` checks version bindings and image digests, then exports the document, figures and generation records.

`server/productProof.ts` signs intermediate artifacts. `productWorkflow.ts` validates persisted data and current-version conditions. Projects are stored in the browser through `projectStorage.ts`; they are not shared between users.

See [product-workflow.md](product-workflow.md) for behavior and validation commands.

## Retained structure APIs and historical projects

The old structure workspace components have been removed. Structure compilation, research and Materials V2 APIs remain mounted by `createAiMiddleware` for protocol compatibility. `server/materialsV2Api.ts` invokes `documentGenerationV2.ts`, which generates, reviews, fixes, polishes and validates documents against a confirmed generation context.

`src/data.ts` still validates historical structure-based project data. Existing invention exports in `App.tsx` use historical Word exporters when the saved project has no product workflow. Keep those validation and rendering modules until historical data support is deliberately retired.

## Evidence and version boundaries

AI-selected structure evidence is user-adopted input, not independently verified prior-art evidence. Research evidence must satisfy its source and excerpt checks. Model-generated dimensions describe a design rather than a physical measurement.

Document validation and export must use the same confirmed model or product brief version as their figures. Old artifacts must not authorize export after the source selection changes. Research, compilation and historical Word checks remain covered by protocol and compatibility tests; the current product UI is covered by `tests/product-workflow-ui.spec.ts`.
