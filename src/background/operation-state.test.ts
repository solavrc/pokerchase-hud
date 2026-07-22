import { getOperationState, setOperationState, isOperationIdle, onOperationBecameIdle, waitForOperationIdle } from './operation-state'

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

  describe('onOperationBecameIdle', () => {
    it('notifies listeners on a non-idle -> idle transition', () => {
      const listener = jest.fn()
      const unsubscribe = onOperationBecameIdle(listener)

      setOperationState({ type: 'rebuild', progress: 90 })
      expect(listener).not.toHaveBeenCalled()

      setOperationState({ type: 'idle' })
      expect(listener).toHaveBeenCalledTimes(1)

      unsubscribe()
    })

    it('does not notify on idle -> idle (no-op transitions) or progress updates within the same operation', () => {
      const listener = jest.fn()
      const unsubscribe = onOperationBecameIdle(listener)

      setOperationState({ type: 'idle' }) // already idle
      expect(listener).not.toHaveBeenCalled()

      setOperationState({ type: 'export', format: 'json', progress: 0 })
      setOperationState({ type: 'export', format: 'json', progress: 50 }) // still non-idle
      expect(listener).not.toHaveBeenCalled()

      unsubscribe()
    })

    it('stops notifying after unsubscribe', () => {
      const listener = jest.fn()
      const unsubscribe = onOperationBecameIdle(listener)
      unsubscribe()

      setOperationState({ type: 'import', progress: 0 })
      setOperationState({ type: 'idle' })

      expect(listener).not.toHaveBeenCalled()
    })

    it('isolates a throwing listener from other listeners', () => {
      const throwingListener = jest.fn(() => { throw new Error('boom') })
      const okListener = jest.fn()
      const unsubscribe1 = onOperationBecameIdle(throwingListener)
      const unsubscribe2 = onOperationBecameIdle(okListener)

      setOperationState({ type: 'rebuild', progress: 50 })
      expect(() => setOperationState({ type: 'idle' })).not.toThrow()

      expect(throwingListener).toHaveBeenCalledTimes(1)
      expect(okListener).toHaveBeenCalledTimes(1)

      unsubscribe1()
      unsubscribe2()
    })

    it('resolves every concurrent idle waiter even though each removes itself', async () => {
      setOperationState({ type: 'import' })
      const first = waitForOperationIdle()
      const second = waitForOperationIdle()
      const settled: string[] = []
      void first.then(() => settled.push('first'))
      void second.then(() => settled.push('second'))

      setOperationState({ type: 'idle' })
      await Promise.all([first, second])

      expect(settled).toEqual(['first', 'second'])
    })
  })
})
