import { FileUpload } from '@mui/icons-material'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import CssBaseline from '@mui/material/CssBaseline'
import LinearProgress from '@mui/material/LinearProgress'
import Paper from '@mui/material/Paper'
import { ThemeProvider } from '@mui/material/styles'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { ChangeEvent, useEffect, useRef, useState } from 'react'
import type { OperationState } from '../background/operation-state'
import {
  IMPORT_RESULT_STORAGE_KEY,
  type ImportResultRecord,
} from '../constants/import-page'
import type {
  ChromeMessage,
  ImportDataChunkMessage,
  ImportDataInitMessage,
  ImportDataProcessMessage,
  MessageResponse,
} from '../types/messages'
import type { PopupThemeMode } from './popup/theme'
import {
  DEFAULT_POPUP_THEME_MODE,
  getPopupTheme,
  resolvePopupThemeVariant,
} from './popup/theme'

const FILE_CHUNK_SIZE = 5 * 1024 * 1024

type ImportPhase = 'idle' | 'uploading' | 'processing' | 'rebuilding' | 'completed' | 'error'

interface ImportPageProps {
  initialPopupThemeMode?: PopupThemeMode
}

const requireSuccessfulResponse = (
  response: MessageResponse | undefined,
  fallbackMessage: string
): void => {
  if (!response?.success) {
    throw new Error(response?.error || fallbackMessage)
  }
}

const phaseFromOperationState = (state: OperationState): ImportPhase | undefined => {
  if (state.type === 'import') {
    return state.phase === 'transfer' ? 'uploading' : 'processing'
  }
  if (state.type === 'rebuild' && state.origin === 'import') {
    return 'rebuilding'
  }
  return undefined
}

const readBlobAsArrayBuffer = (blob: Blob): Promise<ArrayBuffer> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = event => resolve(event.target?.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error ?? new Error('ファイルを読み込めませんでした'))
    reader.readAsArrayBuffer(blob)
  })

export const ImportPage = ({
  initialPopupThemeMode = DEFAULT_POPUP_THEME_MODE,
}: ImportPageProps) => {
  const prefersDarkScheme = useMediaQuery('(prefers-color-scheme: dark)')
  const theme = getPopupTheme(resolvePopupThemeVariant(initialPopupThemeMode, prefersDarkScheme))
  const fileInputRef = useRef<HTMLInputElement>(null)
  const importFlowActiveRef = useRef(false)
  const [phase, setPhase] = useState<ImportPhase>('idle')
  const [progress, setProgress] = useState(0)
  const [processed, setProcessed] = useState(0)
  const [total, setTotal] = useState(0)
  const [duplicates, setDuplicates] = useState(0)
  const [imported, setImported] = useState(0)
  const [status, setStatus] = useState('')
  const [fileName, setFileName] = useState('')

  const isActive = phase === 'uploading' || phase === 'processing' || phase === 'rebuilding'

  useEffect(() => {
    chrome.storage.local.get(IMPORT_RESULT_STORAGE_KEY, (result: Record<string, unknown>) => {
      if (chrome.runtime.lastError) return
      const stored = result[IMPORT_RESULT_STORAGE_KEY] as ImportResultRecord | undefined
      if (stored) {
        setPhase(stored.status)
        setStatus(stored.message)
      }

      // Read the active operation after the older persisted result so an
      // in-flight import always wins if callbacks settle in either order.
      chrome.runtime.sendMessage({ action: 'getOperationState' }, (response: {
        operationState?: OperationState
      }) => {
        const state = response?.operationState
        if (!state) return
        const restoredPhase = phaseFromOperationState(state)
        if (!restoredPhase) return
        importFlowActiveRef.current = true
        setPhase(restoredPhase)
        setProgress(state.progress ?? 0)
        setProcessed(state.processed ?? 0)
        setTotal(state.total ?? 0)
        setStatus(state.message ?? '')
      })
    })

    const handleMessage = (message: ChromeMessage) => {
      if (message.action === 'importProgress') {
        importFlowActiveRef.current = true
        setPhase('processing')
        setProgress(message.progress)
        setProcessed(message.processed)
        setTotal(message.total)
        setDuplicates(message.duplicates ?? 0)
        setImported(message.imported ?? 0)
        setStatus('生データを保存中...')
      } else if (message.action === 'rebuildProgress' && (
        importFlowActiveRef.current ||
        message.message?.includes('インポート')
      )) {
        if (message.state === 'started' || message.state === 'processing') {
          setPhase('rebuilding')
          setProgress(message.progress ?? 0)
          setStatus(message.message ?? 'インポート後のデータ再構築中...')
        } else if (message.state === 'error') {
          setPhase('error')
          setStatus(message.message ?? 'インポート後のデータ再構築に失敗しました')
        }
      } else if (message.action === 'importStatus') {
        const failed = message.status.includes('失敗')
        importFlowActiveRef.current = false
        setPhase(failed ? 'error' : 'completed')
        setProgress(failed ? 0 : 100)
        setStatus(message.status)
      }
    }

    chrome.runtime.onMessage.addListener(handleMessage)
    return () => chrome.runtime.onMessage.removeListener(handleMessage)
  }, [])

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    const fileSizeMB = Math.round(file.size / 1024 / 1024)
    if (fileSizeMB > 50 && !window.confirm(
      `ファイルサイズが${fileSizeMB}MBと大きいため、インポートに時間がかかる可能性があります。続行しますか？`
    )) {
      event.target.value = ''
      return
    }

    setFileName(file.name)
    importFlowActiveRef.current = true
    setPhase('uploading')
    setProgress(0)
    setProcessed(0)
    setTotal(0)
    setDuplicates(0)
    setImported(0)
    setStatus('インポートファイル転送中...')
    try {
      await chrome.storage.local.remove(IMPORT_RESULT_STORAGE_KEY)
    } catch (error) {
      console.warn('[ImportPage] Failed to clear the previous import result:', error)
    }

    try {
      const totalChunks = Math.ceil(file.size / FILE_CHUNK_SIZE)
      const initResponse = await chrome.runtime.sendMessage({
        action: 'importDataInit',
        totalChunks,
        fileName: file.name,
      } satisfies ImportDataInitMessage) as MessageResponse | undefined
      requireSuccessfulResponse(initResponse, 'インポートを開始できませんでした')

      const decoder = new TextDecoder()
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const start = chunkIndex * FILE_CHUNK_SIZE
        const end = Math.min(start + FILE_CHUNK_SIZE, file.size)
        const chunkBytes = await readBlobAsArrayBuffer(file.slice(start, end))
        const chunkData = decoder.decode(new Uint8Array(chunkBytes), {
          stream: chunkIndex < totalChunks - 1,
        })

        const chunkResponse = await chrome.runtime.sendMessage({
          action: 'importDataChunk',
          chunkIndex,
          chunkData,
        } satisfies ImportDataChunkMessage) as MessageResponse | undefined
        requireSuccessfulResponse(chunkResponse, 'インポートデータを送信できませんでした')

        const uploadedChunks = chunkIndex + 1
        setProcessed(uploadedChunks)
        setTotal(totalChunks)
        setProgress(Math.round((uploadedChunks / totalChunks) * 100))
      }

      setPhase('processing')
      setProgress(0)
      setProcessed(0)
      setTotal(0)
      setStatus('生データを処理中...')

      const processResponse = await chrome.runtime.sendMessage({
        action: 'importDataProcess',
      } satisfies ImportDataProcessMessage) as MessageResponse | undefined
      requireSuccessfulResponse(processResponse, 'インポートを処理できませんでした')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      importFlowActiveRef.current = false
      const result: ImportResultRecord = {
        status: 'error',
        message: `インポート失敗: ${message}`,
        completedAt: Date.now(),
      }
      setPhase('error')
      setProgress(0)
      setStatus(result.message)
      try {
        await chrome.storage.local.set({ [IMPORT_RESULT_STORAGE_KEY]: result })
      } catch (storageError) {
        console.warn('[ImportPage] Failed to persist the import transfer error:', storageError)
      }
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const progressLabel = phase === 'uploading'
    ? `ファイル転送中... ${processed.toLocaleString()}/${total.toLocaleString()} (${progress}%)`
    : phase === 'processing'
      ? `生データを保存中... ${processed.toLocaleString()}/${total.toLocaleString()} (${progress}%)`
      : status || 'インポート後のデータ再構築中...'

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ maxWidth: 640, mx: 'auto', p: 3 }}>
        <Paper elevation={3} sx={{ p: 3 }}>
          <Typography variant="h5" component="h1" sx={{ mb: 1 }}>
            NDJSONインポート
          </Typography>
          <Alert severity="info" sx={{ mb: 2 }}>
            このタブを開いたままにしてください。拡張機能の通常ポップアップを閉じてもインポートは継続します。
          </Alert>

          <input
            type="file"
            accept=".ndjson"
            style={{ display: 'none' }}
            ref={fileInputRef}
            onChange={handleFileChange}
          />
          <Button
            variant="contained"
            fullWidth
            onClick={() => fileInputRef.current?.click()}
            startIcon={isActive ? <CircularProgress size={20} color="inherit" /> : <FileUpload />}
            disabled={isActive}
          >
            {isActive ? 'インポート中...' : 'NDJSONファイルを選択'}
          </Button>

          {fileName && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              ファイル: {fileName}
            </Typography>
          )}

          {isActive && (
            <Box sx={{ mt: 2 }}>
              <LinearProgress
                variant={phase === 'rebuilding' && progress === 0 ? 'indeterminate' : 'determinate'}
                value={progress}
              />
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1, textAlign: 'center' }}>
                {progressLabel}
              </Typography>
              {phase === 'processing' && imported > 0 && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center' }}>
                  新規: {imported.toLocaleString()} / 重複: {duplicates.toLocaleString()}
                </Typography>
              )}
            </Box>
          )}

          {(phase === 'completed' || phase === 'error') && status && (
            <Alert severity={phase === 'error' ? 'error' : 'success'} sx={{ mt: 2 }}>
              {status}
            </Alert>
          )}
        </Paper>
      </Box>
    </ThemeProvider>
  )
}
