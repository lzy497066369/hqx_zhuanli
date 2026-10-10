import type { ContentDesign } from './contentDrawing';
import { buildContentAssembly } from './contentDrawing';
import { createFigure, figureLabels } from './drawingModel';
import type { Figure } from './drawingModel';
import type { PatentStructureModel } from './patentStructure';

const VIEWS: Figure[] = ['overall', 'side', 'detail'];

/**
 * Reads the identifiers actually attached to rendered geometry.  A legacy
 * drawing without componentId is accepted only for migration; new drawings
 * must carry the CID copied from PatentStructureModel.
 */
export function actualFigureMarkers(design: ContentDesign, model?: PatentStructureModel): string[][] {
  // A legacy ContentDesign has no persisted per-figure component references.
  // Use the model's declared FigureSpec as the migration baseline instead of
  // inventing a new view membership from array order.
  if (!design.structureModel && model && design.components.some(part => !part.componentId)) return model.figureSpecs.slice(0, VIEWS.length).map(spec => [...spec.componentIds]);
  const assembly = buildContentAssembly(design);
  return VIEWS.map(view => figureLabels(createFigure(assembly, view))
    .map(label => label.componentId).filter((id): id is string => !!id));
}

/** Compatibility entry point: rendered views never alter the compiled structure. */
export function alignFigureSpecsToRenderedModel(model: PatentStructureModel, _design: ContentDesign): PatentStructureModel {
  return model;
}

/**
 * The model is the authority for figure specs. Rendering may validate a model,
 * but it must never rewrite the model from the rendered marker order.
 */
