import { describe, it, expect } from "vitest";
import {
  CHAT_INTENTS,
  COMMUNICATOR_PROMPT,
  CommunicationMoment,
  momentInstruction,
} from "./desk";

const MOMENTS: CommunicationMoment[] = [
  "intake",
  "working",
  "heartbeat",
  "resolution",
  "rungCheck",
  "handoff",
  "chat",
];

describe("the desk prompt", () => {
  // These two rules read as opposites and are not. Plain English is the default;
  // a direct question is the ask that turns the detail on. Deleting either one
  // leaves the other meaning something it was never supposed to mean — drop the
  // disclosure rule and the desk dumps IPs at people who did not ask; drop the
  // question rule and it withholds them from people who did.
  it("keeps progressive disclosure and the direct-question rule together", () => {
    expect(COMMUNICATOR_PROMPT).toContain("PROGRESSIVE DISCLOSURE");
    expect(COMMUNICATOR_PROMPT).toMatch(/asked a direct question/i);
    expect(COMMUNICATOR_PROMPT).toMatch(/exact value from the evidence, first/i);
  });

  it("still holds the honesty rules above tone", () => {
    expect(COMMUNICATOR_PROMPT).toContain("HONESTY RULES");
    expect(COMMUNICATOR_PROMPT).toMatch(/NO EFFECT/);
  });

  // The chat moment needs JSON back. A prompt that hard-asserts "output only the
  // message text" would contradict its own moment instruction, and the model
  // resolves that by ignoring one of them.
  it("lets a moment ask for a shape other than plain text", () => {
    expect(COMMUNICATOR_PROMPT).toMatch(/unless the MOMENT instruction below asks for a different shape/i);
  });

  it("has an instruction for every moment", () => {
    for (const moment of MOMENTS) {
      expect(momentInstruction(moment).length, moment).toBeGreaterThan(40);
    }
  });
});

describe("the chat moment", () => {
  const chat = momentInstruction("chat");

  it("asks for the reply and the intent as one JSON object", () => {
    expect(chat).toContain('"reply"');
    expect(chat).toContain('"intent"');
    for (const intent of CHAT_INTENTS) expect(chat, intent).toContain(intent);
  });

  it("forbids the bare confirmation question that this change exists to kill", () => {
    expect(chat).toMatch(/never end on a bare "is it fixed\?"/i);
  });

  it("tells it not to repeat itself, since it now has the transcript", () => {
    expect(chat).toMatch(/do not repeat/i);
  });
});

describe("the resolution moment", () => {
  const resolution = momentInstruction("resolution");

  // The graph used to post "Is the issue resolved? Reply yes or no" as its own
  // message underneath this one. That line is gone; this instruction is what
  // replaced it, and the Yes/No buttons are the mechanism.
  it("closes on a specific thing to try, not a generic status check", () => {
    expect(resolution).toMatch(/is it fixed\?/i);
    expect(resolution).toMatch(/buttons/i);
  });
});

// The ladder pauses on the same ticket status and the same Yes/No buttons as a
// finished ticket, so the MESSAGE is the only thing telling the employee which
// of the two this is. Told as a resolution, an honest "still broken" reads like
// a relapse instead of the ladder working.
describe("the rung-check moment", () => {
  const rung = momentInstruction("rungCheck");

  it("does not claim the work is finished", () => {
    expect(rung).toMatch(/never imply the ticket is finished/i);
    expect(rung).toMatch(/one attempt/i);
  });

  it("tells them a 'no' is expected and there is more to try", () => {
    expect(rung).toMatch(/other things lined up|more.*to try/i);
  });

  it("still asks for the specific observation rather than a bare yes/no", () => {
    expect(rung).toMatch(/buttons/i);
  });
});
