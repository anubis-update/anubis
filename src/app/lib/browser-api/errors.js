/**
 * Error model of the Anubis Browser API v1 (see SPEC-v1 §6).
 * `ApiError.code` is one of common.schema.json#/$defs/errorCode.
 */

const HTTP_STATUS = {
  INVALID_REQUEST: 400,
  UNKNOWN_COMMAND: 400,
  UNSUPPORTED_VERSION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  POLICY_DENIED: 403,
  CONFIRMATION_REJECTED: 403,
  CREDENTIAL_DOMAIN_MISMATCH: 403,
  BROWSER_NOT_FOUND: 404,
  PROFILE_NOT_FOUND: 404,
  TAB_NOT_FOUND: 404,
  ELEMENT_NOT_FOUND: 404,
  CREDENTIAL_NOT_FOUND: 404,
  BROWSER_CLOSED: 409,
  TIMEOUT: 408,
  CANCELLED: 409,
  CONFIRMATION_TIMEOUT: 504,
  IDEMPOTENCY_CONFLICT: 409,
  STALE_REF: 409,
  PROFILE_LOCKED: 409,
  BROWSER_ALREADY_RUNNING: 409,
  LEASE_REQUIRED: 409,
  LEASE_EXPIRED: 409,
  BUSY: 409,
  ELEMENT_NOT_ACTIONABLE: 409,
  CAPABILITY_MISSING: 412,
  NOT_SUPPORTED_BY_ENGINE: 412,
  NOT_SUPPORTED_BY_BROWSER_VERSION: 412,
  USER_CONTEXT_REQUIRED: 412,
  CONFIRMATION_REQUIRED: 202,
  NAVIGATION_FAILED: 422,
  EXTENSION_REJECTED: 422,
  RATE_LIMITED: 429,
  LIMIT_EXCEEDED: 429,
  INTERNAL: 500
}

const RETRYABLE = new Set(['STALE_REF', 'BUSY', 'RATE_LIMITED', 'TIMEOUT', 'LEASE_EXPIRED'])

class ApiError extends Error {
  constructor (code, message, { details, retryable, retryAfterMs } = {}) {
    super(message || code)
    this.name = 'ApiError'
    this.code = code
    this.retryable = retryable !== undefined ? !!retryable : RETRYABLE.has(code)
    if (details !== undefined) this.details = details
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
  }
}

function apiError (code, message, opts) {
  return new ApiError(code, message, opts)
}

function httpStatusFor (code) {
  return HTTP_STATUS[code] || 500
}

// Strips query/fragment/credentials so URLs never leak tokens through errors.
function safeUrl (url) {
  try {
    const u = new URL(String(url))
    return u.origin === 'null' ? u.protocol : u.origin + u.pathname
  } catch {
    return ''
  }
}

// Converts any thrown value to a wire `error` object without leaking internals.
function toWireError (error) {
  if (error instanceof ApiError || (error && typeof error.code === 'string' && HTTP_STATUS[error.code])) {
    const out = {
      code: error.code,
      message: String(error.message || error.code).slice(0, 1000),
      retryable: error.retryable !== undefined ? !!error.retryable : RETRYABLE.has(error.code)
    }
    if (error.retryAfterMs !== undefined) out.retryAfterMs = error.retryAfterMs
    if (error.details && typeof error.details === 'object') out.details = error.details
    return out
  }
  return { code: 'INTERNAL', message: 'Internal error', retryable: false }
}

module.exports = { ApiError, apiError, httpStatusFor, safeUrl, toWireError, HTTP_STATUS }
