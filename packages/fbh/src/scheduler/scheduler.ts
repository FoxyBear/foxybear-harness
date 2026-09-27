import { ulid } from "ulid"
import { eq, desc } from "drizzle-orm"
import fs from "fs"
import { Database } from "../storage/db"
import { ScheduledTasksTable, SchedulerLogTable, type TaskOutput } from "./scheduler.sql"
import { cronMatches, nextFireTime } from "./cron"
import { Log } from "../util/log"

const log = Log.create({ service: "scheduler" })

export interface ScheduledTask {
  id: string
  name: string
  cron: string
  prompt: string
  persona: string
  category: "maintenance" | "user"
  enabled: boolean
  output: TaskOutput
  last_run?: string
  last_status?: "success" | "error"
  next_fire?: string
  created_at: string
}

export interface TaskInput {
  name: string
  cron: string
  prompt: string
  persona?: string
  output?: Partial<TaskOutput>
}

export interface SchedulerLogEntry {
  id: string
  task_id: string
  task_name: string
  started_at: string
  completed_at?: string
  status: "running" | "success" | "error" | "skipped"
  error?: string
  session_id?: string
}

export interface SchedulerConfig {
  enabled: boolean
  check_interval_seconds: number
  max_concurrent_user_tasks: number
  pruning_schedule: string
  workforce_sync: string
  transcript_cleanup: string
}

const DEFAULT_CONFIG: SchedulerConfig = {
  enabled: false,
  check_interval_seconds: 60,
  max_concurrent_user_tasks: 3,
  pruning_schedule: "0 3 * * *",
  workforce_sync: "0 */6 * * *",
  transcript_cleanup: "0 2 * * 0",
}

export interface MaintenanceTask {
  name: string
  schedule: string
  gate?: () => Promise<boolean>
  handler: () => Promise<void>
}

interface TaskExecutorResult {
  sessionId: string
  content?: string
}
type TaskExecutor = (task: ScheduledTask) => Promise<TaskExecutorResult>

let _taskExecutor: TaskExecutor = async (_task) => {
  log.info("task execution not yet wired", { name: _task.name })
  return { sessionId: `stub-session-${ulid()}` }
}

let _knownPersonas: Set<string> | null = null

export namespace Scheduler {
  let _interval: ReturnType<typeof setInterval> | null = null
  let _running = false
  let _config: SchedulerConfig = { ...DEFAULT_CONFIG }
  let _activeTasks = new Map<string, Promise<void>>()
  let _tickFn: (() => Promise<void>) | null = null

  let _maintenanceTasks: MaintenanceTask[] = []
  let _maintenanceRunning = new Set<string>()
  let _maintenanceHandlers = new Map<string, () => Promise<void>>()

  interface QueuedTaskEntry {
    task: ScheduledTask
    priority: "elevated" | "normal"
  }
  let _taskQueue: QueuedTaskEntry[] = []

  export function setExecutor(executor: TaskExecutor): void {
    _taskExecutor = executor
  }

  export function setKnownPersonas(personas: string[]): void {
    _knownPersonas = new Set(personas)
  }

  export function getMaintenanceTasks(): MaintenanceTask[] {
    return [..._maintenanceTasks]
  }

  export function getQueueLength(): number {
    return _taskQueue.length
  }

  export function setMaintenanceHandler(name: string, handler: () => Promise<void>): void {
    _maintenanceHandlers.set(name, handler)
  }

  export async function start(config?: Partial<SchedulerConfig>, runtimeConfig?: {
    mesh?: { enabled?: boolean }
    memory?: { workforce?: { url?: string } }
  }): Promise<void> {
    if (_running) return

    _config = { ...DEFAULT_CONFIG, ...config }

    if (!_config.enabled) {
      log.info("scheduler disabled by config")
      return
    }

    _running = true
    const intervalMs = _config.check_interval_seconds * 1000

    registerMaintenanceTasks(runtimeConfig)

    _tickFn = tick
    _interval = setInterval(() => {
      tick().catch((err) => {
        log.error("scheduler tick error", { error: String(err) })
      })
    }, intervalMs)

    log.info("scheduler started", { interval_seconds: _config.check_interval_seconds })
  }

  export async function stop(): Promise<void> {
    if (!_running && !_interval) return

    if (_interval) {
      clearInterval(_interval)
      _interval = null
    }

    _running = false
    _tickFn = null

    if (_activeTasks.size > 0) {
      log.info("waiting for running tasks", { count: _activeTasks.size })
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30_000))
      await Promise.race([
        Promise.allSettled(Array.from(_activeTasks.values())),
        timeout,
      ])
      _activeTasks.clear()
    }

    log.info("scheduler stopped")
  }

  export async function tick(): Promise<void> {
    const now = new Date()
    now.setSeconds(0, 0)

    for (const mTask of _maintenanceTasks) {
      const shouldFire =
        mTask.schedule === "tick" || cronMatches(mTask.schedule, now)
      if (shouldFire) {
        if (mTask.gate) {
          try {
            const gateResult = await mTask.gate()
            if (!gateResult) continue
          } catch {
            continue
          }
        }
        await fireMaintenanceTask(mTask.name)
      }
    }

    const tasks = await listTasks()
    const enabledTasks = tasks.filter((t) => t.enabled && t.category === "user")

    for (const task of enabledTasks) {
      if (cronMatches(task.cron, now)) {
        await fireTask(task)
      }
    }
  }

  export function getTickFn(): (() => Promise<void>) | null {
    return _tickFn
  }

  export async function addTask(input: TaskInput): Promise<ScheduledTask> {
    const id = ulid()
    const now = Date.now()
    const output: TaskOutput = {
      transcript: true,
      ...input.output,
    }

    Database.use((db) => {
      db.insert(ScheduledTasksTable)
        .values({
          id,
          name: input.name,
          cron: input.cron,
          prompt: input.prompt,
          persona: input.persona ?? "build",
          category: "user",
          enabled: true,
          output: output,
          time_created: now,
          time_updated: now,
        })
        .run()
    })

    const next = nextFireTime(input.cron, new Date())

    return {
      id,
      name: input.name,
      cron: input.cron,
      prompt: input.prompt,
      persona: input.persona ?? "build",
      category: "user",
      enabled: true,
      output,
      next_fire: next?.toISOString(),
      created_at: new Date(now).toISOString(),
    }
  }

  export async function removeTask(id: string): Promise<void> {
    const task = Database.use((db) => {
      return db.select().from(ScheduledTasksTable).where(eq(ScheduledTasksTable.id, id)).get()
    })

    if (!task) {
      throw new Error(`Task not found: ${id}`)
    }

    const logId = ulid()
    const now = Date.now()

    Database.transaction((db) => {
      db.delete(ScheduledTasksTable).where(eq(ScheduledTasksTable.id, id)).run()
      db.insert(SchedulerLogTable)
        .values({
          id: logId,
          task_id: id,
          task_name: task.name,
          started_at: new Date(now),
          completed_at: new Date(now),
          status: "removed",
          time_created: now,
          time_updated: now,
        })
        .run()
    })
  }

  export async function enableTask(id: string, enabled: boolean): Promise<void> {
    Database.use((db) => {
      db.update(ScheduledTasksTable)
        .set({ enabled, time_updated: Date.now() })
        .where(eq(ScheduledTasksTable.id, id))
        .run()
    })
  }

  export async function runNow(id: string): Promise<string> {
    const task = Database.use((db) => {
      return db.select().from(ScheduledTasksTable).where(eq(ScheduledTasksTable.id, id)).get()
    })

    if (!task) {
      throw new Error(`Task not found: ${id}`)
    }

    const scheduledTask = rowToTask(task)
    try {
      return await executeTask(scheduledTask)
    } catch {
      return `error-${id}`
    }
  }

  export async function listTasks(): Promise<ScheduledTask[]> {
    const rows = Database.use((db) => {
      return db.select().from(ScheduledTasksTable).all()
    })

    return rows.map(rowToTask)
  }

  export async function getLog(taskId?: string, limit: number = 50): Promise<SchedulerLogEntry[]> {
    const rows = Database.use((db) => {
      let query = db.select().from(SchedulerLogTable).orderBy(desc(SchedulerLogTable.started_at))
      if (taskId) {
        return query.where(eq(SchedulerLogTable.task_id, taskId)).limit(limit).all()
      }
      return query.limit(limit).all()
    })

    return rows.map((row) => ({
      id: row.id,
      task_id: row.task_id,
      task_name: row.task_name,
      started_at: row.started_at.toISOString(),
      completed_at: row.completed_at?.toISOString(),
      status: row.status as "running" | "success" | "error" | "skipped",
      error: row.error ?? undefined,
      session_id: row.session_id ?? undefined,
    }))
  }

  export function getConfig(): SchedulerConfig {
    return { ..._config }
  }

  export function isRunning(): boolean {
    return _running
  }

  export async function _reset(): Promise<void> {
    if (_interval) {
      clearInterval(_interval)
      _interval = null
    }
    _running = false
    _tickFn = null
    _activeTasks.clear()
    _config = { ...DEFAULT_CONFIG }
    _maintenanceTasks = []
    _maintenanceRunning.clear()
    _maintenanceHandlers.clear()
    _taskQueue = []
    _knownPersonas = null
    _taskExecutor = async (_task) => {
      log.info("task execution not yet wired", { name: _task.name })
      return { sessionId: `stub-session-${ulid()}` }
    }
  }

  function registerMaintenanceTasks(runtimeConfig?: {
    mesh?: { enabled?: boolean }
    memory?: { workforce?: { url?: string } }
  }): void {
    // SDD-06 / Phase M-3 — English-label interval → cron conversion (SC-6).
    // The scheduler stores cron strings internally; the config exposes
    // English labels (hourly/daily/weekly) per SC-6. Conversion is a pure
    // lookup — no timezone awareness needed (the daemon runs local time).
    const intervalToCron = (label: string): string => {
      if (label === "hourly") return "0 * * * *"
      if (label === "daily") return "0 0 * * *"
      if (label === "weekly") return "0 0 * * 0"
      // Already a cron expression (5 fields) — pass through.
      if (label.trim().split(/\s+/).length === 5) return label
      // Unknown label — default to daily (safe, frequent enough for M-3 tasks).
      return "0 0 * * *"
    }

    // SDD-06 — read memory.scheduler.tasks.* intervals from config. Falls
    // back to English defaults (hourly/daily/weekly) per SC-6. The
    // scheduler.start runtimeConfig does not carry the memory config, so
    // we read it lazily inside each handler via getConfig().
    const memoryTasks = (async () => {
      try {
        const { getConfig } = await import("../config/bridge")
        const cfg = await getConfig()
        return cfg?.memory?.scheduler?.tasks ?? {}
      } catch {
        return {}
      }
    })()

    _maintenanceTasks = [
      {
        name: "memory-consolidation",
        schedule: "tick",
        gate: async () => {
          try {
            const { Consolidation } = await import("../memory/consolidation")
            return Consolidation.shouldRun()
          } catch {
            return false
          }
        },
        handler: async () => {
          const { Consolidation } = await import("../memory/consolidation")
          const { Session } = await import("../session")
          const recent = [...Session.listGlobal({ limit: 50 })].map((s) => s.id)
          await Consolidation.run({
            persona: "default",
            lockDir: "/tmp/opencode-consolidation",
            recentSessionIds: recent,
          })
        },
      },
      {
        // SDD-06 — memory-decay task (hourly). Calls MemoryLifecycle.decay.
        // No-op when decay_model=none (abort A5 state).
        name: "memory-decay",
        schedule: intervalToCron("hourly"),
        handler: async () => {
          try {
            const { decay } = await import("../memory/lifecycle/decay")
            const result = await decay()
            log.info("memory-decay task complete", result)
          } catch (err) {
            log.error("memory-decay task failed", { error: String(err) })
          }
        },
      },
      {
        // SDD-06 — memory-ttl-pruning rewired to call Consolidation.prune
        // (CC-2 — gives prune its first real call site). The inline
        // Memory.getPrunable + Memory.forget loop is removed.
        name: "memory-ttl-pruning",
        schedule: intervalToCron("weekly"),
        handler: async () => {
          try {
            const tasks = await memoryTasks
            const interval = tasks.pruning?.interval ?? "weekly"
            const { prune } = await import("../memory/lifecycle/prune")
            const result = await prune("default")
            log.info("memory-ttl-pruning task complete", { ...result, interval })
          } catch (err) {
            log.error("memory-ttl-pruning task failed", { error: String(err) })
          }
        },
      },
      {
        name: "mesh-peer-heartbeat",
        schedule: "*/5 * * * *",
        gate: async () => {
          return runtimeConfig?.mesh?.enabled === true
        },
        handler: async () => {
          try {
            const { Mesh } = await import("../mesh/mesh")
            await Mesh.heartbeat()
          } catch (err) {
            log.error("mesh heartbeat failed", { error: String(err) })
          }
        },
      },
      {
        // SDD-06 — memory-graduation rewired to call MemoryLifecycle.graduate
        // (daily per SC-6). The existing graduateMemories with
        // gte(access_count, 2) is preserved (CC-2). The hardcoded
        // project_id: "global" + persona: "default" stays as the default
        // for now; req 15 (iterate all personas/projects) is partially
        // addressed — the graduate() function reads the config but the
        // persona iteration is a follow-up (SDD-02 fix dependency).
        name: "memory-graduation",
        schedule: intervalToCron("daily"),
        gate: async () => {
          try {
            const { getGlobalGraphBackend } = await import("../memory/graph")
            const backend = getGlobalGraphBackend()
            return backend !== null && backend.healthy()
          } catch {
            return false
          }
        },
        handler: async () => {
          try {
            const { graduate } = await import("../memory/lifecycle/graduate")
            const result = await graduate()
            log.info("memory-graduation task complete", result)
          } catch (err) {
            log.error("memory graduation failed", { error: String(err) })
          }
        },
      },
      {
        // SDD-06 — memory-gc task (weekly). Hard-deletes ARCHIVED nodes
        // past retention_days. Emits GC_DELETED event before deletion.
        name: "memory-gc",
        schedule: intervalToCron("weekly"),
        handler: async () => {
          try {
            const { gc } = await import("../memory/lifecycle/gc")
            const result = await gc()
            log.info("memory-gc task complete", result)
          } catch (err) {
            log.error("memory-gc task failed", { error: String(err) })
          }
        },
      },
      {
        name: "transcript-cleanup",
        schedule: _config.transcript_cleanup,
        handler: async () => {
          log.info("transcript cleanup not implemented")
        },
      },
    ]
  }

  export async function fireMaintenanceTask(name: string): Promise<void> {
    const mTask = _maintenanceTasks.find((t) => t.name === name)
    if (!mTask) {
      log.warn("maintenance task not found", { name })
      return
    }

    if (_maintenanceRunning.has(name)) {
      const logId = ulid()
      const now = new Date()
      Database.use((db) => {
        db.insert(SchedulerLogTable)
          .values({
            id: logId,
            task_id: `maintenance-${name}`,
            task_name: name,
            started_at: now,
            completed_at: now,
            status: "skipped",
            error: `Skipped ${name}: already running`,
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          .run()
      })
      log.info(`Skipped ${name}: already running`)
      return
    }

    _maintenanceRunning.add(name)
    const logId = ulid()
    const startedAt = new Date()

    Database.use((db) => {
      db.insert(SchedulerLogTable)
        .values({
          id: logId,
          task_id: `maintenance-${name}`,
          task_name: name,
          started_at: startedAt,
          status: "running",
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
    })

    try {
      const handler = _maintenanceHandlers.get(name) ?? mTask.handler
      await handler()

      Database.use((db) => {
        db.update(SchedulerLogTable)
          .set({
            status: "success",
            completed_at: new Date(),
            time_updated: Date.now(),
          })
          .where(eq(SchedulerLogTable.id, logId))
          .run()
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      Database.use((db) => {
        db.update(SchedulerLogTable)
          .set({
            status: "error",
            completed_at: new Date(),
            error: errorMsg,
            time_updated: Date.now(),
          })
          .where(eq(SchedulerLogTable.id, logId))
          .run()
      })
      log.error("maintenance task failed", { name, error: errorMsg })
    } finally {
      _maintenanceRunning.delete(name)
    }
  }

  function rowToTask(row: typeof ScheduledTasksTable.$inferSelect): ScheduledTask {
    const output = (row.output as TaskOutput) ?? { transcript: true }
    const next = row.enabled ? nextFireTime(row.cron, new Date()) : null

    return {
      id: row.id,
      name: row.name,
      cron: row.cron,
      prompt: row.prompt,
      persona: row.persona,
      category: row.category as "maintenance" | "user",
      enabled: row.enabled ?? true,
      output,
      last_run: row.last_run?.toISOString(),
      last_status: row.last_status as "success" | "error" | undefined,
      next_fire: next?.toISOString(),
      created_at: new Date(row.time_created).toISOString(),
    }
  }

  async function fireTask(task: ScheduledTask): Promise<void> {
    enqueueInternal(task, "normal")
  }

  function enqueueInternal(task: ScheduledTask, priority: "elevated" | "normal"): void {
    if (_activeTasks.size >= _config.max_concurrent_user_tasks) {
      log.info("concurrency limit reached, queueing", {
        task: task.name,
        active: _activeTasks.size,
        priority,
      })
      _taskQueue.push({ task, priority })
      return
    }

    startTask(task)
  }

  export interface SchedulerEnqueueInput {
    task: ScheduledTask
    priority?: "elevated" | "normal"
  }

  export function enqueue(input: SchedulerEnqueueInput): void {
    const priority: "elevated" | "normal" = input.priority ?? "normal"
    enqueueInternal(input.task, priority)
  }

  function startTask(task: ScheduledTask): void {
    const promise = executeTask(task)
      .then(() => {
        _activeTasks.delete(task.id)
        drainQueue()
      })
      .catch(() => {
        _activeTasks.delete(task.id)
        drainQueue()
      })

    _activeTasks.set(task.id, promise as unknown as Promise<void>)
  }

  function drainQueue(): void {
    if (_taskQueue.length === 0) return
    if (_activeTasks.size >= _config.max_concurrent_user_tasks) return
    const elevatedIdx = _taskQueue.findIndex((e) => e.priority === "elevated")
    const idx = elevatedIdx >= 0 ? elevatedIdx : 0
    const [next] = _taskQueue.splice(idx, 1)
    if (next) startTask(next.task)
  }

  async function executeTask(task: ScheduledTask): Promise<string> {
    const logId = ulid()
    const startedAt = new Date()

    let effectiveTask = task
    if (_knownPersonas && !_knownPersonas.has(task.persona)) {
      log.warn("persona not configured, using default", {
        persona: task.persona,
        default: "build",
      })
      effectiveTask = { ...task, persona: "build" }
    }

    Database.use((db) => {
      db.insert(SchedulerLogTable)
        .values({
          id: logId,
          task_id: task.id,
          task_name: task.name,
          started_at: startedAt,
          status: "running",
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
    })

    try {
      const result = await _taskExecutor(effectiveTask)
      const sessionId = result.sessionId

      if (task.output?.mesh_target) {
        log.info("mesh output not implemented", {
          task: task.name,
          target: task.output.mesh_target,
        })
      }

      if (task.output?.file_path && result.content) {
        try {
          fs.writeFileSync(task.output.file_path, result.content, "utf-8")
          log.info("response written to file", {
            task: task.name,
            path: task.output.file_path,
          })
        } catch (writeErr) {
          log.error("failed to write response to file", {
            task: task.name,
            path: task.output.file_path,
            error: String(writeErr),
          })
        }
      }

      Database.use((db) => {
        db.update(ScheduledTasksTable)
          .set({
            last_run: startedAt,
            last_status: "success",
            time_updated: Date.now(),
          })
          .where(eq(ScheduledTasksTable.id, task.id))
          .run()

        db.update(SchedulerLogTable)
          .set({
            status: "success",
            completed_at: new Date(),
            session_id: sessionId,
            time_updated: Date.now(),
          })
          .where(eq(SchedulerLogTable.id, logId))
          .run()
      })

      log.info("task completed", { task: task.name, sessionId })
      return sessionId
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)

      Database.use((db) => {
        db.update(ScheduledTasksTable)
          .set({
            last_run: startedAt,
            last_status: "error",
            time_updated: Date.now(),
          })
          .where(eq(ScheduledTasksTable.id, task.id))
          .run()

        db.update(SchedulerLogTable)
          .set({
            status: "error",
            completed_at: new Date(),
            error: errorMsg,
            time_updated: Date.now(),
          })
          .where(eq(SchedulerLogTable.id, logId))
          .run()
      })

      log.error("task failed", { task: task.name, error: errorMsg })
      return `error-${task.id}`
    }
  }
}
