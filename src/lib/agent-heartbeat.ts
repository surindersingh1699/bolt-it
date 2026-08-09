export const HEARTBEAT_CONNECTED_WINDOW_MS = 10_000;

export interface AgentCurrentJob {
  id: string;
  command: string;
  startedAt: number;
}

/**
 * What the agent on the other end says it can do.
 *
 * Reported by the device, never assumed by us. The capability registry says what
 * this SYSTEM can do; this says what THAT MACHINE's build implements, and the
 * difference between the two is what burned three looks on T-4935.
 */
export interface AgentSurface {
  /** Job handler names, e.g. `fs_grep`, `command_output`. */
  handlers: string[];
  binaries: {
    /** Runnable now. */
    default: string[];
    /** Runnable for one ticket once granted. */
    grantable: string[];
  };
}

export interface AgentHeartbeat {
  hostname: string;
  os: string;
  version: string;
  /** The build id the agent reports. Absent on an agent too old to report one. */
  build: string | null;
  /** Null on a build too old to describe itself — assume nothing in that case. */
  surface: AgentSurface | null;
  /**
   * The person at the machine has stopped it taking work from their local
   * console. Reported rather than inferred: a paused agent still heartbeats, so
   * without this it looks identical to a connected agent with nothing to do, and
   * the job it never claims reads as an unreachable device.
   */
  paused: boolean;
  lastPingAt: number;
  currentJob: AgentCurrentJob | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __AGENT_HEARTBEAT__: { current: AgentHeartbeat | null } | undefined;
}

const store = globalThis.__AGENT_HEARTBEAT__ ?? { current: null };
if (!globalThis.__AGENT_HEARTBEAT__) globalThis.__AGENT_HEARTBEAT__ = store;

export function recordHeartbeat(input: {
  hostname: string;
  os: string;
  version: string;
  build?: string | null;
  surface?: AgentSurface | null;
  paused?: boolean;
  currentJob?: AgentCurrentJob | null;
}): void {
  store.current = {
    hostname: input.hostname,
    os: input.os,
    version: input.version,
    build: input.build ?? null,
    surface: input.surface ?? null,
    // An agent too old to report it is not paused — it has no way to be.
    paused: input.paused ?? false,
    lastPingAt: Date.now(),
    currentJob: input.currentJob ?? null,
  };
}

export function readHeartbeat(): AgentHeartbeat | null {
  return store.current;
}
