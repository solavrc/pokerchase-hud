import { getOperationState, setOperationState, isOperationIdle } from './operation-state'

describe('operation-state', () => {
  afterEach(() => {
    // Reset module-level state between tests
    setOperationState({ type: 'idle' })
  })

  it('starts idle', () => {
    expect(getOperationState()).toEqual({ type: 'idle' })
    expect(isOperationIdle()).toBe(true)
  })

  it('reflects updates made via setOperationState', () => {
    setOperationState({ type: 'import', progress: 0 })
    expect(getOperationState()).toEqual({ type: 'import', progress: 0 })
    expect(isOperationIdle()).toBe(false)
  })

  it('supports progress updates carrying processed/total', () => {
    setOperationState({ type: 'import', progress: 50, processed: 5, total: 10 })
    expect(getOperationState()).toEqual({ type: 'import', progress: 50, processed: 5, total: 10 })
  })

  it('supports export state with format', () => {
    setOperationState({ type: 'export', format: 'json', progress: 0 })
    expect(getOperationState()).toEqual({ type: 'export', format: 'json', progress: 0 })
    expect(isOperationIdle()).toBe(false)
  })

  it('returns to idle after finishing', () => {
    setOperationState({ type: 'rebuild', progress: 90 })
    expect(isOperationIdle()).toBe(false)
    setOperationState({ type: 'idle' })
    expect(isOperationIdle()).toBe(true)
    expect(getOperationState()).toEqual({ type: 'idle' })
  })
})
