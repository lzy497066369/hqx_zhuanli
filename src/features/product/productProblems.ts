export type TechnicalProblem = {
  id: string; title: string; problem: string; goal: string; approach: string; suggestedName: string;
};
export type ProblemProposal = { product: string; context: string; scenario: string; problems: TechnicalProblem[] };
export type ProblemSelection = { product: string; context: string; scenario: string; problem: TechnicalProblem };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number, empty = false): v is string => typeof v === 'string' && (empty || !!v.trim()) && [...v].length <= max;
export function isTechnicalProblem(v: unknown): v is TechnicalProblem {
  return object(v) && text(v.id, 40) && /^p[1-9]\d?$/.test(v.id) && text(v.title, 60) &&
    text(v.problem, 500) && text(v.goal, 300) && text(v.approach, 500) &&
    text(v.suggestedName, 25) && v.suggestedName.startsWith('一种') && !/[\s。；：，！？]/u.test(v.suggestedName);
}
export function isProblemProposal(v: unknown): v is ProblemProposal {
  return object(v) && text(v.product, 100) && text(v.context, 3000, true) && text(v.scenario, 500) &&
    Array.isArray(v.problems) && v.problems.length >= 3 && v.problems.length <= 6 && v.problems.every(isTechnicalProblem) &&
    new Set(v.problems.map(p => p.id)).size === v.problems.length && new Set(v.problems.map(p => p.problem)).size === v.problems.length;
}
export function isProblemSelection(v: unknown): v is ProblemSelection {
  return object(v) && text(v.product, 100) && text(v.context, 3000, true) && text(v.scenario, 500) && isTechnicalProblem(v.problem);
}
