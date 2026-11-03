/**
 * Accessibility snapshot + element actions over CDP (SPEC-v1 page.snapshot).
 * Refs are `eN`, scoped to a snapshot id `s_N`; using a ref from an older
 * snapshot or a node that no longer resolves yields STALE_REF. Password fields
 * are masked and typing into them is refused (POLICY_DENIED): secrets must
 * come from the credential/passwords commands, never from the agent.
 */

const { apiError } = require('./browser-api/errors')

const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'menuitem', 'tab', 'slider', 'spinbutton', 'option', 'listbox', 'menuitemcheckbox', 'menuitemradio'])
const TEXTISH = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton'])
const SKIP = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak', 'presentation'])
const MAX_NAME = 200

function propVal (node, name) {
  const p = (node.properties || []).find((x) => x.name === name)
  return p && p.value ? p.value.value : undefined
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' }
}
const MODS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 }

function parseKey (spec) {
  const parts = String(spec).split('+')
  const main = parts.pop()
  let modifiers = 0
  for (const m of parts) {
    if (!MODS[m]) throw apiError('INVALID_PARAMS', 'Unknown modifier')
    modifiers |= MODS[m]
  }
  const named = KEYS[main] || (main === ' ' ? KEYS.Space : null)
  if (named) return { ...named, modifiers, printable: named === KEYS.Space && !(modifiers & ~8) }
  if (main.length === 1) {
    const up = main.toUpperCase()
    return {
      key: main,
      code: /[a-z]/i.test(main) ? 'Key' + up : /\d/.test(main) ? 'Digit' + main : '',
      vk: up.charCodeAt(0),
      text: modifiers & ~8 ? undefined : main,
      modifiers,
      printable: !(modifiers & ~8)
    }
  }
  throw apiError('INVALID_PARAMS', 'Unknown key')
}

function createPageDriver ({ tabs, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let snapSeq = 0
  const stores = new Map() // tabId -> { snapshotId, refs: Map }

  const send = (tabId, method, params) => tabs.send(tabId, method, params)

  async function snapshot (tabId, { maxNodes = 400, interestingOnly = true } = {}) {
    const tab = tabs.get(tabId)
    const { nodes: ax } = await send(tabId, 'Accessibility.getFullAXTree', {})
    const snapshotId = 's_' + (++snapSeq)
    const refs = new Map()
    const out = []
    const lines = []
    const byId = new Map((ax || []).map((n) => [n.nodeId, n]))
    let n = 0
    let truncated = false
    const depthOf = (node) => {
      let d = 0
      let cur = node
      while (cur && cur.parentId && byId.has(cur.parentId) && d < 50) { cur = byId.get(cur.parentId); d++ }
      return d
    }
    for (const node of ax || []) {
      if (node.ignored) continue
      const role = node.role && node.role.value
      if (!role || SKIP.has(role) || role === 'RootWebArea') continue
      const interactive = INTERACTIVE.has(role)
      let name = node.name && node.name.value ? String(node.name.value) : ''
      if (interestingOnly && !interactive && !name && role !== 'heading') continue
      if (out.length >= maxNodes) { truncated = true; break }
      const ref = 'e' + (++n)
      let password = false
      if (TEXTISH.has(role) && node.backendDOMNodeId) {
        try {
          const d = await send(tabId, 'DOM.describeNode', { backendNodeId: node.backendDOMNodeId })
          const attrs = (d && d.node && d.node.attributes) || []
          const map = {}
          for (let i = 0; i + 1 < attrs.length; i += 2) map[attrs[i]] = attrs[i + 1]
          password = map.type === 'password' || /current-password|new-password|one-time-code/.test(map.autocomplete || '')
        } catch {}
      }
      const states = []
      for (const s of ['disabled', 'checked', 'expanded', 'selected', 'required', 'focused']) {
        const v = propVal(node, s)
        if (v === true || v === 'true') states.push(s)
      }
      if (password) states.push('password')
      let value = node.value && node.value.value !== undefined ? String(node.value.value) : undefined
      if (password && value !== undefined) value = '•••'
      name = name.slice(0, MAX_NAME)
      const item = { ref, role, ...(name ? { name } : {}), ...(value !== undefined ? { value: value.slice(0, MAX_NAME) } : {}), ...(states.length ? { states } : {}) }
      out.push(item)
      refs.set(ref, { backendNodeId: node.backendDOMNodeId, role, name, password })
      lines.push('  '.repeat(Math.min(depthOf(node), 6)) + `- ${role}${name ? ` "${name}"` : ''} [${ref}]${states.length ? ' (' + states.join(',') + ')' : ''}${value !== undefined ? ` value="${value.slice(0, 80)}"` : ''}`)
    }
    stores.set(tabId, { snapshotId, refs })
    return {
      snapshotId,
      url: tab.url,
      title: tab.title,
      tree: lines.join('\n'),
      nodes: out,
      truncated,
      untrusted: true
    }
  }

  function resolveRef (tabId, ref, snapshotId) {
    const st = stores.get(tabId)
    if (!st || (snapshotId && snapshotId !== st.snapshotId)) throw apiError('STALE_REF', 'Snapshot is stale; take a new page.snapshot')
    const entry = st.refs.get(ref)
    if (!entry || !entry.backendNodeId) throw apiError('STALE_REF', 'Unknown element reference')
    return entry
  }

  async function locate (tabId, entry) {
    try {
      await send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: entry.backendNodeId })
      const { model } = await send(tabId, 'DOM.getBoxModel', { backendNodeId: entry.backendNodeId })
      const q = model && model.content
      if (!q || q.length < 8) throw new Error('no box')
      const x = (q[0] + q[2] + q[4] + q[6]) / 4
      const y = (q[1] + q[3] + q[5] + q[7]) / 4
      if (!(model.width > 0 && model.height > 0)) throw apiError('ELEMENT_NOT_ACTIONABLE', 'Element has no visible area')
      return { x, y }
    } catch (e) {
      if (e && e.code) throw e
      throw apiError('STALE_REF', 'Element is no longer on the page')
    }
  }

  async function click (tabId, { ref, snapshotId, button = 'left', clickCount = 1 }) {
    const entry = resolveRef(tabId, ref, snapshotId)
    const { x, y } = await locate(tabId, entry)
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount })
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount })
    return { clicked: true }
  }

  async function hover (tabId, { ref, snapshotId }) {
    const { x, y } = await locate(tabId, resolveRef(tabId, ref, snapshotId))
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    return { hovered: true }
  }

  async function type (tabId, { ref, snapshotId, text, clear = false, submit = false }) {
    const entry = resolveRef(tabId, ref, snapshotId)
    if (entry.password) throw apiError('POLICY_DENIED', 'Typing into password fields is not allowed for agents')
    await locate(tabId, entry)
    await send(tabId, 'DOM.focus', { backendNodeId: entry.backendNodeId })
    if (clear) {
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, commands: ['selectAll'] })
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    }
    await send(tabId, 'Input.insertText', { text: String(text) })
    if (submit) await dispatchKey(tabId, parseKey('Enter'))
    return { typed: String(text).length }
  }

  async function dispatchKey (tabId, k) {
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers: k.modifiers || 0 }
    await send(tabId, 'Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text } : {}) })
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  async function focusedIsPassword (tabId) {
    try {
      const r = await send(tabId, 'Runtime.evaluate', {
        expression: "(()=>{const e=document.activeElement;return !!e&&e.tagName==='INPUT'&&(e.type==='password'||/current-password|new-password|one-time-code/.test(e.autocomplete||''))})()",
        returnByValue: true
      })
      return !!(r && r.result && r.result.value === true)
    } catch { return false }
  }

  async function press (tabId, { key }) {
    const k = parseKey(key)
    if (k.printable && await focusedIsPassword(tabId)) throw apiError('POLICY_DENIED', 'Typing into password fields is not allowed for agents')
    await dispatchKey(tabId, k)
    return { pressed: key }
  }

  async function scroll (tabId, { ref, snapshotId, deltaX = 0, deltaY = 0 }) {
    let x = 200
    let y = 200
    if (ref) ({ x, y } = await locate(tabId, resolveRef(tabId, ref, snapshotId)))
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY })
    return { scrolled: true }
  }

  async function screenshot (tabId, { format = 'png', quality, fullPage = false } = {}) {
    const params = { format: format === 'jpeg' ? 'jpeg' : 'png', ...(quality ? { quality } : {}), ...(fullPage ? { captureBeyondViewport: true } : {}) }
    const r = await send(tabId, 'Page.captureScreenshot', params)
    return { format: params.format, data: r.data, untrusted: true }
  }

  async function evaluate (tabId, { expression }) {
    const r = await send(tabId, 'Runtime.evaluate', { expression: String(expression), returnByValue: true, awaitPromise: true })
    if (r && r.exceptionDetails) throw apiError('EVALUATION_FAILED', 'Script threw an exception')
    return { value: r && r.result ? r.result.value : undefined, untrusted: true }
  }

  async function wait (tabId, { text, selector, ms, timeoutMs = 10000 }) {
    if (ms) { await sleep(Math.min(ms, timeoutMs)); return { waited: true } }
    const expr = text !== undefined
      ? `document.body&&document.body.innerText.includes(${JSON.stringify(String(text))})`
      : `!!document.querySelector(${JSON.stringify(String(selector))})`
    const start = Date.now()
    while (Date.now() - start <= timeoutMs) {
      const r = await send(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true })
      if (r && r.result && r.result.value === true) return { waited: true }
      await sleep(100)
    }
    throw apiError('TIMEOUT', 'Timed out waiting for the page')
  }

  async function extract (tabId, { ref, snapshotId, maxChars = 20000 } = {}) {
    let text
    if (ref) {
      const entry = resolveRef(tabId, ref, snapshotId)
      const r = await send(tabId, 'DOM.resolveNode', { backendNodeId: entry.backendNodeId })
      const o = await send(tabId, 'Runtime.callFunctionOn', { objectId: r.object.objectId, functionDeclaration: 'function(){return this.innerText||this.textContent||""}', returnByValue: true })
      text = String((o.result && o.result.value) || '')
    } else {
      const r = await send(tabId, 'Runtime.evaluate', { expression: 'document.body?document.body.innerText:""', returnByValue: true })
      text = String((r.result && r.result.value) || '')
    }
    return { text: text.slice(0, maxChars), truncated: text.length > maxChars, untrusted: true }
  }

  return { snapshot, click, hover, type, press, scroll, screenshot, evaluate, wait, extract, forget: (t) => stores.delete(t) }
}

module.exports = { createPageDriver, parseKey }
