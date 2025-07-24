import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import LinearProgress from '@mui/material/LinearProgress'
import Typography from '@mui/material/Typography'
import React from 'react'
import { FileDownload, FileUpload } from '@mui/icons-material'
import type {
  ExportDataMessage,
  ImportDataChunkMessage,
  ImportDataInitMessage,
  ImportDataProcessMessage,
} from '../../types/messages'

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
  const handleExportClick = (format: string) => {
    chrome.runtime.sendMessage<ExportDataMessage>({
      action: 'exportData',
      format: format as 'json' | 'pokerstars'
    })
  }

  const handleImportClick = () => {
    fileInputRef.current?.click()
  }

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

  const handleRebuildClick = () => {
    if (window.confirm('データを再構築しますか？この処理には時間がかかる場合があります。')) {
      chrome.runtime.sendMessage({ action: 'rebuildData' })
    }
  }

  return (
    <>
      <Button
        variant="contained"
        fullWidth
        onClick={() => handleExportClick('pokerstars')}
        startIcon={<FileDownload />}
        sx={{ 
          marginBottom: '10px',
          backgroundColor: '#d70022',
          color: 'white',
          '&:hover': {
            backgroundColor: '#b8001c'
          }
        }}
      >
        Export Hand History (PokerStars)
      </Button>

      <Button
        variant="contained"
        color="primary"
        fullWidth
        onClick={() => handleExportClick('json')}
        startIcon={<FileDownload />}
        style={{ marginBottom: '10px' }}
      >
        Export Raw Data (NDJSON)
      </Button>

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
        startIcon={<FileUpload />}
        style={{ marginBottom: '10px' }}
        disabled={importProgress > 0 && importProgress < 100}
      >
        {importProgress > 0 && importProgress < 100 ? 'Importing...' : 'Import Raw Data (NDJSON)'}
      </Button>

      {importProgress > 0 && importProgress < 100 && (
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

      {importStatus && (
        <Typography
          variant="body2"
          color={importStatus.includes('失敗') ? 'error' : 'success'}
          style={{ marginTop: '5px', textAlign: 'center' }}
        >
          {importStatus}
        </Typography>
      )}

      <Button
        variant="outlined"
        fullWidth
        onClick={handleRebuildClick}
        style={{ marginTop: '10px' }}
        disabled={importStatus === 'データ再構築中...'}
      >
        データ再構築
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