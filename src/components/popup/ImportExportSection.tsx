import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import LinearProgress from '@mui/material/LinearProgress'
import Typography from '@mui/material/Typography'
import React, { useCallback, useEffect, useState } from 'react'
import { FileDownload, FileUpload } from '@mui/icons-material'
import type {
  ExportDataMessage,
  ExportProgressMessage,
  ImportDataChunkMessage,
  ImportDataInitMessage,
  ImportDataProcessMessage,
  RebuildProgressMessage,
} from '../../types/messages'
import { isExportProgressMessage, isRebuildProgressMessage } from '../../types/messages'

interface ImportExportSectionProps {
  importStatus: string
  importProgress: number
  importProcessed: number
  importTotal: number
  importDuplicates: number
  importSuccess: number
  importStartTime: number
  fileInputRef: React.RefObject<HTMLInputElement>
  setImportStatus: (status: string) => void
  setImportProgress: (progress: number) => void
  setImportProcessed: (processed: number) => void
  setImportTotal: (total: number) => void
  setImportDuplicates: (duplicates: number) => void
  setImportSuccess: (success: number) => void
  setImportStartTime: (time: number) => void
}

const FILE_CHUNK_SIZE = 5 * 1024 * 1024 // 5MB chunks for file import

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
  fileInputRef,
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

  const isImporting = importProgress > 0 && importProgress < 100
  const isAnyOperationInProgress = isImporting || exportState !== 'idle' || rebuildState !== 'idle'

  // Listen for export/rebuild progress messages and query state on mount
  useEffect(() => {
    // Query current operation state on mount (handles popup close/reopen)
    chrome.runtime.sendMessage({ action: 'getOperationState' }, (response: any) => {
      if (chrome.runtime.lastError) return // Extension context may be invalid
      if (response?.operationState) {
        const state = response.operationState
        if (state.type === 'export') {
          setExportState('exporting')
          setExportFormat(state.format ?? null)
          setExportProgress(state.progress ?? 0)
          setExportProcessed(state.processed ?? 0)
          setExportTotal(state.total ?? 0)
          setOperationStatus(state.message ?? '')
        } else if (state.type === 'rebuild') {
          setRebuildState('rebuilding')
          setRebuildProgress(state.progress ?? 0)
          setOperationStatus(state.message ?? '')
        }
        // Import state is managed by parent Popup.tsx via importProgress messages
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
        switch (msg.state) {
          case 'started':
            setRebuildState('rebuilding')
            setRebuildProgress(0)
            setOperationStatus(msg.message ?? '')
            break
          case 'processing':
            setRebuildProgress(msg.progress ?? 0)
            setOperationStatus(msg.message ?? '')
            break
          case 'completed':
            setRebuildState('idle')
            setRebuildProgress(0)
            setOperationStatus(msg.message ?? 'データ再構築完了')
            break
          case 'error':
            setRebuildState('idle')
            setRebuildProgress(0)
            setOperationStatus(msg.message ?? 'データ再構築失敗')
            break
        }
      }
    }

    chrome.runtime.onMessage.addListener(handleMessage)
    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage)
    }
  }, [])

  const handleExportClick = useCallback((format: string) => {
    chrome.runtime.sendMessage<ExportDataMessage>({
      action: 'exportData',
      format: format as 'json' | 'pokerstars'
    })
  }, [])

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [fileInputRef])

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    // Show file size warning for large files
    const fileSizeMB = Math.round(file.size / 1024 / 1024)
    if (fileSizeMB > 50) {
      const confirmImport = window.confirm(
        `ファイルサイズが${fileSizeMB}MBと大きいため、インポートに時間がかかる可能性があります。続行しますか？`
      )
      if (!confirmImport) {
        if (fileInputRef.current) {
          fileInputRef.current.value = ''
        }
        return
      }
    }

    try {
      // Start import with progress tracking
      setImportProgress(0)
      setImportProcessed(0)
      setImportTotal(0)
      setImportDuplicates(0)
      setImportSuccess(0)
      setImportStatus('インポート開始...')
      setImportStartTime(Date.now())

      // For large files, we need to chunk the data before sending
      const totalChunks = Math.ceil(file.size / FILE_CHUNK_SIZE)

      // Initialize import session
      await chrome.runtime.sendMessage<ImportDataInitMessage>({
        action: 'importDataInit',
        totalChunks: totalChunks,
        fileName: file.name
      })

      // Read and send file in chunks
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const start = chunkIndex * FILE_CHUNK_SIZE
        const end = Math.min(start + FILE_CHUNK_SIZE, file.size)
        const chunk = file.slice(start, end)
        
        const chunkContent = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = (e) => resolve(e.target?.result as string)
          reader.onerror = reject
          reader.readAsText(chunk)
        })

        // Send chunk to background
        await chrome.runtime.sendMessage<ImportDataChunkMessage>({
          action: 'importDataChunk',
          chunkIndex: chunkIndex,
          chunkData: chunkContent
        })

        // Update progress
        const fileProgress = Math.round(((chunkIndex + 1) / totalChunks) * 100)
        setImportProgress(fileProgress)
      }

      // Process the complete data
      await chrome.runtime.sendMessage<ImportDataProcessMessage>({
        action: 'importDataProcess'
      })

      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    } catch (error) {
      setImportStatus(`インポート失敗: ${error}`)
      setImportProgress(0)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const handleRebuildClick = useCallback(() => {
    if (window.confirm('データを再構築しますか？この処理には時間がかかる場合があります。')) {
      chrome.runtime.sendMessage({ action: 'rebuildData' })
    }
  }, [])

  // Determine status display
  const displayStatus = operationStatus || importStatus
  const isStatusError = displayStatus.includes('失敗') || displayStatus.includes('エラー')

  return (
    <>
      <Button
        variant="contained"
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
          backgroundColor: '#d70022',
          color: 'white',
          '&:hover': {
            backgroundColor: '#b8001c'
          },
          '&.Mui-disabled': {
            backgroundColor: exportState === 'exporting' && exportFormat === 'pokerstars' ? '#d70022' : undefined,
            color: exportState === 'exporting' && exportFormat === 'pokerstars' ? 'white' : undefined,
            opacity: exportState === 'exporting' && exportFormat === 'pokerstars' ? 0.8 : undefined,
          }
        }}
      >
        {exportState === 'exporting' && exportFormat === 'pokerstars'
          ? 'Exporting...'
          : 'Export Hand History (PokerStars)'}
      </Button>

      <Button
        variant="contained"
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
            backgroundColor: exportState === 'exporting' && exportFormat === 'json' ? 'primary.main' : undefined,
            color: exportState === 'exporting' && exportFormat === 'json' ? 'white' : undefined,
            opacity: exportState === 'exporting' && exportFormat === 'json' ? 0.8 : undefined,
          }
        }}
      >
        {exportState === 'exporting' && exportFormat === 'json'
          ? 'Exporting...'
          : 'Export Raw Data (NDJSON)'}
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

      <input
        type="file"
        accept=".ndjson"
        style={{ display: 'none' }}
        ref={fileInputRef}
        onChange={handleFileChange}
      />

      <Button
        variant="contained"
        color="primary"
        fullWidth
        onClick={handleImportClick}
        startIcon={
          isImporting
            ? <CircularProgress size={20} color="inherit" />
            : <FileUpload />
        }
        disabled={isAnyOperationInProgress}
        sx={{
          marginBottom: '10px',
          '&.Mui-disabled': {
            backgroundColor: isImporting ? 'primary.main' : undefined,
            color: isImporting ? 'white' : undefined,
            opacity: isImporting ? 0.8 : undefined,
          }
        }}
      >
        {isImporting ? 'Importing...' : 'Import Raw Data (NDJSON)'}
      </Button>

      {isImporting && (
        <Box sx={{ marginTop: 2 }}>
          <LinearProgress variant="determinate" value={importProgress} />
          <Typography
            variant="body2"
            color="textSecondary"
            style={{ marginTop: '5px', textAlign: 'center' }}
          >
            インポート中... {importProcessed.toLocaleString()}/{importTotal.toLocaleString()} ({importProgress}%)
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

      <Button
        variant="outlined"
        fullWidth
        onClick={handleRebuildClick}
        disabled={isAnyOperationInProgress}
        startIcon={
          rebuildState === 'rebuilding'
            ? <CircularProgress size={20} />
            : undefined
        }
        style={{ marginTop: '10px' }}
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
