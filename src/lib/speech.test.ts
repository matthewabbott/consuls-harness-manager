import { describe, expect, it } from "vitest";

import { continuing, heard, Resumes, spoken, transcript } from "./speech";

const res = (...parts: [string, boolean][]) => parts.map(([t, isFinal]) => ({ isFinal, 0: { transcript: t } }));

describe("transcript", () => {
  it("puts the final segments before the interim tail", () => {
    expect(transcript(res(["Hello there", true], ["how are", false]))).toEqual({ final: "Hello there", interim: "how are" });
  });
  it("joins segments with a space only where there isn't one", () => {
    expect(transcript(res(["one", true], ["two", true], [" three", true])).final).toBe("one two three");
  });
  it("rebuilds from the results, so a repeated event doesn't double words", () => {
    const r = res(["fix the", true], ["bug", false]);
    transcript(r);
    expect(transcript(r)).toEqual({ final: "fix the", interim: "bug" });
  });
  it("doesn't capitalize a segment that carries on a sentence", () => {
    expect(transcript(res(["Fix the bug", true], ["Then run the tests.", true], ["Thanks", false]))).toEqual({
      final: "Fix the bug then run the tests.",
      interim: "Thanks",
    });
  });
  it("follows a result list that shrinks", () => {
    expect(transcript(res(["fix", false]))).toEqual({ final: "", interim: "fix" });
  });
});

describe("spoken", () => {
  it("turns spoken punctuation into marks, capitalizing after a sentence", () => {
    expect(spoken("hello comma world period how are you question mark")).toBe("hello, world. How are you?");
  });
  it("takes new lines and paragraphs, eating the spaces around them", () => {
    expect(spoken("first new line second New paragraph third")).toBe("first\nSecond\n\nThird");
  });
  it("leaves words that only contain the commands alone", () => {
    expect(spoken("periodic semicolons, a colonel")).toBe("periodic semicolons, a colonel");
    expect(spoken("a semicolon")).toBe("a;");
  });
  it("leaves the recognizer's own punctuation as it is", () => {
    expect(spoken("Done. Next")).toBe("Done. Next");
  });
});

describe("continuing", () => {
  it("lowercases the first word mid-sentence, but not I or acronyms", () => {
    expect(continuing("please ", "Fix it")).toBe("fix it");
    expect(continuing("please", "I think")).toBe("I think");
    expect(continuing("check the", "API docs")).toBe("API docs");
  });
  it("keeps the capital at the start, after a sentence or a line", () => {
    expect(continuing("", "Fix it")).toBe("Fix it");
    expect(continuing("Done. ", "Fix it")).toBe("Fix it");
    expect(continuing("Done\n", "Fix it")).toBe("Fix it");
  });
});

describe("heard", () => {
  it("marks where the final text ends, after punctuation", () => {
    expect(heard(res(["hello period", true], ["how", false]))).toEqual({ text: "hello. How", finalLength: 6 });
  });
  it("counts punctuation finished by the interim tail as not final", () => {
    expect(heard(res(["hello", true], ["comma", false]))).toEqual({ text: "hello,", finalLength: 5 });
  });
});

describe("Resumes", () => {
  it("spaces an utterance Safari appended after a pause, for as long as the text before stays", () => {
    const r = new Resumes();
    for (const t of ["Fix the", "Fix the bug", "Fix the bugThen", "Fix the bugThen run it"]) r.note(t);
    expect(r.apply("Fix the bugThen run it")).toBe("Fix the bug then run it");
    expect(r.apply("Fix the bugThen run it now")).toBe("Fix the bug then run it now");
    // The text before it changed: no longer a known spot.
    expect(r.apply("Fix the bagThen")).toBe("Fix the bagThen");
  });
  it("leaves ordinary growth alone", () => {
    const r = new Resumes();
    for (const t of ["Open", "Open the", "Open the iPhone", "Open the iPhone app."]) r.note(t);
    expect(r.apply("Open the iPhone app.")).toBe("Open the iPhone app.");
  });
  it("works through heard()", () => {
    const r = new Resumes();
    const one = res(["Hello there", false]);
    const two = res(["Hello thereHow are you", false]);
    r.note("Hello there");
    r.note("Hello thereHow are you");
    expect(heard(one, r).text).toBe("Hello there");
    expect(heard(two, r).text).toBe("Hello there how are you");
  });
});
