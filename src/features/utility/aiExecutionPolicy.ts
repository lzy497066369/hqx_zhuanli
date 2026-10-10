/** Explicit real-E2E policy; ordinary production leaves it unset. */
export const STRICT_E2E_POLICY = Object.freeze({
  maxAttempts: 1,
  allowProviderFallback: false,
  allowProviderRotation: false,
} as const);
export type AIExecutionPolicy = typeof STRICT_E2E_POLICY;
