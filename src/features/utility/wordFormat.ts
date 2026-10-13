import {
  AlignmentType, BorderStyle, DocumentGridType, Footer, Header, LineRuleType,
  NumberFormat, Packer, PageNumber, PageOrientation, Paragraph, SectionType, TextRun,
} from "docx";
import type { Document, IParagraphOptions, ISectionOptions, IStylesOptions } from "docx";

// No author or edit history is recorded by the app. Explicit empty values avoid
// docx's "Un-named" author/editor and revision=1 defaults; 0 omits the XML field.
// Creation/modification timestamps remain the library's actual export time.
export const WORD_METADATA = { creator: "", lastModifiedBy: "", revision: 0 };

// Measured from the reference patent. Page dimensions and margins are in twips.
export const WORD_PAGE = {
  size: { width: 11906, height: 16838, orientation: PageOrientation.PORTRAIT },
  margin: { top: 1417, bottom: 850, left: 1418, right: 851, header: 850, footer: 454, gutter: 0 },
  pageNumbers: { formatType: NumberFormat.DECIMAL },
};
export const WORD_BODY = {
  font: { ascii: "SimSun", hAnsi: "SimSun", eastAsia: "SimSun", cs: "SimSun", hint: "eastAsia" },
  language: { eastAsia: "zh-CN" }, size: 28, sizeComplexScript: 28,
  color: "000000", characterSpacing: 0, scale: 100, snapToGrid: true,
};
export const WORD_LINE = 312;
const NO_INDENT = { firstLine: 0, firstLineChars: 0, left: 0, right: 0 };
// No explicit line multiplier: Word lays text on the reference's lines-only grid.
const TEXT_SPACING = { before: 0, after: 0 };
export const WORD_BODY_PARAGRAPH = {
  alignment: AlignmentType.LEFT, spacing: TEXT_SPACING,
  indent: { firstLine: 560, firstLineChars: 200 },
  widowControl: true, keepNext: false, keepLines: false,
};
const BORDER = { style: BorderStyle.SINGLE, size: 4, color: "000000", space: 0 };
const CENTERED = { alignment: AlignmentType.CENTER, indent: NO_INDENT, keepNext: false, keepLines: true };
const CAPTION_GAP = 120;
const HEADER_LINE = 560;
const FOOTER_LINE = 240;

export const WORD_STYLES: IStylesOptions = {
  default: {
    document: { run: WORD_BODY, paragraph: WORD_BODY_PARAGRAPH },
    title: {
      run: { ...WORD_BODY, size: 36, sizeComplexScript: 36, bold: true },
      paragraph: { ...CENTERED, keepNext: true, spacing: TEXT_SPACING },
    },
  },
  paragraphStyles: [
    {
      id: "PatentSectionHeading", name: "Patent Section Heading", basedOn: "Normal", next: "Normal",
      run: { ...WORD_BODY, bold: true },
      paragraph: { alignment: AlignmentType.LEFT, indent: NO_INDENT, spacing: TEXT_SPACING, keepNext: true, keepLines: true },
    },
  ],
};

export function wordTitle(text: string) {
  return new Paragraph({ style: "Title", children: [new TextRun({ text, ...WORD_BODY, size: 36, sizeComplexScript: 36, bold: true })] });
}

export function wordHeading(text: string) {
  return new Paragraph({ style: "PatentSectionHeading", children: [new TextRun({ text, ...WORD_BODY, bold: true })] });
}

export function patentSection(title: string, children: Paragraph[]): ISectionOptions {
  return {
    properties: {
      type: SectionType.NEXT_PAGE, page: WORD_PAGE,
      grid: { type: DocumentGridType.LINES, linePitch: WORD_LINE, charSpace: 0 },
    },
    headers: { default: new Header({ children: [new Paragraph({
      ...CENTERED, spacing: { before: 0, after: 0, line: HEADER_LINE, lineRule: LineRuleType.EXACT },
      border: { bottom: BORDER },
      children: [new TextRun({ text: title, ...WORD_BODY, size: 32, sizeComplexScript: 32, snapToGrid: false })],
    })] }) },
    footers: { default: new Footer({ children: [new Paragraph({
      ...CENTERED, spacing: { before: 0, after: 0, line: FOOTER_LINE, lineRule: LineRuleType.EXACT },
      border: { top: BORDER },
      children: [new TextRun({ children: [PageNumber.CURRENT], ...WORD_BODY, size: 20, sizeComplexScript: 20, snapToGrid: false })],
    })] }) },
    children,
  };
}

export function fitWordImage(width: number, height: number, withCaption: boolean) {
  if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw new Error("附图尺寸无效，无法导出 Word。");
  const { size, margin } = WORD_PAGE;
  // Inline pictures also need a baseline and a following section-break paragraph.
  const reserved = WORD_LINE * 2 + (withCaption ? WORD_LINE + CAPTION_GAP : 0);
  const maxWidth = (size.width - margin.left - margin.right) / 15;
  const top = Math.max(margin.top, margin.header + HEADER_LINE);
  const bottom = Math.max(margin.bottom, margin.footer + FOOTER_LINE);
  const maxHeight = (size.height - top - bottom - reserved) / 15;
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return { width: width * scale, height: height * scale };
}

export async function packPatentWord(document: Document) {
  const body = document.Document.View.Body;
  const prepare = body.prepForXml;
  // docx 9.7.1 omits zero charSpace. Amend the public XML representation only.
  const explicitGrid = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(explicitGrid); return; }
    const node = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(node)) {
      if (key === "w:docGrid" && child && typeof child === "object") {
        const grids = Array.isArray(child) ? child : [child];
        for (const grid of grids) {
          if (!grid || typeof grid !== "object") continue;
          const attributes = (grid as Record<string, unknown>)["_attr"];
          if (attributes && typeof attributes === "object") (attributes as Record<string, unknown>)["w:charSpace"] = 0;
        }
      }
      explicitGrid(child);
    }
  };
  body.prepForXml = context => {
    const xml = prepare.call(body, context);
    explicitGrid(xml);
    return xml;
  };
  try { return await Packer.toBlob(document); }
  finally { body.prepForXml = prepare; }
}

export function wordImageParagraph(children: IParagraphOptions["children"], pageBreakBefore = false, withCaption = false) {
  return new Paragraph({
    ...CENTERED, pageBreakBefore, keepNext: withCaption,
    // Exact body leading would clip an inline image. Let this line grow to its image.
    spacing: { before: 0, after: 0, line: WORD_LINE, lineRule: LineRuleType.AT_LEAST }, children,
  });
}

export function wordCaption(text: string) {
  return new Paragraph({
    ...CENTERED, spacing: { ...TEXT_SPACING, before: CAPTION_GAP },
    children: [new TextRun({ text, ...WORD_BODY })],
  });
}
