/**
 * NumberInput / HexInput — text boxes that are actually typeable.
 *
 * The old pattern bound `value` to controlled state and validated on every
 * keystroke, only committing when the value was already in range. That makes
 * the field revert your keystrokes — you can't clear it, can't type "5" on the
 * way to "50", and can't type a value that's briefly out of range. These
 * components instead keep a free-form draft string: you type whatever you want,
 * valid in-range values apply live, and on blur / Enter the value is clamped
 * and committed. Keystrokes are never thrown away.
 */
import React, { useState, useRef, useEffect } from 'react'

function fmtNum(v) {
  if (v == null || v === '') return ''
  if (typeof v === 'number' && Number.isNaN(v)) return ''
  return String(v)
}

export default function NumberInput({
  value, onCommit, min, max, integer = true, allowEmpty = false,
  placeholder, style, ...rest
}) {
  const [draft, setDraft] = useState(() => fmtNum(value))
  const focused = useRef(false)

  // Keep the draft in sync with external changes (e.g. a paired slider) while
  // the user isn't actively editing this field.
  useEffect(() => {
    if (!focused.current) setDraft(fmtNum(value))
  }, [value])

  const parse = (s) => (integer ? parseInt(s, 10) : parseFloat(s))
  const inRange = (n) => (min == null || n >= min) && (max == null || n <= max)
  const clamp = (n) => {
    let r = n
    if (min != null) r = Math.max(min, r)
    if (max != null) r = Math.min(max, r)
    return r
  }

  function handleChange(e) {
    // Mark as actively editing so a live onCommit (below) re-rendering the
    // parent can't sync our draft away mid-keystroke — guards even when a
    // focus event wasn't observed.
    focused.current = true
    const raw = e.target.value
    setDraft(raw)
    const t = raw.trim()
    if (t === '') {
      if (allowEmpty) onCommit(null)
      return
    }
    const n = parse(t)
    if (!Number.isNaN(n) && inRange(n)) onCommit(n)   // live-apply valid in-range values
  }

  function finalize() {
    focused.current = false
    const t = draft.trim()
    if (t === '') {
      if (allowEmpty) { onCommit(null); setDraft('') }
      else setDraft(fmtNum(value))                     // revert empty when not allowed
      return
    }
    let n = parse(t)
    if (Number.isNaN(n)) { setDraft(fmtNum(value)); return }
    n = clamp(n)
    setDraft(String(n))
    onCommit(n)
  }

  return (
    <input
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      value={draft}
      placeholder={placeholder}
      style={style}
      onFocus={() => { focused.current = true }}
      onChange={handleChange}
      onBlur={finalize}
      onKeyDown={(e) => { if (e.key === 'Enter') { finalize(); e.currentTarget.blur() } }}
      {...rest}
    />
  )
}

const HEX_RE = /^#[0-9a-fA-F]{3,8}$/

export function HexInput({ value, onCommit, placeholder = '#hex', style, ...rest }) {
  const [draft, setDraft] = useState(() => value || '')
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setDraft(value || '')
  }, [value])

  const normalize = (s) => {
    let v = s.trim()
    if (v && !v.startsWith('#')) v = '#' + v
    return v
  }

  function handleChange(e) {
    focused.current = true
    const raw = e.target.value
    setDraft(raw)
    const v = normalize(raw)
    if (HEX_RE.test(v)) onCommit(v)                    // live-apply once a full hex is typed
  }

  function finalize() {
    focused.current = false
    const v = normalize(draft)
    if (HEX_RE.test(v)) { setDraft(v); onCommit(v) }
    else setDraft(value || '')                         // revert invalid/partial input
  }

  return (
    <input
      type="text"
      value={draft}
      placeholder={placeholder}
      style={style}
      onFocus={() => { focused.current = true }}
      onChange={handleChange}
      onBlur={finalize}
      onKeyDown={(e) => { if (e.key === 'Enter') { finalize(); e.currentTarget.blur() } }}
      {...rest}
    />
  )
}
