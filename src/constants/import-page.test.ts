import { isImportPageSearch } from './import-page'

describe('isImportPageSearch', () => {
  test.each([
    ['?mode=import', true],
    ['?mode=import&source=popup', true],
    ['', false],
    ['?mode=settings', false],
  ])('returns %s for %s', (search, expected) => {
    expect(isImportPageSearch(search)).toBe(expected)
  })
})
