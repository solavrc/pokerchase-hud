# Firebase Setup & Cloud Sync Guide

> Detailed setup instructions and implementation details for Firebase integration.

## Architecture

### Service Worker Compatible Design
- Firebase SDK v12+ is fully compatible with Service Workers
- Direct Firestore SDK usage without XMLHttpRequest issues
- Authentication via `chrome.identity` API with Firebase credential exchange

### Data Structure
```
Firestore:
/users/{userId}/
  /apiEvents/{eventId}  // eventId = timestamp_ApiTypeId
    - timestamp: number
    - ApiTypeId: number
    - [event data...]
```

## Setup Requirements

### 1. Firebase Project Setup

1. **Create Firebase Project**:
   - Go to [Firebase Console](https://console.firebase.google.com)
   - Create a new project or select existing
   - Enable Authentication with Google provider
   - Create Firestore database (asia-northeast1 recommended for Asia)

2. **Configure Firebase**:
   - Get your Firebase configuration from Project Settings
   - Update `src/services/firebase-config.ts` with your configuration:
   ```typescript
   export const firebaseConfig = {
     apiKey: "your-api-key",
     authDomain: "your-auth-domain",
     projectId: "your-project-id",
     storageBucket: "your-storage-bucket",
     messagingSenderId: "your-messaging-sender-id",
     appId: "your-app-id"
   };
   ```

3. **Deploy Security Rules**:
   ```bash
   npm run firebase:deploy:rules
   ```

### 2. OAuth Configuration

1. **Google Cloud Console Setup**:
   - Go to [Google Cloud Console](https://console.cloud.google.com)
   - Select your Firebase project
   - Navigate to APIs & Services > Credentials
   - Create OAuth 2.0 Client ID (Chrome Extension type)
   - Copy the Client ID

2. **Update Extension Manifest**:
   - Add OAuth client ID to `manifest.json`:
   ```json
   "oauth2": {
     "client_id": "your-oauth-client-id.apps.googleusercontent.com",
     "scopes": [
       "https://www.googleapis.com/auth/userinfo.email",
       "https://www.googleapis.com/auth/userinfo.profile"
     ]
   }
   ```

### 3. Extension ID Management

**Important**: Chrome Extension IDs differ between environments

- **Development**: Generated based on your local key
- **Production**: Assigned by Chrome Web Store
- **Consequence**: Need separate OAuth clients for each environment

**Setup for Multiple Environments**:
1. Create separate OAuth clients for dev/staging/production
2. Use environment-specific manifest files
3. Configure CI/CD to use correct OAuth client per environment

## Implementation Details

### Firebase SDK Integration
- Uses Firebase SDK v12.0.0 (Service Worker compatible)
- Direct Firestore SDK methods (collection, doc, writeBatch, etc.)
- No REST API wrapper needed - modern Firebase SDK works in Service Workers
- Authentication handled via Chrome identity API token exchange

### Authentication Flow
1. User clicks "Sign in with Google" in popup
2. Chrome identity API requests OAuth token
3. Token exchanged for Firebase credential
4. Firebase Auth session established
5. Firestore operations authenticated with user context

## Cloud Data Flow

### Upload Sync Strategy
1. Query cloud for latest timestamp (single document)
2. Filter local events newer than cloud's latest timestamp
3. Batch process in chunks of 300 events
4. Use composite key `timestamp_ApiTypeId` for deduplication
5. Update user metadata with sync timestamp

### Download Sync Strategy
1. Get all events from cloud (cloud is source of truth)
2. Bulk insert to IndexedDB using bulkPut (updates existing records)
3. Restore service state from downloaded events:
   - Latest EVT_DEAL → playerId, latestEvtDeal
   - Session events → session.id, battleType, name, players
4. Rebuild entities using EntityConverter
5. Trigger statistics recalculation

### Auto Sync Triggers
- Initial login (first sync only - bidirectional)
- Game session end (100+ new events threshold - upload only)
- Manual sync via popup UI (direction selectable)

## BigQuery Integration

### Export Configuration
1. Enable BigQuery export in Firebase Console
2. Configure export settings:
   - Dataset location: Same region as Firestore
   - Export schedule: Daily
   - Collections: `users`

### Table Structure
- Daily snapshots: `users_raw_latest`
- Change history: `users_raw_changelog`

### Analysis Views
```sql
-- User event statistics
CREATE VIEW user_event_stats AS
SELECT 
  user_id,
  COUNT(*) as total_events,
  MIN(TIMESTAMP_MILLIS(timestamp)) as first_event,
  MAX(TIMESTAMP_MILLIS(timestamp)) as last_event,
  COUNT(DISTINCT DATE(TIMESTAMP_MILLIS(timestamp))) as active_days
FROM (
  SELECT 
    SPLIT(document_name, '/')[OFFSET(1)] as user_id,
    CAST(JSON_EXTRACT_SCALAR(data, '$.timestamp') AS INT64) as timestamp
  FROM `your-project.firestore_export.users_raw_latest`
  WHERE collection_id = 'apiEvents'
)
GROUP BY user_id;
```

## Cost Optimization

### Firestore Optimization
- Smart incremental sync (cloud timestamp for uploads, full for downloads)
- No periodic sync (event-driven only)
- Batch operations to reduce API calls
- 100-event threshold for game-end sync
- Single query for cloud max timestamp during upload

### Free Tier Limits
- Authentication: 10,000/month
- Firestore: 50k reads/day, 20k writes/day, 1GB storage
- BigQuery: 1TB queries/month, 10GB storage

### Data Size Estimates
- 1 event ≈ 200 bytes
- 1000 hands ≈ 10,000 events ≈ 2MB
- Typical user stays within free tier

## Troubleshooting

### Common Issues

#### Authentication Errors
- **Symptom**: "Failed to authenticate" error
- **Solutions**:
  - Ensure OAuth client ID matches the extension ID
  - Verify Firebase project configuration
  - Check chrome.identity permissions in manifest.json
  - Confirm authorized domains in Firebase Auth settings

#### Write Stream Exhausted
- **Symptom**: "Write stream exhausted" error during sync
- **Cause**: Firestore rate limiting
- **Solutions**:
  - Reduce batch size in `firestore-backup-service.ts`
  - Add delays between batches
  - Implement exponential backoff

#### Login UI Not Updating
- **Symptom**: Sign-in button doesn't reflect auth state
- **Debug Steps**:
  1. Open Service Worker console
  2. Check for auth errors
  3. Verify message passing between popup and background
  4. Ensure Firebase Auth domains are authorized

### Debug Commands

```javascript
// Check auth state (in Service Worker console)
firebaseAuthService.getCurrentUser()
firebaseAuthService.isSignedIn()

// Test Chrome identity
chrome.identity.getAuthToken({ interactive: true }, console.log)

// Check Firestore connection
const testDoc = await firestore.collection('test').add({ test: true })
console.log('Test doc created:', testDoc.id)
```

### Monitoring

1. **Firebase Console**:
   - Monitor Authentication usage
   - Check Firestore reads/writes
   - Review error logs

2. **Chrome DevTools**:
   - Service Worker console for background errors
   - Network tab for API calls
   - Application tab for IndexedDB state

3. **BigQuery**:
   - Query costs and data usage
   - Export job status
   - Data freshness monitoring