import type { KeyboardShortcut } from '../types/hand-log'

const MODIFIER_CODES = new Set([
  'AltLeft', 'AltRight',
  'ControlLeft', 'ControlRight',
  'MetaLeft', 'MetaRight',
  'ShiftLeft', 'ShiftRight',
])

const isBrowserReservedShortcut = (
  event: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>
): boolean => {
  const { code, ctrlKey, altKey, shiftKey, metaKey } = event
  const logicalKey = event.key.toLowerCase()
  const isLogicalKey = (...keys: string[]) => keys.includes(logicalKey)

  // Browser/OS commands that page-level preventDefault cannot reliably
  // replace. Letter commands use the logical key so non-US layouts cannot
  // bypass them; physical codes remain appropriate for non-character keys.
  if (altKey && (code === 'F4' || code === 'ArrowLeft' || code === 'ArrowRight' || code === 'Home')) {
    return true
  }
  if (metaKey && !ctrlKey && !altKey) {
    if (isLogicalKey('q', 'w')) return true
    if (!shiftKey && (isLogicalKey('h', 'm') || code === 'Comma')) return true
  }

  const primaryKey = ctrlKey || metaKey
  if (primaryKey && !altKey) {
    if (ctrlKey && code === 'F4') return true
    if (isLogicalKey('w', 'q', 't', 'n', 'r', 'l') || code === 'Tab') return true
    if (!shiftKey && isLogicalKey('p', 's', 'o', 'd', 'f', 'h', 'j', 'u')) {
      return true
    }
    if (shiftKey && code === 'Delete') return true
  }

  return !ctrlKey && !altKey && !shiftKey && !metaKey &&
    ['F1', 'F3', 'F5', 'F6', 'F10', 'F11', 'F12'].includes(code)
}

export const shortcutFromKeyboardEvent = (
  event: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>
): KeyboardShortcut | null => {
  if (!event.code || MODIFIER_CODES.has(event.code)) return null

  const isFunctionKey = /^F([1-9]|1[0-2])$/.test(event.code)
  if (!isFunctionKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
    return null
  }
  if (isBrowserReservedShortcut(event)) return null

  return {
    code: event.code,
    key: event.key,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  }
}

export const matchesShortcut = (
  event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
  shortcut: KeyboardShortcut
): boolean =>
  event.code === shortcut.code &&
  event.ctrlKey === shortcut.ctrl &&
  event.altKey === shortcut.alt &&
  event.shiftKey === shortcut.shift &&
  event.metaKey === shortcut.meta

const displayKey = (shortcut: KeyboardShortcut): string => {
  if (/^F([1-9]|1[0-2])$/.test(shortcut.code)) return shortcut.code
  const numpadDigit = shortcut.code.match(/^Numpad([0-9])$/)
  if (numpadDigit) return `Numpad ${numpadDigit[1]}`

  const labels: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Space: 'Space',
    NumpadEnter: 'Numpad Enter',
    NumpadAdd: 'Numpad +',
    NumpadSubtract: 'Numpad −',
    NumpadMultiply: 'Numpad ×',
    NumpadDivide: 'Numpad ÷',
    NumpadDecimal: 'Numpad .',
    NumpadEqual: 'Numpad =',
    NumpadComma: 'Numpad ,',
  }
  const recordedKey = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key
  return labels[shortcut.code] ?? recordedKey
}

export const formatShortcut = (shortcut: KeyboardShortcut): string => {
  const parts: string[] = []
  if (shortcut.ctrl) parts.push('Ctrl')
  if (shortcut.alt) parts.push('Alt')
  if (shortcut.shift) parts.push('Shift')
  if (shortcut.meta) parts.push('⌘')
  parts.push(displayKey(shortcut))
  return parts.join(' + ')
}

export const isEditableShortcutTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}
