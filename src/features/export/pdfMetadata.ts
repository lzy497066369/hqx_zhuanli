import { PDFDict, PDFDocument, PDFName, PDFStream } from 'pdf-lib';

/** Copy only the page graph so discarded metadata cannot survive as unused objects. */
export async function clearPdfMetadata(bytes: ArrayBuffer): Promise<Uint8Array<ArrayBuffer>> {
  const source = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const [, object] of source.context.enumerateIndirectObjects()) {
    const dict = object instanceof PDFStream ? object.dict : object;
    if (dict instanceof PDFDict) {
      for (const key of ['Metadata', 'PieceInfo', 'LastModified']) dict.delete(PDFName.of(key));
    }
  }
  const clean = await PDFDocument.create({ updateMetadata: false });
  for (const page of await clean.copyPages(source, source.getPageIndices())) clean.addPage(page);
  return new Uint8Array(await clean.save());
}
