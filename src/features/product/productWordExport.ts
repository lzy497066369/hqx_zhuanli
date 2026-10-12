import { Document, ImageRun, Paragraph, TextRun } from 'docx';
import type { CadViewDrawing, ProductImage, ProductPreview, ProductWorkflow } from './productWorkflow';
import { CAD_VIEWS, PREVIEW_VIEWS, hasCurrentCad, isProductWorkflow, isProductWorkflowComplete } from './productWorkflow';
import { PATENT_FIGURE_TEMPLATES } from './productPrompts';
import { fitWordImage, packPatentWord, patentSection, WORD_BODY, WORD_BODY_PARAGRAPH, WORD_STYLES, wordCaption, wordHeading, wordImageParagraph, wordTitle } from '../utility/wordFormat';
import { sha256Hex } from './digest';

function body(text: string): Paragraph {
  return new Paragraph({ ...WORD_BODY_PARAGRAPH, children: [new TextRun({ text, ...WORD_BODY })] });
}
function paragraphs(text: string): Paragraph[] {
  return text.split(/\n+/).map(line => line.trim()).filter(Boolean).map(line => body(line));
}
async function sha256(bytes: Uint8Array): Promise<string> {
  return sha256Hex(bytes);
}
export async function productImageBytes(image: ProductImage): Promise<Uint8Array> {
  const encoded = image.dataUrl.split(',')[1];
  if (!encoded) throw new Error('图片数据缺失，请重新生成。');
  const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  if (await sha256(bytes) !== image.digest) throw new Error('图片数据与生成结果不一致，请重新生成，不能确认或导出被改动的图片。');
  return bytes;
}
async function decodeImage(source: string, failure: string): Promise<HTMLImageElement> {
  const picture = new window.Image();
  const loaded = new Promise<void>((resolve, reject) => { picture.onload = () => resolve(); picture.onerror = () => reject(new Error(failure)); });
  picture.src = source;
  await loaded;
  return picture;
}
function binarize(context: CanvasRenderingContext2D, width: number, height: number) {
  // The DOC image is strictly black/white even if a provider leaves anti-aliasing or a colour fringe.
  const pixels = context.getImageData(0, 0, width, height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const value = .2126 * pixels.data[i] + .7152 * pixels.data[i + 1] + .0722 * pixels.data[i + 2] < 195 ? 0 : 255;
    pixels.data[i] = value; pixels.data[i + 1] = value; pixels.data[i + 2] = value; pixels.data[i + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
}
async function canvasPng(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('无法打包黑白附图，请重试导出。');
  return { data: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
}
/** Convert the actual model-generated picture, not a placeholder or separately drawn approximation. */
export async function patentImageForWord(image: ProductImage) {
  await productImageBytes(image);
  const picture = await decodeImage(image.dataUrl, '黑白附图无法解码，请重新生成附图。');
  if (!picture.naturalWidth || !picture.naturalHeight || picture.naturalWidth * picture.naturalHeight > 32_000_000) throw new Error('附图像素尺寸无效或过大，请降低生图尺寸。');
  const canvas = document.createElement('canvas'); canvas.width = picture.naturalWidth; canvas.height = picture.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('当前浏览器无法创建 Word 附图画布。');
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(picture, 0, 0);
  binarize(context, canvas.width, canvas.height);
  return canvasPng(canvas);
}
/** FreeCAD 投影出的矢量附图按原始画布尺寸栅格化为纯黑白 PNG；导出前核对 SVG 摘要。 */
export async function cadFigureForWord(view: CadViewDrawing) {
  if (await sha256(new TextEncoder().encode(view.svg)) !== view.digest) throw new Error(`${view.title}的附图数据与生成结果不一致，请重新生成附图。`);
  const picture = await decodeImage(`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(view.svg)))}`, `${view.title}无法解码，请重新生成附图。`);
  const canvas = document.createElement('canvas'); canvas.width = view.width; canvas.height = view.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('当前浏览器无法创建 Word 附图画布。');
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(picture, 0, 0, view.width, view.height);
  binarize(context, canvas.width, canvas.height);
  return canvasPng(canvas);
}
/** 发给视觉模型的参考图：核对摘要后压缩到 1024 像素以内，减小请求体，不改变原始预览。 */
export async function previewImagesForVision(preview: ProductPreview): Promise<{ templateId: string; dataUrl: string }[]> {
  const results: { templateId: string; dataUrl: string }[] = [];
  for (const view of PREVIEW_VIEWS) {
    const image = preview.images.find(item => item.templateId === view.templateId);
    if (!image) throw new Error(`缺少${view.title}，请重新生成彩色预览。`);
    await productImageBytes(image);
    const picture = await decodeImage(image.dataUrl, `${view.title}无法解码，请重新生成彩色预览。`);
    const scale = Math.min(1, 1024 / Math.max(picture.naturalWidth, picture.naturalHeight, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(picture.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(picture.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法处理预览图片。');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(picture, 0, 0, canvas.width, canvas.height);
    results.push({ templateId: view.templateId, dataUrl: canvas.toDataURL('image/jpeg', .86) });
  }
  return results;
}
export async function createProductWordBlob(workflow: ProductWorkflow): Promise<Blob> {
  if (!isProductWorkflow(workflow) || !isProductWorkflowComplete(workflow, PATENT_FIGURE_TEMPLATES.map(template => template.id))) throw new Error('请先确认当前彩色预览，并完成同一版本的文案与全部附图。');
  const brief = workflow.brief!;
  const materials = workflow.materials!;
  const specification = [wordTitle(materials.title)];
  for (const [heading, text] of [
    ['技术领域', materials.technicalField], ['背景技术', materials.background],
    [brief.selection.patentType === 'invention' ? '发明内容' : '实用新型内容', materials.content],
    ['附图说明', materials.drawings], ['具体实施方式', materials.embodiment],
  ]) specification.push(wordHeading(heading), ...paragraphs(text));
  const figures: Paragraph[] = [];
  const addFigure = (png: { data: Uint8Array; width: number; height: number }, index: number, title: string) => {
    const label = `图${index + 1} ${title}`;
    figures.push(wordImageParagraph([new ImageRun({ type: 'png', data: png.data, transformation: fitWordImage(png.width, png.height, true),
      altText: { name: label, title: label, description: `${materials.title}的${title}` } })], index > 0, true), wordCaption(`图${index + 1}`));
  };
  if (hasCurrentCad(workflow)) {
    const cad = workflow.cad!;
    const ordered = CAD_VIEWS.map(view => cad.views.find(item => item.view === view.id)).filter((view): view is CadViewDrawing => !!view);
    for (const [index, view] of ordered.entries()) addFigure(await cadFigureForWord(view), index, view.title);
  } else {
    for (const [index, template] of PATENT_FIGURE_TEMPLATES.entries()) addFigure(await patentImageForWord(workflow.figures[template.id]), index, template.title);
  }
  // 正式申请文件只含摘要、权利要求书、说明书和说明书附图；简介、提示词、建模脚本等生成记录不进入 Word。
  const document = new Document({ creator: '知创工坊', title: materials.title, description: '依据已确认产品简介生成的专利申请初稿与黑白附图',
    styles: WORD_STYLES, sections: [
      patentSection('说 明 书 摘 要', [wordTitle(materials.title), ...paragraphs(materials.abstract)]),
      patentSection('权 利 要 求 书', [wordTitle(materials.title), ...materials.claims.flatMap(claim => paragraphs(claim))]),
      patentSection('说 明 书', specification), patentSection('说 明 书 附 图', figures),
    ] });
  return packPatentWord(document);
}
export function productWordFilename(workflow: ProductWorkflow): string {
  const title = workflow.brief?.design.title || workflow.selection.proposedName;
  return `${title.replace(/[/\\:*?"<>|]/g, '-')}-${workflow.selection.patentType === 'invention' ? '发明专利' : '实用新型'}申请初稿.docx`;
}
