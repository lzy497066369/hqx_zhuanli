export const stageFixtureSecrets = Object.freeze({
  query: 'OFFLINE_QUERY_SECRET', id: 'OFFLINE_TOOL_ID_SECRET', token: 'OFFLINE_TOKEN_SECRET',
  apiKey: 'OFFLINE_API_KEY_SECRET', fragment: 'OFFLINE_FRAGMENT_SECRET',
  username: 'OFFLINE_USER_SECRET', password: 'OFFLINE_PASSWORD_SECRET', error: 'OFFLINE_ERROR_SECRET',
});

export function responsesStageFixture() {
  return {
    object: 'response', status: 'completed', output: [
      { type: 'web_search_call', status: 'completed', id: stageFixtureSecrets.id,
        action: { type: 'search', query: stageFixtureSecrets.query, sources: [
          { type: 'url', url: 'https://patents.google.com/patent/CN217307583U/zh', title: 'Offline patent fixture' },
          { type: 'url', url: 'https://example.com/reference', title: 'Offline non-patent fixture' },
        ] } },
      { type: 'message', role: 'assistant', status: 'completed', content: [
        { type: 'output_text', text: 'Offline placeholder only.', annotations: [] },
      ] },
    ] as Record<string, unknown>[],
  };
}

export function stageSearchCall(action: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { type: 'web_search_call', status: 'completed', id: stageFixtureSecrets.id, action, ...extra };
}

/** A tripwire independent of the observer: no assistant content may be read. */
export function poisonAssistantContent(payload: ReturnType<typeof responsesStageFixture>) {
  const trap = { reads: 0 };
  const message = payload.output.find(item => item.type === 'message');
  if (!message) throw new Error('ASSISTANT_FIXTURE_REQUIRED');
  Object.defineProperty(message, 'content', { get() { trap.reads++; throw new Error('ASSISTANT_CONTENT_ENTERED'); } });
  return trap;
}
