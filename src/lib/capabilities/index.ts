/**
 * The capability surface the rest of the app imports.
 *
 * Everything here is derived from `registry.ts`. Nothing in this file holds a
 * second copy of a fact that lives on a spec — that duplication is exactly what
 * the registry replaced.
 */

import { CAPABILITY_SPECS, isReadOnlyCapability } from "./registry";

export {
  CAPABILITIES,
  CAPABILITY_SPECS,
  buildCommand,
  capabilityAllowed,
  capabilitySpec,
  isReadOnlyCapability,
} from "./registry";
export type {
  BlastRadius,
  BuiltCommand,
  CapabilityProvenance,
  CapabilityRisk,
  CapabilitySpec,
  DevicePlatform,
  Reversibility,
} from "./registry";

/** One-line description per capability, rendered into both model prompts. */
export const CAPABILITY_HELP: Record<string, string> = Object.fromEntries(
  CAPABILITY_SPECS.map((s) => [s.id, s.help]),
);

/** Human label for a capability, used on the ticket log and in the job record. */
export function humanLabelFor(capability: string | undefined): string {
  return CAPABILITY_SPECS.find((s) => s.id === capability)?.label ?? "Run device action";
}

/**
 * The capability block appended to a model prompt, split by what it costs.
 *
 * Reads and changes are listed separately because that split is the thing the
 * operator's authorisation rule turns on: it may run any read to clear a
 * roadblock, and only a change the strategist already authorised.
 */
export function capabilityBlock(): string {
  const line = (s: { id: string; help: string }) => `  ${s.id.padEnd(22)} — ${s.help}`;
  const reads = CAPABILITY_SPECS.filter((s) => isReadOnlyCapability(s.id)).map(line).join("\n");
  const writes = CAPABILITY_SPECS.filter((s) => !isReadOnlyCapability(s.id)).map(line).join("\n");
  return `READ-ONLY — these only look, and are always safe to run:\n${reads}\n\nCHANGES SOMETHING — these alter the machine or the directory:\n${writes}`;
}

/**
 * The step kind for a capability.
 *
 * The strategist emits a `kind` alongside each step, but that is a model reading
 * an untrusted ticket body, so it is a suggestion rather than a fact. The spec's
 * kind wins. Anything with no spec degrades to a user-visible message rather
 * than an unknown action.
 */
export function normalizeKind(k: string | undefined): "device" | "backend" | "reply" {
  if (k === "device" || k === "backend" || k === "reply") return k;
  return "reply";
}

/** The authoritative kind for a step, ignoring whatever the model claimed. */
export function kindForCapability(
  capability: string | undefined,
  proposed: string | undefined,
): "device" | "backend" | "reply" {
  return CAPABILITY_SPECS.find((s) => s.id === capability)?.kind ?? normalizeKind(proposed);
}
