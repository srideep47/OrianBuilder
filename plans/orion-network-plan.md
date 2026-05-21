# OrionBuilder Network, Auth & Cloud Sync — Master Plan

> **Scope**: Peer-to-peer compute sharing, friend networking, Google account login,
> and personal Google Drive cloud sync.
> **Target users**: Small private group (3–5 friends), non-commercial.
> **Guiding principle**: Robust networking, local-first, no central server required.

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────────┐
│                  OrionBuilder App                        │
├─────────────────┬───────────────────┬───────────────────┤
│  Compute        │  Project          │  Settings / Prefs  │
│  Routing        │  Sharing          │  Sync              │
├─────────────────┴───────────────────┴───────────────────┤
│              Autobase  (multi-writer CRDT sync)          │
├─────────────────────────────────────────────────────────┤
│              Hypercore (append-only logs)                │
├─────────────────────────────────────────────────────────┤
│              Hyperswarm (P2P transport)                  │
│      mDNS · DHT · Hole Punching · Relay fallback         │
├─────────────────────────────────────────────────────────┤
│         Google OAuth 2.0  +  Google Drive API            │
│         (personal cloud backup & cross-device sync)      │
└─────────────────────────────────────────────────────────┘
```

### Key Technology Choices

| Layer          | Technology                           | Reason                                                                           |
| -------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| P2P networking | Hyperswarm (Holepunch)               | Node.js native, battle-tested in Keet (video calls), excellent NAT hole punching |
| Data sync      | Hypercore + Autobase                 | Append-only, multi-writer, merges correctly when both devices write              |
| Identity       | Ed25519 keypair                      | Persistent, hardware-bound, Noise protocol encrypted channels                    |
| Discovery      | mDNS (LAN) + Kademlia DHT (internet) | Both run in parallel, no single point of failure                                 |
| Cloud backup   | Google Drive API v3                  | Free, personal quota (15GB), OAuth2 is free for personal use                     |
| Auth           | Google OAuth 2.0                     | Free, familiar, enables Drive access with one login                              |

---

## Screen Inventory

| ID  | Screen                                 | Phase |
| --- | -------------------------------------- | ----- |
| S1  | First Launch / Onboarding (3-step)     | 1     |
| S2  | Sign In with Google                    | 1     |
| S3  | Account & Identity Settings page       | 1     |
| S4  | Network Hub (peer list + detail panel) | 3     |
| S5  | Peer Detail Panel                      | 3     |
| S6  | Add Friend Flow (invite code modal)    | 3     |
| S7  | Compute Routing Popover                | 4     |
| S8  | Cloud Sync Status Indicator (top bar)  | 2     |
| S9  | Project Sharing Sheet                  | 5     |
| S10 | Notifications / Activity Drawer        | 3     |

---

## Navigation Changes

```
Sidebar
├── Projects          (existing)
├── Chat / Build      (existing)
├── Models            (existing)
├── ─────────────
├── Network           ← NEW  (S4, S5, S6)
└── ─────────────

Settings
├── Account           ← NEW  (S3)
├── Cloud & Sync      ← NEW  (S3 sub-section)
├── Network & Peers   ← NEW  (links to S4)
└── ... existing

Top Bar
├── Compute selector  ← NEW  (S7, near model picker)
├── Cloud sync icon   ← NEW  (S8)
└── Notifications     ← NEW  (S10)
```

---

---

# Phase 1 — Identity, Auth & Onboarding

**Goal**: Every device has a persistent identity. Users can sign in with Google.
Nothing in the P2P network yet — just the foundation everything else builds on.

**Deliverables**:

- Ed25519 keypair generated and stored securely on first launch
- Google OAuth 2.0 login flow (Electron-compatible, uses system browser)
- User profile stored locally + backed up to Drive
- First-launch onboarding wizard (3 steps)
- Account & Identity settings page

---

### 1.1 — Device Identity System

**Files to create**:

- `src/main/identity/keypair.ts` — generate, store, load Ed25519 keypair
- `src/main/identity/device.ts` — device metadata (name, type, hardware fingerprint)
- `src/shared/types/identity.ts` — shared type definitions

**What it does**:

- On first launch, generate an Ed25519 keypair using Node's `crypto` module
- Store private key encrypted in Electron's `safeStorage` (OS keychain integration)
- Store public key + device metadata in local SQLite (existing Drizzle setup)
- Public key fingerprint = first 8 bytes of SHA-256(pubkey), displayed as hex

**IPC channels**:

- `identity:get` → returns `{ publicKey, fingerprint, deviceName, deviceType, hardware }`
- `identity:updateDevice` → update name/type
- `identity:getAll` → list all known identities (self + trusted peers)

**Schema additions** (Drizzle):

```ts
// New table: device_identity
(id, publicKey, privateKeyEncrypted, deviceName, deviceType, createdAt);

// New table: trusted_peers
(id, publicKey, fingerprint, displayName, addedAt, lastSeenAt, permissions);
```

---

### 1.2 — Google OAuth 2.0

**Files to create**:

- `src/main/auth/google.ts` — OAuth flow, token management, refresh
- `src/main/auth/tokens.ts` — store/retrieve tokens via `safeStorage`
- `src/shared/types/auth.ts` — auth state types

**What it does**:

- Open system browser to Google consent screen (OAuth 2.0 PKCE flow for desktop apps)
- Listen on `localhost:PORT` for the redirect callback
- Exchange auth code for access + refresh tokens
- Store tokens encrypted via `safeStorage`
- Auto-refresh tokens before expiry
- Scopes needed: `profile email drive.file` (drive.file = only files this app creates)

**IPC channels**:

- `auth:signIn` → opens browser, waits for callback, returns user profile
- `auth:signOut` → clears tokens, clears local profile cache
- `auth:getStatus` → returns `{ isSignedIn, user: { name, email, avatar } | null }`
- `auth:refreshTokens` → internal, called by token manager

**Environment variables needed**:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:9876/oauth/callback
```

> Note: OAuth credentials created in Google Cloud Console (free). Client secret is OK
> to ship in Electron since it's not a web server — use PKCE for safety.

---

### 1.3 — Screen S1: First Launch Onboarding

**File**: `src/renderer/screens/Onboarding.tsx`

**Step 1 — Welcome**

- `<OrionLogo />` centered
- `<h1>` "Welcome to OrionBuilder"
- `<p>` one-line description
- Two `<Card>` options side by side:
  - Primary `<Button>` "Sign in with Google" → calls `auth:signIn`
  - Secondary `<Button>` "Use Locally" → skips auth, goes to Step 2
- `<p className="text-muted">` "You can sign in later from Settings"

**Step 2 — Device Setup**

- `<StepIndicator steps={3} current={2} />`
- `<Input>` Device name (pre-filled with `os.hostname()`)
- `<IconSelector>` Device type: Desktop / Laptop / Server (3 toggle buttons with icons)
- `<HardwareCard>` read-only: CPU, RAM, GPU — auto-detected from IPC call `system:getHardware`
- `<p className="text-muted">` "This is how your peers will see your device"
- `<Button>` "Next"

**Step 3 — Network Setup**

- `<StepIndicator steps={3} current={3} />`
- `<Switch>` "Join OrionBuilder Network" (default on)
- If on, shows:
  - `<KeyFingerprintDisplay>` monospace 8-char hash + copy button
  - `<p className="text-muted">` explainer text
  - `<Button variant="outline">` "Invite a Friend" → opens S6 inline
- `<Button>` "Finish" → marks onboarding complete in local DB, navigates to main app

**State machine**: `useOnboardingStore` (Zustand) tracking `{ step, isSignedIn, deviceName, deviceType, joinNetwork }`

---

### 1.4 — Screen S2: Sign In

**File**: `src/renderer/screens/SignIn.tsx`  
**Also used as**: modal when triggered from Settings

**Elements**:

- `<GoogleSignInButton>` — standard Google branding, calls `auth:signIn` IPC
- Loading state: spinner + "Opening browser..."
- Success state: auto-closes modal, shows toast "Signed in as [name]"
- Error state: inline error message + retry button
- `<Divider>` "What signing in gives you"
- `<FeatureList>` two columns: with account / without account
- `<p className="text-xs text-muted">` "Your data stays in your own Google Drive"
- Close / Cancel button

---

### 1.5 — Screen S3: Account & Identity Settings

**File**: `src/renderer/settings/AccountSettings.tsx`

**Section: Profile** (only shown if signed in, else shows sign-in prompt)

- `<Avatar src={user.avatar} size="lg" />`
- `<Input>` Display name (editable)
- `<p>` Email (read-only)
- `<Button variant="destructive-outline">` "Sign Out" → calls `auth:signOut`, confirm dialog

**Section: This Device**

- `<Input>` Device name (editable, calls `identity:updateDevice`)
- `<IconSelector>` Device type
- `<HardwareReadout>` CPU / RAM / GPU chips (read-only)
- `<KeyFingerprintDisplay>` "Your Public Key" + copy button + "What is this?" popover

**Section: Your Devices** (sign-in required, populated from Drive)

- `<DeviceList>` — list of all devices signed in with same Google account
- Each `<DeviceCard>`:
  - Device name + type icon
  - "Last seen: X ago"
  - `<OnlineDot>`
  - "This device" badge on current
  - `<Button size="sm" variant="ghost">` "Remove" → confirm dialog

**Section: Danger Zone**

- `<Button variant="destructive">` "Reset Identity" — regenerates keypair (warns this breaks existing peer connections)

---

### Phase 1 Acceptance Criteria

- [ ] App generates keypair on first launch, survives restart
- [ ] Google sign-in opens browser, completes OAuth, shows user profile
- [ ] Onboarding wizard completes and is not shown again on next launch
- [ ] Device name and type are editable and persist
- [ ] Account settings page shows all sections correctly
- [ ] Sign-out clears tokens and reverts to local-only state

---

---

# Phase 2 — Google Drive Cloud Sync

**Goal**: Settings, preferences, and projects automatically sync to the user's personal
Google Drive. Cross-device access via same Google account.

**Deliverables**:

- Drive folder structure created on first sign-in
- Settings JSON synced bidirectionally
- Project files synced to Drive
- Conflict resolution for simultaneous edits
- Cloud sync status indicator (S8) in top bar

---

### 2.1 — Drive Folder Structure

**File**: `src/main/cloud/drive-structure.ts`

Created automatically on first sign-in:

```
Google Drive/
└── OrionBuilder/
    ├── identity.json          ← keypair backup (private key encrypted)
    ├── settings.json          ← app preferences
    ├── devices.json           ← list of user's own devices
    └── projects/
        ├── [project-id]/
        │   ├── manifest.json  ← project metadata
        │   ├── files/         ← project source files
        │   └── assets/        ← images, videos
        └── ...
```

---

### 2.2 — Sync Engine

**Files to create**:

- `src/main/cloud/sync-engine.ts` — core sync logic, conflict detection
- `src/main/cloud/drive-client.ts` — Drive API wrapper (upload, download, list, watch)
- `src/main/cloud/sync-queue.ts` — debounced queue, prevents hammering API on rapid changes
- `src/shared/types/sync.ts` — `SyncStatus`, `SyncItem`, `SyncConflict` types

**Sync strategy**:

- **Settings**: Last-write-wins with timestamp. Settings changes debounced 2s before upload.
- **Projects**: File-level sync. Each file tracked by content hash. Upload only changed files.
- **Conflicts**: If local and remote both changed since last sync — keep both versions, surface conflict to user in notification.
- **Assets (images/video)**: Upload on add, never auto-delete from Drive.

**IPC channels**:

- `sync:getStatus` → `{ lastSyncedAt, items: SyncItem[], isOnline, hasDriveAccess }`
- `sync:syncNow` → triggers immediate full sync, returns when complete
- `sync:getConflicts` → list of unresolved conflicts
- `sync:resolveConflict` → `{ conflictId, resolution: 'local' | 'remote' }`

**Background behavior**:

- Sync runs every 5 minutes while app is open and signed in
- File watcher on project directory triggers incremental sync on save
- On app launch: pull latest from Drive before loading projects

---

### 2.3 — Screen S8: Sync Status Indicator

**File**: `src/renderer/components/SyncStatusIndicator.tsx`  
**Location**: Top bar, right side

**Collapsed** (icon only, always visible if signed in):

- `<CloudIcon>` with state variant:
  - `synced` → green checkmark overlay
  - `syncing` → spinning animation
  - `error` → yellow warning overlay
  - `offline` → grey, no overlay

**Expanded** (click → `<Popover>`):

- "Last synced: 2 minutes ago" with timestamp
- `<SyncItemList>`:
  - Settings ✓ / syncing / error
  - Projects — "Uploading 3 files..."
  - Identity backup ✓
- `<Button size="sm">` "Sync Now"
- `<Progress>` Drive storage: "2.1 GB / 15 GB"
- `<Link>` "Open in Google Drive"
- `<Link>` "Manage Sync Settings" → Account Settings

---

### 2.4 — Sync Settings (within Account Settings S3)

**Added to AccountSettings.tsx**

**Section: Cloud Storage**

- `<StorageBar>` visual: used / 15GB with color gradient
- "Last synced: [timestamp]" + `<Button size="sm">` "Sync Now"
- `<SyncToggleList>`:
  - `<Switch>` App settings (default on)
  - `<Switch>` Project files (default on)
  - `<Switch>` Project assets — images & video (default on, note: uses Drive quota)
  - `<Switch>` Identity backup (default on, recommended)
- `<Button variant="outline" size="sm">` "Open My OrionBuilder Folder in Drive"

---

### Phase 2 Acceptance Criteria

- [ ] Signing in creates `OrionBuilder/` folder structure in Drive
- [ ] Settings changes sync to Drive within 10 seconds
- [ ] Projects sync on save, new files appear in Drive
- [ ] Second device signs in with same account, pulls settings and projects from Drive
- [ ] Sync status indicator shows correct state at all times
- [ ] Sign-out stops all sync activity

---

---

# Phase 3 — P2P Network (Discovery & Connections)

**Goal**: Devices find each other and establish encrypted authenticated connections.
Works on LAN (instant) and over the internet (via DHT + hole punching).

**Deliverables**:

- Hyperswarm integration in Electron main process
- mDNS LAN discovery
- Internet peer discovery via DHT
- Encrypted channel per peer (Noise protocol)
- Peer metadata broadcast (hardware, models, load)
- Network Hub UI (S4, S5)
- Add Friend flow (S6)
- Notifications drawer (S10)

---

### 3.1 — Hyperswarm Integration

**Files to create**:

- `src/main/network/swarm.ts` — Hyperswarm instance, lifecycle management
- `src/main/network/peer-manager.ts` — track connected peers, handle events
- `src/main/network/discovery.ts` — mDNS + DHT topic registration
- `src/main/network/peer-channel.ts` — per-peer encrypted message framing
- `src/shared/types/network.ts` — `Peer`, `PeerStatus`, `PeerCapabilities`, `NetworkEvent` types

**How discovery works**:

- Each OrionBuilder installation registers on a DHT topic = `sha256("orionbuilder-v1")`
- When two peers find each other, they do a handshake:
  1. Exchange public keys
  2. Noise protocol handshake (encrypted channel)
  3. Exchange signed peer metadata
  4. Check if peer is in trusted list — if not, mark as `unknown` (no auto-connect)
- LAN peers found via mDNS additionally (faster, lower latency)

**Peer metadata payload** (broadcasted on connect):

```ts
interface PeerMetadata {
  publicKey: string;
  displayName: string;
  deviceName: string;
  deviceType: "desktop" | "laptop" | "server";
  hardware: {
    cpu: string;
    ramGB: number;
    gpu: string;
    vramGB: number;
  };
  loadedModels: string[]; // model IDs currently loaded
  gpuUtilization: number; // 0–100, live
  computeAvailable: boolean; // whether sharing is enabled
  version: string; // app version for compatibility check
}
```

**IPC channels**:

- `network:getStatus` → `{ isOnline, peers: Peer[], self: PeerMetadata }`
- `network:setOnline` → toggle joining/leaving the network
- `network:getPeer` → `{ peerId }` → full peer details
- `network:sendMessage` → `{ peerId, type, payload }` → send typed message to peer
- `network:onEvent` → renderer subscribes to network events (peer online/offline/message)

---

### 3.2 — Friend System

**Files to create**:

- `src/main/network/friends.ts` — trusted peer list management
- `src/main/network/invite.ts` — invite code generation and verification

**Invite code system**:

- Code format: `ORION-[NAME]-[8CHAR_HEX]` e.g. `ORION-SRIDEEP-4F2AC18B`
- Code = `encrypt(yourPublicKey + timestamp + nonce, sharedSecret)` — time-limited (24h)
- When friend enters your code: their app decodes it, extracts your public key, sends a friend request signed with their private key
- You see the request in Notifications, accept/decline
- On accept: both sides add each other to `trusted_peers` table

**Schema additions**:

```ts
// New table: friend_requests
id, fromPublicKey, fromDisplayName, inviteCode, status, createdAt

// Update: trusted_peers
+ addedVia: 'invite' | 'manual'
+ sharedComputeEnabled: boolean
+ allowedModels: string[]         // JSON array
```

**IPC channels**:

- `friends:generateInviteCode` → returns `{ code, expiresAt }`
- `friends:redeemInviteCode` → `{ code }` → sends friend request
- `friends:getRequests` → pending incoming + outgoing requests
- `friends:acceptRequest` → `{ requestId }` → adds to trusted peers
- `friends:declineRequest` → `{ requestId }`
- `friends:removeFriend` → `{ publicKey }` → removes from trusted list, disconnects
- `friends:list` → all trusted peers with online status

---

### 3.3 — Screen S4: Network Hub

**File**: `src/renderer/screens/NetworkHub.tsx`

**Layout**: Two-column (`grid-cols-[320px_1fr]`), full height.

**Left column — Peer List**

Top bar:

- `<h2>` "Network"
- `<OnlineToggle>` pill — Online (green) / Offline (grey), calls `network:setOnline`
- `<Button size="sm">` "Add Friend" → opens S6 modal
- `<Input placeholder="Search peers...">` — filters list

Sub-section: **On This Network (LAN)**

- `<SectionHeader count={lanPeers.length}>` "On This Network"
- For each peer: `<PeerRow>` (see below)
- Empty: "No devices on this network"

Sub-section: **Friends (Internet)**

- `<SectionHeader count={internetPeers.length}>` "Friends"
- For each peer: `<PeerRow>`
- Offline friends greyed, sorted last

Sub-section: **Pending** (if any)

- `<SectionHeader>` "Pending Invites"
- Incoming: `<IncomingRequestRow>` with Accept/Decline buttons
- Outgoing: `<OutgoingRequestRow>` with "Cancel" link

Empty state (no peers, no pending):

- Illustration + "No peers yet"
- `<Button>` "Add a Friend"

**`<PeerRow>` component** (`src/renderer/components/PeerRow.tsx`):

- `<Avatar>` initials-based, colored by hash of public key
- `<div>` device name (bold) + owner display name (muted)
- `<HardwareChip>` e.g. "RTX 4080 · 64GB" — truncated
- `<LatencyBadge>` color-coded: green <20ms, yellow <100ms, red >100ms, grey offline
- `<OnlineDot>` green / grey
- On hover: `<Button size="xs">` "Use Compute" (only if peer sharing compute)
- Click row → selects peer, right panel updates

**Right column — Peer Detail**
→ `<PeerDetailPanel>` (Screen S5 component), shows when peer selected.  
Shows `<NetworkEmptyDetail>` when none selected.

---

### 3.4 — Screen S5: Peer Detail Panel

**File**: `src/renderer/components/PeerDetailPanel.tsx`

**Header**:

- `<Avatar size="xl">`
- `<h2>` display name
- `<Badge>` "Friend" or "LAN Device"
- `<OnlineDot>` + "Online" / "Last seen X ago"
- `<LatencyBadge>`
- `<Button variant="ghost" size="sm" className="text-destructive">` "Remove Friend" → confirm dialog

**Section: Their Devices**

- List of their devices (from their metadata broadcast)
- `<DeviceCard>` per device:
  - Device name + type icon
  - Online / offline
  - Latency
  - `<HardwareChip>` GPU + RAM
  - Radio button: "Use this device's compute"

**Section: Shared Compute**

- `<Switch>` "Allow this peer to use my compute"
- If on:
  - `<ModelChecklist>` — your loaded models, checkbox per model
  - `<SegmentedControl>` Max concurrent: 1 / 2 / Unlimited
  - `<Slider>` "VRAM limit" — 2GB to full, stepped
- "They are sharing with you" read-only sub-section:
  - Available models from peer (list of chips)
  - `<LoadBar>` GPU utilization — live, updates via peer broadcast
  - `<p>` "X inference requests queued" if any

**Section: Shared Projects**

- `<ProjectThumbnailGrid>` — shared projects between you two
- Each card: thumbnail, name, "Shared by" label, last modified
- `<Button>` "Share a Project" → opens S9 sheet

**Section: Trust & Security**

- Their public key fingerprint (monospace)
- `<Badge>` "Verified" (green) or "Unverified" (yellow)
- `<Button size="sm">` "Verify Key" → opens side-by-side fingerprint comparison modal
- "First connected: [date]" — from `trusted_peers.addedAt`
- "Connected [N] sessions total"

---

### 3.5 — Screen S6: Add Friend Modal

**File**: `src/renderer/components/AddFriendModal.tsx`

**Layout**: `<Dialog>` centered, two `<Tabs>`.

**Tab: Share Your Code**

- `<InviteCodeDisplay>` — large monospace code, rounded box
- `<QRCode>` below (for future mobile support)
- `<Button>` "Copy Code" + `<Button>` "Share..." (system share)
- `<p className="text-muted">` "Code expires in 24 hours"
- `<Button variant="ghost" size="sm">` "Generate New Code"
- `<p>` "Send this code to your friend. They enter it in their app under Add Friend."

**Tab: Enter Friend's Code**

- `<Input size="lg" placeholder="ORION-NAME-XXXXXXXX">` — auto-formats as typed
- `<Button variant="ghost" size="sm">` "Paste from clipboard"
- `<Button>` "Connect"
- Status area (conditional):
  - "Connecting..." → spinner
  - Found: `<PeerPreviewCard>` — their avatar, name, device — with "Add as Friend" confirm
  - Error: inline error message + retry

---

### 3.6 — Screen S10: Notifications Drawer

**File**: `src/renderer/components/NotificationsDrawer.tsx`  
**Trigger**: Bell icon in top bar, opens as right `<Sheet>`

**Top bar**:

- `<h2>` "Activity"
- Unread count badge on bell icon (top bar)
- `<Button variant="ghost" size="sm">` "Clear all"

**Notification list** (grouped by Today / Earlier):

Each `<NotificationRow>` has:

- `<Avatar>` (peer avatar or cloud/system icon)
- One-line summary text (bold name, muted detail)
- Relative timestamp
- Action button where applicable (inline, right side)

**Notification types**:

- `peer_online` — "[Name]'s [Device] came online" · no action
- `peer_offline` — "[Name]'s [Device] went offline" · no action
- `compute_active` — "Friend is using your GPU" · `<Button size="xs">` "Stop"
- `compute_done` — "Inference on [Device] completed · [N] tokens · [Xs]" · no action
- `project_shared` — "[Name] shared '[Project]' with you" · `<Button size="xs">` "Open"
- `friend_request` — "New friend request from [Name]" · `<Button size="xs">` "Accept" + `<Button size="xs" variant="ghost">` "Decline"
- `sync_done` — "All projects synced to Drive" · no action
- `sync_error` — "Drive sync failed" · `<Button size="xs">` "Retry"
- `sync_conflict` — "Conflict in '[Project]'" · `<Button size="xs">` "Resolve"

**Footer**:

- `<Link>` "Notification Settings" → Account Settings

---

### Phase 3 Acceptance Criteria

- [ ] Two devices on same LAN discover each other within 5 seconds via mDNS
- [ ] Two devices on different networks find each other via DHT within 30 seconds
- [ ] All peer-to-peer traffic is encrypted (verify via Wireshark — only encrypted bytes)
- [ ] Unknown peers are discovered but not auto-connected (require friend request)
- [ ] Invite code flow completes end-to-end: generate → share → redeem → accept → trusted
- [ ] Network Hub shows all connected peers with live hardware/load data
- [ ] Removing a friend disconnects them and they can no longer connect
- [ ] Notifications appear for all peer events in real-time

---

---

# Phase 4 — Distributed Compute (Remote Inference)

**Goal**: Route inference calls to the most capable device on the network.
Your laptop seamlessly uses your PC's RTX 4080 for models it can't run locally.

**Deliverables**:

- Compute node mode (expose local inference via P2P)
- Compute client mode (route API calls to a peer)
- Live load broadcasting
- Compute Routing popover (S7)
- Queue management for concurrent requests
- Streaming token delivery over P2P

---

### 4.1 — Compute Node (Server Side)

**Files to create**:

- `src/main/compute/compute-node.ts` — accept inference requests from peers, proxy to local Ollama
- `src/main/compute/request-queue.ts` — queue, concurrency limit, per-peer rate limiting
- `src/main/compute/load-monitor.ts` — poll GPU/CPU utilization, broadcast to peers

**What it does**:

- Listens on a Hyperswarm multiplexed stream named `"compute"`
- Receives `InferenceRequest` messages from trusted peers
- Checks peer is in allowed list and within their quota
- Forwards request to local Ollama API (`localhost:11434`)
- Streams token chunks back over the same P2P stream as `InferenceChunk` messages
- Broadcasts current load (GPU%, queue depth) every 2 seconds to all connected peers

**`InferenceRequest` message**:

```ts
interface InferenceRequest {
  requestId: string;
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  options?: OllamaOptions;
}
```

**`InferenceChunk` message**:

```ts
interface InferenceChunk {
  requestId: string;
  type: "chunk" | "done" | "error";
  content?: string;
  error?: string;
  usage?: { promptTokens: number; completionTokens: number };
}
```

**IPC channels**:

- `compute:setSharing` → `{ enabled, allowedPeers, maxConcurrent, vramLimitGB }`
- `compute:getShareStatus` → current sharing config + active request count
- `compute:stopRequest` → `{ requestId }` → cancels an in-flight request from a peer

---

### 4.2 — Compute Client (Device Side)

**Files to create**:

- `src/main/compute/compute-client.ts` — send inference requests to a peer, handle streaming
- `src/main/compute/routing.ts` — decide which peer to use (auto-select or manual)

**Routing logic (auto mode)**:

1. Filter: peers online + compute available + has requested model loaded
2. Score each: (100 - gpuUtilization) - (latencyMs / 10)
3. Pick highest score
4. Fallback to local if no peers qualify

**Failover**:

- If peer disconnects mid-inference: emit error event, renderer shows "Connection lost — retry locally?"
- If peer queue is full: fallback to local or next best peer

**Integration point**:

- The existing inference call pathway in the app routes through `routing.ts`
- Routing layer is transparent — whether local or remote, same API to the renderer

**IPC channels**:

- `compute:setTarget` → `{ mode: 'auto' | 'local' | 'peer', peerId?: string, deviceId?: string }`
- `compute:getTarget` → current routing target + its current load
- `compute:getAvailableNodes` → all nodes (local + peers) with hardware + load info

---

### 4.3 — Screen S7: Compute Routing Popover

**File**: `src/renderer/components/ComputeRoutingPopover.tsx`  
**Location**: Top bar or near model picker — always visible during chat

**Trigger button** (always in top bar):

- `<GPUIcon>` + short label: "RTX 4080 · Local" or "Rahul's PC · 80ms"
- Small load bar under text (GPU% of active node)

**Popover content**:

Header:

- "Running on:" label
- Currently active node name + GPU chip

Node list (radio group):

- **This device** (always first):
  - "Local" label
  - GPU name + `<LoadBar>` current GPU%
  - Latency: "Local"
  - `<RadioButton>`
- For each peer offering compute (online only):
  - Device name + owner
  - GPU + VRAM chip
  - `<LoadBar>` GPU% — live, from peer broadcast
  - `<LatencyBadge>`
  - `<RadioButton>`
- Offline peers: shown greyed, no radio button, "Offline" label

Footer:

- `<Switch>` "Auto-select fastest available" — disables radio buttons when on
- `<Link size="sm">` "Manage sharing settings" → peer detail panel

---

### 4.4 — Compute Activity in Notifications (S10 additions)

Existing notifications drawer (S10) gets these compute-specific real-time updates:

- When a peer starts using your GPU: banner notification + entry in drawer
- Live "X requests queued" sub-text while active
- On completion: duration + token count shown

---

### Phase 4 Acceptance Criteria

- [ ] Laptop can run a model loaded only on the PC via P2P routing
- [ ] Streaming tokens arrive on client device in real time (no buffering wait)
- [ ] Auto-routing selects the least-loaded node correctly
- [ ] If the remote peer disconnects mid-stream, the client surfaces an error gracefully
- [ ] Load bar in S7 updates every 2 seconds, reflects real GPU load
- [ ] "Stop" button in notifications cancels a remote inference request

---

---

# Phase 5 — Project Sharing

**Goal**: Share projects with friends directly over P2P. Friends can view, edit, or
fork your projects. Large assets (images, video) transfer reliably.

**Deliverables**:

- Project sharing protocol over Hyperswarm
- Permissions system (view / edit / fork)
- Project Sharing Sheet UI (S9)
- Incoming shared projects section
- Large file transfer (chunked, resumable)

---

### 5.1 — Project Share Protocol

**Files to create**:

- `src/main/sharing/project-share.ts` — share initiation, permission management
- `src/main/sharing/file-transfer.ts` — chunked file transfer, resume support, progress tracking
- `src/main/sharing/share-store.ts` — local DB for shares, permissions, incoming projects

**How sharing works**:

- Sharer sends a `ShareOffer` message to specific peer over P2P channel
- Receiver sees notification in S10, accepts
- On accept: file transfer begins — project files sent in chunks (64KB), checksummed
- Assets (images/video) transferred separately, lower priority
- Receiver's app reconstructs project in their local projects folder
- For `edit` permission: changes sync back via Hypercore append-only log (both sides append, Autobase merges)
- For `fork` permission: receiver gets a full independent copy, no ongoing sync

**Schema additions**:

```ts
// New table: shared_projects
(id, projectId, sharedWithPublicKey, permission, direction, status, createdAt);

// New table: incoming_projects
(id, fromPublicKey, projectName, projectId, permission, status, receivedAt);
```

**IPC channels**:

- `sharing:shareProject` → `{ projectId, peerPublicKey, permission }`
- `sharing:revokeShare` → `{ projectId, peerPublicKey }`
- `sharing:getShares` → `{ projectId }` → who has access to a project
- `sharing:getIncoming` → all projects shared with me
- `sharing:acceptIncoming` → `{ shareId }` → triggers file transfer
- `sharing:declineIncoming` → `{ shareId }`
- `sharing:getTransferProgress` → `{ shareId }` → `{ bytesTransferred, totalBytes, status }`

---

### 5.2 — Screen S9: Project Sharing Sheet

**File**: `src/renderer/components/ProjectShareSheet.tsx`  
**Trigger**: Three-dot menu on project card → "Share"

**Layout**: `<Sheet side="right">` — slides in from right, ~480px wide

**Header**:

- Project thumbnail (48px) + project name
- `<h2>` "Share Project"

**Tab: Share with Friends**

- `<p className="text-muted">` "Choose friends to share with"
- Friend list (`<ScrollArea>`):
  - `<FriendSelectRow>` per friend:
    - Checkbox (left)
    - `<Avatar>` + name + device (online status dot)
    - When checked: `<PermissionSelect>` slides in — "View" / "Edit" / "Fork"
- Friends without the app greyed and explained
- `<Button>` "Send Share" — disabled until ≥1 selected

**Tab: Currently Shared**

- `<p className="text-muted">` "People with access"
- `<SharedWithList>`:
  - Each row: `<Avatar>` + name + `<PermissionBadge>` + `<Button size="xs">` "Revoke"
- "Not shared with anyone yet" empty state
- `<Button variant="destructive-outline" size="sm">` "Remove everyone" at bottom

**Tab: Shared with Me** (different projects, cross-project view)

- `<IncomingProjectGrid>` — thumbnail cards
- Each card: thumbnail, name, "from [Name]", permission badge
- `<Button>` "Open" + `<Button variant="outline">` "Fork to my projects"
- `<Badge variant="outline">` "Pending" on unaccepted shares

---

### Phase 5 Acceptance Criteria

- [ ] Sharing a project to a friend triggers a notification on their device within 5 seconds
- [ ] File transfer completes correctly, reconstructed project opens without errors
- [ ] Large assets (>100MB video) transfer reliably with progress shown
- [ ] Transfer resumes after network interruption (resumable)
- [ ] "Fork" creates a fully independent copy with no ongoing sync
- [ ] Revoking access prevents future syncs (does not delete their local copy)
- [ ] View-only permission: peer can open project but cannot save changes back

---

---

# Phase 6 — Polish, Hardening & Edge Cases

**Goal**: Production-quality reliability. Handle every failure mode gracefully.

---

### 6.1 — Network Resilience

- Reconnection with exponential backoff (max 30s interval)
- If DHT unreachable: fall back to known peer IPs from last session (stored in DB)
- If hole punching fails: automatic relay fallback with user notification "Using relay — higher latency"
- Graceful degradation: if peer goes offline mid-inference, surface clear error + local retry option
- Connection health heartbeat: ping peers every 30s, mark offline after 2 missed pings

### 6.2 — Security Hardening

- Peer identity verification UI (side-by-side fingerprint comparison, manual out-of-band confirm)
- Rate limiting: max requests per peer per minute (configurable in peer settings)
- Compute quota: per-peer VRAM and time limits enforced server-side
- All invite codes: expire after 24h, single-use
- Key rotation: UI to regenerate keypair with guided peer re-trust flow
- Audit log: every compute request from a peer logged locally with timestamp, model, tokens

### 6.3 — Drive Sync Edge Cases

- Offline queue: changes while offline are queued, synced on reconnect
- Large file upload: resumable uploads via Drive API (built-in)
- Quota exceeded: clear error message + link to manage Drive storage
- Token expiry: refresh token flow, re-auth prompt if refresh fails
- Multiple devices writing simultaneously: Autobase CRDT merge

### 6.4 — UX Polish

- Onboarding: "what's new in networking" tooltip tour on first visit to Network Hub
- Empty states: every list has an illustrated empty state with a clear CTA
- Loading skeletons: peer list, project grid — never raw spinners
- Optimistic UI: friend request sent shows immediately, reverts on error
- Keyboard navigation: all modals and panels fully keyboard accessible
- Peer avatars: consistent color + initials derived from public key hash (same color on every device)

### 6.5 — Settings: Network Preferences Page

**New settings section** in Settings → Network & Peers:

- `<Switch>` "Start connected on launch" (default on)
- `<Switch>` "Allow LAN discovery" (default on)
- `<Switch>` "Allow internet peers" (default on)
- `<Switch>` "Accept compute requests" (default off — user must opt in)
- `<Switch>` "Show peer notifications" (default on)
- `<NumberInput>` "Max concurrent compute requests from peers" (default 1)
- `<Button variant="destructive-outline">` "Disconnect all peers"
- `<Button variant="destructive">` "Reset peer list" — removes all trusted peers

---

---

## Dependency Map (What Blocks What)

```
Phase 1 (Identity + Auth)
    └── Phase 2 (Drive Sync)          ← needs auth tokens
    └── Phase 3 (P2P Network)         ← needs keypair for identity
            └── Phase 4 (Compute)     ← needs peer connections
            └── Phase 5 (Sharing)     ← needs peer connections + file transfer
                    └── Phase 6       ← polish all of the above
```

Phases 2 and 3 can be built in parallel after Phase 1.  
Phases 4 and 5 can be built in parallel after Phase 3.

---

## Estimated Effort

| Phase     | Description                            | Est. Time      |
| --------- | -------------------------------------- | -------------- |
| Phase 1   | Identity, Auth, Onboarding             | 3–4 days       |
| Phase 2   | Google Drive cloud sync                | 3–4 days       |
| Phase 3   | P2P networking, discovery, friends     | 5–7 days       |
| Phase 4   | Distributed compute / remote inference | 4–5 days       |
| Phase 5   | Project sharing                        | 3–4 days       |
| Phase 6   | Polish, hardening, edge cases          | 3–4 days       |
| **Total** |                                        | **~3–4 weeks** |

---

## npm Packages Needed

```jsonc
// P2P networking
"hyperswarm": "^4.x",
"hypercore": "^10.x",
"autobase": "^6.x",
"b4a": "^1.x",              // Buffer utilities for Hyperswarm

// Google APIs
"googleapis": "^140.x",     // Drive + OAuth2
"electron-oauth2": "^5.x",  // OAuth2 for Electron (PKCE flow)

// Utilities
"@noble/ed25519": "^2.x",   // Ed25519 keypair (faster than Node built-in)
"@noble/hashes": "^1.x",    // SHA-256 for fingerprints, topic hashing
```

---

## Decisions

1. **Model file sharing**: Inference only. The client device sends prompts over P2P; the host device runs them on its GPU and streams tokens back. No model weight files are transferred over the network.
2. **Drive scope**: `drive.file` — stores files in a visible `My Drive / OrionBuilder /` folder the user can browse and manage manually.
3. **Peer display names**: Each user sets a custom network alias (e.g. "Srideep") stored locally and synced to Drive. Independent of their Google account name.
4. **Project edit conflicts**: Last-write-wins. When two peers edit the same file simultaneously and reconnect, the most recently saved version is kept. A notification is shown: "Conflict resolved — [Name]'s version kept." No silent data loss — the overwritten version is kept in a local backup for 24h.
