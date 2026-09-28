import { describe, expect, it } from "vitest";

import { makeRedactor, maskOf } from "./redact";

const secrets = { literals: ["consulear", "Matthew Abbott", "DESKTOP-J0PIMAK", "me@example.com"], machines: [] as string[][] };

describe("recording mode redaction", () => {
  it("masks personal strings, keeping lengths", () => {
    const r = makeRedactor(secrets, "ui");
    expect(r.text("consulear@spark2:~$ ls /home/consulear")).toBe("•••••••••@spark2:~$ ls /home/•••••••••");
    expect(r.text("C:/Users/Matthew Abbott/code")).toBe("C:/Users/••••••••••••••/code");
    expect(r.text("matthew abbott")).toBe("••••••••••••••"); // case-insensitive
    expect(r.text("on desktop-j0pimak")).toBe("on •••••••••••••••");
    expect(r.text("nothing here")).toBe("nothing here");
  });

  it("masks e-mails, tailnet names and IPs generically", () => {
    const r = makeRedactor({ literals: [], machines: [] }, "ui");
    expect(r.text("tailnet someone@gmail.com")).toBe(`tailnet ${maskOf("someone@gmail.com")}`);
    expect(r.text("ssh spark-d683.tail1234.ts.net")).toBe(`ssh ${maskOf("spark-d683.tail1234.ts.net")}`);
    expect(r.text("at 100.101.2.3:22")).toBe(`at ${maskOf("100.101.2.3")}:22`);
    expect(r.text("fd7a:115c:a1e0::abcd")).toBe(maskOf("fd7a:115c:a1e0::abcd"));
    expect(r.text("ssh to 143.198.13.71")).toBe(`ssh to ${maskOf("143.198.13.71")}`);
    expect(r.text("root@143.198.13.71")).toBe(maskOf("root@143.198.13.71")); // reads as an address
    // Not addresses, or harmless ones.
    expect(r.text("v1.2.3 and 127.0.0.1 and 0.0.0.0 and 1.2.3.4.5 and 300.1.1.1")).toBe("v1.2.3 and 127.0.0.1 and 0.0.0.0 and 1.2.3.4.5 and 300.1.1.1");
  });

  it("aliases machine names in the UI and masks them in terminals", () => {
    const s = { literals: ["consulear"], machines: [["spark-d683"], ["spark2", "Spark2-Box"]] };
    expect(makeRedactor(s, "ui").text("spark2 and spark-d683, spark2-box")).toBe("machine 2 and machine 1, machine 2");
    expect(makeRedactor(s, "tile").text("consulear@spark2")).toBe("•••••••••@••••••");
  });

  it("keeps terminal cell widths for wide characters", () => {
    const r = makeRedactor({ literals: ["名前です"], machines: [] }, "stream");
    expect(r.text("x名前ですy")).toBe("x••••••••y");
    expect(makeRedactor({ literals: ["名前です"], machines: [] }, "tile").text("x名前ですy")).toBe("x••••y");
  });

  it("knows what might still be arriving", () => {
    const r = makeRedactor(secrets, "stream");
    expect(r.hold("hello consu")).toBe(5);
    expect(r.hold("hello there!")).toBe(0);
    expect(r.hold("hello world")).toBe(1); // "d" could start DESKTOP-…
    expect(r.hold("ping 100.101")).toBe(7);
    expect(r.hold("mail me@exa")).toBe(6);
    expect(r.spans("a consulear b")).toEqual([[2, 11]]);
  });
});
