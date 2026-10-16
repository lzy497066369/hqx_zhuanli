/** Validated content shared by the Word and PDF renderers. */
export type PatentExportFigure = {
  data: Uint8Array;
  width: number;
  height: number;
  label: string;
  description: string;
};

export type PatentExportDocument = {
  title: string;
  abstract: string;
  claims: string[];
  sections: { title: string; paragraphs: string[] }[];
  figures: PatentExportFigure[];
  abstractFigure?: PatentExportFigure;
};
