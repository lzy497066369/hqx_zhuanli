export type StructureAnswerSuggestion = {
  question: string;
  answer: string;
  basis: 'supported' | 'proposed';
  rationale: string;
};

export function isStructureAnswerSuggestions(value: unknown, questions: string[]): value is StructureAnswerSuggestion[] {
  return Array.isArray(value) && value.length === questions.length &&
    value.every((item, index) => item && typeof item === 'object' && item.question === questions[index] &&
      typeof item.answer === 'string' && !!item.answer.trim() && item.answer.length <= 1000 &&
      (item.basis === 'supported' || item.basis === 'proposed') &&
      typeof item.rationale === 'string' && !!item.rationale.trim() && item.rationale.length <= 500);
}
