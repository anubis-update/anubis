// Pure decision helpers for auto-routing the Chrome/Edge (CDP) engine to the
// logged-on user's Windows workspace context, so the operator does not have to
// pick a context by hand before Chrome/Edge can stream a visible, real-profile
// window.
//
// Kept as a side-effect-free CommonJS module (like engine-options.js /
// browser-profile.js) so the branching logic is unit-tested with `node --test`
// while the JSX shell only performs the fetch / reload I/O around it. Nothing
// here touches the DOM, network, or storage.
//
// Background: the managed gateway forwards every request of a web session to the
// selected Windows context runtime once that session has POSTed a selection to
// `/_anubis/contexts`; the selector then persists at the gateway session level
// across reloads. Chrome/Edge must run in that user-context runtime (session
// >= 1) to reach the real profile and show a window, whereas the Internal (RBI)
// engine runs fine in the default SYSTEM runtime. So when the user switches to
// Chrome/Edge we auto-select the single signed-in user context; RBI needs none.

const CONTEXT_ROUTE = '/_anubis/contexts'

// localStorage key holding the engine a browser tab should re-open with after a
// context switch reload. Scoped per tab id so concurrent tabs do not collide.
function intentKey (tabId) {
  return 'anubisBrowserEngine:' + tabId
}

function isUserContext (choice) {
  return !!choice && choice.target === 'user'
}

// Decide what to do when the operator selects Chrome/Edge, given the context
// catalog returned by GET /_anubis/contexts. The result is a plain object the
// JSX layer acts on; all copy is plain, neutral English (no "success"/green).
//   { action: 'select', id }   exactly one signed-in Windows user context
//   { action: 'multiple' }     several signed-in users; operator must choose
//   { action: 'none' }         no signed-in Windows user session to route to
//   { action: 'unsupported' }  host/gateway does not offer context selection
function decideContextAction (catalog) {
  if (!catalog || catalog.supported !== true || !Array.isArray(catalog.contexts)) {
    return { action: 'unsupported' }
  }
  const users = catalog.contexts.filter(isUserContext)
  if (users.length === 1) return { action: 'select', id: users[0].id }
  if (users.length > 1) return { action: 'multiple' }
  return { action: 'none' }
}

// Neutral English guidance shown in the panel when auto-routing cannot complete
// on its own. Deliberately not styled as success.
const CONTEXT_NOTES = {
  multiple: 'Several Windows users are signed in. Open the Windows workspace selector (top-right) and choose yours, then pick Chrome or Edge again.',
  none: 'No signed-in Windows session was found to run Chrome or Edge in. Sign in to Windows on this device and try again.',
  unsupported: 'Chrome and Edge need a Windows workspace context, which only the Web administrator can select on this device. Ask the administrator to choose your workspace, or use Internal (RBI).',
  error: 'Could not reach the Windows workspace selector. Refresh and try again, or use Internal (RBI).'
}

function noteFor (action) {
  return CONTEXT_NOTES[action] || ''
}

module.exports = {
  CONTEXT_ROUTE,
  intentKey,
  isUserContext,
  decideContextAction,
  CONTEXT_NOTES,
  noteFor
}
