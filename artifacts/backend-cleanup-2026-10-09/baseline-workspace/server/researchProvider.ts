import type { DrawingPlanInput } from '../src/features/utility/aiDrawing.ts';
import { extractResearchFacts, isPatentResearch, patentUrl } from '../src/features/utility/patentResearch.ts';
import type { PatentResearch, PatentSource } from '../src/features/utility/patentResearch.ts';
import { AiFailure, AI_USER_AGENT, responseText } from './aiSupport.ts';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const records = (value: unknown) => Array.isArray(value) ? value.map(record) : [];
const nonempty = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
const unverified = () => new AiFailure(502, 'RESEARCH_UNVERIFIED', '检索工具、来源和引用未通过核对，未生成产品方案。');
const fetchFailed = () => new AiFailure(502, 'EVIDENCE_FETCH_FAILED', '无法读取并核对专利页面原文，未生成产品方案。');

function stableCitationHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function looksLikePatentUrl(value: unknown) {
  return typeof value === 'string' && /\/patents?\//i.test(value);
}

function plainText(html: string) {
  return html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos);|&#(?:\d+|x[\da-f]+);/gi, entity => {
      const named: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
      if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
      const code = entity.toLowerCase().startsWith('&#x') ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
    }).replace(/\s+/g, ' ').trim();
}

/** Fixed-host, non-redirecting fetch. No provider credentials are sent to patent pages. */
export async function verifyPatentPage(source: PatentSource, fetcher: typeof fetch, signal: AbortSignal) {
  const canonical = patentUrl(source.url);
  if (!canonical || canonical.url !== source.url) throw fetchFailed();
  try {
    const response = await fetcher(canonical.url, { method: 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: { 'User-Agent': AI_USER_AGENT, Accept: 'text/html' } });
    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('text/html') || response.redirected) {
      await response.body?.cancel().catch(() => {});
      throw fetchFailed();
    }
    const html = await responseText(response, 2 * 1024 * 1024);
    const publication = html.match(/<(dd|span)\b[^>]*\bitemprop=["']publicationNumber["'][^>]*>([\s\S]*?)<\/\1>/i)?.[2];
    const title = html.match(/<meta\b[^>]*\bname=["']DC\.title["'][^>]*\bcontent=["']([^"']+)["']/i)?.[1];
    const section = (name: string) => plainText(html.match(new RegExp(`<section\\b[^>]*\\bitemprop=["']${name}["'][^>]*>([\\s\\S]*?)<\\/section>`, 'i'))?.[1]?.replace(/<h2\b[^>]*>[\s\S]*?<\/h2>/gi, '') || '');
    const abstract = section('abstract'), claims = section('claims'), description = section('description');
    if (plainText(publication || '') !== canonical.publication || !title || !abstract || !claims || !description) throw fetchFailed();
    return { publication: canonical.publication, title: plainText(title), abstract, claims, description };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof AiFailure && error.code === 'EVIDENCE_FETCH_FAILED') throw error;
    throw fetchFailed();
  }
}

export type NativeResearchDiagnostics = {
  searchActionCount: number; searchResultCount: number; qualifiedPatentResultCount: number;
  queryCount: number; coveredQueryCount: number; citationCount: number;
  originalPageCount: number; verifiedSourceCount: number; factCount: number;
  failureStage?: string; failureReason?: string;
  toolResultFailureReason?: NativeResearchToolResultFailureReason;
  toolResultDiagnostics?: NativeResearchToolResultDiagnostic[];
  responsesToolResultDiagnostics?: ResponsesResearchToolResultDiagnostic;
};

type ResponsesErrorDiagnostic = { errorPresent: boolean; errorType: string | null; errorCode: string | null };
type ResponsesLocationDiagnostic = { hostname: string; pathname: string };
export type ResponsesResearchToolResultDiagnostic = ResponsesErrorDiagnostic & {
  responseType: string;
  responseStatus: string;
  outputIsArray: boolean;
  outputItemCount: number;
  outputItemTypes: string[];
  webSearchCallCount: number;
  webSearchCallTypes: string[];
  webSearchCallIdsPresent: boolean[];
  webSearchCallIdLengths: number[];
  errors: ResponsesErrorDiagnostic[];
  webSearchCalls: Array<ResponsesErrorDiagnostic & {
    callStatus: string;
    actionType: string;
    actionQueryPresent: boolean;
    queryPresent: boolean;
    queryLength: number;
    queriesIsArray: boolean;
    queryLengths: number[];
    sourcesIsArray: boolean;
    sourceCount: number;
    sourceTypes: string[];
    sources: ResponsesLocationDiagnostic[];
    openedLocation?: ResponsesLocationDiagnostic;
  }>;
};

const responsesEnum = (value: unknown, allowed: readonly string[]) => typeof value === 'string' && allowed.includes(value) ? value : '[unknown]';
const responsesStatus = (value: unknown) => responsesEnum(value, ['completed', 'failed', 'incomplete', 'in_progress', 'searching', 'queued']);
function responsesError(value: unknown): ResponsesErrorDiagnostic {
  const errorPresent = value !== undefined && value !== null;
  const error = record(value);
  return { errorPresent,
    errorType: errorPresent ? responsesEnum(error.type, ['error', 'invalid_request_error', 'server_error', 'rate_limit_error', 'authentication_error', 'permission_error']) : null,
    errorCode: errorPresent ? responsesEnum(error.code, ['server_error', 'rate_limit_exceeded', 'invalid_request', 'invalid_api_key', 'model_not_found', 'unsupported_tool', 'unsupported_model', 'unsupported_endpoint', 'unavailable']) : null };
}
function responsesLocation(value: unknown): ResponsesLocationDiagnostic[] {
  if (typeof value !== 'string') return [];
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? [{ hostname: url.hostname, pathname: url.pathname }] : [];
  } catch { return []; }
}

/** Observe only the existing Responses parser's fields; never emit provider-controlled free text. */
export function summarizeResponsesResearchToolResult(payload: unknown): ResponsesResearchToolResultDiagnostic {
  const data = record(payload);
  const output = records(data.output);
  const calls = output.filter(item => item.type === 'web_search_call');
  const errors = [responsesError(data.error), ...output.map(item => responsesError(item.type === 'error' ? item : item.error))]
    .filter(error => error.errorPresent);
  const webSearchCalls = calls.map(call => {
    const action = record(call.action);
    const queryLengths = Array.isArray(action.queries) ? action.queries.filter((query): query is string => typeof query === 'string').map(query => query.length) : [];
    const queryPresent = typeof action.query === 'string' && action.query.length > 0;
    const sources = records(action.sources);
    const openedLocation = action.type === 'open_page' ? responsesLocation(action.url)[0] : undefined;
    return { callStatus: responsesStatus(call.status), actionType: responsesEnum(action.type, ['search', 'open_page', 'find_in_page']),
      actionQueryPresent: queryPresent || queryLengths.some(length => length > 0), queryPresent,
      queryLength: typeof action.query === 'string' ? action.query.length : 0,
      queriesIsArray: Array.isArray(action.queries), queryLengths,
      sourcesIsArray: Array.isArray(action.sources), sourceCount: sources.length,
      sourceTypes: sources.map(source => responsesEnum(source.type, ['url'])),
      sources: sources.flatMap(source => responsesLocation(source.url)),
      ...(openedLocation ? { openedLocation } : {}), ...responsesError(call.error) };
  });
  return { responseType: data.object !== undefined || data.type !== undefined ? responsesEnum(data.object ?? data.type, ['response']) : contentType(payload),
    responseStatus: responsesStatus(data.status), outputIsArray: Array.isArray(data.output), outputItemCount: output.length,
    outputItemTypes: output.map(item => responsesEnum(item.type, ['web_search_call', 'message', 'reasoning', 'function_call', 'error'])),
    webSearchCallCount: calls.length, webSearchCallTypes: calls.map(() => 'web_search_call'),
    webSearchCallIdsPresent: calls.map(call => typeof call.id === 'string' && call.id.length > 0),
    webSearchCallIdLengths: calls.map(call => typeof call.id === 'string' ? call.id.length : 0),
    ...(errors[0] || responsesError(undefined)), errors, webSearchCalls };
}

export type NativeResearchToolResultFailureReason = 'CONTENT_NOT_ARRAY' | 'TOOL_RESULT_ERROR' | 'TOOL_USE_ID_MISMATCH' | 'UNKNOWN_CONTENT_ITEM';

export type NativeResearchToolResultDiagnostic = {
  blockType: string;
  toolUseIdPresent: boolean;
  toolUseIdLength: number;
  toolUseIdMatched: boolean;
  contentType: string;
  contentIsArray: boolean;
  contentItemCount: number;
  contentItemTypes: string[];
  toolResultErrorCodes: string[];
  searchResultCount: number;
  searchResultTypes: string[];
  searchResultHostnames: string[];
  searchResultPathnames: string[];
  toolResultFailureReason?: NativeResearchToolResultFailureReason;
};

const safeDiagnosticType = (value: unknown) => typeof value === 'string' && value.length <= 100 ? value : '[unknown]';
const knownToolResultErrorCodes = new Set(['unavailable']);
const safeToolResultErrorCode = (value: unknown) => typeof value === 'string' && knownToolResultErrorCodes.has(value) ? value : '[unknown]';

function contentType(value: unknown) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function safeResultLocation(value: unknown) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return { hostname: url.hostname, pathname: url.pathname };
  } catch {
    return undefined;
  }
}

export function summarizeAnthropicToolResult(block: Record<string, unknown>, expectedToolIds: ReadonlySet<string>): NativeResearchToolResultDiagnostic {
  const toolUseId = block.tool_use_id;
  const toolUseIdPresent = typeof toolUseId === 'string';
  const toolUseIdMatched = toolUseIdPresent && expectedToolIds.has(toolUseId);
  const content = block.content;
  const items = Array.isArray(content) ? records(content) : [];
  const contentItemTypes = items.map(item => safeDiagnosticType(item.type));
  const errorItems = items.filter(item => item.type === 'web_search_tool_result_error');
  const searchItems = items.filter(item => item.type === 'web_search_result');
  const locations = searchItems.map(item => safeResultLocation(item.url)).filter((location): location is { hostname: string; pathname: string } => !!location);
  const unknownItem = contentItemTypes.some(type => type !== 'web_search_result' && type !== 'web_search_tool_result_error');
  const failureReason = !toolUseIdMatched ? 'TOOL_USE_ID_MISMATCH' : !Array.isArray(content) ? 'CONTENT_NOT_ARRAY'
    : errorItems.length ? 'TOOL_RESULT_ERROR' : unknownItem ? 'UNKNOWN_CONTENT_ITEM' : undefined;
  const diagnostic: NativeResearchToolResultDiagnostic = {
    blockType: safeDiagnosticType(block.type),
    toolUseIdPresent,
    toolUseIdLength: typeof toolUseId === 'string' ? toolUseId.length : 0,
    toolUseIdMatched,
    contentType: contentType(content),
    contentIsArray: Array.isArray(content),
    contentItemCount: items.length,
    contentItemTypes,
    toolResultErrorCodes: errorItems.map(item => safeToolResultErrorCode(item.error_code)),
    searchResultCount: searchItems.length,
    searchResultTypes: searchItems.map(item => safeDiagnosticType(item.type)),
    searchResultHostnames: [...new Set(locations.map(location => location.hostname))],
    searchResultPathnames: [...new Set(locations.map(location => location.pathname))],
    ...(failureReason ? { toolResultFailureReason: failureReason } : {}),
  };
  return diagnostic;
}

function logResearchFailure(diagnostics: NativeResearchDiagnostics) {
  console.warn('research gate', {
    failureStage: diagnostics.failureStage,
    failureReason: diagnostics.failureReason,
    searchActionCount: diagnostics.searchActionCount,
    searchResultCount: diagnostics.searchResultCount,
    qualifiedPatentResultCount: diagnostics.qualifiedPatentResultCount,
    queryCount: diagnostics.queryCount,
    coveredQueryCount: diagnostics.coveredQueryCount,
    citationCount: diagnostics.citationCount,
    originalPageCount: diagnostics.originalPageCount,
    verifiedSourceCount: diagnostics.verifiedSourceCount,
    factCount: diagnostics.factCount,
    ...(diagnostics.toolResultFailureReason ? { toolResultFailureReason: diagnostics.toolResultFailureReason } : {}),
    ...(diagnostics.toolResultDiagnostics?.length ? { toolResultDiagnostics: diagnostics.toolResultDiagnostics } : {}),
  });
}

/**
 * Native tool blocks are parsed as native blocks, never fabricated Responses actions.
 * The current Evidence validator admits only INFERRED cited summaries. Retrieved
 * patent text verifies the page, but is NOT relabelled or injected into that scope.
 */
export async function parseAnthropicResearch(payload: unknown, input: DrawingPlanInput, fetcher: typeof fetch, signal: AbortSignal,
  diagnostics: NativeResearchDiagnostics): Promise<PatentResearch> {
  const fail = (stage: string, reason: string): never => {
    diagnostics.failureStage = stage;
    diagnostics.failureReason = reason;
    logResearchFailure(diagnostics);
    throw unverified();
  };
  const data = record(payload);
  if (data.type !== 'message' || data.role !== 'assistant' || data.stop_reason !== 'end_turn' || !Array.isArray(data.content)) fail('message-shape', 'MESSAGE_SHAPE_INVALID');
  const blocks = records(data.content);
  const uses = new Map<string, string>();
  const found = new Map<string, PatentSource>();
  const queries: string[] = [];
  const covered = new Set<string>();
  for (const block of blocks) {
    if (block.type === 'server_tool_use' && block.name === 'web_search' && nonempty(block.id, 200) && nonempty(record(block.input).query, 1000)) {
      if (uses.has(block.id)) fail('duplicate-tool-use', 'DUPLICATE_TOOL_USE');
      const query = (record(block.input).query as string).trim();
      uses.set(block.id, query);
      diagnostics.searchActionCount++;
      if (!queries.includes(query)) queries.push(query);
    }
    if (block.type === 'web_search_tool_result') {
      const toolResultDiagnostic = summarizeAnthropicToolResult(block, new Set(uses.keys()));
      (diagnostics.toolResultDiagnostics ||= []).push(toolResultDiagnostic);
      if (toolResultDiagnostic.toolResultFailureReason) diagnostics.toolResultFailureReason = toolResultDiagnostic.toolResultFailureReason;
    }
    if (block.type !== 'web_search_tool_result' || typeof block.tool_use_id !== 'string' || !uses.has(block.tool_use_id)) continue;
    const query = uses.get(block.tool_use_id)!;
    uses.delete(block.tool_use_id);
    if (!Array.isArray(block.content) || records(block.content).some(item => item.type === 'web_search_tool_result_error')) fail('tool-result', 'TOOL_RESULT_INVALID');
    let count = 0;
    for (const item of records(block.content)) {
      if (item.type === 'web_search_result') diagnostics.searchResultCount++;
      const canonical = patentUrl(item.url);
      if (item.type !== 'web_search_result' || !canonical || !nonempty(item.title, 500)) continue;
      found.set(canonical.url, { ...canonical, title: item.title.trim(), evidence: 'search_result' });
      count++;
    }
    if (count) covered.add(query);
  }
  diagnostics.qualifiedPatentResultCount = found.size;
  diagnostics.queryCount = queries.length;
  diagnostics.coveredQueryCount = covered.size;
  if (!diagnostics.searchActionCount) fail('search-results', 'SEARCH_ACTION_MISSING');
  if (!found.size) fail('search-results', 'PATENT_RESULTS_MISSING');
  if (queries.length > 10 || covered.size !== queries.length) fail('search-results', 'QUERY_COVERAGE_INSUFFICIENT');
  // Keep each citation attached to its own source. cited_text may be only a
  // search snippet/title; it is not patent original text and must not be
  // replaced with the assistant's complete summary.
  const cited: Array<{ source: PatentSource; citedText: string; citationId: string }> = [];
  const citedKeys = new Set<string>();
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type !== 'text') continue;
    if (nonempty(block.text, 12000)) texts.push(block.text);
    if (block.citations !== undefined && !Array.isArray(block.citations)) fail('citation-mapping', 'CITATION_MAPPING_FAILED');
    for (const citation of records(block.citations)) {
      const canonical = patentUrl(citation.url);
      if (citation.type !== 'web_search_result_location') continue;
      if (!canonical) {
        if (looksLikePatentUrl(citation.url)) fail('citation-mapping', 'CITATION_MAPPING_FAILED');
        continue;
      }
      if (!found.has(canonical.url)) fail('citation-mapping', 'CITATION_MAPPING_FAILED');
      const citationText = citation.cited_text;
      if (!nonempty(citationText, 12000)) fail('citation-mapping', 'CITATION_MAPPING_FAILED');
      const citedText = (citationText as string).trim();
      const key = `${canonical.url}\n${citedText}`;
      if (citedKeys.has(key)) continue;
      citedKeys.add(key);
      cited.push({
        source: found.get(canonical.url)!,
        citedText,
        citationId: `ANTHROPIC-${canonical.publication}-${stableCitationHash(key)}`,
      });
    }
  }
  diagnostics.citationCount = cited.length;
  if (!texts.length || !cited.length) fail('citation-mapping', 'CITATION_MAPPING_FAILED');
  // Assistant prose is not a provenance boundary. Only citation excerpts can
  // seed downstream summaries/facts, and each excerpt must identify at most
  // the patent to which the provider attached it.
  const selected: typeof cited = [];
  const selectedSources = new Set<string>();
  for (const citation of cited) {
    const publications = citation.citedText.match(/\b[A-Z]{2}\d{4,16}[A-Z]\d?\b/gi) || [];
    if (publications.some(publication => publication.toUpperCase() !== citation.source.publication.toUpperCase())) continue;
    if (!selectedSources.has(citation.source.url) && selectedSources.size >= 5) continue;
    if (selected.length >= 20) break;
    selectedSources.add(citation.source.url);
    selected.push(citation);
  }
  if (!selected.length) fail('citation-mapping', 'CITATION_MAPPING_FAILED');
  const verifiedSources: PatentSource[] = [];
  const verified = new Set<string>();
  for (const citation of selected) {
    if (verified.has(citation.source.url)) continue;
    let page: Awaited<ReturnType<typeof verifyPatentPage>>;
    try {
      page = await verifyPatentPage(citation.source, fetcher, signal);
    } catch (error) {
      if (error instanceof AiFailure && error.code === 'EVIDENCE_FETCH_FAILED') {
        diagnostics.failureStage = 'patent-page-fetch';
        diagnostics.failureReason = 'PATENT_PAGE_FETCH_FAILED';
        logResearchFailure(diagnostics);
      }
      throw error;
    }
    diagnostics.originalPageCount++;
    diagnostics.verifiedSourceCount++;
    citation.source.title = page.title;
    citation.source.evidence = 'opened';
    verified.add(citation.source.url);
    verifiedSources.push(citation.source);
  }
  // Preserve the existing extractor and validator; no original-text / SUPPORTED upgrade.
  const facts = extractResearchFacts(selected.map(citation => ({
    source: citation.source,
    citedText: citation.citedText,
    citationId: citation.citationId,
    evidenceScope: 'SEARCH_SNIPPET' as const,
  })));
  diagnostics.factCount = facts.length;
  for (const fact of facts) fact.notes = '已读取专利页面核对来源；此事实仍是对应 citation 的搜索摘要，不是专利原文摘录，仅供现有技术参考，不是用户结构事实。';
  const summary = facts.map(fact => `[${fact.publication}] ${fact.extractedFact.slice(0, 500)}`).join('\n');
  const research: PatentResearch = { query: `${input.title}\n${input.technicalField}`.trim(), queries, summary, sources: verifiedSources, facts, searchedAt: new Date().toISOString() };
  if (!isPatentResearch(research) || !facts.length) fail('research-validation', 'RESEARCH_VALIDATION_FAILED');
  return research;
}
