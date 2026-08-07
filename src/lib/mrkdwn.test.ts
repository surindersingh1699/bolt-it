import { describe, it, expect } from "vitest";
import { parseMrkdwn } from "./mrkdwn";

const flat = (s: string) => parseMrkdwn(s).map((x) => x.text).join("");

describe("parseMrkdwn", () => {
  it("leaves plain text alone", () => {
    expect(parseMrkdwn("no markup here")).toEqual([{ kind: "text", text: "no markup here" }]);
  });

  it("reads the three inline spans the agent emits", () => {
    expect(parseMrkdwn("*bold*")).toEqual([{ kind: "bold", text: "bold" }]);
    expect(parseMrkdwn("_italic_")).toEqual([{ kind: "italic", text: "italic" }]);
    expect(parseMrkdwn("`code`")).toEqual([{ kind: "code", text: "code" }]);
  });

  it("keeps the surrounding text around a span", () => {
    expect(parseMrkdwn("see _Ticket T-6970_ now")).toEqual([
      { kind: "text", text: "see " },
      { kind: "italic", text: "Ticket T-6970" },
      { kind: "text", text: " now" },
    ]);
  });

  it("handles several spans in one line", () => {
    expect(parseMrkdwn("*a* and _b_ and `c`").map((s) => s.kind)).toEqual([
      "bold",
      "text",
      "italic",
      "text",
      "code",
    ]);
  });

  // The failure that matters: a stray marker must read as itself, not eat the line.
  it("leaves unmatched markers literal", () => {
    expect(parseMrkdwn("5 * 3 = 15")).toEqual([{ kind: "text", text: "5 * 3 = 15" }]);
    expect(parseMrkdwn("trailing *")).toEqual([{ kind: "text", text: "trailing *" }]);
  });

  // The agent quotes identifiers straight off the machine; underscores inside
  // one are part of the name, not italics.
  it("does not italicise inside an identifier", () => {
    expect(parseMrkdwn("snake_case_name")).toEqual([{ kind: "text", text: "snake_case_name" }]);
    expect(parseMrkdwn("HKLM\\SOFTWARE\\my_app_key")).toEqual([
      { kind: "text", text: "HKLM\\SOFTWARE\\my_app_key" },
    ]);
  });

  it("never drops characters outside markers", () => {
    for (const s of ["", "plain", "a *b* c", "trailing *", "_x_ _y_"]) {
      expect(flat(s).length).toBeLessThanOrEqual(s.length);
    }
  });

  it("does not span across a newline", () => {
    expect(parseMrkdwn("_open\nclose_")).toEqual([{ kind: "text", text: "_open\nclose_" }]);
  });
});
