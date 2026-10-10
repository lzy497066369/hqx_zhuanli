# Patent generation data flow (audited 2026-10-05)

## Live path

`PatentStructureFlow` collects the brief, selected AI structure evidence, confirmed
facts and a reviewable `StructureDraft`. `structureCompiler` compiles the draft to
`PatentStructureModel`. `UtilityWorkspace.applyPatentStructure` saves the model
and regenerates the drawing design from the same model. `makeUtilityMaterials`
in `src/data.ts` creates the claims, description and abstract from that model.
`createUtilityWordBlob` runs the consistency check, normalizes the final text,
renders the figures and packs the Word document. The plain-text export uses
`makeUtilityDocument` separately.

`server/index.ts` mounts `createAiMiddleware` from `server/drawingAi.ts` for
the research/structure APIs. `server/documentGenerationV2.ts` is not mounted
there and is not the current production text generator. Changes to V2 alone
would not protect the actual Word export.

## Evidence boundaries

The existing `structureEvidence` options are AI suggestions selected by a user,
not independently verified patent/source excerpts. `patentResearch` stores
search metadata, source URLs and summaries, but no quoted original passages.
Research summaries must not be treated as verified prior-art facts. The model
schema version is 1 and stored projects must remain readable. A model-derived
drawing geometry is a design representation, not a physical measurement.

## Required checks

The authoritative structure is the confirmed `PatentStructureModel`. Attach
provenance to its components/relations without changing draft compilation.
Generate reasoning and claims against that snapshot. Check provenance and
numerical assertions after final normalization, since that step can add a
benefit paragraph. The final check must not honor user consistency exemptions.
