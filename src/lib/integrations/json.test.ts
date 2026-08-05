import { describe, it, expect } from "vitest";
import { extractJsonObject } from "./json";

// Every LLM response in this app is parsed through this brace matcher. If it
// mis-slices, a plan silently becomes a fallback.
describe("extractJsonObject", () => {
  it("returns null when there is no object", () => {
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject("")).toBeNull();
  });

  it("extracts a bare object", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it("strips prose before and after", () => {
    const out = extractJsonObject('Here you go:\n{"a":1}\nHope that helps!');
    expect(out).toBe('{"a":1}');
  });

  it("strips a markdown fence", () => {
    const out = extractJsonObject('```json\n{"a":1}\n```');
    expect(JSON.parse(out!)).toEqual({ a: 1 });
  });

  it("keeps nested objects intact", () => {
    const src = '{"plan":[{"params":{"app":"Excel"}}]}';
    expect(JSON.parse(extractJsonObject(`prefix ${src} suffix`)!)).toEqual(JSON.parse(src));
  });

  // The string-aware part: a brace inside a string value must not end the object.
  it("ignores braces inside string values", () => {
    const src = '{"description":"use {reporter_email} here","n":1}';
    expect(JSON.parse(extractJsonObject(src)!)).toEqual({
      description: "use {reporter_email} here",
      n: 1,
    });
  });

  it("ignores escaped quotes inside strings", () => {
    const src = '{"q":"she said \\"hi\\" }","n":2}';
    expect(JSON.parse(extractJsonObject(src)!)).toEqual({ q: 'she said "hi" }', n: 2 });
  });

  it("returns null on an unbalanced object rather than a truncated slice", () => {
    expect(extractJsonObject('{"a":1')).toBeNull();
  });
});
