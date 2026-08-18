/**
 * PokerChaseの参加取消応答。対局pipelineには流さずactivity判定だけに使う。
 * `ApiType`へ追加するとapplication event扱いになるため、生ApiTypeIdのまま共有する。
 */
export const EVT_ENTRY_CANCELLED_API_TYPE_ID = 203

const getResponseCode = (response: unknown): unknown =>
  typeof response === 'object' && response !== null
    ? (response as { Code?: unknown }).Code
    : undefined

/** 201の非0 Codeだけを明示的な参加失敗として扱う。Code欠落は安全側のACTIVE。 */
export const isExplicitEntryFailure = (
  response: unknown
): boolean => {
  const code = getResponseCode(response)
  return typeof code === 'number' && code !== 0
}

/**
 * 203はCode=0の成功応答だけが参加取消の確定境界。
 * 非0 CodeまたはCode欠落をINACTIVEへ倒してはならない（MUST NOT）。
 */
export const isConfirmedEntryCancellation = (
  response: unknown
): boolean => getResponseCode(response) === 0
