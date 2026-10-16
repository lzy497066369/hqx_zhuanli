# Patent generation data flow (updated 2026-10-14)

## Current product workflow

`src/App.tsx` mounts `ProductWorkflowWorkspace` for product inventions and utility patents. `UtilityNaming` saves the selected name and structure evidence; `createProductWorkflow` builds the initial selection.

The browser calls `/api/product/*` through `progressRequest`. `server/index.ts` mounts `createAiMiddleware`, which dispatches requests to `createProductWorkflowService` in `server/productWorkflowAi.ts`.

1. Review checks every selected feature and returns explicit conflict resolutions.
2. Structure generates a technical plan and protection hierarchy. Brief reviews it using stable part IDs and original names, freezes the technical source, and derives the existing product-description format. These are automatic internal stages, with persisted checkpoints.
3. Preview generates four separate images from that same brief.
4. Explicit confirmation binds the current brief and all four preview images.
5. CAD produces one restricted FreeCAD script and a mesh, then projects four SVG views from the same model. Part identifiers are checked against the brief.
6. Draft writes claims, specification and abstract from a whitelist of the frozen technical fields. Materials reviews and patches the draft without changing the product, then attaches the existing deterministic figure description. The draft is saved before review for retries.
7. `createProductWordBlob` checks version bindings and image digests, then exports the patent body and figures. Copy/TXT and Word exclude design assumptions, review logs, engineering tasks and product-introduction appendices.

`server/productProof.ts` signs intermediate artifacts. `productWorkflow.ts` validates persisted data and current-version conditions. Projects are stored in the browser through `projectStorage.ts`; they are not shared between users.

Product generation token usage is collected from provider `usage` fields for text, vision/CAD and image calls. Streaming chat requests ask for `stream_options.include_usage`; trailing usage-only chunks are read before completing the request. Each upstream attempt gets one usage record, including validation repairs, fallbacks and failed attempts; cached artifacts do not create new records. Request-local collection keeps parallel image requests and different users isolated.

The API sends separate NDJSON `usage` events (or an encoded `X-AI-Token-Usage` JSON header for non-streaming clients), preserving signed artifact payloads. The product workspace saves deduplicated records in `ProductWorkflow.tokenUsage`, including records received before an error, and displays their cumulative total and available input/output counts above the generation steps. Redraws and retries accumulate; restoring a previous design retains usage already consumed. This count starts at product logic review and excludes the earlier naming workflow. Missing provider usage and historical projects are shown as unavailable/partial, never fabricated as zero. Usage not delivered before a connection is lost cannot be recovered from provider billing by this implementation.

See [product-workflow.md](product-workflow.md) for behavior and validation commands.
See [product-text-workflow.md](product-text-workflow.md) for the four text stages, version and identity rules, historical compatibility and focused validation.

## Retained structure APIs and historical projects

The old structure workspace components have been removed. Structure compilation, research and Materials V2 APIs remain mounted by `createAiMiddleware` for protocol compatibility. `server/materialsV2Api.ts` invokes `documentGenerationV2.ts`, which generates, reviews, fixes, polishes and validates documents against a confirmed generation context.

`src/data.ts` still validates historical structure-based project data. Existing invention exports in `App.tsx` use historical Word exporters when the saved project has no product workflow. Keep those validation and rendering modules until historical data support is deliberately retired.

## Evidence and version boundaries

AI-selected structure evidence is user-adopted input, not independently verified prior-art evidence. Research evidence must satisfy its source and excerpt checks. Model-generated dimensions describe a design rather than a physical measurement.

Document validation and export must use the same confirmed model or product brief version as their figures. Old artifacts must not authorize export after the source selection changes. Research, compilation and historical Word checks remain covered by protocol and compatibility tests; the current product UI is covered by `tests/product-workflow-ui.spec.ts`.
