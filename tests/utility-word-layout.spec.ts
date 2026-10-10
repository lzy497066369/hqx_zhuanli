import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fitWordImage, WORD_PAGE } from '../src/features/utility/wordFormat';
import { generateMaterialsV2, mockMaterialsV2 } from './fixtures/materialsV2';
import { generateStructure, mockStructure, openNamedWorkspace, savedProject } from './fixtures/structureFlow';

test('Word 图片布局：横图、长图按版心和图号空间等比缩放', () => {
  const maxWidth = (WORD_PAGE.size.width - WORD_PAGE.margin.left - WORD_PAGE.margin.right) / 15;
  const maxHeight = (WORD_PAGE.size.height - WORD_PAGE.margin.top - WORD_PAGE.margin.bottom) / 15;
  for (const [width, height] of [[4000, 300], [300, 6000], [2400, 2400], [120, 80]]) {
    for (const caption of [true, false]) {
      const fitted = fitWordImage(width, height, caption);
      expect(fitted.width).toBeLessThanOrEqual(maxWidth);
      expect(fitted.height).toBeLessThan(maxHeight - 40);
      expect(fitted.width / fitted.height).toBeCloseTo(width / height, 8);
      expect(fitted.width).toBeLessThanOrEqual(width);
    }
  }
  for (const [width, height] of [[0, 10], [10, -1], [NaN, 10], [10, Infinity]]) {
    expect(() => fitWordImage(width, height, true)).toThrow('附图尺寸无效');
  }
});

test('Word 集成验收：真实导出、格式契约与篡改拒绝', async ({ page }, testInfo) => {
  await mockMaterialsV2(page);
  await mockStructure(page);
  const title = await openNamedWorkspace(page);
  await generateStructure(page);
  await generateMaterialsV2(page);
  const project = await savedProject(page, title);
  const outputDirectory = process.env.QA_WORD_DIR || testInfo.outputPath('word');
  mkdirSync(outputDirectory, { recursive: true });

  for (const variant of ['normal', 'long', 'short', 'annotated', 'extended'] as const) {
    const result = await page.evaluate(async ({ project, variant }) => {
      const { createUtilityWordBlob } = await import('../src/features/utility/wordExport.tsx');
      const { sanitizeFinalPatentDocument } = await import('../src/features/utility/finalDocumentSanitizer.ts');
      const materials = structuredClone(project.utilityMaterials);
      const sentence = '壳体与支架相互连接，快拆罩设置于支架上，快拆罩用于防护并便于维护。';
      if (variant === 'long') {
        materials.abstract = materials.abstract.repeat(20);
        const claims = materials.claims.split('\n');
        claims[0] += sentence.repeat(65);
        materials.claims = claims.join('\n');
        materials.background = [sentence.repeat(65), ...Array.from({ length: 12 }, () => sentence.repeat(3))].join('\n');
      } else if (variant === 'short') {
        materials.abstract = `本实用新型公开${project.name}。${sentence}`;
        materials.background = sentence;
      } else if (variant === 'annotated') {
        const model = project.utilityDrawing.patentStructureModel;
        model.components[0].position += '（示意数量与位置，待核对）';
        model.components[1].whyNeeded += '。E01/E03 明确部件来源。';
        model.components[2].purpose += '；标记为创新';
        model.baseStructure += '拟议结构，待实物核对。';
        model.workingPrinciple += '【AI分析：内部推理】';
        model.connections[0].description += '。AI备注：示意连接。';
        materials.abstract += '拟议结构，待实物核对。';
        materials.claims = materials.claims.replace('主体。', '主体（示意位置，待核对）。');
        materials.background = sentence + 'Evidence: E01。validation: 已检查。internal: 元数据。draft: 草稿。';
        materials.content = materials.content.replace('设置理由：固定支架', '设置理由：E01/E03 明确部件来源') + '\nAI备注：内部草稿。';
        materials.embodiment += '\n拟议结构，待实物核对。';
      } else if (variant === 'extended') {
        materials.content += '\n壳体侧面设有排水槽，排水槽与外侧连通。';
        materials.embodiment += '\n维护时，先解除快拆罩与支架之间的连接，再移开快拆罩。\nE01/E03 型连接器提供 validation 模式，显示屏显示“待核对”状态。';
        materials.drawings += '\n图3中的连接位置位于快拆罩下侧。';
      }
      const before = JSON.stringify({ project, materials });
      try {
        if (variant !== 'normal') {
          await createUtilityWordBlob(project, project.utilityDrawing, materials);
          return { rejected: '', unchanged: before === JSON.stringify({ project, materials }) };
        }
        const final = sanitizeFinalPatentDocument(project.name, project.utilityDrawing.patentStructureModel, materials, 'utility', true);
        const blob = await createUtilityWordBlob(project, project.utilityDrawing, materials);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return { base64: btoa(binary), unchanged: before === JSON.stringify({ project, materials }), claims: final.claims,
          sourceClaims: materials.claims.split('\n'),
          formalParagraphs: [final.abstract, ...final.sections.flatMap(section => section.paragraphs)] };
      } catch (error) {
        if (variant !== 'normal') return { rejected: String(error), unchanged: before === JSON.stringify({ project, materials }) };
        throw error;
      }
    }, { project, variant });
    if (variant !== 'normal') {
      expect(result.rejected).toMatch(/缺少有效的 V2 审核|文案不是当前结构模型的 V2 校验结果|新增结构“排水槽”不在结构模型中/u);
      expect(result.unchanged).toBe(true);
      continue;
    }
    expect(result.unchanged).toBe(true);
    const output = join(outputDirectory, `${variant}.docx`);
    writeFileSync(output, Buffer.from(result.base64, 'base64'));
    execFileSync('unzip', ['-t', output]);
    const files = execFileSync('unzip', ['-Z1', output], { encoding: 'utf8' }).split('\n');
    const xml = Object.fromEntries(files.filter(path => /^word\/(document|styles|settings|header\d+|footer\d+)\.xml$/.test(path))
      .map(path => [path, execFileSync('unzip', ['-p', output, path], { encoding: 'utf8' })]));
    const observed = await page.evaluate(xml => {
      const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
      const parse = (text: string) => new DOMParser().parseFromString(text, 'application/xml');
      const all = (node: Document | Element, name: string) => Array.from(node.getElementsByTagNameNS(ns, name));
      const attr = (node: Element | undefined, name = 'val') => node?.getAttributeNS(ns, name);
      const text = (node: Element) => all(node, 't').map(t => t.textContent).join('');
      const document = parse(xml['word/document.xml']);
      const styles = parse(xml['word/styles.xml']);
      const defaults = all(styles, 'docDefaults')[0];
      const paragraphs = all(document, 'p').map(p => ({
        text: text(p), style: attr(all(p, 'pStyle')[0]),
        line: attr(all(p, 'spacing')[0], 'line'), rule: attr(all(p, 'spacing')[0], 'lineRule'),
        indent: attr(all(p, 'ind')[0], 'firstLineChars'), align: attr(all(p, 'jc')[0]),
        hasDrawing: p.getElementsByTagNameNS('*', 'inline').length > 0,
        keepNext: all(p, 'keepNext').some(n => attr(n) !== 'false'),
        pageBreak: all(p, 'pageBreakBefore').some(n => attr(n) !== 'false'),
      }));
      const stylesById = Object.fromEntries(all(styles, 'style').map(s => [attr(s, 'styleId'), {
        size: attr(all(s, 'sz')[0]), bold: all(s, 'b').length > 0,
        indent: attr(all(s, 'ind')[0], 'firstLineChars'), align: attr(all(s, 'jc')[0]),
        keepNext: all(s, 'keepNext').some(n => attr(n) !== 'false'),
      }]));
      const furniture = (kind: string, edge: string) => Object.entries(xml).filter(([path]) => path.includes(`/` + kind)).map(([, source]) => {
        const root = parse(source);
        return {
          text: all(root, 't').map(t => t.textContent).join(''),
          fields: all(root, 'instrText').map(t => t.textContent?.trim()),
          border: { type: attr(all(root, edge)[0]), size: attr(all(root, edge)[0], 'sz'), color: attr(all(root, edge)[0], 'color') },
          align: attr(all(root, 'jc')[0]), indent: attr(all(root, 'ind')[0], 'firstLineChars'),
          font: attr(all(root, 'rFonts')[0], 'eastAsia'), size: attr(all(root, 'sz')[0]),
        };
      });
      return {
        sections: all(document, 'sectPr').map(s => ({
          width: attr(all(s, 'pgSz')[0], 'w'), height: attr(all(s, 'pgSz')[0], 'h'),
          margins: ['top', 'bottom', 'left', 'right', 'gutter'].map(key => attr(all(s, 'pgMar')[0], key)),
          grid: ['type', 'linePitch', 'charSpace'].map(key => attr(all(s, 'docGrid')[0], key)),
          start: attr(all(s, 'pgNumType')[0], 'start'), format: attr(all(s, 'pgNumType')[0], 'fmt'),
        })),
        defaults: { font: attr(all(defaults, 'rFonts')[0], 'eastAsia'), size: attr(all(defaults, 'sz')[0]),
          line: attr(all(defaults, 'spacing')[0], 'line'), rule: attr(all(defaults, 'spacing')[0], 'lineRule'),
          indent: attr(all(defaults, 'ind')[0], 'firstLineChars'), align: attr(all(defaults, 'jc')[0]),
          charSpace: attr(all(all(defaults, 'rPr')[0], 'spacing')[0]) ?? '0',
        },
        paragraphs, stylesById, headers: furniture('header', 'bottom'), footers: furniture('footer', 'top'),
        updateFields: all(parse(xml['word/settings.xml']), 'updateFields').some(n => attr(n) !== 'false'),
        styleIds: all(styles, 'style').map(s => attr(s, 'styleId')),
        numbering: all(document, 'numPr').length, breaks: all(document, 'br').length,
      };
    }, xml);
  expect(observed.defaults).toEqual({ font: 'SimSun', size: '28', line: null, rule: null, indent: '200', align: 'left', charSpace: '0' });
    expect(new Set(observed.styleIds).size).toBe(observed.styleIds.length);
    expect(observed.sections).toHaveLength(5);
    for (const section of observed.sections) expect(section).toEqual({ width: '11906', height: '16838', margins: ['1417', '850', '1418', '851', '0'], grid: ['lines', '312', '0'], start: null, format: 'decimal' });
    expect(observed.headers.map(header => header.text)).toEqual(['说明书摘要', '摘要附图', '权利要求书', '说明书', '说明书附图']);
    for (const header of observed.headers) expect(header).toMatchObject({ size: '32', font: 'SimSun', align: 'center', indent: '0', border: { type: 'single', size: '4', color: '000000' } });
    expect(observed.footers).toHaveLength(5);
    for (const footer of observed.footers) expect(footer).toMatchObject({ fields: ['PAGE'], align: 'center', indent: '0', border: { type: 'single', size: '4', color: '000000' } });
    expect(observed.updateFields).toBe(true);
    expect(observed.numbering).toBe(0);
    expect(observed.breaks).toBe(0);
    expect(observed.stylesById.Title).toEqual({ size: '36', bold: true, indent: '0', align: 'center', keepNext: true });
    expect(observed.stylesById.PatentSectionHeading).toEqual({ size: '28', bold: true, indent: '0', align: 'left', keepNext: true });
    expect(observed.paragraphs.find(p => p.text === title)?.style).toBe('Title');
    for (const heading of ['技术领域', '背景技术', '实用新型内容', '附图说明', '具体实施方式']) {
      expect(observed.paragraphs.find(p => p.text === heading)?.style).toBe('PatentSectionHeading');
    }
    expect(observed.paragraphs.filter(p => /^\d+\. /u.test(p.text)).map(p => p.text)).toEqual(result.claims);
    expect(result.claims).toHaveLength(result.sourceClaims.length);
    expect(result.claims).toEqual(result.sourceClaims);
    const ordinary = observed.paragraphs.filter(p => p.text && !p.style && !/^图\d$/u.test(p.text));
    for (const paragraph of ordinary) expect(paragraph).toMatchObject({ align: 'left', indent: '200' });
    for (const text of result.formalParagraphs) {
      const matches = observed.paragraphs.some(p => p.text === text);
      expect(matches, `缺少正式段落：${JSON.stringify(text)}`).toBe(true);
    }
    const documentText = observed.paragraphs.map(p => p.text).join('\n');
    expect(documentText).not.toMatch(/拟议结构|待实物核对|AI分析|AI备注|标记为创新|Evidence|internal|draft|需人工核对|不代表授权结论/u);
    expect(documentText).not.toMatch(/E01|E02|E03|待核对|validation/u);
    const images = observed.paragraphs.filter(p => p.hasDrawing);
    expect(images).toHaveLength(4);
    images.forEach(image => expect(image).toMatchObject({ align: 'center', indent: '0', rule: 'atLeast' }));
    expect(images.filter(image => image.pageBreak)).toHaveLength(2);
    expect(images.slice(1).every(image => image.keepNext)).toBe(true);
    const captions = observed.paragraphs.filter(p => /^图\d$/u.test(p.text));
    expect(captions.map(p => p.text)).toEqual(['图1', '图2', '图3']);
    captions.forEach(caption => expect(caption).toMatchObject({ align: 'center', indent: '0', keepNext: false }));
    const media = files.filter(path => /^word\/media\/.*\.png$/.test(path));
    // 摘要附图复用整体结构图，docx 按字节哈希去重：3 个 PNG 文件承载 4 个图片实例。
    expect(media).toHaveLength(3);
    const aspectRatios = media.map(path => {
      const png = execFileSync('unzip', ['-p', output, path]);
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([794 * 3, 1123 * 3]);
      return png.readUInt32BE(16) / png.readUInt32BE(20);
    });
    for (const [, width, height] of xml['word/document.xml'].matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)) {
      expect(Number(width)).toBeLessThanOrEqual((11906 - 1418 - 851) * 635);
      expect(Number(height)).toBeLessThan((16838 - 1417 - 850) * 635);
      expect(aspectRatios.some(ratio => Math.abs(Number(width) / Number(height) - ratio) < 0.00001)).toBe(true);
    }
  }
  expect(await savedProject(page, title)).toEqual(project);
});
