export const syntheticSecrets = {
  id: 'CALL_ID_PRIVATE_FIXTURE', query: 'QUERY_PRIVATE_FIXTURE',
  apiKey: 'API_KEY_PRIVATE_FIXTURE', token: 'TOKEN_PRIVATE_FIXTURE',
  username: 'USERNAME_PRIVATE_FIXTURE', password: 'PASSWORD_PRIVATE_FIXTURE',
  fragment: 'FRAGMENT_PRIVATE_FIXTURE', message: 'ERROR_MESSAGE_PRIVATE_FIXTURE',
};
export function responsesDiagnosticsFixture() {
  const url = 'https://patents.google.com/patent/CN217307583U/zh';
  return { object: 'response', status: 'completed', output: [
    { type: 'web_search_call', id: syntheticSecrets.id, status: 'completed', action: {
      type: 'search', query: syntheticSecrets.query, queries: [syntheticSecrets.query],
      sources: [{ type: 'url', url }, { type: 'url', url: 'https://patents.google.com/patent/CN218000001U/en' }],
    } },
    { type: 'web_search_call', id: `${syntheticSecrets.id}_OPEN`, status: 'completed', action: { type: 'open_page', url } },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
      text: '测试检索归纳：檩条与固定支架配合。', annotations: [{ type: 'url_citation', title: '光伏组件的安装支架', url }],
    }] },
  ] };
}
