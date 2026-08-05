import { describe, it, expect } from "vitest";
import { isAutoPromoted, recordCleanExecution, PROMOTION_THRESHOLD } from "./governance";

const approver = { name: "Morgan Reilly", email: "morgan@acme.test" };

// Precedent lives in a globalThis-backed store, so every test uses its own
// workspace id rather than trying to reset shared state.
let n = 0;
const ws = () => `test-ws-${++n}`;

describe("capability promotion", () => {
  it("does not promote before the threshold", () => {
    const w = ws();
    for (let i = 1; i < PROMOTION_THRESHOLD; i++) {
      recordCleanExecution(w, "ad.unlock_account", approver);
      expect(isAutoPromoted(w, "ad.unlock_account")).toBe(false);
    }
  });

  it("promotes on exactly the threshold approval", () => {
    const w = ws();
    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      recordCleanExecution(w, "ad.unlock_account", approver);
    }
    expect(isAutoPromoted(w, "ad.unlock_account")).toBe(true);
  });

  it("scopes precedent per workspace", () => {
    const a = ws();
    const b = ws();
    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      recordCleanExecution(a, "ad.unlock_account", approver);
    }
    expect(isAutoPromoted(a, "ad.unlock_account")).toBe(true);
    expect(isAutoPromoted(b, "ad.unlock_account")).toBe(false);
  });

  it("scopes precedent per capability", () => {
    const w = ws();
    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      recordCleanExecution(w, "ad.unlock_account", approver);
    }
    expect(isAutoPromoted(w, "mdm.push_vpn_config")).toBe(false);
  });

  it("keeps a capability promoted once it crosses the threshold", () => {
    const w = ws();
    for (let i = 0; i < PROMOTION_THRESHOLD + 3; i++) {
      recordCleanExecution(w, "ad.unlock_account", approver);
    }
    expect(isAutoPromoted(w, "ad.unlock_account")).toBe(true);
  });
});
