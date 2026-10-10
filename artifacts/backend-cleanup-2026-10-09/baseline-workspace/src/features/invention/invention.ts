export type InventionFacts = {
  technicalField: string;
  background: string;
  problem: string;
  solution: string;
  steps: string;
  limitations: string;
  effects: string;
  embodiment: string;
  confirmed: boolean;
};

export type InventionMaterials = {
  source: string;
  abstract: string;
  claims: string[];
  sections: { title: string; paragraphs: string[] }[];
};

const fields: (keyof Omit<InventionFacts, 'confirmed'>)[] = [
  'technicalField', 'background', 'problem', 'solution', 'steps', 'limitations', 'effects', 'embodiment',
];

export function isInventionFacts(value: unknown): value is InventionFacts {
  if (!value || typeof value !== 'object') return false;
  const facts = value as Record<string, unknown>;
  return fields.every(key => typeof facts[key] === 'string') && typeof facts.confirmed === 'boolean';
}

export function isInventionMaterials(value: unknown): value is InventionMaterials {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<InventionMaterials>;
  return typeof item.source === 'string' && typeof item.abstract === 'string' &&
    Array.isArray(item.claims) && item.claims.every(text => typeof text === 'string') &&
    Array.isArray(item.sections) && item.sections.every(section =>
      typeof section?.title === 'string' && Array.isArray(section.paragraphs) && section.paragraphs.every(text => typeof text === 'string'));
}

export function inventionSource(title: string, facts: InventionFacts) {
  return JSON.stringify([title.trim(), ...fields.map(key => facts[key].trim())]);
}

const lines = (value: string) => value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
const end = (text: string) => /[。；;]$/u.test(text) ? text : `${text}。`;
const explicitParent = /^根据权利要求\s*(\d+)\s*所述(?:的[^，,：:]*)?[，,：:]\s*/u;

function limitationWithParent(text: string, claimNo: number, title: string) {
  const match = explicitParent.exec(text);
  const parentClaimNo = match ? Number(match[1]) : claimNo - 1;
  const limitation = match ? text.slice(match[0].length).trim() : text;
  if (!limitation) throw new Error(`权利要求${claimNo}缺少从属限定内容。`);
  if (!Number.isInteger(parentClaimNo) || parentClaimNo < 1 || parentClaimNo >= claimNo) {
    throw new Error(`权利要求${claimNo}的上位引用无效，应引用编号更小的权利要求。`);
  }
  return `${claimNo}. 根据权利要求${parentClaimNo}所述的${title}，其特征在于：${end(limitation)}`;
}

export function makeInventionMaterials(title: string, facts: InventionFacts): InventionMaterials {
  if (!facts.confirmed) throw new Error('请先确认技术事实，再生成申请材料。');
  if (!title.trim() || !facts.technicalField.trim() || !facts.background.trim() || !facts.problem.trim() ||
    !facts.solution.trim() || !facts.effects.trim() || !facts.embodiment.trim()) {
    throw new Error('请补齐技术领域、背景、问题、技术方案、效果依据及实施例。');
  }
  const steps = lines(facts.steps);
  if (!steps.length) throw new Error('请至少填写一个实际工艺步骤。');
  const limitations = lines(facts.limitations);
  const name = title.trim();
  const process = steps.map((step, index) => `S${index + 1}：${end(step)}`);
  const claims = [
    `1. ${name}，其特征在于，包括以下步骤：${process.join('')}`,
    ...limitations.map((text, index) => limitationWithParent(text, index + 2, name)),
  ];
  return {
    source: inventionSource(name, facts),
    abstract: `本发明公开${name}，涉及${facts.technicalField.trim()}。${end(facts.solution.trim())}${process.join('')}针对${end(facts.problem.trim())}${end(facts.effects.trim())}`,
    claims,
    sections: [
      { title: '技术领域', paragraphs: [end(facts.technicalField.trim())] },
      { title: '背景技术', paragraphs: lines(facts.background).map(end) },
      { title: '发明内容', paragraphs: [
        `本发明针对${end(facts.problem.trim())}`,
        `本发明的技术方案为：${end(facts.solution.trim())}`,
        ...process,
        ...limitations.map(text => `进一步地，${end(text)}`),
        `根据已确认的技术事实，${end(facts.effects.trim())}`,
      ] },
      { title: '具体实施方式', paragraphs: [...lines(facts.embodiment).map(end), ...process] },
    ],
  };
}

export function validateInventionMaterials(title: string, facts: InventionFacts | undefined, materials: InventionMaterials | undefined) {
  if (!facts || !materials || !facts.confirmed || materials.source !== inventionSource(title, facts)) {
    throw new Error('发明文案与当前技术事实不一致，请重新确认并生成。');
  }
  if (!materials.abstract.trim() || !materials.claims.length || materials.sections.length !== 4 ||
    materials.sections.some(section => !section.paragraphs.length || section.paragraphs.some(text => !text.trim())) ||
    materials.claims.some((claim, index) => !claim.startsWith(`${index + 1}. `)) ||
    materials.claims.slice(1).some((claim, index) => {
      const parent = /根据权利要求\s*(\d+)\s*所述/u.exec(claim)?.[1];
      return !parent || Number(parent) >= index + 2;
    })) {
    throw new Error('发明申请材料不完整或权利要求编号不连续。');
  }
}
