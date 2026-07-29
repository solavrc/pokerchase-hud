import type { KeyboardShortcut } from '../types/hand-log'

const MODIFIER_CODES = new Set([
  'AltLeft', 'AltRight',
  'ControlLeft', 'ControlRight',
  'MetaLeft', 'MetaRight',
  'ShiftLeft', 'ShiftRight',
])

export const shortcutFromKeyboardEvent = (
  event: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>
): KeyboardShortcut | null => {
  if (!event.code || MODIFIER_CODES.has(event.code)) return null

  const isFunctionKey = /^F([1-9]|1[0-2])$/.test(event.code)
  if (!isFunctionKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    return null
  }

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

  const labels: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Space: 'Space',
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
