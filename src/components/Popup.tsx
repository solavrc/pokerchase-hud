import Divider from '@mui/material/Divider'
import { ChangeEvent, useEffect, useRef, useState } from 'react'
import type { FilterOptions, GameTypeFilter } from '../types'
import { loadOptions, saveOptions, type Options } from '../utils/options-storage'
import { defaultStatDisplayConfigs, mergeStatDisplayConfigs } from '../stats'
import type { StatDisplayConfig } from '../types/filters'
import type { UIConfig } from '../types/hand-log'
import { DEFAULT_UI_CONFIG } from '../types/hand-log'
import type {
  ChromeMessage,
  UpdateBattleTypeFilterMessage,
  FirebaseSignInMessage,
  FirebaseSignOutMessage,
  ManualSyncUploadMessage,
  ManualSyncDownloadMessage
} from '../types/messages'
import type { SyncState } from '../services/auto-sync-service'
import { content_scripts } from '../../manifest.json'
import { sendMessageWithTimeout } from './popup/send-message'

// Import sub-components
import { UIScaleSection } from './popup/UIScaleSection'
import { ImportExportSection } from './popup/ImportExportSection'
import { FirebaseAuthSection } from './popup/FirebaseAuthSection'
import { GameTypeFilterSection } from './popup/GameTypeFilterSection'
import { HandLimitSection } from './popup/HandLimitSection'
import { StatisticsConfigSection } from './popup/StatisticsConfigSection'

export type { Options }

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
  const [uiConfig, setUIConfig] = useState<UIConfig>(DEFAULT_UI_CONFIG)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Firebase states
  const [isFirebaseSignedIn, setIsFirebaseSignedIn] = useState<boolean>(false)
  const [firebaseUserInfo, setFirebaseUserInfo] = useState<{ email: string; uid: string } | null>(null)
  const [syncState, setSyncState] = useState<SyncState | null>(null)

  // Fetch sync state
  useEffect(() => {
    const fetchSyncState = () => {
      // Fails open: on timeout/error, leave syncState as-is rather than
      // blocking the poll loop or surfacing a stuck spinner.
      sendMessageWithTimeout<{ syncState?: SyncState }>({ action: 'getSyncState' }).then((response) => {
        if (response?.syncState) {
          setSyncState(response.syncState)
        }
      })
    }

    // Initial fetch
    fetchSyncState()

    // Set up interval to refresh sync state
    const interval = setInterval(fetchSyncState, 5000) // Update every 5 seconds

    // Listen for sync state updates
    const handleMessage = (message: any) => {
      if (message.action === 'SYNC_STATE_UPDATE') {
        setSyncState(message.state)
      }
    }

    chrome.runtime.onMessage.addListener(handleMessage)

    return () => {
      clearInterval(interval)
      chrome.runtime.onMessage.removeListener(handleMessage)
    }
  }, [])


  const openGameTab = async () => {
    try {
      // Check current tab URL
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
      
      // Extract base URL from manifest
      const gameBaseUrl = content_scripts[0]!.matches[0]!.replace(/\/\*$/, '')
      
      // Check if current tab is on game domain
      if (activeTab?.url && !activeTab.url.startsWith(gameBaseUrl)) {
        // Not on game page - check if game tab already exists
        const gameTabs = await chrome.tabs.query({ url: `${gameBaseUrl}/*` })
        
        if (gameTabs.length > 0 && gameTabs[0]?.id !== undefined) {
          // Game tab exists - switch to it
          await chrome.tabs.update(gameTabs[0].id, { active: true })
          
          // Also focus the window if it's different
          if (gameTabs[0]?.windowId !== undefined && activeTab?.windowId !== undefined && gameTabs[0].windowId !== activeTab.windowId) {
            await chrome.windows.update(gameTabs[0].windowId, { focused: true })
          }
        } else {
          // No game tab exists - open new tab
          await chrome.tabs.create({ url: `${gameBaseUrl}/play/index.html` })
        }
      }
      // If already on game page, do nothing
    } catch (error) {
      console.error('Error opening game tab:', error)
    }
  }

  useEffect(() => {
    // Check and switch to game tab on popup open
    openGameTab()
    
    loadOptions().then((savedOptions) => {
      if (savedOptions) {
        setOptions(savedOptions)
        if (savedOptions.filterOptions) {
          // Merge existing configurations with new defaults
          const mergedConfigs = mergeStatDisplayConfigs(
            savedOptions.filterOptions.statDisplayConfigs || [],
            defaultStatDisplayConfigs
          )

          setStatDisplayConfigs(mergedConfigs)
          setPendingStatDisplayConfigs(mergedConfigs)

          // Save merged configurations back to storage if new stats were added
          if (savedOptions.filterOptions.statDisplayConfigs && mergedConfigs.length > savedOptions.filterOptions.statDisplayConfigs.length) {
            saveOptions({
              ...savedOptions,
              filterOptions: {
                ...savedOptions.filterOptions,
                statDisplayConfigs: mergedConfigs
              }
            })
          }

          setGameTypeFilter(savedOptions.filterOptions.gameTypes || { sng: true, mtt: true, ring: true })
          setHandLimit(savedOptions.filterOptions.handLimit)
        }
      }

      // Load UI config from chrome.storage.sync
      chrome.storage.sync.get('uiConfig', (result: Record<string, any>) => {
        if (result.uiConfig) {
          setUIConfig(result.uiConfig)
        }
      })

      // Load cached Firebase auth state first for instant rendering
      chrome.storage.local.get('firebaseAuthCache', (result: Record<string, any>) => {
        if (result.firebaseAuthCache) {
          setIsFirebaseSignedIn(result.firebaseAuthCache.isSignedIn || false)
          setFirebaseUserInfo(result.firebaseAuthCache.userInfo || null)
        }
      })

      // Then verify with background (authoritative source).
      // Fails open: on timeout/error, keep whatever was already set from
      // the chrome.storage.local cache above instead of blocking the UI.
      sendMessageWithTimeout<{ isSignedIn?: boolean; userInfo?: { email: string; uid: string } | null }>({
        action: 'firebaseAuthStatus'
      }).then((response) => {
        if (response) {
          setIsFirebaseSignedIn(response.isSignedIn || false)
          setFirebaseUserInfo(response.userInfo || null)

          // Also get sync state if signed in
          sendMessageWithTimeout<{ syncState?: SyncState }>({ action: 'getSyncState' }).then((syncResponse) => {
            if (syncResponse?.syncState) {
              setSyncState(syncResponse.syncState)
            }
          })
        }
      })
    })
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
        setImportStartTime(0)
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
      } else if (message.action === 'firebaseAuthStatus') {
        setIsFirebaseSignedIn(message.isSignedIn)
        if (message.userInfo && message.userInfo.email && message.userInfo.uid) {
          setFirebaseUserInfo({
            email: message.userInfo.email,
            uid: message.userInfo.uid
          })
        } else {
          setFirebaseUserInfo(null)
        }
      } else if (message.action === 'firebaseBackupProgress') {
        // Progress is now handled by sync state UI
      } else if (message.action === 'SYNC_STATE_UPDATE') {
        // Update sync state from background service
        setSyncState(message.state)
      }
    }

    chrome.runtime.onMessage.addListener(handleMessage)
    return () => chrome.runtime.onMessage.removeListener(handleMessage)
  }, [])


  const handleGameTypeFilterChange = (type: keyof GameTypeFilter) => (event: ChangeEvent<HTMLInputElement>) => {
    const newFilter = {
      ...gameTypeFilter,
      [type]: event.target.checked
    }

    // Game type filter changed
    setGameTypeFilter(newFilter)
    
    const updatedOptions: FilterOptions = {
      gameTypes: newFilter,
      handLimit,
      statDisplayConfigs  // Use current applied configs for immediate filters
    }

    saveAndBroadcastOptions(updatedOptions)
  }

  const handleHandLimitChange = (_event: Event, value: number | number[]) => {
    const handCounts = [20, 50, 100, 200, 500]
    const newHandLimit = value === 6 ? undefined : handCounts[(value as number) - 1]

    // Hand limit changed
    setHandLimit(newHandLimit)
    
    const updatedOptions: FilterOptions = {
      gameTypes: gameTypeFilter,
      handLimit: newHandLimit,
      statDisplayConfigs  // Use current applied configs for immediate filters
    }

    saveAndBroadcastOptions(updatedOptions)
  }

  const handleStatToggle = (statId: string) => (event: ChangeEvent<HTMLInputElement>) => {
    const newConfigs = pendingStatDisplayConfigs.map(config =>
      config.id === statId ? { ...config, enabled: event.target.checked } : config
    )

    // Stat toggle changed (pending)
    setPendingStatDisplayConfigs(newConfigs)
    setHasUnsavedStatChanges(true)
  }

  const handleStatOrderChange = (statId: string, direction: 'up' | 'down') => {
    const newConfigs = [...pendingStatDisplayConfigs]
    const index = newConfigs.findIndex(config => config.id === statId)
    
    if (index === -1) return

    const targetIndex = direction === 'up' ? index - 1 : index + 1
    
    // Swap order values
    const currentConfig = newConfigs[index]
    const targetConfig = newConfigs[targetIndex]
    if (currentConfig && targetConfig) {
      const tempOrder = currentConfig.order
      currentConfig.order = targetConfig.order
      targetConfig.order = tempOrder
    }

    // Sort by order
    newConfigs.sort((a, b) => a.order - b.order)

    // Stat order changed (pending)
    setPendingStatDisplayConfigs(newConfigs)
    setHasUnsavedStatChanges(true)
  }

  const saveAndBroadcastOptions = (filterOptions: FilterOptions) => {
    const newOptions = { ...options, filterOptions }
    setOptions(newOptions)
    // 永続化はここが唯一の書き込み元（message-routerは書かない）
    saveOptions(newOptions)

    chrome.runtime.sendMessage<UpdateBattleTypeFilterMessage>({
      action: 'updateBattleTypeFilter',
      filterOptions
    })
  }

  const handleApplyStatChanges = () => {
    // Applying stat display changes
    setStatDisplayConfigs(pendingStatDisplayConfigs)
    setHasUnsavedStatChanges(false)

    const updatedOptions: FilterOptions = {
      gameTypes: gameTypeFilter,
      handLimit,
      statDisplayConfigs: pendingStatDisplayConfigs
    }

    saveAndBroadcastOptions(updatedOptions)
  }

  const handleResetStatChanges = () => {
    // Resetting stat display changes
    setPendingStatDisplayConfigs(statDisplayConfigs)
    setHasUnsavedStatChanges(false)
  }

  // Firebase handlers
  const handleFirebaseSignIn = async () => {
    await openGameTab()
    chrome.runtime.sendMessage<FirebaseSignInMessage>({ action: 'firebaseSignIn' })
  }

  const handleFirebaseSignOut = () => {
    chrome.runtime.sendMessage<FirebaseSignOutMessage>({ action: 'firebaseSignOut' })
  }

  const handleManualSyncUpload = () => {
    chrome.runtime.sendMessage<ManualSyncUploadMessage>({ action: 'manualSyncUpload' })
  }

  const handleManualSyncDownload = () => {
    chrome.runtime.sendMessage<ManualSyncDownloadMessage>({ action: 'manualSyncDownload' })
  }

  return <div style={{ width: 300, padding: '10px' }}>
    {/* UI Display Controls */}
    <UIScaleSection
      uiConfig={uiConfig}
      setUIConfig={setUIConfig}
    />

    <Divider style={{ margin: '10px 0' }} />

    <GameTypeFilterSection
      gameTypeFilter={gameTypeFilter}
      handleGameTypeFilterChange={handleGameTypeFilterChange}
    />

    <Divider style={{ margin: '10px 0' }} />

    <HandLimitSection
      handLimit={handLimit}
      handleHandLimitChange={handleHandLimitChange}
    />

    <Divider style={{ margin: '10px 0' }} />

    {/* Cloud Backup - ハンド数とHUD表示設定の間 */}
    <FirebaseAuthSection
      isFirebaseSignedIn={isFirebaseSignedIn}
      firebaseUserInfo={firebaseUserInfo}
      syncState={syncState}
      setImportStatus={setImportStatus}
      handleFirebaseSignIn={handleFirebaseSignIn}
      handleFirebaseSignOut={handleFirebaseSignOut}
      handleManualSyncUpload={handleManualSyncUpload}
      handleManualSyncDownload={handleManualSyncDownload}
    />

    <Divider style={{ margin: '10px 0' }} />

    <StatisticsConfigSection
      pendingStatDisplayConfigs={pendingStatDisplayConfigs}
      hasUnsavedStatChanges={hasUnsavedStatChanges}
      handleStatToggle={handleStatToggle}
      handleStatOrderChange={handleStatOrderChange}
      handleApplyStatChanges={handleApplyStatChanges}
      handleResetStatChanges={handleResetStatChanges}
    />

    <Divider style={{ margin: '10px 0' }} />

    <ImportExportSection
      importStatus={importStatus}
      importProgress={importProgress}
      importProcessed={importProcessed}
      importTotal={importTotal}
      importDuplicates={importDuplicates}
      importSuccess={importSuccess}
      importStartTime={importStartTime}
      fileInputRef={fileInputRef}
      setImportStatus={setImportStatus}
      setImportProgress={setImportProgress}
      setImportProcessed={setImportProcessed}
      setImportTotal={setImportTotal}
      setImportDuplicates={setImportDuplicates}
      setImportSuccess={setImportSuccess}
      setImportStartTime={setImportStartTime}
    />
  </div>
}

export default Popup