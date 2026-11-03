/**
 * Minimal JSON Schema (2020-12 subset) validator used by the Command Registry.
 * No external dependency: supports exactly the keywords used by registry.json /
 * common.schema.json. Applies `default`s to missing object properties.
 */

function typeOf (v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function matchesType (type, v) {
  const t = typeOf(v)
  if (type === 'integer') return t === 'number' && Number.isInteger(v)
  if (type === 'number') return t === 'number' && Number.isFinite(v)
  return t === type
}

function clone (v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v))
}

function createValidator ({ documents = {}, root } = {}) {
  // documents: { 'common.schema.json': {...} }; root: the document that
  // "#/..." refs inside registry schemas resolve against.
  function resolveRef (ref, base) {
    const hashAt = ref.indexOf('#')
    const file = hashAt === -1 ? ref : ref.slice(0, hashAt)
    const pointer = hashAt === -1 ? '' : ref.slice(hashAt + 1)
    const doc = file ? documents[file] : base
    if (!doc) throw new Error('Unresolvable $ref: ' + ref)
    let node = doc
    for (const part of pointer.split('/').filter(Boolean)) {
      node = node && node[part.replace(/~1/g, '/').replace(/~0/g, '~')]
    }
    if (node === undefined) throw new Error('Unresolvable $ref: ' + ref)
    return { schema: node, base: doc }
  }

  function check (schema, value, path, base, errors, apply) {
    if (schema === true || schema === undefined) return value
    if (schema === false) { errors.push({ path, message: 'not allowed' }); return value }
    if (schema.$ref) {
      const r = resolveRef(schema.$ref, base)
      // siblings of $ref (description/default) are annotations only
      return check(r.schema, value, path, r.base, errors, apply)
    }
    if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
      errors.push({ path, message: 'must equal ' + JSON.stringify(schema.const) })
      return value
    }
    if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
      errors.push({ path, message: 'must be one of ' + schema.enum.join('|') })
      return value
    }
    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type]
      if (!types.some((t) => matchesType(t, value))) {
        errors.push({ path, message: 'must be ' + types.join('|') })
        return value
      }
    }
    if (schema.oneOf) {
      let matched = 0
      for (const sub of schema.oneOf) {
        const subErrors = []
        check(sub, value, path, base, subErrors, false)
        if (!subErrors.length) matched++
      }
      if (matched !== 1) errors.push({ path, message: 'must match exactly one alternative' })
    }
    const t = typeOf(value)
    if (t === 'string') {
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push({ path, message: 'too short' })
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push({ path, message: 'too long' })
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push({ path, message: 'does not match pattern' })
    } else if (t === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, message: 'below minimum' })
      if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, message: 'above maximum' })
    } else if (t === 'array') {
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path, message: 'too few items' })
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, message: 'too many items' })
      if (schema.items) value = value.map((item, i) => check(schema.items, item, `${path}[${i}]`, base, errors, apply))
    } else if (t === 'object') {
      const keys = Object.keys(value)
      if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push({ path, message: 'too few properties' })
      if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errors.push({ path, message: 'too many properties' })
      for (const req of schema.required || []) {
        if (value[req] === undefined) errors.push({ path: `${path}.${req}`, message: 'is required' })
      }
      const props = schema.properties || {}
      const out = apply ? { ...value } : value
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(props, key)) {
          out[key] = check(props[key], value[key], `${path}.${key}`, base, errors, apply)
        } else if (schema.additionalProperties === false) {
          errors.push({ path: `${path}.${key}`, message: 'is not allowed' })
        } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
          out[key] = check(schema.additionalProperties, value[key], `${path}.${key}`, base, errors, apply)
        }
      }
      if (apply) {
        for (const [key, sub] of Object.entries(props)) {
          if (out[key] !== undefined) continue
          let def = sub.default
          if (def === undefined && sub.$ref) {
            try { def = resolveRef(sub.$ref, base).schema.default } catch {}
          }
          if (def !== undefined) out[key] = clone(def)
        }
      }
      value = out
    }
    return value
  }

  return {
    // -> { ok, errors, value } ; `value` has defaults applied.
    validate (schema, value, { applyDefaults = true } = {}) {
      const errors = []
      const out = check(schema, value, '$', root, errors, applyDefaults)
      return { ok: errors.length === 0, errors, value: out }
    },
    resolveRef
  }
}

module.exports = { createValidator }
