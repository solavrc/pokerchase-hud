/**
 * options（フィルター設定など）のchrome.storage.sync永続化。
 *
 * 全コンシューマー（Popup / HUD / service worker）がフラットな`options`キー
 * 1箇所を読み書きする。かつてPopupだけが@extend-chrome/storageのbucket
 * （プレフィックス付きサブキー extend-chrome/storage__options--<field>）を
 * 使っており、フラットキーとの同期はupdateBattleTypeFilterメッセージの
 * 副作用頼みだった。旧bucketキーにしかデータが残っていないユーザーのために、
 * loadOptionsは読み取り時マイグレーションを行う。
 */
import type { FilterOptions, GameTypeFilter } from '../types'

export interface Options {
  sendUserData: boolean;
  gameTypeFilter?: GameTypeFilter; // New filter format
  filterOptions?: FilterOptions; // Complete filter options
}

export const OPTIONS_STORAGE_KEY = 'options'

/** @extend-chrome/storage getBucket('options', 'sync') が実際に使っていたキー形式 */
const LEGACY_BUCKET_PREFIX = 'extend-chrome/storage__options'
const LEGACY_BUCKET_KEYS_KEY = `${LEGACY_BUCKET_PREFIX}_keys`
const legacyFieldKey = (field: string) => `${LEGACY_BUCKET_PREFIX}--${field}`

// コールバック形式で呼び出す（jestのchromeモックが両形式に対応しているが、
// 既存コード（App.tsx / background.ts）と同じ形式に揃える）
const syncGet = (keys: string[]): Promise<Record<string, any>> =>
  new Promise(resolve => chrome.storage.sync.get(keys, items => resolve(items)))

const syncSet = (items: Record<string, any>): Promise<void> =>
  new Promise(resolve => chrome.storage.sync.set(items, resolve))

const syncRemove = (keys: string[]): Promise<void> =>
  new Promise(resolve => chrome.storage.sync.remove(keys, resolve))

export const saveOptions = (options: Options): Promise<void> =>
  syncSet({ [OPTIONS_STORAGE_KEY]: options })

/**
 * フラットな`options`キーを読む。旧bucketキーが残っている場合は
 * フラットキーへ統合し、旧キーを削除する（一度きりのマイグレーション）。
 */
export const loadOptions = async (): Promise<Options | undefined> => {
  const result = await syncGet([OPTIONS_STORAGE_KEY, LEGACY_BUCKET_KEYS_KEY])
  const flat = result[OPTIONS_STORAGE_KEY] as Options | undefined
  const legacyFields = (result[LEGACY_BUCKET_KEYS_KEY] as string[] | undefined) ?? []
  if (legacyFields.length === 0) return flat

  // フラット側に既にあるフィールドはフラット側を優先する
  // （HUD・service workerが実際に消費してきたのはフラット側の値）。
  // sendUserDataのように旧bucketにしか無いフィールドはここで拾われる。
  const legacyResult = await syncGet(legacyFields.map(legacyFieldKey))
  const legacy: Record<string, any> = {}
  for (const field of legacyFields) {
    const value = legacyResult[legacyFieldKey(field)]
    if (value !== undefined) legacy[field] = value
  }
  const merged = { ...legacy, ...flat } as Options
  await saveOptions(merged)
  await syncRemove([LEGACY_BUCKET_KEYS_KEY, ...legacyFields.map(legacyFieldKey)])
  return merged
}
