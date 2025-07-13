import { rotateArrayFromIndex } from './array-utils'

describe('rotateArrayFromIndex', () => {
  it('配列を指定インデックスから回転させる', () => {
    expect(rotateArrayFromIndex([1, 2, 3, 4, 5], 2)).toEqual([3, 4, 5, 1, 2])
    expect(rotateArrayFromIndex(['A', 'B', 'C', 'D'], 1)).toEqual(['B', 'C', 'D', 'A'])
    expect(rotateArrayFromIndex([10, 20, 30], 0)).toEqual([10, 20, 30])
  })

  it('範囲外のインデックスでは元の配列を返す', () => {
    expect(rotateArrayFromIndex([1, 2, 3], -1)).toEqual([1, 2, 3])
    expect(rotateArrayFromIndex([1, 2, 3], 3)).toEqual([1, 2, 3])
    expect(rotateArrayFromIndex([1, 2, 3], 10)).toEqual([1, 2, 3])
  })

  it('空の配列を処理できる', () => {
    expect(rotateArrayFromIndex([], 0)).toEqual([])
    expect(rotateArrayFromIndex([], 1)).toEqual([])
  })

  it('1要素の配列を処理できる', () => {
    expect(rotateArrayFromIndex([42], 0)).toEqual([42])
    expect(rotateArrayFromIndex([42], 1)).toEqual([42])
  })

  it('null配列で例外を投げる', () => {
    expect(() => rotateArrayFromIndex(null as any, 0)).toThrow('rotateArrayFromIndex: array cannot be null or undefined')
  })

  it('undefined配列で例外を投げる', () => {
    expect(() => rotateArrayFromIndex(undefined as any, 0)).toThrow('rotateArrayFromIndex: array cannot be null or undefined')
  })

  it('非整数のインデックスで例外を投げる', () => {
    expect(() => rotateArrayFromIndex([1, 2, 3], 1.5)).toThrow('rotateArrayFromIndex: index must be an integer')
    expect(() => rotateArrayFromIndex([1, 2, 3], NaN)).toThrow('rotateArrayFromIndex: index must be an integer')
    expect(() => rotateArrayFromIndex([1, 2, 3], 'abc' as any)).toThrow('rotateArrayFromIndex: index must be an integer')
  })
})