import { getBucket } from '@extend-chrome/storage'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import FormGroup from '@mui/material/FormGroup'
import IconButton from '@mui/material/IconButton'
import LinearProgress from '@mui/material/LinearProgress'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemSecondaryAction from '@mui/material/ListItemSecondaryAction'
import ListItemText from '@mui/material/ListItemText'
import Slider from '@mui/material/Slider'
import Switch from '@mui/material/Switch'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import { ChangeEvent, useEffect, useRef, useState } from 'react'
import { FilterOptions, GameTypeFilter } from '../app'
import { defaultRegistry, defaultStatDisplayConfigs } from '../stats'
import type { StatDisplayConfig } from '../types/filters'
import type { UIConfig } from '../types/hand-log'
import { DEFAULT_UI_CONFIG, DEFAULT_HAND_LOG_CONFIG } from '../types/hand-log'
import type {
  ChromeMessage,
  DeleteAllDataMessage,
  ExportDataMessage,
  ImportDataChunkMessage,
  ImportDataInitMessage,
  ImportDataProcessMessage,
  UpdateBattleTypeFilterMessage,
} from '../types/messages'
import { content_scripts } from '../../manifest.json'

// Constants
const FILE_CHUNK_SIZE = 5 * 1024 * 1024 // 5MB chunks for file import

export interface Options {
  sendUserData: boolean;
  gameTypeFilter?: GameTypeFilter; // New filter format
  filterOptions?: FilterOptions; // Complete filter options
}

const bucket = getBucket<Options>('options', 'sync')

/**
 * Merge existing stat display configurations with new defaults
 * This ensures new statistics appear and obsolete ones are removed for existing users
 */
function mergeStatDisplayConfigs(
  existingConfigs: StatDisplayConfig[],
  defaultConfigs: StatDisplayConfig[]
): StatDisplayConfig[] {
  const defaultMap = new Map(defaultConfigs.map(config => [config.id, config]))
  const existingMap = new Map(existingConfigs.map(config => [config.id, config]))

  // Start with default configs as the base (ensures proper order and removes obsolete stats)
  const mergedConfigs = defaultConfigs.map(defaultConfig => {
    const existingConfig = existingMap.get(defaultConfig.id)
    if (existingConfig) {
      // Preserve user settings (enabled/disabled state and order) but update defaults if needed
      return {
        ...defaultConfig,
        enabled: existingConfig.enabled,
        order: existingConfig.order
      }
    }
    // New statistic - use default configuration
    return defaultConfig
  })

  // Log removed statistics for debugging
  const removedStats = existingConfigs
    .filter(existing => !defaultMap.has(existing.id))
    .map(stat => stat.id)

  if (removedStats.length > 0) {
    // Removed obsolete statistics
  }

  // Sort by order to maintain consistent display
  return mergedConfigs.sort((a, b) => a.order - b.order)
}

const Popup = () => {
  const [options, setOptions] = useState<Options>({ sendUserData: true })
  const [importStatus, setImportStatus] = useState<string>('')
  const [importProgress, setImportProgress] = useState<number>(0)
  const [importProcessed, setImportProcessed] = useState<number>(0)
  const [importTotal, setImportTotal] = useState<number>(0)
  const [importDuplicates, setImportDuplicates] = useState<number>(0)
  const [importSuccess, setImportSuccess] = useState<number>(0)
  const [importStartTime, setImportStartTime] = useState<number>(0)
  const [gameTypeFilter, setGameTypeFilter] = useState<GameTypeFilter>({ sng: true, mtt: true, ring: true })
  const [handLimit, setHandLimit] = useState<number | undefined>(500)
  const [statDisplayConfigs, setStatDisplayConfigs] = useState<StatDisplayConfig[]>(defaultStatDisplayConfigs)
  const [pendingStatDisplayConfigs, setPendingStatDisplayConfigs] = useState<StatDisplayConfig[]>(defaultStatDisplayConfigs)
  const [hasUnsavedStatChanges, setHasUnsavedStatChanges] = useState<boolean>(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState<boolean>(false)
  const [resetDialogOpen, setResetDialogOpen] = useState<boolean>(false)
  const [uiConfig, setUIConfig] = useState<UIConfig>(DEFAULT_UI_CONFIG)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    (async () => {
      // Check current tab URL
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })

      // Extract base URL from manifest
      const gameBaseUrl = content_scripts[0]!.matches[0]!.replace(/\/\*$/, '')

      // Check if current tab is on game domain
      if (activeTab?.url && !activeTab.url.startsWith(gameBaseUrl)) {
        // Not on game page - open game in new tab and close popup
        await chrome.tabs.create({ url: `${gameBaseUrl}/play/index.html` })
        window.close()
        return
      }

      const savedOptions = await bucket.get()
      setOptions(savedOptions)
      if (savedOptions.gameTypeFilter) {
        // 保存されたフィルタがすべて false の場合はデフォルト値を使用
        const checkedCount = Object.values(savedOptions.gameTypeFilter).filter(Boolean).length
        const safeFilter = checkedCount > 0 ? savedOptions.gameTypeFilter : { sng: true, mtt: true, ring: true }
        setGameTypeFilter(safeFilter)
      }
      if (savedOptions.filterOptions) {
        // 保存されたフィルタがすべて false の場合はデフォルト値を使用
        const checkedCount = Object.values(savedOptions.filterOptions.gameTypes).filter(Boolean).length
        const safeFilter = checkedCount > 0 ? savedOptions.filterOptions.gameTypes : { sng: true, mtt: true, ring: true }
        setGameTypeFilter(safeFilter)
        setHandLimit(savedOptions.filterOptions.handLimit)
        if (savedOptions.filterOptions.statDisplayConfigs) {
          // Merge existing configurations with new defaults
          const mergedConfigs = mergeStatDisplayConfigs(
            savedOptions.filterOptions.statDisplayConfigs,
            defaultStatDisplayConfigs
          )
          setStatDisplayConfigs(mergedConfigs)
          setPendingStatDisplayConfigs(mergedConfigs)

          // Save merged configurations back to storage if new stats were added
          if (mergedConfigs.length > savedOptions.filterOptions.statDisplayConfigs.length) {
            const updatedOptions = {
              ...savedOptions,
              filterOptions: {
                ...savedOptions.filterOptions,
                statDisplayConfigs: mergedConfigs
              }
            }
            bucket.set(updatedOptions)
          }
        }
      }
      // Load UI config from chrome.storage.sync
      chrome.storage.sync.get('uiConfig', (result) => {
        if (result.uiConfig) {
          setUIConfig({ ...DEFAULT_UI_CONFIG, ...result.uiConfig })
        }
      })
    })()
  }, [])

  useEffect(() => {
    const handleMessage = (message: ChromeMessage) => {
      if (message.action === 'importStatus') {
        setImportStatus(message.status)
        setImportProgress(0)
        setImportProcessed(0)
        setImportTotal(0)
        setImportDuplicates(0)
        setImportSuccess(0)

        setTimeout(() => {
          setImportStatus('')
        }, 5000)
      } else if (message.action === 'importProgress') {
        setImportProgress(message.progress)
        setImportProcessed(message.processed)
        setImportTotal(message.total)
        if (message.duplicates !== undefined) {
          setImportDuplicates(message.duplicates)
        }
        if (message.imported !== undefined) {
          setImportSuccess(message.imported)
        }
      }
    }

    chrome.runtime.onMessage.addListener(handleMessage)
    return () => chrome.runtime.onMessage.removeListener(handleMessage)
  }, [])



  const handleGameTypeFilterChange = (type: keyof GameTypeFilter) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const newFilter = { ...gameTypeFilter, [type]: event.target.checked }

    // すべてのチェックが外されそうな場合は変更を阻止
    const checkedCount = Object.values(newFilter).filter(Boolean).length
    if (checkedCount === 0) {
      return // 最後の1つは外せない
    }

    // Game type filter changed
    setGameTypeFilter(newFilter)

    const filterOptions: FilterOptions = {
      gameTypes: newFilter,
      handLimit,
      statDisplayConfigs  // Use current applied configs for immediate filters
    }

    bucket.set({ ...options, filterOptions })
    chrome.runtime.sendMessage<UpdateBattleTypeFilterMessage>({ action: 'updateBattleTypeFilter', filterOptions })
  }

  const handleHandLimitChange = (_event: Event, value: number | number[]) => {
    const numValue = value as number
    const handCounts = [20, 50, 100, 200, 500]
    const newHandLimit = numValue === 6 ? undefined : handCounts[numValue - 1]
    // Hand limit changed
    setHandLimit(newHandLimit)

    const filterOptions: FilterOptions = {
      gameTypes: gameTypeFilter,
      handLimit: newHandLimit,
      statDisplayConfigs  // Use current applied configs for immediate filters
    }

    bucket.set({ ...options, filterOptions })
    chrome.runtime.sendMessage<UpdateBattleTypeFilterMessage>({ action: 'updateBattleTypeFilter', filterOptions })
  }

  const handleStatToggle = (statId: string) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const newConfigs = pendingStatDisplayConfigs.map(config =>
      config.id === statId ? { ...config, enabled: event.target.checked } : config
    )
    // Stat toggle changed (pending)
    setPendingStatDisplayConfigs(newConfigs)
    setHasUnsavedStatChanges(true)
  }

  const handleStatOrderChange = (statId: string, direction: 'up' | 'down') => {
    const index = pendingStatDisplayConfigs.findIndex(config => config.id === statId)
    if (index === -1) return

    const newConfigs = [...pendingStatDisplayConfigs]
    const targetIndex = direction === 'up' ? index - 1 : index + 1

    if (targetIndex < 0 || targetIndex >= newConfigs.length) return

    // Swap order values
    const currentConfig = newConfigs[index]
    const targetConfig = newConfigs[targetIndex]
    if (!currentConfig || !targetConfig) return

    const tempOrder = currentConfig.order
    currentConfig.order = targetConfig.order
    targetConfig.order = tempOrder

    // Sort by order
    newConfigs.sort((a, b) => a.order - b.order)

    // Stat order changed (pending)
    setPendingStatDisplayConfigs(newConfigs)
    setHasUnsavedStatChanges(true)
  }

  const handleExport = async (format: string) => {
    chrome.runtime.sendMessage<ExportDataMessage>({
      action: 'exportData',
      format: format as 'json' | 'pokerstars'
    })
  }

  const handleImportClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click()
    }
  }

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    // Show file size warning for large files
    const fileSizeMB = Math.round(file.size / 1024 / 1024)
    if (fileSizeMB > 50) {
      setImportStatus(`大きなファイル (${fileSizeMB}MB) を処理中...`)
    }

    try {
      // Start import with progress tracking
      setImportProgress(0)
      setImportProcessed(0)
      setImportTotal(0)
      setImportDuplicates(0)
      setImportSuccess(0)
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

        const reader = new FileReader()
        const chunkContent = await new Promise<string>((resolve, reject) => {
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
        setImportStatus(`ファイル読み込み中... ${fileProgress}%`)
      }

      // Process the complete data
      await chrome.runtime.sendMessage<ImportDataProcessMessage>({
        action: 'importDataProcess'
      })

      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    } catch (error) {
      console.error('Error reading file:', error)
      setImportStatus('ファイルの読み込みに失敗しました')
      setImportProgress(0)
    }
  }

  const handleApplyStatChanges = async () => {
    // Applying stat display changes
    setStatDisplayConfigs(pendingStatDisplayConfigs)

    const filterOptions: FilterOptions = {
      gameTypes: gameTypeFilter,
      handLimit,
      statDisplayConfigs: pendingStatDisplayConfigs
    }

    bucket.set({ ...options, filterOptions })
    chrome.runtime.sendMessage<UpdateBattleTypeFilterMessage>({ action: 'updateBattleTypeFilter', filterOptions })
    setHasUnsavedStatChanges(false)
  }

  const handleResetStatChanges = () => {
    // Resetting stat display changes
    setPendingStatDisplayConfigs(statDisplayConfigs)
    setHasUnsavedStatChanges(false)
  }

  const handleDeleteData = async () => {
    try {
      const response = await chrome.runtime.sendMessage<DeleteAllDataMessage>({ action: 'deleteAllData' })
      if (response.success) {
        setImportStatus('全データが削除されました')
        setTimeout(() => {
          setImportStatus('')
        }, 3000)
      } else {
        setImportStatus('データの削除に失敗しました')
      }
    } catch (error) {
      console.error('Error deleting data:', error)
      setImportStatus('データの削除に失敗しました')
    }
    setDeleteDialogOpen(false)
  }

  const handleRebuildData = async () => {
    try {
      setImportStatus('データ再構築中...')
      const response = await chrome.runtime.sendMessage({ action: 'rebuildData' })
      if (response.success) {
        setImportStatus('データ再構築が完了しました')
        setTimeout(() => {
          setImportStatus('')
        }, 3000)
      } else {
        setImportStatus('データ再構築に失敗しました')
      }
    } catch (error) {
      console.error('Error rebuilding data:', error)
      setImportStatus('エラーが発生しました')
    }
  }

  const handleResetSettings = async () => {
    try {
      // デフォルト設定を定義
      const defaultGameTypeFilter = { sng: true, mtt: true, ring: true }
      const defaultHandLimit = 500
      const defaultStats = [...defaultStatDisplayConfigs]
      const defaultUI = { ...DEFAULT_UI_CONFIG }

      // UIをデフォルト値にリセット
      setGameTypeFilter(defaultGameTypeFilter)
      setHandLimit(defaultHandLimit)
      setStatDisplayConfigs(defaultStats)
      setPendingStatDisplayConfigs(defaultStats)
      setHasUnsavedStatChanges(false)
      setUIConfig(defaultUI)

      // ストレージをクリアしてデフォルト値を設定
      await bucket.clear()
      await bucket.set({
        sendUserData: true,
        filterOptions: {
          gameTypes: defaultGameTypeFilter,
          handLimit: defaultHandLimit,
          statDisplayConfigs: defaultStats
        }
      })

      // Chrome storageのUI設定とHandLog設定もリセット
      await chrome.storage.sync.set({
        uiConfig: defaultUI,
        handLogConfig: DEFAULT_HAND_LOG_CONFIG
      })

      // HUDの位置情報もクリア
      const keysToRemove = []
      for (let i = 0; i < 6; i++) {
        keysToRemove.push(`hudPosition_${i}`)
      }
      await chrome.storage.sync.remove(keysToRemove)

      // バックグラウンドサービスに新しいフィルター設定を送信
      chrome.runtime.sendMessage<UpdateBattleTypeFilterMessage>({
        action: 'updateBattleTypeFilter',
        filterOptions: {
          gameTypes: defaultGameTypeFilter,
          handLimit: defaultHandLimit,
          statDisplayConfigs: defaultStats
        }
      })

      // すべてのタブにUI設定を送信
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          if (tab.id) {
            chrome.tabs.sendMessage(tab.id, {
              action: 'updateUIConfig',
              config: defaultUI
            })
          }
        })
      })

      setImportStatus('設定を初期化しました')
      setTimeout(() => {
        setImportStatus('')
      }, 3000)
    } catch (error) {
      console.error('Error resetting settings:', error)
      setImportStatus('設定の初期化に失敗しました')
    }
    setResetDialogOpen(false)
  }

  return <div style={{ width: 300, padding: '10px' }}>

    {/* UI Display Controls - 最上段 */}
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="body2">サイズ:</Typography>
        <IconButton
          size="small"
          onClick={() => {
            const newScale = Math.max(0.5, uiConfig.scale - 0.1)
            const newConfig = { ...uiConfig, scale: newScale }
            setUIConfig(newConfig)
            chrome.storage.sync.set({ uiConfig: newConfig })
            chrome.tabs.query({}, (tabs) => {
              tabs.forEach(tab => {
                if (tab.id) {
                  chrome.tabs.sendMessage(tab.id, {
                    action: 'updateUIConfig',
                    config: newConfig
                  })
                }
              })
            })
          }}
          disabled={uiConfig.scale <= 0.5}
        >
          -
        </IconButton>
        <Typography variant="body2" sx={{ minWidth: 35, textAlign: 'center' }}>
          {Math.round(uiConfig.scale * 100)}%
        </Typography>
        <IconButton
          size="small"
          onClick={() => {
            const newScale = Math.min(2.0, uiConfig.scale + 0.1)
            const newConfig = { ...uiConfig, scale: newScale }
            setUIConfig(newConfig)
            chrome.storage.sync.set({ uiConfig: newConfig })
            chrome.tabs.query({}, (tabs) => {
              tabs.forEach(tab => {
                if (tab.id) {
                  chrome.tabs.sendMessage(tab.id, {
                    action: 'updateUIConfig',
                    config: newConfig
                  })
                }
              })
            })
          }}
          disabled={uiConfig.scale >= 2.0}
        >
          +
        </IconButton>
      </Box>

      <ToggleButtonGroup
        value={uiConfig.displayEnabled ? 'on' : 'off'}
        exclusive
        onChange={(_event, newValue: string | null) => {
          if (newValue !== null) {
            const newConfig = { ...uiConfig, displayEnabled: newValue === 'on' }
            setUIConfig(newConfig)
            chrome.storage.sync.set({ uiConfig: newConfig })
            chrome.tabs.query({}, (tabs) => {
              tabs.forEach(tab => {
                if (tab.id) {
                  chrome.tabs.sendMessage(tab.id, {
                    action: 'updateUIConfig',
                    config: newConfig
                  })
                }
              })
            })
          }
        }}
        size="small"
        sx={{
          '& .MuiToggleButton-root': {
            padding: '4px 12px',
            fontSize: '12px',
            fontWeight: 'bold',
            '&.Mui-selected': {
              '&[value="off"]': {
                backgroundColor: '#f44336',
                color: '#ffffff',
                '&:hover': {
                  backgroundColor: '#d32f2f',
                }
              },
              '&[value="on"]': {
                backgroundColor: '#4caf50',
                color: '#ffffff',
                '&:hover': {
                  backgroundColor: '#388e3c',
                }
              }
            }
          }
        }}
      >
        <ToggleButton value="off">
          非表示
        </ToggleButton>
        <ToggleButton value="on">
          表示
        </ToggleButton>
      </ToggleButtonGroup>
    </Box>

    <Divider style={{ margin: '10px 0' }} />

    <Typography variant="h6">ゲームタイプ</Typography>
    <FormControl component="fieldset" style={{ marginTop: '10px', width: '100%' }}>
      <FormGroup>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <FormControlLabel
            control={
              <Checkbox
                checked={gameTypeFilter.sng}
                onChange={handleGameTypeFilterChange('sng')}
              />
            }
            label="Sit & Go"
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={gameTypeFilter.mtt}
                onChange={handleGameTypeFilterChange('mtt')}
              />
            }
            label="MTT"
          />
        </Box>
        <FormControlLabel
          control={
            <Checkbox
              checked={gameTypeFilter.ring}
              onChange={handleGameTypeFilterChange('ring')}
            />
          }
          label="リングゲーム"
        />
      </FormGroup>
    </FormControl>

    <Divider style={{ margin: '10px 0' }} />

    <Typography variant="h6">ハンド数</Typography>
    <Box sx={{ px: 2, mt: 2, mb: 2 }}>
      <Slider
        value={(() => {
          if (handLimit === undefined) return 6
          const handCounts = [20, 50, 100, 200, 500]
          const index = handCounts.indexOf(handLimit)
          return index >= 0 ? index + 1 : 6
        })()}
        onChange={handleHandLimitChange}
        valueLabelDisplay="auto"
        valueLabelFormat={(value) => {
          const handCounts = [20, 50, 100, 200, 500, 'ALL']
          return value === 6 ? 'ALL' : `${handCounts[value - 1]}ハンド`
        }}
        step={1}
        marks={[
          { value: 1, label: '最新20' },
          { value: 2, label: '50' },
          { value: 3, label: '100' },
          { value: 4, label: '200' },
          { value: 5, label: '500' },
          { value: 6, label: 'ALL' }
        ]}
        min={1}
        max={6}
      />
    </Box>

    <Divider style={{ margin: '10px 0' }} />

    <Typography variant="h6">
      HUD表示設定
      {hasUnsavedStatChanges && (
        <Typography component="span" variant="body2" color="orange" style={{ marginLeft: 8 }}>
          (未適用の変更があります)
        </Typography>
      )}
    </Typography>
    <List dense style={{ maxHeight: 200, overflow: 'auto' }}>
      {pendingStatDisplayConfigs
        .filter(config => config.id !== 'playerName') // playerNameはヘッダーに常に表示されるため除外
        .sort((a, b) => a.order - b.order)
        .map((config, index) => {
          const statDef = defaultRegistry.get(config.id)
          return (
            <ListItem key={config.id} style={{ paddingLeft: 0, paddingRight: 0 }}>
              <IconButton
                size="small"
                disabled={index === 0}
                onClick={() => handleStatOrderChange(config.id, 'up')}
              >
                ↑
              </IconButton>
              <IconButton
                size="small"
                disabled={index === pendingStatDisplayConfigs.filter(c => c.id !== 'playerName').length - 1}
                onClick={() => handleStatOrderChange(config.id, 'down')}
              >
                ↓
              </IconButton>
              <ListItemText
                primary={statDef?.name || config.id}
                secondary={statDef?.description}
                style={{ marginLeft: 8, paddingRight: 80 }}
              />
              <ListItemSecondaryAction>
                <Switch
                  edge="end"
                  onChange={handleStatToggle(config.id)}
                  checked={config.enabled}
                />
              </ListItemSecondaryAction>
            </ListItem>
          )
        })}
    </List>

    {hasUnsavedStatChanges && (
      <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
        <Button
          variant="contained"
          color="primary"
          size="small"
          onClick={handleApplyStatChanges}
          style={{ flex: 1 }}
        >
          適用
        </Button>
        <Button
          variant="outlined"
          color="primary"
          size="small"
          onClick={handleResetStatChanges}
          style={{ flex: 1 }}
        >
          リセット
        </Button>
      </Box>
    )}

    <Divider style={{ margin: '10px 0' }} />

    <Button
      variant="contained"
      color="primary"
      fullWidth
      disabled={true}
      style={{ marginBottom: '10px' }}
    >
      バックアップ
    </Button>

    <Button
      variant="contained"
      color="primary"
      fullWidth
      onClick={() => handleExport('pokerstars')}
      style={{ marginBottom: '10px' }}
    >
      エクスポート (PokerStars)
    </Button>

    <Button
      variant="contained"
      color="primary"
      fullWidth
      onClick={() => handleExport('json')}
      style={{ marginBottom: '10px' }}
    >
      エクスポート (.ndjson)
    </Button>

    <input
      type="file"
      accept=".ndjson"
      style={{ display: 'none' }}
      ref={fileInputRef}
      onChange={handleFileChange}
    />

    <Button
      variant="outlined"
      color="primary"
      fullWidth
      onClick={handleImportClick}
      disabled={importProgress > 0 && importProgress < 100}
    >
      {importProgress > 0 && importProgress < 100 ? 'インポート中...' : 'インポート (.ndjson)'}
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
      color="warning"
      fullWidth
      onClick={() => setResetDialogOpen(true)}
      style={{ marginTop: '10px' }}
    >
      初期設定に戻す
    </Button>

    <Button
      variant="outlined"
      color="error"
      fullWidth
      onClick={() => setDeleteDialogOpen(true)}
      style={{ marginTop: '10px' }}
    >
      全データを削除
    </Button>

    <Button
      variant="outlined"
      color="primary"
      fullWidth
      onClick={handleRebuildData}
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
      ※統計データを生ログから再計算します
    </Typography>

    <Dialog
      open={deleteDialogOpen}
      onClose={() => setDeleteDialogOpen(false)}
    >
      <DialogTitle>全データ削除の確認</DialogTitle>
      <DialogContent>
        <DialogContentText>
          保存されているすべてのハンド履歴と統計データが削除されます。
          設定は削除されません。
          この操作は元に戻せません。
          本当に削除しますか？
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setDeleteDialogOpen(false)} color="primary">
          キャンセル
        </Button>
        <Button onClick={handleDeleteData} color="error" autoFocus>
          削除
        </Button>
      </DialogActions>
    </Dialog>

    <Dialog
      open={resetDialogOpen}
      onClose={() => setResetDialogOpen(false)}
    >
      <DialogTitle>初期設定に戻す</DialogTitle>
      <DialogContent>
        <DialogContentText>
          すべての設定を初期値に戻します。
          データ（ハンド履歴や統計）は削除されません。
          続行しますか？
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setResetDialogOpen(false)} color="primary">
          キャンセル
        </Button>
        <Button onClick={handleResetSettings} color="warning" autoFocus>
          リセット
        </Button>
      </DialogActions>
    </Dialog>
  </div>
}

export default Popup
