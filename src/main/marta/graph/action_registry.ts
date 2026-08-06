/**
 * The permission list: which of the app's IPC contracts Marta may invoke.
 *
 * The app defines 457 invoke contracts. Marta is granted a curated subset,
 * because the other side of "she can drive the whole app" is "she can break
 * the whole app". **Default deny** — a contract absent from this file does not
 * appear in the graph, is not retrievable, and cannot be called, even if the
 * model hallucinates its name.
 *
 * Three things each entry supplies that a Zod schema cannot:
 *
 *   summary   — what the thing *is*, in the words a person would say. This is
 *               the retrieval surface; `app.createApp` is found by "new
 *               project" only because the summary says "project".
 *   risk      — from `tool_capabilities.ts`, the same vocabulary the
 *               local-agent tools already use.
 *   stateScope— likewise. Together these derive the confirmation gate; see
 *               `requiresConfirmation` in `types.ts`.
 *
 * Deliberate omissions, so the reasoning survives:
 *   - `system.resetAll`, `system.clearSessionData`, `app.deleteApp` and the
 *     mission worker-lifecycle internals are absent on purpose. Destroying a
 *     project or wiping app data is not something a voice command should be
 *     one mis-transcription away from.
 *   - Window chrome (`system.minimizeWindow` …) is absent: the Stage owns the
 *     window, and it is not orchestration.
 *   - Mission's 33 endpoints are mostly worker-runner plumbing driven by the
 *     mission runtime itself. Marta gets the handful that represent *intent*
 *     (create, inspect, interrupt), not the machinery.
 */

import type { ActionRegistryEntry } from "./types";

export const ACTION_REGISTRY: Readonly<Record<string, ActionRegistryEntry>> = {
  "marta.listTasks": {
    summary:
      "List delegated Claude and local-agent tasks with live status, model, effort, current tool, usage and errors.",
    risk: "low",
    stateScope: "read_only",
    keywords: [
      "task status",
      "progress",
      "what is claude doing",
      "is it finished",
      "running agents",
    ],
  },
  "marta.listTaskEvents": {
    summary:
      "Read the durable timeline, checkpoints, evidence and failures for Marta tasks and goals.",
    risk: "low",
    stateScope: "read_only",
    keywords: [
      "task timeline",
      "what happened",
      "show progress details",
      "execution history",
      "task evidence",
    ],
  },
  "marta.listGoals": {
    summary:
      "List Marta's parallel goals, workstreams, dependencies and current outcomes.",
    risk: "low",
    stateScope: "read_only",
    keywords: [
      "parallel plan",
      "workstreams",
      "goal graph",
      "what are you coordinating",
    ],
  },
  "marta.createGoal": {
    summary:
      "Create and start a durable parallel goal graph whose workstreams may run actions, delegates and verification gates concurrently.",
    risk: "medium",
    stateScope: "workspace",
    keywords: [
      "do these in parallel",
      "coordinate multiple tasks",
      "plan and execute",
      "fan out",
    ],
  },
  "marta.controlGoal": {
    summary:
      "Pause, resume, cancel or reprioritize a running Marta goal or one of its workstreams.",
    risk: "medium",
    stateScope: "runtime",
    keywords: [
      "pause task",
      "resume task",
      "cancel workstream",
      "make task one priority",
    ],
  },
  // ── Projects ──────────────────────────────────────────────────────────────
  "app.listApps": {
    summary: "List every project in the workspace.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["projects", "apps", "what have I built", "my work"],
  },
  "app.getApp": {
    summary: "Get one project's details by its numeric id.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["project details", "open project"],
  },
  "app.searchApps": {
    summary: "Find projects by name.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["find project", "which project", "search apps"],
  },
  "app.createApp": {
    summary: "Create a new project, optionally from a template.",
    risk: "medium",
    stateScope: "workspace",
    keywords: ["new project", "start a project", "scaffold", "new app"],
  },
  "app.renameApp": {
    summary: "Rename a project.",
    risk: "medium",
    stateScope: "workspace",
  },
  "app.copyApp": {
    summary: "Duplicate a project under a new name.",
    risk: "medium",
    stateScope: "workspace",
    keywords: ["fork", "duplicate", "clone project"],
  },
  "app.runApp": {
    summary: "Start a project's dev server.",
    risk: "medium",
    stateScope: "runtime",
    keywords: ["run", "start", "serve", "preview", "dev server"],
  },
  "app.stopApp": {
    summary: "Stop a project's running dev server.",
    risk: "medium",
    stateScope: "runtime",
    keywords: ["stop", "kill server", "shut down"],
  },
  "app.restartApp": {
    summary: "Restart a project's dev server.",
    risk: "medium",
    stateScope: "runtime",
  },
  "app.readAppFile": {
    summary: "Read one file from a project.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["show file", "open file", "read source"],
  },
  "app.searchAppFiles": {
    summary: "Search a project's files by name or content.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["find in project", "grep", "search code", "where is"],
  },
  "app.editAppFile": {
    summary: "Write file contents in a project. Overwrites the file.",
    risk: "medium",
    stateScope: "workspace",
    keywords: ["edit", "change file", "write file", "save"],
  },
  "app.getCurrentCommitHash": {
    summary: "Get the project's current git commit hash.",
    risk: "low",
    stateScope: "read_only",
  },
  "app.exportAppZip": {
    summary: "Export a project as a zip archive.",
    risk: "medium",
    stateScope: "workspace",
    keywords: ["export", "zip", "package up", "download project"],
  },
  "app.listAppScreenshots": {
    summary: "List screenshots captured for a project.",
    risk: "low",
    stateScope: "read_only",
  },

  // ── Conversations ─────────────────────────────────────────────────────────
  "chat.getChats": {
    summary: "List a project's conversations.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["chats", "conversations", "history", "sessions"],
  },
  "chat.getChat": {
    summary: "Read one conversation and its messages.",
    risk: "low",
    stateScope: "read_only",
  },
  "chat.searchChats": {
    summary: "Search across conversations by text.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["what did I say", "find conversation", "search history"],
  },
  "chat.createChat": {
    summary: "Start a new conversation in a project.",
    risk: "low",
    stateScope: "workspace",
    keywords: ["new chat", "start talking about"],
  },
  "chat.cancelStream": {
    summary: "Stop a conversation that is currently generating.",
    risk: "low",
    stateScope: "runtime",
    keywords: ["stop", "cancel", "abort generation"],
  },

  // ── Workspace files ───────────────────────────────────────────────────────
  "workspaceFiles.list": {
    summary: "List files and folders at a path inside a project.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["files", "directory", "folder contents", "ls"],
  },
  "workspaceFiles.properties": {
    summary: "Get size, type and timestamps for a file or folder.",
    risk: "low",
    stateScope: "read_only",
  },
  "workspaceFiles.createFile": {
    summary: "Create a new empty file in a project.",
    risk: "medium",
    stateScope: "workspace",
  },
  "workspaceFiles.createDirectory": {
    summary: "Create a new folder in a project.",
    risk: "medium",
    stateScope: "workspace",
  },
  "workspaceFiles.rename": {
    summary: "Rename a file or folder in a project.",
    risk: "medium",
    stateScope: "workspace",
  },
  "workspaceFiles.move": {
    summary: "Move a file or folder to another path in a project.",
    risk: "medium",
    stateScope: "workspace",
  },
  "workspaceFiles.copy": {
    summary: "Copy a file or folder within a project.",
    risk: "medium",
    stateScope: "workspace",
  },
  "workspaceFiles.remove": {
    // Deleting the user's source is exactly the class of thing that must never
    // happen on a misheard word, so this is confirmed even though the local
    // agent's equivalent `delete_file` runs unattended inside a build loop.
    summary: "Delete a file or folder from a project. Destructive.",
    risk: "high",
    stateScope: "workspace",
    keywords: ["delete", "remove", "rm"],
  },
  "workspaceFiles.revealInFolder": {
    summary: "Show a project file in the OS file manager.",
    risk: "low",
    stateScope: "host",
    confirm: false,
  },

  // ── Terminal ──────────────────────────────────────────────────────────────
  "terminal.list": {
    summary: "List open terminal sessions.",
    risk: "low",
    stateScope: "read_only",
  },
  "terminal.create": {
    summary: "Open a new terminal session in a project directory.",
    risk: "medium",
    stateScope: "host",
    keywords: ["terminal", "shell", "console", "command line"],
  },
  "terminal.write": {
    summary: "Type into a terminal session. Runs arbitrary shell commands.",
    risk: "high",
    stateScope: "host",
    keywords: ["run command", "execute", "shell"],
  },
  "terminal.scrollback": {
    summary: "Read a terminal session's output history.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["terminal output", "what did it print", "logs"],
  },
  "terminal.kill": {
    summary: "Close a terminal session.",
    risk: "medium",
    stateScope: "host",
    confirm: false,
  },

  // ── Flow: the workflow substrate ──────────────────────────────────────────
  "flow.listCapabilities": {
    summary: "List the workflow capabilities the flow runner can execute.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["what can you do", "capabilities", "pipelines"],
  },
  "flow.parseCommand": {
    summary: "Turn a sentence into a structured multi-step flow intent.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["plan", "break down", "what would that involve"],
  },
  "flow.runCommand": {
    summary:
      "Parse a sentence and run the resulting multi-step workflow end to end.",
    risk: "medium",
    stateScope: "workspace",
    keywords: ["do this", "make me", "build and generate", "run workflow"],
  },
  "flow.runFlow": {
    summary: "Run an already-parsed flow intent.",
    risk: "medium",
    stateScope: "workspace",
  },
  "flow.listResumableFlows": {
    summary: "List workflows that were interrupted and can be resumed.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["unfinished", "resume", "what stalled"],
  },
  "flow.resumeFlow": {
    summary: "Resume an interrupted workflow, re-running only failed steps.",
    risk: "medium",
    stateScope: "workspace",
    keywords: ["resume", "continue", "pick up where it stopped"],
  },
  "flow.generateMedia": {
    summary: "Generate one media asset (image, video, audio or music).",
    risk: "medium",
    stateScope: "workspace",
    keywords: ["image", "picture", "video", "audio", "music", "render"],
  },

  // ── Media ─────────────────────────────────────────────────────────────────
  "mediaQueue.enqueue": {
    summary: "Queue a media generation job to run in the background.",
    risk: "medium",
    stateScope: "workspace",
    keywords: ["queue", "generate later", "batch"],
  },
  "mediaQueue.list": {
    summary: "List queued, running and finished media jobs.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["queue", "jobs", "what's rendering"],
  },
  "mediaQueue.cancel": {
    summary: "Cancel a queued or running media job.",
    risk: "low",
    stateScope: "runtime",
  },
  "mediaQueue.retry": {
    summary: "Retry a failed media job.",
    risk: "medium",
    stateScope: "workspace",
  },
  "generatedMedia.list": {
    summary: "List everything generated so far.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["gallery", "my images", "what did we make", "generated"],
  },
  "generatedMedia.getFilePath": {
    summary: "Get the file path of a generated media item.",
    risk: "low",
    stateScope: "read_only",
  },
  "generatedMedia.setShared": {
    summary: "Share or unshare a generated media item with trusted peers.",
    risk: "medium",
    stateScope: "external",
    keywords: ["share", "send to peers"],
  },
  "mediaAi.getStatus": {
    summary: "Check whether the media backend and its models are installed.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["media setup", "is it ready", "backend status"],
  },
  "mediaAi.startBackend": {
    summary: "Start the local media generation backend.",
    risk: "medium",
    stateScope: "runtime",
  },
  "mediaAi.stopBackend": {
    summary: "Stop the local media generation backend and free its VRAM.",
    risk: "medium",
    stateScope: "runtime",
    keywords: ["free vram", "unload media"],
  },

  // ── Game: Godot and Blender ───────────────────────────────────────────────
  "godot.status": {
    summary: "Check whether the Godot engine is running and on which project.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["godot", "engine", "game running"],
  },
  "godot.findProject": {
    summary: "Locate a Godot project on disk.",
    risk: "low",
    stateScope: "read_only",
  },
  "godot.createProject": {
    summary: "Create a new Godot project.",
    risk: "medium",
    stateScope: "workspace",
    keywords: ["new game", "godot project"],
  },
  "godot.start": {
    summary: "Launch the Godot engine on a project, windowed or headless.",
    risk: "medium",
    stateScope: "host",
    keywords: ["open godot", "start engine", "run the game"],
    confirm: false,
  },
  "godot.stop": {
    summary: "Stop the running Godot engine.",
    risk: "medium",
    stateScope: "host",
    confirm: false,
  },
  "godot.call": {
    summary:
      "Call one of the Godot bridge operations: inspect or edit scenes, nodes, resources and animation.",
    risk: "medium",
    stateScope: "workspace",
    keywords: ["scene", "node", "sprite", "animation", "godot bridge"],
  },
  "godot.viewport": {
    summary: "Capture a screenshot of the Godot viewport.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["what does it look like", "screenshot the game", "preview"],
  },
  "godot.listAssets": {
    summary: "List the assets in a Godot project.",
    risk: "low",
    stateScope: "read_only",
  },
  "godot.importAsset": {
    summary: "Import a mesh, texture or audio file into a Godot project.",
    risk: "medium",
    stateScope: "workspace",
    keywords: ["import", "add asset", "bring into the game"],
  },
  "godot.checkProject": {
    summary: "Check a Godot project for script and scene errors.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["errors", "does it compile", "check the game"],
  },
  "godot.exportProject": {
    summary: "Export a Godot project to a playable build.",
    risk: "medium",
    stateScope: "workspace",
    keywords: ["build the game", "export", "make it playable"],
  },
  "blender.run": {
    summary:
      "Run a Blender operation on a mesh: decimate, unwrap UVs, re-origin, rescale, auto-rig, bake or export.",
    risk: "medium",
    stateScope: "workspace",
    keywords: ["mesh", "blender", "uv", "rig", "decimate", "3d model"],
  },

  // ── Delegation to Claude Code ─────────────────────────────────────────────
  "claudeCode.detect": {
    summary: "Check whether the Claude Code CLI is installed and signed in.",
    risk: "low",
    stateScope: "read_only",
  },
  "claudeCode.sessionInfo": {
    summary: "Get the current Claude Code session's context and cost usage.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["context left", "how much has it cost", "usage"],
  },
  "claudeCode.getAccountUsage": {
    summary: "Get Claude Code rate-limit and quota usage.",
    risk: "low",
    stateScope: "read_only",
  },
  "claudeCode.cancelTurn": {
    summary: "Stop Claude Code mid-turn.",
    risk: "low",
    stateScope: "runtime",
    keywords: ["stop", "cancel"],
  },

  // ── Missions: long autonomous runs ────────────────────────────────────────
  "mission.listMissionsForApp": {
    summary: "List the autonomous missions running against a project.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["missions", "background work", "what's running"],
  },
  "mission.getMission": {
    summary: "Get one mission's status and goal.",
    risk: "low",
    stateScope: "read_only",
  },
  "mission.listMissionEvents": {
    summary: "Read a mission's event log.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["what has it done", "mission log", "progress"],
  },
  "mission.listMissionTasks": {
    summary: "List a mission's task breakdown and their statuses.",
    risk: "low",
    stateScope: "read_only",
  },
  "mission.listMissionArtifacts": {
    summary: "List the files and outputs a mission produced.",
    risk: "low",
    stateScope: "read_only",
  },
  "mission.updateMissionStatus": {
    summary: "Pause, resume or cancel a mission.",
    risk: "medium",
    stateScope: "runtime",
    keywords: ["pause", "stop the mission", "resume"],
  },
  "mission.createMissionInterrupt": {
    summary:
      "Inject a course correction into a running mission without stopping it.",
    risk: "medium",
    stateScope: "runtime",
    keywords: ["tell it to", "change direction", "interrupt", "also do"],
  },
  "mission.listMissionPermissionRequests": {
    summary: "List actions a mission is waiting for permission to take.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["waiting on me", "needs approval", "blocked"],
  },
  "mission.resolveMissionPermissionRequest": {
    summary: "Approve or deny an action a mission is waiting on.",
    risk: "medium",
    stateScope: "runtime",
    keywords: ["approve", "allow it", "deny", "yes go ahead"],
  },

  // ── Models, inference and hardware ────────────────────────────────────────
  "hardware.getProfile": {
    summary: "Get this machine's CPU, GPU, VRAM and available backends.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["hardware", "my gpu", "how much vram", "specs"],
  },
  "telemetry.getLiveSample": {
    summary:
      "Sample live GPU utilisation, VRAM, temperature, power, CPU load and RAM.",
    risk: "low",
    stateScope: "read_only",
    keywords: [
      "gpu stats",
      "pc stats",
      "how hot",
      "cpu load",
      "how much ram",
      "is the gpu busy",
    ],
  },
  "telemetry.getInference": {
    summary:
      "Get recent model decode rate, time to first token and context occupancy.",
    risk: "low",
    stateScope: "read_only",
    keywords: [
      "tokens per second",
      "how fast are you",
      "inference stats",
      "context used",
    ],
  },
  "embeddedModel.getStatus": {
    summary:
      "Get the local inference server's state and which model is loaded.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["what model is loaded", "inference", "server status"],
  },
  "embeddedModel.getGpuStats": {
    summary: "Get live GPU utilisation, VRAM use and temperature.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["gpu usage", "vram free", "how hot", "utilisation"],
  },
  "embeddedModel.getStats": {
    summary: "Get inference throughput: tokens per second and latency.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["how fast", "tokens per second", "speed"],
  },
  "embeddedModel.loadModel": {
    summary: "Load a local model into the inference server.",
    risk: "medium",
    stateScope: "runtime",
    keywords: ["load model", "use model", "switch to"],
  },
  "embeddedModel.unloadModel": {
    summary: "Unload the local model and free its VRAM.",
    risk: "medium",
    stateScope: "runtime",
    keywords: ["free vram", "unload"],
  },
  "embeddedModel.swapModel": {
    summary: "Swap the resident local model for another one.",
    risk: "medium",
    stateScope: "runtime",
  },
  "orchestrator.getStatus": {
    summary:
      "Get the model orchestrator's state: what is resident and what VRAM is free.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["resident", "vram budget", "orchestrator"],
  },
  "orchestrator.releaseAll": {
    summary: "Unload every resident model and free all VRAM.",
    risk: "medium",
    stateScope: "runtime",
    keywords: ["free everything", "clear vram", "unload all"],
  },
  "marketplace.searchModels": {
    summary: "Search HuggingFace for downloadable models.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["find a model", "search models", "huggingface"],
  },
  "marketplace.listLocalModels": {
    summary: "List models already downloaded to this machine.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["installed models", "what models do I have"],
  },
  "marketplace.startDownload": {
    summary: "Download a model from HuggingFace.",
    risk: "medium",
    stateScope: "external",
    keywords: ["download model", "get model", "install"],
  },
  "marketplace.listDownloads": {
    summary: "List in-progress model downloads and their progress.",
    risk: "low",
    stateScope: "read_only",
  },
  "marketplace.cancelDownload": {
    summary: "Cancel a model download.",
    risk: "low",
    stateScope: "runtime",
  },
  "marketplace.getModelsDirInfo": {
    summary: "Get the models directory path and how much disk it uses.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["disk space", "where are models", "storage"],
  },

  // ── Source control ────────────────────────────────────────────────────────
  "github.getGitState": {
    summary: "Get a project's git state: branch, remote and sync status.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["git status", "which branch", "am I up to date"],
  },
  // Note: the working-tree operations live in `gitContracts`, not
  // `githubContracts` — hence the `git.` prefix here while branch and remote
  // operations below are `github.`.
  "git.getUncommittedFiles": {
    summary: "List a project's uncommitted changes.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["what changed", "uncommitted", "dirty files", "diff"],
  },
  "git.commitChanges": {
    summary: "Commit a project's changes with a message.",
    risk: "medium",
    stateScope: "workspace",
    keywords: ["commit", "save changes to git"],
  },
  "github.listLocalBranches": {
    summary: "List a project's local git branches.",
    risk: "low",
    stateScope: "read_only",
  },
  "github.createBranch": {
    summary: "Create a new git branch.",
    risk: "medium",
    stateScope: "workspace",
  },
  "github.switchBranch": {
    summary: "Switch a project to another git branch.",
    risk: "medium",
    stateScope: "workspace",
    keywords: ["checkout", "switch branch"],
  },
  "github.push": {
    summary: "Push commits to the remote repository.",
    risk: "high",
    stateScope: "external",
    keywords: ["push", "publish", "send to github"],
  },
  "github.pull": {
    summary: "Pull commits from the remote repository.",
    risk: "medium",
    stateScope: "external",
  },

  // ── Network and shared compute ────────────────────────────────────────────
  "network.getStatus": {
    summary: "Get peer-to-peer network status and connected peers.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["peers", "network", "who's online", "friends"],
  },
  "network.getNotifications": {
    summary: "List unread notifications from peers.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["notifications", "anything new", "messages"],
  },
  "compute.getAvailableNodes": {
    summary: "List peers offering GPU compute.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["borrow gpu", "peer compute", "who can help"],
  },
  "compute.getTarget": {
    summary: "Get where inference currently runs: locally or on a peer.",
    risk: "low",
    stateScope: "read_only",
  },
  "compute.setTarget": {
    summary: "Route inference to the local GPU or to a specific peer.",
    risk: "medium",
    stateScope: "external",
    keywords: ["run on", "offload to", "use my machine"],
  },

  // ── Background work ───────────────────────────────────────────────────────
  "watchdog.getStatus": {
    summary:
      "Get the watchdog's status: what long-running work it is watching.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["watchdog", "monitoring", "background health"],
  },
  "schedule.list": {
    summary: "List scheduled publishing jobs.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["scheduled", "upcoming", "what's queued to post"],
  },
  "schedule.cancel": {
    summary: "Cancel a scheduled publishing job.",
    risk: "medium",
    stateScope: "external",
  },

  // ── Settings ──────────────────────────────────────────────────────────────
  "settings.getUserSettings": {
    summary: "Read the app's settings.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["settings", "preferences", "configuration", "what is set to"],
  },
  "settings.setUserSettings": {
    summary:
      "Change app settings. Merges at the top level, so send only the keys you mean to change.",
    risk: "medium",
    stateScope: "workspace",
    keywords: [
      "change setting",
      "turn on",
      "turn off",
      "configure",
      "switch to",
    ],
  },
  "template.getTemplates": {
    summary: "List the project templates available to start from.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["templates", "starting points", "boilerplate"],
  },
  "template.getThemes": {
    summary: "List the visual themes projects can use.",
    risk: "low",
    stateScope: "read_only",
  },

  // ── System ────────────────────────────────────────────────────────────────
  "system.getSystemPlatform": {
    summary: "Get the operating system this app is running on.",
    risk: "low",
    stateScope: "read_only",
  },
  "system.getAppVersion": {
    summary: "Get the app's version.",
    risk: "low",
    stateScope: "read_only",
  },
  "system.getAppDataDir": {
    summary: "Get the directory where app data and models are stored.",
    risk: "low",
    stateScope: "read_only",
    keywords: ["where is data", "app folder", "storage location"],
  },
  "system.openExternalUrl": {
    summary: "Open a URL in the user's browser.",
    risk: "medium",
    stateScope: "external",
    keywords: ["open link", "browse to", "show me the docs"],
  },
  "system.showItemInFolder": {
    summary: "Reveal a file in the OS file manager.",
    risk: "low",
    stateScope: "host",
    confirm: false,
    keywords: ["show in explorer", "open folder", "find the file"],
  },
  "system.takeScreenshot": {
    summary: "Capture a screenshot of the app window.",
    risk: "low",
    stateScope: "read_only",
  },
};

export type RegisteredActionId = keyof typeof ACTION_REGISTRY;
