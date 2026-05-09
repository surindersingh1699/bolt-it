export interface AgentHeartbeat {
  hostname: string;
  os: string;
  version: string;
  lastPingAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __AGENT_HEARTBEAT__: { current: AgentHeartbeat | null } | undefined;
}

const store = globalThis.__AGENT_HEARTBEAT__ ?? { current: null };
if (!globalThis.__AGENT_HEARTBEAT__) globalThis.__AGENT_HEARTBEAT__ = store;

export function recordHeartbeat(input: { hostname: string; os: string; version: string }): void {
  store.current = {
    hostname: input.hostname,
    os: input.os,
    version: input.version,
    lastPingAt: Date.now(),
  };
}

export function readHeartbeat(): AgentHeartbeat | null {
  return store.current;
}
