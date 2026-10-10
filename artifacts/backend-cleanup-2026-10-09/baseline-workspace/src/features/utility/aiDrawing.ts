import { isPatentResearch, isProductConcept } from './patentResearch.ts';
import type { PatentResearch, ProductConcept } from './patentResearch.ts';
import { parseGeometry } from './contentDrawing.ts';

export type DrawingPlanInput = {
  mode?: 'concept';
  title: string;
  technicalField: string;
  structure: string;
  workingPrinciple: string;
};
export type DrawingPlan = {
  concept?: ProductConcept;
  status: 'ready' | 'needs_information' | 'unsupported';
  summary: string;
  assumptions: string[];
  questions: string[];
  geometryText: string;
};
export type DrawingPlanResponse = {
  plan: DrawingPlan;
  research?: PatentResearch;
  source: string;
  model: string;
  generatedAt: string;
};
export function planSource(input: DrawingPlanInput) {
  return JSON.stringify([input.title, input.technicalField, input.structure, input.workingPrinciple, ...(input.mode ? [input.mode] : [])]);
}
export function isPlanInput(value: unknown): value is DrawingPlanInput {
  if (!value || typeof value !== 'object') return false;
  const input = value as DrawingPlanInput;
  return (input.mode === undefined || input.mode === 'concept') && typeof input.title === 'string' && input.title.trim().length > 0 && input.title.length <= 100 &&
    typeof input.technicalField === 'string' && input.technicalField.length <= 2000 &&
    typeof input.structure === 'string' && (input.mode === 'concept' || input.structure.trim().length >= 8) && input.structure.length <= 10000 &&
    typeof input.workingPrinciple === 'string' && input.workingPrinciple.length <= 10000;
}
const textList = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 20 && value.every(v => typeof v === 'string' && v.trim().length > 0 && v.length <= 1000);
export function isDrawingPlan(value: unknown): value is DrawingPlan {
  if (!value || typeof value !== 'object') return false;
  const p = value as DrawingPlan;
  if ((p.concept !== undefined && !isProductConcept(p.concept)) || !['ready', 'needs_information', 'unsupported'].includes(p.status) ||
      typeof p.summary !== 'string' || !p.summary.trim() || p.summary.length > 3000 ||
      !textList(p.assumptions) || !textList(p.questions) || typeof p.geometryText !== 'string' || p.geometryText.length > 12000) return false;
  return p.status === 'ready'
    ? p.questions.length === 0 && parseGeometry(p.geometryText).errors.length === 0
    : !p.geometryText.trim() && p.questions.length > 0;
}
export function isPlanResponse(value: unknown): value is DrawingPlanResponse {
  if (!value || typeof value !== 'object') return false;
  const r = value as DrawingPlanResponse;
  return (r.research === undefined || isPatentResearch(r.research)) && isDrawingPlan(r.plan) && typeof r.source === 'string' && r.source.length <= 150000 &&
    typeof r.model === 'string' && r.model.length > 0 && r.model.length <= 100 &&
    typeof r.generatedAt === 'string' && Number.isFinite(Date.parse(r.generatedAt));
}
