export const HEARTBEAT_CONNECTED_WINDOW_MS = 10_000;

export interface AgentCurrentJob {
  id: string;
  command: string;
  startedAt: number;
}

export interface AgentHeartbeat {
  hostname: string;
  os: string;
  version: string;
  /** The build id the agent reports. Absent on an agent too old to report one. */
  build: string | null;
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
  currentJob?: AgentCurrentJob | null;
}): void {
  store.current = {
    hostname: input.hostname,
    os: input.os,
    version: input.version,
    build: input.build ?? null,
    lastPingAt: Date.now(),
    currentJob: input.currentJob ?? null,
  };
}

export function readHeartbeat(): AgentHeartbeat | null {
  return store.current;
}
