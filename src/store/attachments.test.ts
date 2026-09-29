import { describe, expect, it } from "vitest";

import { pastedPath } from "./attachments";

describe("pasted image paths", () => {
  it("quotes only what agents would split", () => {
    expect(pastedPath("C:/Users/A B/AppData/Local/consuls/pastes/p.png")).toBe("C:/Users/A B/AppData/Local/consuls/pastes/p.png");
    expect(pastedPath("/home/u/.cache/consuls/pastes/p.png")).toBe("/home/u/.cache/consuls/pastes/p.png");
    expect(pastedPath("/Users/a b/it's.png")).toBe(`'/Users/a b/it'\\''s.png'`);
  });
});
