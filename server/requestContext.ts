import type { IncomingMessage } from 'node:http';

export type RequestContext = { userId: string; workspaceId?: string };
// Server-only state: never trust a browser-supplied owner or user ID.
const contexts = new WeakMap<IncomingMessage, RequestContext>();
export function setRequestContext(req: IncomingMessage, context: RequestContext) { contexts.set(req, context); }
export function requestContext(req: IncomingMessage): RequestContext | undefined { return contexts.get(req); }
