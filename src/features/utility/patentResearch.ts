/** Research provenance is supplied by completed provider search calls, never by the design model. */
export type PatentSource = {
  publication: string;
  title: string;
  url: string;
  evidence: 'search_result' | 'opened';
  /** Bounded verbatim section excerpts, populated only after a server page fetch/verification. */
  originalPage?: VerifiedPatentPage;
};
export type VerifiedPatentPage = {
  publication: string;
  url: string;
  title: string;
  abstract: string;
  claims: string;
  description: string;
};
export type QueryCoverageStatus = 'MEASURED' | 'UNKNOWN' | 'NOT_EVALUABLE' | 'NOT_RUN';
export type ResponsesQueryCoverage = {
  status: Exclude<QueryCoverageStatus, 'MEASURED'>;
  queryCount: number | null;
  coveredQueryCount: null;
  coverageRatio: null;
  reason: 'RESPONSES_WEB_SEARCH_NO_RELIABLE_QUERY_ATTRIBUTION';
};
export type ResearchFactType = 'TECHNICAL_FEATURE' | 'STRUCTURAL_RELATION' | 'MOTION_RELATION' | 'PROBLEM' | 'EFFECT' | 'MATERIAL' | 'PARAMETER' | 'OTHER' | 'PRIOR_ART_FEATURE';
export const evidenceScopes = ['PATENT_ORIGINAL_TEXT', 'PATENT_CLAIMS', 'PATENT_DESCRIPTION', 'PATENT_ABSTRACT',
  'SEARCH_SNIPPET', 'CITED_ASSISTANT_SUMMARY', 'USER_PROVIDED', 'DOCUMENT_EXCERPT', 'INFERRED'] as const;
export type EvidenceScope = typeof evidenceScopes[number];
export type ResearchEvidenceScope = EvidenceScope;
export type PatentResearchFact = {
  /** Stable within one research response; never a user-structure identifier. */
  id?: string;
  /** Provider citation identity; never a user-structure identifier. */
  citationId?: string;
  /** All source publications that support this fact. sourceId remains the first source for compatibility. */
  sourceRefs?: string[];
  /** All provider citations that support this fact. citationId remains the first citation for compatibility. */
  citationRefs?: string[];
  sourceId?: string;
  sourceType?: 'PATENT';
  publication: string;
  sourceUrl: string;
  sourceTitle: string;
  originalText: string;
  extractedFact: string;
  factType?: ResearchFactType;
  confidence?: number;
  status?: 'SUPPORTED' | 'INFERRED' | 'UNSUPPORTED';
  evidenceScope?: ResearchEvidenceScope;
  relatedComponentIds?: string[];
  relatedConnectionIds?: string[];
  relatedMotionIds?: string[];
  relatedFigureIds?: string[];
  notes?: string;
};
export type SourcedPatentResearchFact = PatentResearchFact & {
  id: string;
  sourceId: string;
  sourceType: 'PATENT';
  factType: ResearchFactType;
  confidence: number;
  status: 'INFERRED';
  evidenceScope: ResearchEvidenceScope;
  relatedComponentIds: [];
  relatedConnectionIds: [];
  relatedMotionIds: [];
  relatedFigureIds: [];
};
export type PatentResearch = {
  query: string;
  queries: string[];
  summary: string;
  sources: PatentSource[];
  /** Prior-art facts from cited summaries or separately fetched and verified patent pages. */
  facts?: PatentResearchFact[];
  searchedAt: string;
  queryCoverage?: ResponsesQueryCoverage;
};
export type ProductConcept = {
  technicalField: string;
  structure: string;
  workingPrinciple: string;
  improvements: string[];
};
export function patentUrl(value: unknown): { url: string; publication: string } | null {
  if (typeof value !== 'string' || value.length > 1000) return null;
  try {
    const url = new URL(value);
    if (url.port || url.username || url.password) return null;
    // Search providers may cite a localized Google Patents page (for example
    // /fi, /ja, or /tr) or its legacy advanced-search path. Accept only the
    // fixed patent host and bounded page shapes, then normalize every citation
    // to the HTTPS /en page used for verification.
    const standard = url.hostname === 'patents.google.com' && /^\/patent\/([A-Z]{2}\d{4,16}[A-Z]\d?)\/(?:[a-z]{2}|adv_search\.asp)$/i.exec(url.pathname);
    if (standard && url.protocol === 'https:') return { url: `https://patents.google.com/patent/${standard[1]}/en`, publication: standard[1] };
    // The native provider occasionally emits the legacy Google Patents entry
    // point, including HTTP links returned by the provider. Normalize only its
    // exact publication path, then verify the fixed HTTPS page instead of
    // following the legacy URL redirect.
    const legacy = url.hostname === 'www.google.com' && /^\/patents\/([A-Z]{2}\d{4,16}[A-Z]\d?)$/.exec(url.pathname);
    return legacy ? { url: `https://patents.google.com/patent/${legacy[1]}/en`, publication: legacy[1] } : null;
  } catch { return null; }
}
const text = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const emptyIds = (value: unknown) => Array.isArray(value) && value.length === 0;

/**
 * A research fact is prior-art provenance only. It deliberately cannot refer to
 * the user's components, connections, motions or figures.
 */
export function isSourcedPatentResearchFact(value: unknown): value is SourcedPatentResearchFact {
  if (!value || typeof value !== 'object') return false;
  const fact = value as PatentResearchFact;
  const canonical = patentUrl(fact.sourceUrl);
  const sourceRefs = fact.sourceRefs === undefined ? [fact.sourceId] : fact.sourceRefs;
  const citationRefs = fact.citationRefs === undefined ? (fact.citationId ? [fact.citationId] : []) : fact.citationRefs;
  return typeof fact.id === 'string' && /^RSF-\d{3}$/u.test(fact.id) &&
    fact.sourceId === fact.publication && !!canonical && canonical.publication === fact.publication &&
    Array.isArray(sourceRefs) && sourceRefs.length >= 1 && sourceRefs.length <= 5 &&
    new Set(sourceRefs).size === sourceRefs.length && sourceRefs.every(ref => typeof ref === 'string' && text(ref, 120) && /^[A-Z]{2}\d{4,16}[A-Z]\d?$/u.test(ref)) &&
    sourceRefs.includes(fact.sourceId) &&
    text(fact.sourceTitle, 500) && text(fact.originalText, 12000) && text(fact.extractedFact, 3000) &&
    fact.originalText.includes(fact.extractedFact) && fact.factType === 'PRIOR_ART_FEATURE' &&
    fact.sourceType === 'PATENT' && fact.status === 'INFERRED' &&
    (fact.evidenceScope === 'CITED_ASSISTANT_SUMMARY' ||
      (fact.evidenceScope === 'PATENT_ORIGINAL_TEXT' && canonical.url === fact.sourceUrl &&
        sourceRefs.length === 1 && text(fact.citationId, 200) && Array.isArray(citationRefs) && citationRefs.length >= 1) ||
      (fact.evidenceScope === 'SEARCH_SNIPPET' && text(fact.citationId, 200) && citationRefs.length >= 1)) &&
    (fact.citationId === undefined || text(fact.citationId, 200)) &&
    Array.isArray(citationRefs) && citationRefs.length <= 10 &&
    new Set(citationRefs).size === citationRefs.length && citationRefs.every(ref => text(ref, 200)) &&
    (!fact.citationId || citationRefs.includes(fact.citationId)) &&
    typeof fact.confidence === 'number' && fact.confidence >= 0 && fact.confidence <= 1 &&
    emptyIds(fact.relatedComponentIds) && emptyIds(fact.relatedConnectionIds) && emptyIds(fact.relatedMotionIds) &&
    emptyIds(fact.relatedFigureIds) && (fact.notes === undefined || text(fact.notes, 1000));
}

/**
 * Convert cited assistant text into conservative prior-art facts. The source
 * scope remains explicit because the provider returned a cited summary, not a
 * complete patent claim or description.
 */
export type ResearchFactEntry = {
  source: PatentSource;
  sources?: PatentSource[];
  citedText: string;
  citationId?: string;
  citationIds?: string[];
  /** Only callers that explicitly know several citations support one fact may set this. */
  groupKey?: string;
  evidenceScope?: ResearchEvidenceScope;
};

export function extractResearchFacts(entries: ResearchFactEntry[]): PatentResearchFact[] {
  const facts: PatentResearchFact[] = [];
  const grouped = new Map<string, { source: PatentSource; sources: PatentSource[]; citedText: string; citationIds: string[]; evidenceScope: ResearchEvidenceScope }>();
  for (const [entryIndex, entry] of entries.entries()) {
    if (facts.length >= 20) break;
    const originalText = entry.citedText.trim();
    const evidenceScope = entry.evidenceScope || 'CITED_ASSISTANT_SUMMARY';
    // This entry point only receives provider prose/snippets, never fetched page text.
    if (!['CITED_ASSISTANT_SUMMARY', 'SEARCH_SNIPPET'].includes(evidenceScope)) continue;
    const rawSources = [entry.source, ...(entry.sources || [])];
    const sources = rawSources.map(source => {
      const canonical = patentUrl(source.url);
      return canonical ? { ...source, ...canonical } : null;
    }).filter((source): source is PatentSource => !!source && text(source.title, 500) && ['search_result', 'opened'].includes(source.evidence));
    const uniqueSources = sources.filter((source, index, all) => all.findIndex(value => value.publication === source.publication) === index);
    const citationIds = [entry.citationId, ...(entry.citationIds || [])].filter((citation): citation is string => typeof citation === 'string' && !!citation.trim())
      .map(citation => citation.trim()).filter((citation, index, all) => all.indexOf(citation) === index);
    if (!originalText || originalText.length > 12000 || !uniqueSources.length ||
        (evidenceScope === 'SEARCH_SNIPPET' && !citationIds.length)) continue;
    // Entries are independent by default. A provider must explicitly identify
    // a shared fact before multiple citations may be merged.
    const groupKey = typeof entry.groupKey === 'string' && entry.groupKey.trim() ? entry.groupKey.trim() : `entry-${entryIndex}`;
    const key = `${evidenceScope}\n${groupKey}`;
    const existing = grouped.get(key);
    if (existing) {
      for (const source of uniqueSources) if (!existing.sources.some(value => value.publication === source.publication)) existing.sources.push(source);
      for (const citation of citationIds) if (!existing.citationIds.includes(citation)) existing.citationIds.push(citation);
      continue;
    }
    grouped.set(key, { source: uniqueSources[0], sources: uniqueSources, citedText: originalText, citationIds, evidenceScope });
  }
  for (const entry of grouped.values()) {
    if (facts.length >= 20) break;
    const extractedFact = entry.citedText.slice(0, 2000).trim();
    if (!extractedFact) continue;
    const sourceRefs = entry.sources.map(source => source.publication);
    const citationId = entry.citationIds[0];
    facts.push({
      id: `RSF-${String(facts.length + 1).padStart(3, '0')}`,
      ...(citationId ? { citationId } : {}),
      ...(sourceRefs.length ? { sourceRefs } : {}),
      ...(entry.citationIds.length ? { citationRefs: entry.citationIds } : {}),
      sourceId: entry.source.publication,
      sourceType: 'PATENT',
      publication: entry.source.publication,
      sourceUrl: entry.source.url,
      sourceTitle: entry.source.title,
      originalText: entry.citedText,
      extractedFact,
      factType: 'PRIOR_ART_FEATURE',
      confidence: entry.sources.every(source => source.evidence === 'opened') ? 0.7 : 0.6,
      status: 'INFERRED',
      evidenceScope: entry.evidenceScope,
      relatedComponentIds: [],
      relatedConnectionIds: [],
      relatedMotionIds: [],
      relatedFigureIds: [],
      notes: '这是带引用的 AI 检索归纳，未取得专利原文；仅供问题与差异推理，不是已核实事实或用户产品结构依据。',
    });
  }
  return facts;
}

/** Serialization checks preserve provenance; they are not a substitute for server-side fetching. */
export function isVerifiedPatentSource(source: PatentSource): boolean {
  const page = source?.originalPage;
  const canonical = patentUrl(source?.url);
  return !!page && !!canonical && source.evidence === 'opened' && canonical.url === source.url &&
    canonical.publication === source.publication && page.publication === source.publication && page.url === source.url &&
    page.title === source.title && text(page.title, 500) &&
    text(page.abstract, 3500) && text(page.claims, 3500) && text(page.description, 3500);
}
export function verifiedPatentPageText(page: VerifiedPatentPage): string {
  return `Abstract: ${page.abstract}
Claims: ${page.claims}
Description: ${page.description}`;
}
export function factMatchesOriginalPage(fact: PatentResearchFact, sources: PatentSource[]): boolean {
  const source = sources.find(source => source?.publication === fact.sourceId && source.url === fact.sourceUrl);
  return !!source && isVerifiedPatentSource(source) && fact.sourceTitle === source.title &&
    fact.originalText === verifiedPatentPageText(source.originalPage!) &&
    source.originalPage!.abstract.includes(fact.extractedFact);
}

/** Dedicated verified-page entry point. Never accepts cited assistant text. */
export function extractVerifiedPatentFacts(entries: Array<{ source: PatentSource; citationIds: string[] }>): PatentResearchFact[] {
  return entries.slice(0, 20).flatMap(({ source, citationIds }, index) => {
    if (!isVerifiedPatentSource(source)) return [];
    const page = source.originalPage!;
    const fact: PatentResearchFact = {
      id: `RSF-${String(index + 1).padStart(3, '0')}`, sourceId: source.publication,
      publication: source.publication, sourceTitle: source.title, sourceUrl: source.url,
      sourceRefs: [source.publication], citationId: citationIds[0], citationRefs: [...new Set(citationIds)],
      originalText: verifiedPatentPageText(page), extractedFact: page.abstract.slice(0, 2000).trim(),
      sourceType: 'PATENT', factType: 'PRIOR_ART_FEATURE', status: 'INFERRED', confidence: 0.7,
      evidenceScope: 'PATENT_ORIGINAL_TEXT', relatedComponentIds: [], relatedConnectionIds: [],
      relatedMotionIds: [], relatedFigureIds: [],
      notes: '摘自实际获取并核验身份及正文的专利页面（保留有界原文片段）；仅为现有技术参考，不证明用户产品结构、可行性或新颖性。',
    };
    return isSourcedPatentResearchFact(fact) && factMatchesOriginalPage(fact, [source]) ? [fact] : [];
  });
}

function isLegacyPatentResearchFact(value: unknown): value is PatentResearchFact {
  if (!value || typeof value !== 'object') return false;
  const fact = value as PatentResearchFact;
  const canonical = patentUrl(fact.sourceUrl);
  return fact.id === undefined && fact.sourceId === undefined && fact.status === undefined && fact.evidenceScope === undefined &&
    !!canonical && canonical.publication === fact.publication &&
    text(fact.sourceTitle, 500) && text(fact.originalText, 12000) && text(fact.extractedFact, 3000) &&
    fact.extractedFact.length <= fact.originalText.length;
}
export function isProductConcept(value: unknown): value is ProductConcept {
  if (!value || typeof value !== 'object') return false;
  const c = value as ProductConcept;
  return text(c.technicalField, 2000) && text(c.structure, 10000) && text(c.workingPrinciple, 10000) &&
    Array.isArray(c.improvements) && c.improvements.length > 0 && c.improvements.length <= 10 && c.improvements.every(v => text(v, 1000));
}
export function isResponsesQueryCoverage(value: unknown, queryCount: number): value is ResponsesQueryCoverage {
  if (!value || typeof value !== 'object') return false;
  const coverage = value as ResponsesQueryCoverage;
  return coverage.status === 'UNKNOWN' && coverage.queryCount === queryCount && coverage.coveredQueryCount === null &&
    coverage.coverageRatio === null && coverage.reason === 'RESPONSES_WEB_SEARCH_NO_RELIABLE_QUERY_ATTRIBUTION';
}
export function isPatentResearch(value: unknown): value is PatentResearch {
  if (!value || typeof value !== 'object') return false;
  const r = value as PatentResearch;
  const factsValid = r.facts === undefined || (
    Array.isArray(r.facts) && r.facts.length <= 20 &&
    new Set(r.facts.map(fact => fact?.id).filter((id): id is string => typeof id === 'string')).size === r.facts.filter(fact => typeof fact?.id === 'string').length &&
    r.facts.every(fact => (isSourcedPatentResearchFact(fact) || isLegacyPatentResearchFact(fact)) &&
      r.sources?.some(source => source?.publication === fact.publication && source.url === patentUrl(fact.sourceUrl)?.url) &&
      (fact.evidenceScope !== 'PATENT_ORIGINAL_TEXT' || factMatchesOriginalPage(fact, r.sources)) &&
      (fact.sourceRefs === undefined || fact.sourceRefs.every(ref => r.sources.some(source => source.publication === ref))))
  );
  const coverageValid = r.queryCoverage === undefined || isResponsesQueryCoverage(r.queryCoverage, r.queries?.length);
  return coverageValid && text(r.query, 2200) && text(r.summary, 12000) && typeof r.searchedAt === 'string' && Number.isFinite(Date.parse(r.searchedAt)) && factsValid &&
    Array.isArray(r.queries) && r.queries.length > 0 && r.queries.length <= 10 && r.queries.every(v => text(v, 1000)) &&
    Array.isArray(r.sources) && r.sources.length > 0 && r.sources.length <= 5 &&
    new Set(r.sources.map(s => s?.publication)).size === r.sources.length && r.sources.every(s => {
      const canonical = patentUrl(s?.url);
      return !!canonical && canonical.url === s.url && canonical.publication === s.publication && text(s.title, 500) && ['search_result', 'opened'].includes(s.evidence) &&
        (s.originalPage === undefined || isVerifiedPatentSource(s));
    });
}
