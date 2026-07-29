import type { KeyboardShortcut } from '../types/hand-log'

const isSupportedShortcut = (
  shortcut: Pick<KeyboardShortcut, 'code' | 'ctrl' | 'alt' | 'shift' | 'meta'>
): boolean =>
  /^Key[A-Z]$/.test(shortcut.code) &&
  shortcut.shift &&
  !shortcut.ctrl &&
  !shortcut.alt &&
  !shortcut.meta

export const shortcutFromKeyboardEvent = (
  event: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>
): KeyboardShortcut | null => {
  // Use a small allowlist instead of attempting to enumerate every
  // browser/OS-reserved accelerator. Shift + a physical letter key avoids
  // PokerChase's unmodified bindings and browser Ctrl/Alt/Meta commands.
  const shortcut: KeyboardShortcut = {
    code: event.code,
    key: event.key,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  }
  return isSupportedShortcut(shortcut) ? shortcut : null
}

export const matchesShortcut = (
  event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
  shortcut: KeyboardShortcut
): boolean =>
  isSupportedShortcut(shortcut) &&
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
