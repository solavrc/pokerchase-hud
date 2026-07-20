import { compareVersions, isVersionBelow } from './version-compare'

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('5.1.0', '5.1.0')).toBe(0)
  })

  it('returns -1 when the first version is lower', () => {
    expect(compareVersions('5.0.9', '5.1.0')).toBe(-1)
    expect(compareVersions('4.9.9', '5.0.0')).toBe(-1)
  })

  it('returns 1 when the first version is higher', () => {
    expect(compareVersions('5.2.0', '5.1.9')).toBe(1)
    expect(compareVersions('6.0.0', '5.9.9')).toBe(1)
  })

  it('handles unequal segment lengths by padding missing segments with 0', () => {
    expect(compareVersions('5.1', '5.1.0')).toBe(0)
    expect(compareVersions('5.1.0', '5.1')).toBe(0)
    expect(compareVersions('5', '5.0.0')).toBe(0)
    expect(compareVersions('5.1', '5.1.1')).toBe(-1)
    expect(compareVersions('5.1.1', '5.1')).toBe(1)
  })

  it('returns null (incomparable) for non-numeric segments and never throws', () => {
    expect(compareVersions('5.1.0-beta', '5.1.0')).toBeNull()
    expect(compareVersions('5.1.0', 'abc')).toBeNull()
    expect(compareVersions('', '5.1.0')).toBeNull()
    expect(compareVersions('5..1', '5.1.0')).toBeNull()
    expect(compareVersions('5.-1.0', '5.1.0')).toBeNull()
  })
})

describe('isVersionBelow', () => {
  it('is true when current is strictly below minimum', () => {
    expect(isVersionBelow('4.9.0', '5.0.0')).toBe(true)
  })

  it('is false when current equals minimum', () => {
    expect(isVersionBelow('5.0.0', '5.0.0')).toBe(false)
  })

  it('is false when current is above minimum', () => {
    expect(isVersionBelow('5.1.0', '5.0.0')).toBe(false)
  })

  it('fails open (false) for non-comparable versions', () => {
    expect(isVersionBelow('not-a-version', '5.0.0')).toBe(false)
    expect(isVersionBelow('5.0.0', 'not-a-version')).toBe(false)
  })
})
