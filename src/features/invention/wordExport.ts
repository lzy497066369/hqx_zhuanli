import { Document, Paragraph, TextRun } from 'docx';
import type { Project } from '../../data';
import { packPatentWord, patentSection, WORD_BODY, WORD_BODY_PARAGRAPH, WORD_METADATA, WORD_STYLES, wordHeading, wordTitle } from '../utility/wordFormat';
import { validateInventionMaterials } from './invention';
import type { PatentExportDocument } from '../export/patentDocument';

const body = (text: string) => new Paragraph({ ...WORD_BODY_PARAGRAPH, children: [new TextRun({ text, ...WORD_BODY })] });

export function prepareInventionPatentExport(project: Project): PatentExportDocument {
  if (project.category !== 'invention') throw new Error('不是发明专利项目。');
  const { inventionFacts: facts, inventionMaterials: materials } = project;
  validateInventionMaterials(project.name, facts, materials);
  return { title: project.name, abstract: materials!.abstract, claims: materials!.claims, sections: materials!.sections, figures: [] };
}

export async function createInventionWordBlob(project: Project) {
  const materials = prepareInventionPatentExport(project);
  const specification = [wordTitle(project.name)];
  for (const section of materials!.sections) specification.push(wordHeading(section.title), ...section.paragraphs.map(body));
  const document = new Document({
    ...WORD_METADATA, title: project.name, styles: WORD_STYLES, features: { updateFields: true },
    sections: [
      patentSection('说明书摘要', [body(materials!.abstract)]),
      patentSection('权利要求书', materials!.claims.map(body)),
      patentSection('说明书', specification),
    ],
  });
  return packPatentWord(document);
}

export function inventionWordFilename(title: string) {
  return `${title.replace(/[/\\:*?"<>|]/g, '-')}-发明专利申请材料.docx`;
}
