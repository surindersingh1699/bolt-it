export interface AgentCurrentJob {
  id: string;
  command: string;
  startedAt: number;
}

export interface AgentHeartbeat {
  hostname: string;
  os: string;
  version: string;
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
  currentJob?: AgentCurrentJob | null;
}): void {
  store.current = {
    hostname: input.hostname,
    os: input.os,
    version: input.version,
    lastPingAt: Date.now(),
    currentJob: input.currentJob ?? null,
  };
}

export function readHeartbeat(): AgentHeartbeat | null {
  return store.current;
}
