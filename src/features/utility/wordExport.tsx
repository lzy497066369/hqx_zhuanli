import { Document, ImageRun, Paragraph, TextRun } from "docx";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { hasConfirmedUtilityStructure } from "../../data";
import type { Project, UtilityDrawing, UtilityMaterials } from "../../data";
import { UtilityFigure } from "./UtilityFigure";
import { buildContentAssembly } from "./contentDrawing";
import { FIGURE_DESCRIPTIONS, FIGURE_LABELS, PATENT_DRAWING_STYLE, SVG_FRAME } from "./drawingModel";
import type { Figure } from "./drawingModel";
import { fitWordImage, packPatentWord, patentSection, WORD_BODY as BODY, WORD_BODY_PARAGRAPH as BODY_PARAGRAPH, WORD_METADATA, WORD_STYLES, wordCaption, wordHeading, wordImageParagraph, wordTitle } from "./wordFormat";
import { freezePatentPackage } from './patentPackage';

function body(text: string) {
  return new Paragraph({ ...BODY_PARAGRAPH,
    keepNext: /^(?:部件及设置理由|连接关系|运动关系)[:：]$/u.test(text),
    children: [new TextRun({ text, ...BODY })] });
}

function svgMarkup(project: Project, drawing: UtilityDrawing, figure: Figure) {
  if (!drawing.design) throw new Error("附图尚未生成，无法导出 Word。");
  const model = buildContentAssembly(drawing.design);
  return renderToStaticMarkup(createElement(UtilityFigure, {
    model, parts: drawing.design.components.map(({ id, componentId, referenceNo, name }) => ({ id, componentId, referenceNo, name })), figure, title: project.name,
  }));
}

async function svgToPng(svg: string) {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  // Remove only the standalone sheet furniture; Word owns the header and caption.
  for (const element of Array.from(parsed.documentElement.children)) {
    if (element.localName === "text" && [PATENT_DRAWING_STYLE.pageTitle, ...Object.values(FIGURE_LABELS)].includes(element.textContent || "")) element.remove();
  }
  const image = new Image(); image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(parsed))}`;
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("附图转 Word 图片失败。")); });
  const canvas = document.createElement("canvas"); canvas.width = SVG_FRAME.width * 3; canvas.height = SVG_FRAME.height * 3;
  const context = canvas.getContext("2d"); if (!context) throw new Error("无法创建附图导出画布。");
  context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  // Preserve the entire original frame; fitting happens only at Word layout time.
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("无法生成附图 PNG。");
  return { data: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
}

export async function createUtilityWordBlob(project: Project, drawing: UtilityDrawing, materials: UtilityMaterials) {
  if (!drawing.design) throw new Error("附图尚未生成，无法导出 Word。");
  if (!hasConfirmedUtilityStructure(project, drawing) || !drawing.design.structureModel) throw new Error("结构模型尚未确定或附图内容已过期，无法导出 Word。");
  const frozen = freezePatentPackage(project, drawing, materials);
  const final = frozen.document;
  const specification: Paragraph[] = [wordTitle(final.title)];
  for (const section of final.sections) specification.push(wordHeading(section.title), ...section.paragraphs.map(body));
  const figures: Paragraph[] = [];
  let abstractFigure: Paragraph | undefined;
  for (const { kind: figure, figureLabel } of final.figures) {
    // 摘要附图使用与图 1 相同的整体结构示意图（不再绘制 A 区域虚线框）。
    // 两者输入完全相同，复用同一份光栅化结果，无需再渲染一遍整体图。
    const png = await svgToPng(svgMarkup(frozen.project, frozen.drawing, figure));
    const image = (withCaption: boolean) => new ImageRun({ type: 'png', data: png.data, transformation: fitWordImage(png.width, png.height, withCaption), altText: { name: figureLabel, title: figureLabel, description: FIGURE_DESCRIPTIONS[figure] } });
    if (figure === 'overall') {
      abstractFigure = wordImageParagraph([new ImageRun({ type: 'png', data: png.data, transformation: fitWordImage(png.width, png.height, false), altText: { name: figureLabel, title: figureLabel, description: '摘要附图为整体结构示意图。' } })]);
    }
    figures.push(wordImageParagraph([image(true)], figures.length > 0, true));
    figures.push(wordCaption(figureLabel));
  }
  if (!abstractFigure) throw new Error('缺少摘要附图，无法导出 Word。');
  const document = new Document({
    ...WORD_METADATA,
    title: final.title,
    styles: WORD_STYLES,
    features: { updateFields: true },
    sections: [patentSection('说明书摘要', [body(final.abstract)]), patentSection('摘要附图', [abstractFigure]), patentSection('权利要求书', final.claims.map(body)), patentSection('说明书', specification), patentSection('说明书附图', figures)],
  });
  return packPatentWord(document);
}

export function utilityWordFilename(projectName: string, patentType: "utility" | "invention" = "utility") {
  return `${projectName.replace(/[/\\:*?"<>|]/g, "-")}-${patentType === "invention" ? "发明专利" : "实用新型"}申请材料.docx`;
}
