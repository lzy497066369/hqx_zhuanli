import type { Content, ContentText, TDocumentDefinitions } from 'pdfmake/interfaces';
import type { PatentExportDocument, PatentExportFigure } from './patentDocument';
import { clearPdfMetadata } from './pdfMetadata';

const FONT_FILE = 'NotoSerifSC-Regular.otf';
let fontPromise: Promise<Record<string, string>> | undefined;

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}

function loadFont() {
  fontPromise ??= (async () => {
    const response = await fetch(`${import.meta.env.BASE_URL}fonts/${FONT_FILE}`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('PDF 中文字体加载失败，请重试下载。');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'OTTO') throw new Error('PDF 中文字体文件无效，请重试下载。');
    return { [FONT_FILE]: base64(bytes) };
  })().catch(cause => { fontPromise = undefined; throw cause; });
  return fontPromise;
}

function paragraphs(text: string): ContentText[] {
  return text.split(/\n+/).map(line => line.trim()).filter(Boolean).map(line => ({ text: `　　${line}`, margin: [0, 0, 0, 6] }));
}

function figureContent(figure: PatentExportFigure, caption: boolean): Content {
  if (![figure.width, figure.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('附图尺寸无效，无法导出 PDF。');
  // Leave room for the section heading, caption, and page furniture; preserve the full image.
  const scale = Math.min(481 / figure.width, 620 / figure.height, 0.75);
  return { unbreakable: true, stack: [
    { image: `data:image/png;base64,${base64(figure.data)}`, width: figure.width * scale, height: figure.height * scale, alignment: 'center', margin: [0, 8, 0, 12] },
    ...(caption ? [{ text: figure.label, alignment: 'center' as const, fontSize: 12 }] : []),
  ] };
}

export async function createPatentPdfBlob(document: PatentExportDocument): Promise<Blob> {
  const [pdfMake, vfs] = await Promise.all([import('pdfmake/build/pdfmake'), loadFont()]);
  const content: Content[] = [];
  const section = (title: string, children: Content[]) => {
    content.push({ text: title, style: 'section', headlineLevel: 1, ...(content.length ? { pageBreak: 'before' as const } : {}) }, ...children);
  };
  const title = (): Content => ({ text: document.title, style: 'title', headlineLevel: 2 });
  section('说 明 书 摘 要', [title(), ...paragraphs(document.abstract)]);
  if (document.abstractFigure) section('摘 要 附 图', [figureContent(document.abstractFigure, false)]);
  section('权 利 要 求 书', [title(), ...document.claims.flatMap(paragraphs)]);
  section('说 明 书', [title(), ...document.sections.flatMap(item => [
    { text: item.title, style: 'heading', headlineLevel: 2 } satisfies ContentText,
    ...item.paragraphs.flatMap(paragraphs),
  ])]);
  if (document.figures.length) section('说 明 书 附 图', document.figures.map((figure, index) => ({
    stack: [figureContent(figure, true)], ...(index ? { pageBreak: 'before' as const } : {}),
  })));
  const definition: TDocumentDefinitions = {
    pageSize: 'A4', pageMargins: [70.9, 70.85, 42.55, 42.5],
    defaultStyle: { font: 'PatentChinese', fontSize: 14, lineHeight: 1.25, color: '#000000' },
    styles: {
      section: { fontSize: 16, alignment: 'center', margin: [0, 0, 0, 16] },
      title: { fontSize: 18, alignment: 'center', margin: [0, 0, 0, 16] },
      heading: { fontSize: 14, margin: [0, 10, 0, 6] },
    },
    header: { text: '专利申请材料', fontSize: 10, alignment: 'center', margin: [70.9, 32, 42.55, 0] },
    footer: currentPage => ({ text: String(currentPage), fontSize: 10, alignment: 'center', margin: [70.9, 12, 42.55, 0] }),
    pageBreakBefore: (node, following) => !!node.headlineLevel && following.length === 0,
    content,
  };
  const fonts = { PatentChinese: { normal: FONT_FILE, bold: FONT_FILE, italics: FONT_FILE, bolditalics: FONT_FILE } };
  // A local VFS avoids pdfmake's remote font resolver. Synchronous layout errors and stream errors both reject.
  const stream = pdfMake.createPdf(definition, undefined, fonts, vfs).getStream();
  const generated = await new Promise<Blob>((resolve, reject) => {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    stream.on('data', (chunk: Uint8Array) => chunks.push(new Uint8Array(chunk)));
    stream.on('error', reject);
    stream.on('end', () => resolve(new Blob(chunks, { type: 'application/pdf' })));
    stream.end();
  });
  return new Blob([await clearPdfMetadata(await generated.arrayBuffer())], { type: 'application/pdf' });
}
