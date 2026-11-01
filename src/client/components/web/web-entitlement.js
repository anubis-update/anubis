// Pure decision helpers for the Browser PRO entitlement gate on the web
// surface. The managed gateway exposes two same-origin endpoints to every valid
// web session (user or administrator):
//   GET  /_anubis/browser-entitlement -> { entitled, proExpiresAt }
//   POST /_anubis/browser-activate    -> 200 { entitled, proExpiresAt }
//                                        403 { entitled, error }
//
// Kept as a side-effect-free CommonJS module (like web-context.js /
// engine-options.js) so the branching logic is unit-tested with `node --test`
// while the JSX shell (web-browser-gate.jsx) only performs the fetch I/O. The
// web client is fail-closed: unlike the desktop build it must not assume PRO,
// so an unreadable or false entitlement keeps the panel behind activation.

const ENTITLEMENT_ROUTE = '/_anubis/browser-entitlement'
const ACTIVATE_ROUTE = '/_anubis/browser-activate'

// Readable messages for the activation failure codes returned by the gateway.
const ACTIVATION_MESSAGES = {
  invalid: 'Invalid key',
  scope: 'Key not valid for this device',
  expired: 'Key expired',
  offline: 'Managed service offline'
}

// Normalise the GET /_anubis/browser-entitlement payload into a plain shape the
// JSX layer acts on. Anything that is not an explicit `entitled: true` is fail
// closed (false), and proExpiresAt is only kept when it is a real number.
function parseEntitlement (payload) {
  const entitled = !!payload && payload.entitled === true
  const proExpiresAt = payload && typeof payload.proExpiresAt === 'number'
    ? payload.proExpiresAt
    : null
  return { entitled, proExpiresAt }
}

// Normalise a POST /_anubis/browser-activate response given its HTTP status and
// JSON body into { ok, entitled, proExpiresAt, error }. A 200 with entitled:true
// unlocks the panel; any other outcome stays locked and carries an error code
// that maps to ACTIVATION_MESSAGES.
function parseActivation (status, payload) {
  if (status === 200 && !!payload && payload.entitled === true) {
    return {
      ok: true,
      entitled: true,
      proExpiresAt: typeof payload.proExpiresAt === 'number' ? payload.proExpiresAt : null,
      error: null
    }
  }
  const error = payload && typeof payload.error === 'string' && payload.error
    ? payload.error
    : 'invalid'
  return { ok: false, entitled: false, proExpiresAt: null, error }
}

// Human-readable text for an activation error code, with a neutral fallback.
function activationMessage (error) {
  return ACTIVATION_MESSAGES[error] || 'Activation failed'
}

module.exports = {
  ENTITLEMENT_ROUTE,
  ACTIVATE_ROUTE,
  ACTIVATION_MESSAGES,
  parseEntitlement,
  parseActivation,
  activationMessage
}
