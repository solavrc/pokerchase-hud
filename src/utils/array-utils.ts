/**
 * 配列を指定されたインデックスから回転させる
 * 
 * @param array 回転させる配列
 * @param index 開始インデックス
 * @returns 回転後の新しい配列
 * 
 * @example
 * rotateArrayFromIndex([1, 2, 3, 4, 5], 2) // [3, 4, 5, 1, 2]
 * rotateArrayFromIndex(['A', 'B', 'C', 'D'], 1) // ['B', 'C', 'D', 'A']
 */
export function rotateArrayFromIndex<T>(array: T[], index: number): T[] {
  if (array === null || array === undefined) {
    throw new Error('rotateArrayFromIndex: array cannot be null or undefined')
  }
  
  if (typeof index !== 'number' || !Number.isInteger(index)) {
    throw new Error('rotateArrayFromIndex: index must be an integer')
  }
  
  if (index < 0 || index >= array.length) {
    return [...array]
  }
  
  return [
    ...array.slice(index),
    ...array.slice(0, index)
  ]
}