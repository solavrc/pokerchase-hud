/**
 * update-manager.ts - awaitIngestionDrain() loop behavior
 *
 * Unit-tests the drain barrier's core algorithm in isolation from
 * event-ingestion.ts's real queue, using a controllable fake provider.
 *
 * P1, codex review 2026-07-20 pass-4, "Wait for tasks appended while
 * draining": `awaitIngestionDrain()` used to call `ingestionDrainProvider()`
 * exactly once and await that single snapshot. If a new task got appended
 * to the real ingestion queue (i.e. `ingestionQueue` got reassigned) while
 * that snapshot was still settling, the drain resolved without ever
 * waiting for the newly-appended task -- so even callers using the "drain
 * barrier" could still read stale session-activity state and reload
 * mid-hand. The fix re-calls the provider after each snapshot settles and
 * keeps looping until it returns the same reference twice in a row (i.e.
 * nothing new was appended between the last resolution and the check),
 * bounded by a safety cap against a pathological/buggy provider.
 */
import { awaitIngestionDrain, setIngestionDrainProvider } from './update-manager'

describe('awaitIngestionDrain (loop-until-stable)', () => {
  test('follows the queue tail through a task appended WHILE the first snapshot is still settling', async () => {
    let resolveFirst!: () => void
    let resolveSecond!: () => void
    const firstTask = new Promise<void>(resolve => { resolveFirst = resolve })
    const secondTask = new Promise<void>(resolve => { resolveSecond = resolve })

    let currentTail = firstTask
    let providerCallCount = 0
    setIngestionDrainProvider(() => {
      providerCallCount++
      return currentTail
    })

    let drainSettled = false
    const drainPromise = awaitIngestionDrain().then(() => { drainSettled = true })

    // Let the drain loop make its first call and start awaiting `firstTask`.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(providerCallCount).toBe(1)

    // While the drain is still awaiting the FIRST snapshot, a new task gets
    // appended -- simulating registerEventIngestion()'s onMessage listener
    // reassigning `ingestionQueue` to a new tail mid-drain.
    currentTail = secondTask
    resolveFirst()

    // Give the drain's `.then()` continuation a chance to run and re-check
    // the provider -- if it incorrectly resolved after only the first
    // snapshot (the bug), `drainSettled` would already be true here.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(drainSettled).toBe(false)
    expect(providerCallCount).toBeGreaterThanOrEqual(2) // re-checked after the first snapshot resolved

    resolveSecond()
    await drainPromise

    expect(drainSettled).toBe(true)
  })

  test('resolves immediately (single provider call round-trip) when nothing new is appended', async () => {
    const task = Promise.resolve()
    let providerCallCount = 0
    setIngestionDrainProvider(() => {
      providerCallCount++
      return task
    })

    await awaitIngestionDrain()

    // Exactly 2 calls: one to get the initial snapshot, one more to confirm
    // nothing new was appended before returning.
    expect(providerCallCount).toBe(2)
  })

  test('is a no-op when no provider has been registered', async () => {
    // Simulates the state before event-ingestion.ts's registerEventIngestion()
    // has ever run (e.g. very early Service Worker startup) -- must not throw.
    setIngestionDrainProvider(undefined as unknown as () => Promise<void>)
    await expect(awaitIngestionDrain()).resolves.toBeUndefined()
  })
})
