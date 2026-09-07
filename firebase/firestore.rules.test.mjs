import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, beforeEach, test } from 'node:test'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, deleteDoc, doc, getDocFromServer, getDocsFromServer, setDoc, updateDoc, writeBatch } from 'firebase/firestore'

// このsuiteは専用demo project + loopback emulatorだけに接続する（MUST）。
const host = process.env.FIRESTORE_EMULATOR_HOST
assert.match(host ?? '', /^(127\.0\.0\.1|localhost):\d+$/, 'Run with npm run test:firestore-rules')
const [hostname, port] = host.split(':')
let environment
let owner
let other
let anonymous

const payload = { timestamp: 100, ApiTypeId: 304, SeatIndex: 0, Progress: { Phase: 1, Pot: 200 } }
const eventPath = 'users/alice/apiEvents/100_304'

before(async () => {
  environment = await initializeTestEnvironment({
    projectId: 'demo-pokerchase-hud-rules',
    firestore: {
      host: hostname,
      port: Number(port),
      rules: await readFile(new URL('./firestore.rules', import.meta.url), 'utf8'),
    },
  })
})

beforeEach(async () => {
  await environment.clearFirestore()
  owner = environment.authenticatedContext('alice').firestore()
  other = environment.authenticatedContext('bob').firestore()
  anonymous = environment.unauthenticatedContext().firestore()
})

after(async () => { await environment?.cleanup() })

test('owner can create, read, list, and delete an event', async () => {
  const reference = doc(owner, eventPath)
  await assertSucceeds(setDoc(reference, payload))
  assert.deepEqual((await assertSucceeds(getDocFromServer(reference))).data(), payload)
  assert.equal((await assertSucceeds(getDocsFromServer(collection(owner, 'users/alice/apiEvents')))).size, 1)
  await assertSucceeds(deleteDoc(reference))
  assert.equal((await getDocFromServer(reference)).exists(), false)
})

test('legacy no-op upserts and sequence-only additions, changes, and removal remain valid', async () => {
  const reference = doc(owner, eventPath)
  await setDoc(reference, payload)
  await assertSucceeds(setDoc(reference, payload))
  await assertSucceeds(setDoc(reference, { ...payload, sequence: 0 }))
  await assertSucceeds(updateDoc(reference, { sequence: 4 }))
  await assertSucceeds(setDoc(reference, payload))
  assert.deepEqual((await getDocFromServer(reference)).data(), payload)
})

test('payload changes, additions, removals, and nested changes are rejected', async () => {
  const reference = doc(owner, eventPath)
  await setDoc(reference, payload)
  for (const replacement of [
    { ...payload, timestamp: 101 },
    { ...payload, ApiTypeId: 305 },
    { ...payload, SeatIndex: 1 },
    { ...payload, Extra: true },
    { timestamp: 100, ApiTypeId: 304, SeatIndex: 0 },
    { ...payload, Progress: { ...payload.Progress, Pot: 300 } },
  ]) {
    await assertFails(setDoc(reference, replacement))
  }
  assert.deepEqual((await getDocFromServer(reference)).data(), payload)
})

test('an old writer cannot overwrite a legacy payload after a new client confirms it', async () => {
  const newClient = environment.authenticatedContext('alice').firestore()
  const legacyReference = doc(owner, eventPath)
  await setDoc(legacyReference, payload)
  // 新clientの内容照合が完了した直後に、旧clientの無条件upsertを挿入する。
  assert.deepEqual((await getDocFromServer(doc(newClient, eventPath))).data(), payload)
  const differentPayload = { ...payload, SeatIndex: 1, sequence: 0 }
  const pendingReference = doc(owner, 'users/alice/apiEvents/101_304')
  const oldBatch = writeBatch(owner)
  oldBatch.set(legacyReference, differentPayload)
  oldBatch.set(pendingReference, { ...payload, timestamp: 101 })
  await assertFails(oldBatch.commit())
  assert.deepEqual((await getDocFromServer(doc(newClient, eventPath))).data(), payload)
  assert.equal((await getDocFromServer(pendingReference)).exists(), false)
  // 新内容の別documentへのcreateは拒否しない。
  const contentReference = doc(newClient, 'users/alice/apiEvents/100_304_h_other_content')
  await assertSucceeds(setDoc(contentReference, differentPayload))
  assert.equal((await getDocsFromServer(collection(newClient, 'users/alice/apiEvents'))).size, 2)
})

test('another user and an unauthenticated client cannot access owner events', async () => {
  await setDoc(doc(owner, eventPath), payload)
  for (const client of [other, anonymous]) {
    await assertFails(getDocFromServer(doc(client, eventPath)))
    await assertFails(getDocsFromServer(collection(client, 'users/alice/apiEvents')))
    await assertFails(setDoc(doc(client, 'users/alice/apiEvents/new'), payload))
    await assertFails(setDoc(doc(client, eventPath), payload))
    await assertFails(deleteDoc(doc(client, eventPath)))
  }
})

test('owner metadata remains writable and public config remains read-only', async () => {
  await assertSucceeds(setDoc(doc(owner, 'users/alice'), { lastSyncTimestamp: 100 }))
  await assertSucceeds(updateDoc(doc(owner, 'users/alice'), { lastSyncTimestamp: 200 }))
  await assertFails(setDoc(doc(other, 'users/alice'), { lastSyncTimestamp: 300 }))
  await environment.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'config/client'), { minSupportedVersion: '6.0.0' })
  })
  await assertSucceeds(getDocFromServer(doc(anonymous, 'config/client')))
  await assertFails(setDoc(doc(owner, 'config/client'), { minSupportedVersion: '7.0.0' }))
})
