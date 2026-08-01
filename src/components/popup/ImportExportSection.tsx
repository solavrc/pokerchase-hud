import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import LinearProgress from '@mui/material/LinearProgress'
import Typography from '@mui/material/Typography'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FileDownload, FileUpload } from '@mui/icons-material'
import type {
  AcknowledgeRebuildAdvisoryMessage,
  ExportDataMessage,
  ExportProgressMessage,
  RebuildProgressMessage,
} from '../../types/messages'
import {
  isExportProgressMessage,
  isImportProgressMessage,
  isImportStatusMessage,
  isRebuildProgressMessage,
} from '../../types/messages'
import type { OperationState } from '../../background/operation-state'
import { REBUILD_ADVISORY_STORAGE_KEY, type RebuildAdvisoryState } from '../../background/rebuild-advisory'
import {
  getImportPageUrl,
  IMPORT_RESULT_STORAGE_KEY,
  type ImportResultRecord,
} from '../../constants/import-page'
import { sendMessageWithTimeout } from './send-message'

interface ImportExportSectionProps {
  importStatus: string
  importProgress: number
  importProcessed: number
  importTotal: number
  importDuplicates: number
  importSuccess: number
  importStartTime: number
  setImportStatus: (status: string) => void
  setImportProgress: (progress: number) => void
  setImportProcessed: (processed: number) => void
  setImportTotal: (total: number) => void
  setImportDuplicates: (duplicates: number) => void
  setImportSuccess: (success: number) => void
  setImportStartTime: (time: number) => void
}

type ExportState = 'idle' | 'exporting'
type RebuildState = 'idle' | 'rebuilding'

export const ImportExportSection = ({
  importStatus,
  importProgress,
  importProcessed,
  importTotal,
  importDuplicates,
  importSuccess,
  importStartTime,
  setImportStatus,
  setImportProgress,
  setImportProcessed,
  setImportTotal,
  setImportDuplicates,
  setImportSuccess,
  setImportStartTime,
}: ImportExportSectionProps) => {
  const [exportState, setExportState] = useState<ExportState>('idle')
  const [exportFormat, setExportFormat] = useState<'json' | 'pokerstars' | null>(null)
  const [exportProgress, setExportProgress] = useState(0)
  const [exportProcessed, setExportProcessed] = useState(0)
  const [exportTotal, setExportTotal] = useState(0)
  const [rebuildState, setRebuildState] = useState<RebuildState>('idle')
  const [rebuildProgress, setRebuildProgress] = useState(0)
  const [operationStatus, setOperationStatus] = useState('')
  const [rebuildAdvisoryPending, setRebuildAdvisoryPending] = useState(false)
  const [importOperationActive, setImportOperationActive] = useState(false)
  const importOperationActiveRef = useRef(false)
  const openImportPageInFlightRef = useRef(false)
  const [rebuildOrigin, setRebuildOrigin] = useState<'import' | 'manual' | null>(null)

  const isImporting = importOperationActive && rebuildOrigin !== 'import'
  const isAnyOperationInProgress = importOperationActive || exportState !== 'idle' || rebuildState !== 'idle'
  const isOtherOperationInProgress = exportState !== 'idle' || (rebuildState !== 'idle' && rebuildOrigin !== 'import')

  // Listen for export/rebuild progress messages and query state on mount
  useEffect(() => {
    // Query current operation state on mount (handles popup close/reopen).
    // Fails open: on timeout/error, leave export/rebuild state at their
    // 'idle' defaults instead of blocking the buttons or showing a spinner.
    sendMessageWithTimeout<{ operationState?: OperationState }>({ action: 'getOperationState' }).then((response) => {
      if (response?.operationState) {
        const state = response.operationState
        if (state.type === 'export') {
          setExportState('exporting')
          setExportFormat(state.format ?? null)
          setExportProgress(state.progress ?? 0)
          setExportProcessed(state.processed ?? 0)
          setExportTotal(state.total ?? 0)
          setOperationStatus(state.message ?? '')
        } else if (state.type === 'import') {
          importOperationActiveRef.current = true
          setImportOperationActive(true)
          setImportStatus('')
          setImportProgress(state.progress ?? 0)
          setImportProcessed(state.processed ?? 0)
          setImportTotal(state.total ?? 0)
          setImportStartTime(Date.now())
          setOperationStatus(state.message ?? 'インポート中...')
        } else if (state.type === 'rebuild') {
          setRebuildState('rebuilding')
          setRebuildOrigin(state.origin === 'import' ? 'import' : 'manual')
          if (state.origin === 'import') {
            importOperationActiveRef.current = true
            setImportOperationActive(true)
          }
          setRebuildProgress(state.progress ?? 0)
          setOperationStatus(state.message ?? '')
        }
      }
    })

    const handleMessage = (message: unknown) => {
      if (isExportProgressMessage(message)) {
        const msg = message as ExportProgressMessage
        switch (msg.state) {
          case 'started':
            setExportState('exporting')
            setExportFormat(msg.format ?? null)
            setExportProgress(0)
            setExportProcessed(0)
            setExportTotal(0)
            setOperationStatus(msg.message ?? '')
            break
          case 'processing':
            setExportState('exporting')
            setExportFormat(msg.format ?? null)
            setExportProgress(msg.progress ?? 0)
            setExportProcessed(msg.processed ?? 0)
            setExportTotal(msg.total ?? 0)
            setOperationStatus(msg.message ?? '')
            break
          case 'completed':
            setExportState('idle')
            setExportFormat(null)
            setExportProgress(0)
            setOperationStatus(msg.message ?? 'エクスポート完了')
            break
          case 'error':
            setExportState('idle')
            setExportFormat(null)
            setExportProgress(0)
            setOperationStatus(msg.message ?? 'エクスポート失敗')
            break
        }
      }

      if (isRebuildProgressMessage(message)) {
        const msg = message as RebuildProgressMessage
        const isImportRebuild = importOperationActiveRef.current || msg.message?.includes('インポート')
        switch (msg.state) {
          case 'started':
            setRebuildState('rebuilding')
            setRebuildOrigin(isImportRebuild ? 'import' : 'manual')
            if (isImportRebuild) {
              importOperationActiveRef.current = true
              setImportOperationActive(true)
            }
            setRebuildProgress(0)
            setOperationStatus(msg.message ?? '')
            break
          case 'processing':
            setRebuildState('rebuilding')
            setRebuildOrigin(isImportRebuild ? 'import' : 'manual')
            setRebuildProgress(msg.progress ?? 0)
            setOperationStatus(msg.message ?? '')
            break
          case 'completed':
            setRebuildState('idle')
            setRebuildOrigin(null)
            setRebuildProgress(0)
            setOperationStatus(msg.message ?? 'データ再構築完了')
            break
          case 'error':
            setRebuildState('idle')
            setRebuildOrigin(null)
            setRebuildProgress(0)
            setOperationStatus(msg.message ?? 'データ再構築失敗')
            break
        }
      }

      if (isImportProgressMessage(message)) {
        importOperationActiveRef.current = true
        setImportOperationActive(true)
        setImportStatus('')
        setImportProgress(message.progress)
        setImportProcessed(message.processed)
        setImportTotal(message.total)
        setImportDuplicates(message.duplicates ?? 0)
        setImportSuccess(message.imported ?? 0)
        setOperationStatus('生データを保存中...')
      }

      if (isImportStatusMessage(message)) {
        importOperationActiveRef.current = false
        setImportOperationActive(false)
        setRebuildOrigin(null)
        setImportStatus(message.status)
        setOperationStatus('')
      }
    }

    chrome.runtime.onMessage.addListener(handleMessage)
    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage)
    }
  }, [])

  // データ再構築アドバイザリ: マウント時に一度読み込み、以後はstorage変更を購読する
  // （rebuildAllData完了時のresolveAdvisory()によるstorage書き込みでバナーが自動的に消える）
  useEffect(() => {
    chrome.storage.local.get(
      [REBUILD_ADVISORY_STORAGE_KEY, IMPORT_RESULT_STORAGE_KEY],
      (result: Record<string, any>) => {
        if (chrome.runtime.lastError) return
        const state = result?.[REBUILD_ADVISORY_STORAGE_KEY] as RebuildAdvisoryState | undefined
        setRebuildAdvisoryPending(!!state?.pendingVersion)
        const importResult = result?.[IMPORT_RESULT_STORAGE_KEY] as ImportResultRecord | undefined
        if (importResult) setImportStatus(importResult.message)
      }
    )

    const handleStorageChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string
    ) => {
      if (areaName !== 'local') return
      if (changes[REBUILD_ADVISORY_STORAGE_KEY]) {
        const newState = changes[REBUILD_ADVISORY_STORAGE_KEY].newValue as RebuildAdvisoryState | undefined
        setRebuildAdvisoryPending(!!newState?.pendingVersion)
      }
      if (changes[IMPORT_RESULT_STORAGE_KEY]?.newValue) {
        const importResult = changes[IMPORT_RESULT_STORAGE_KEY].newValue as ImportResultRecord
        // A result written while the popup is open is terminal: the background
        // is idle again. Release the same state the importStatus message path
        // above releases, because that message never arrives when the import
        // page itself fails mid-transfer -- ImportPage's catch writes this key
        // directly and only sends importDataCancel, which broadcasts nothing.
        // Leaving importOperationActive set keeps isAnyOperationInProgress
        // true, which blanks displayStatus (hiding this very error) and holds
        // export and rebuild disabled.
        importOperationActiveRef.current = false
        setImportOperationActive(false)
        setRebuildOrigin(null)
        setImportStatus(importResult.message)
        setOperationStatus('')
      }
    }

    chrome.storage.onChanged.addListener(handleStorageChange)
    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange)
    }
  }, [])

  const handleDismissRebuildAdvisory = useCallback(() => {
    // 楽観的に即座に消す（background側の書き込みでも二重に消えるが問題ない）
    setRebuildAdvisoryPending(false)
    chrome.runtime.sendMessage<AcknowledgeRebuildAdvisoryMessage>({
      action: 'acknowledgeRebuildAdvisory'
    })
  }, [])

  const handleExportClick = useCallback((format: 'json' | 'pokerstars') => {
    // Optimistically set state immediately to disable buttons (prevents double-click)
    setExportState('exporting')
    setExportFormat(format)
    setExportProgress(0)
    setExportProcessed(0)
    setExportTotal(0)
    setOperationStatus(format === 'pokerstars' ? 'PokerStarsエクスポート開始...' : 'NDJSONエクスポート開始...')

    chrome.runtime.sendMessage<ExportDataMessage>({
      action: 'exportData',
      format
    }, (response: any) => {
      // If background rejected (e.g., concurrent operation), revert state
      if (response && !response.success) {
        setExportState('idle')
        setExportFormat(null)
        setOperationStatus(response.error || 'エクスポート失敗')
      }
    })
  }, [])

  const handleImportClick = useCallback(async () => {
    // Single-flight. query + create is a check-then-act pair: a second click
    // while the first round trip is still open runs its own query, still sees
    // no import page, and creates a second one. Both pages then race for the
    // single import operation slot and the loser writes its rejection into
    // lastImportResult, surfacing as a failure the user never started.
    if (openImportPageInFlightRef.current) return
    openImportPageInFlightRef.current = true
    try {
      const importPageUrl = getImportPageUrl()
      const tabs = await chrome.tabs.query({})
      // A tab whose navigation has not committed yet carries the destination
      // in pendingUrl only -- url is empty or still the previous page. Matching
      // on url alone misses the import page opened moments ago and opens
      // another one.
      const existingTab = tabs.find(
        tab => tab.url === importPageUrl || tab.pendingUrl === importPageUrl
      )
      if (existingTab?.id !== undefined) {
        await chrome.tabs.update(existingTab.id, { active: true })
        if (existingTab.windowId !== undefined) {
          await chrome.windows.update(existingTab.windowId, { focused: true })
        }
        return
      }
      await chrome.tabs.create({ url: importPageUrl })
    } catch (error) {
      console.error('Failed to open the NDJSON import page:', error)
      setImportStatus('インポートページを開けませんでした。もう一度お試しください。')
    } finally {
      openImportPageInFlightRef.current = false
    }
  }, [])

  const handleRebuildClick = useCallback(() => {
    if (window.confirm('データを再構築しますか？この処理には時間がかかる場合があります。')) {
      // Optimistically set state immediately to disable buttons
      setRebuildState('rebuilding')
      setRebuildProgress(0)
      setOperationStatus('データ再構築開始...')

      chrome.runtime.sendMessage({ action: 'rebuildData' }, (response: any) => {
        // If background rejected (e.g., concurrent operation), revert state
        if (response && !response.success) {
          setRebuildState('idle')
          setRebuildProgress(0)
          setOperationStatus(response.error || 'データ再構築失敗')
        }
      })
    }
  }, [])

  // Determine status display
  const displayStatus = isAnyOperationInProgress ? '' : operationStatus || importStatus
  const isStatusError = displayStatus.includes('失敗') || displayStatus.includes('エラー')

  return (
    <>
      <Button
        variant="contained"
        color="primary"
        fullWidth
        onClick={() => handleExportClick('pokerstars')}
        startIcon={
          exportState === 'exporting' && exportFormat === 'pokerstars'
            ? <CircularProgress size={20} color="inherit" />
            : <FileDownload />
        }
        disabled={isAnyOperationInProgress}
        sx={{
          marginBottom: '10px',
          '&.Mui-disabled': {
            // While a PokerStars export is running, keep this button on its
            // themed primary background instead of MUI's disabled-gray, so
            // the active operation stays visually obvious. Doing that alone
            // regresses foreground contrast (MUI defaults disabled text to
            // `action.disabled`, and the CircularProgress uses
            // `color="inherit"`), so the foreground must be pinned to
            // `primary.contrastText` too -- both theme.ts variants already
            // define one for exactly this kind of on-primary content
            // (dark-felt: #211804 on #d9a842 ~8.0:1; modern-light: #ffffff
            // on #1f6b45 ~6.5:1, both well above WCAG AA's 4.5:1).
            backgroundColor: exportState === 'exporting' && exportFormat === 'pokerstars' ? 'primary.main' : undefined,
            color: exportState === 'exporting' && exportFormat === 'pokerstars' ? 'primary.contrastText' : undefined,
            opacity: exportState === 'exporting' && exportFormat === 'pokerstars' ? 0.8 : undefined,
          }
        }}
      >
        {exportState === 'exporting' && exportFormat === 'pokerstars'
          ? 'エクスポート中...'
          : 'ハンド履歴をエクスポート (PokerStars)'}
      </Button>

      <Button
        variant="outlined"
        color="primary"
        fullWidth
        onClick={() => handleExportClick('json')}
        startIcon={
          exportState === 'exporting' && exportFormat === 'json'
            ? <CircularProgress size={20} color="inherit" />
            : <FileDownload />
        }
        disabled={isAnyOperationInProgress}
        sx={{
          marginBottom: '10px',
          '&.Mui-disabled': {
            opacity: exportState === 'exporting' && exportFormat === 'json' ? 0.8 : undefined,
          }
        }}
      >
        {exportState === 'exporting' && exportFormat === 'json'
          ? 'エクスポート中...'
          : '生データをエクスポート (NDJSON)'}
      </Button>

      {/* Export progress bar (both NDJSON and PokerStars) */}
      {exportState === 'exporting' && exportProgress > 0 && (
        <Box sx={{ marginBottom: '10px' }}>
          <LinearProgress variant="determinate" value={exportProgress} />
          <Typography
            variant="body2"
            color="textSecondary"
            style={{ marginTop: '5px', textAlign: 'center' }}
          >
            {exportFormat === 'json'
              ? `エクスポート中... ${exportProcessed.toLocaleString()}/${exportTotal.toLocaleString()} (${exportProgress}%)`
              : `ハンドヒストリー変換中... ${exportProcessed.toLocaleString()}/${exportTotal.toLocaleString()} (${exportProgress}%)`
            }
          </Typography>
        </Box>
      )}

      <Button
        variant="outlined"
        color="primary"
        fullWidth
        onClick={handleImportClick}
        startIcon={
          isImporting
            ? <CircularProgress size={20} color="inherit" />
            : <FileUpload />
        }
        disabled={isOtherOperationInProgress}
        sx={{
          marginBottom: '10px',
          '&.Mui-disabled': {
            opacity: isImporting ? 0.8 : undefined,
          }
        }}
      >
        {importOperationActive ? 'インポートページを表示' : '生データをインポート (NDJSON)'}
      </Button>

      {isImporting && (
        <Box sx={{ marginTop: 2 }}>
          <LinearProgress variant="determinate" value={importProgress} />
          <Typography
            variant="body2"
            color="textSecondary"
            style={{ marginTop: '5px', textAlign: 'center' }}
          >
            {operationStatus || 'インポート中...'} {importProcessed.toLocaleString()}/{importTotal.toLocaleString()} ({importProgress}%)
          </Typography>
          {importSuccess > 0 && (
            <Typography
              variant="caption"
              color="textSecondary"
              style={{ textAlign: 'center', display: 'block' }}
            >
              新規: {importSuccess.toLocaleString()} / 重複: {importDuplicates.toLocaleString()}
              {importStartTime > 0 && ` / 経過: ${Math.round((Date.now() - importStartTime) / 1000)}秒`}
            </Typography>
          )}
        </Box>
      )}

      {displayStatus && (
        <Typography
          variant="body2"
          color={isStatusError ? 'error' : 'success'}
          style={{ marginTop: '5px', textAlign: 'center' }}
        >
          {displayStatus}
        </Typography>
      )}

      {/* Rebuild progress bar */}
      {rebuildState === 'rebuilding' && (
        <Box sx={{ marginTop: 1, marginBottom: 1 }}>
          <LinearProgress variant={rebuildProgress > 0 ? 'determinate' : 'indeterminate'} value={rebuildProgress} />
          <Typography
            variant="body2"
            color="textSecondary"
            style={{ marginTop: '5px', textAlign: 'center' }}
          >
            {operationStatus || 'データ再構築中...'}
          </Typography>
        </Box>
      )}

      {/* データ再構築アドバイザリ: 統計ロジック更新後、既存ユーザーに再構築を促すバナー */}
      {rebuildAdvisoryPending && (
        <Alert
          severity="warning"
          onClose={handleDismissRebuildAdvisory}
          closeText="閉じる"
          sx={{ marginTop: 1, marginBottom: 1 }}
        >
          拡張機能の更新により統計ロジックが改善されました。既存データに正しい統計を反映するには「データ再構築」を実行してください。
        </Alert>
      )}

      <Button
        variant="outlined"
        color="inherit"
        fullWidth
        onClick={handleRebuildClick}
        disabled={isAnyOperationInProgress}
        startIcon={
          rebuildState === 'rebuilding'
            ? <CircularProgress size={20} />
            : undefined
        }
        sx={{ mt: 1.25, borderColor: 'divider', color: 'text.secondary' }}
      >
        {rebuildState === 'rebuilding' ? 'データ再構築中...' : 'データ再構築'}
      </Button>

      <Typography
        variant="caption"
        color="textSecondary"
        style={{ marginTop: '5px', display: 'block', textAlign: 'center' }}
      >
        ※ データ再構築は統計情報を再計算します
      </Typography>
    </>
  )
}
