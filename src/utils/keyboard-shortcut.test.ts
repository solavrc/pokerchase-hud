import {
  formatShortcut,
  matchesShortcut,
  shortcutFromKeyboardEvent,
} from './keyboard-shortcut'

describe('keyboard shortcuts', () => {
  test('requires a safe modifier for ordinary keys', () => {
    expect(shortcutFromKeyboardEvent({
      code: 'KeyH',
      key: 'h',
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    })).toBeNull()
  })

  test('records, formats and matches a modified key', () => {
    const shortcut = shortcutFromKeyboardEvent({
      code: 'KeyH',
      key: 'h',
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      metaKey: false,
    })
    expect(shortcut).not.toBeNull()
    expect(formatShortcut(shortcut!)).toBe('Ctrl + Shift + H')
    expect(matchesShortcut({
      code: 'KeyH',
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      metaKey: false,
    }, shortcut!)).toBe(true)
  })

  test('allows Shift + letter while still rejecting an unmodified chat character', () => {
    const shortcut = shortcutFromKeyboardEvent({
      code: 'KeyH',
      key: 'H',
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      metaKey: false,
    })

    expect(shortcut).not.toBeNull()
    expect(formatShortcut(shortcut!)).toBe('Shift + H')
  })

  test('allows function keys without modifiers', () => {
    expect(shortcutFromKeyboardEvent({
      code: 'F8',
      key: 'F8',
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    })).toEqual(expect.objectContaining({ code: 'F8' }))
  })

  test('formats the recorded logical key instead of the physical US-layout code', () => {
    expect(formatShortcut({
      code: 'KeyY',
      key: 'z',
      ctrl: true,
      alt: false,
      shift: false,
      meta: false,
    })).toBe('Ctrl + Z')
  })

  test.each([
    { code: 'KeyW', key: 'w', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
    { code: 'KeyQ', key: 'q', ctrlKey: false, altKey: false, shiftKey: false, metaKey: true },
    { code: 'F4', key: 'F4', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false },
    { code: 'F5', key: 'F5', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false },
  ])('rejects browser or OS reserved combinations: $code', event => {
    expect(shortcutFromKeyboardEvent(event)).toBeNull()
  })

  test('uses an explicit numpad label for physical keypad keys', () => {
    expect(formatShortcut({
      code: 'Numpad1',
      key: '1',
      ctrl: true,
      alt: false,
      shift: false,
      meta: false,
    })).toBe('Ctrl + Numpad 1')
    expect(formatShortcut({
      code: 'NumpadEnter',
      key: 'Enter',
      ctrl: false,
      alt: false,
      shift: true,
      meta: false,
    })).toBe('Shift + Numpad Enter')
  })
})
