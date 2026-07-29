export const IMPORT_PAGE_MODE = 'import'
export const IMPORT_RESULT_STORAGE_KEY = 'lastImportResult'

export interface ImportResultRecord {
  status: 'completed' | 'error'
  message: string
  completedAt: number
}

export const getImportPageUrl = (): string =>
  chrome.runtime.getURL(`dist/index.html?mode=${IMPORT_PAGE_MODE}`)

export const isImportPageSearch = (search: string): boolean =>
  new URLSearchParams(search).get('mode') === IMPORT_PAGE_MODE
