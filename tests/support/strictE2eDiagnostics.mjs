const errorTypes = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'AbortError', 'TimeoutError']);
const errorCodes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EADDRINUSE', 'ENOTFOUND',
  'ERR_OUTDATED_OPTIMIZED_DEP', 'ERR_INVALID_URL', 'ERR_MODULE_NOT_FOUND'];

// Never persist messages or raw stacks: they can contain credentials and response bodies.
export function serverDiagnostic(args, state, callerStack = '') {
  const error = args.find(value => value instanceof Error);
  const text = args.filter(value => typeof value === 'string').join('\n');
  const stack = `${error?.stack || ''}\n${callerStack}\n${text}`;
  const location = stack.match(/(?:^|[/\s(])((?:server|tests|node_modules\/vite)\/[A-Za-z0-9_./-]+):([0-9]+):([0-9]+)/u);
  const code = errorCodes.find(value => error?.code === value || new RegExp(`\\b${value}\\b`, 'u').test(text)) || 'UNCLASSIFIED_SERVER_ERROR';
  return { type: 'server-error', errorType: errorTypes.has(error?.name) ? error.name : 'Error', errorCode: code,
    source: location ? `${location[1]}:${location[2]}:${location[3]}` : 'server-console',
    stage: state.generationRequests ? 'generation' : state.researchRequests ? 'research' : 'before-research-dispatch',
    requestStarted: state.researchRequests + state.generationRequests > 0,
    providerRequestFailed: state.providerRequestFailed, httpStatus: null };
}

export function createServerErrorObserver(transport, record) {
  return (...args) => record(serverDiagnostic(args, transport.state, new Error().stack));
}

export function createStrictLogObservers(transport, record) {
  const diagnosticKeys = ['failureStage', 'failureReason', 'searchActionCount', 'searchResultCount',
    'qualifiedPatentResultCount', 'queryCount', 'coveredQueryCount', 'citationCount', 'originalPageCount', 'verifiedSourceCount', 'factCount'];
  const safeValue = value => typeof value === 'number' && Number.isFinite(value) ||
    typeof value === 'string' && /^[A-Z_a-z-]{1,100}$/u.test(value);
  return {
    error: createServerErrorObserver(transport, record),
    log: () => {},
    info: (...args) => {
      if (args.length !== 1 || typeof args[0] !== 'string') return;
      let entry;
      try { entry = JSON.parse(args[0]); } catch { return; }
      transport.diagnostic(entry);
    },
    warn: (label, entry) => {
      if (label === 'research gate' && entry && typeof entry === 'object') {
        record({ type: 'research-diagnostics', ...Object.fromEntries(diagnosticKeys.filter(key =>
          safeValue(entry[key])).map(key => [key, entry[key]])) });
        if (entry.failureStage) transport.halt('RESEARCH_GATE_BLOCKED');
      }
      if (label === 'patent-structure stage' && entry && typeof entry === 'object') {
        record({ type: 'structure-stage', ...Object.fromEntries(['stage', 'httpStatus', 'outcome'].filter(key =>
          entry[key] === null || safeValue(entry[key])).map(key => [key, entry[key]])) });
        if (entry.stage === 'research' && entry.outcome !== 'completed') transport.halt('RESEARCH_STAGE_BLOCKED');
      }
    },
  };
}

export async function startIsolatedServer(createServer, options, transport, record) {
  let server;
  try {
    server = await createServer(options);
    await server.listen();
    return server;
  } catch (error) {
    transport?.halt('SERVER_STARTUP_FAILED');
    record({ ...serverDiagnostic([error], transport?.state || { researchRequests: 0, generationRequests: 0,
      providerRequestFailed: false }), type: 'test-abort', stage: 'server-startup', code: 'SERVER_STARTUP_FAILED' });
    await server?.close();
    throw new Error('SERVER_STARTUP_FAILED');
  }
}
