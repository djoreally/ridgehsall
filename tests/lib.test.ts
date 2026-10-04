import { describe, expect, it } from "vitest";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "../lib/unsubscribe";
import { renderTemplate } from "../lib/templates";
import { parseCsv, mapRowsToContacts, guessMapping } from "../lib/csv";
import { generateApiKey, hashApiKey } from "../lib/apikey";

describe("unsubscribe tokens", () => {
  it("round-trips: sign then verify returns the contact id", () => {
    const token = signUnsubscribeToken("contact_123");
    expect(verifyUnsubscribeToken(token)).toBe("contact_123");
  });
  it("rejects tampered tokens", () => {
    const token = signUnsubscribeToken("contact_123");
    const [idPart, sig] = token.split(".");
    expect(verifyUnsubscribeToken(`${idPart}.${sig.slice(0, -2)}xx`)).toBeNull();
    expect(verifyUnsubscribeToken("not-a-token")).toBeNull();
    expect(verifyUnsubscribeToken("")).toBeNull();
  });
  it("a token for one contact does not verify as another", () => {
    const token = signUnsubscribeToken("contact_123");
    const idPart = token.split(".")[0];
    const other = signUnsubscribeToken("contact_999").split(".")[1];
    expect(verifyUnsubscribeToken(`${idPart}.${other}`)).toBeNull();
  });
});

describe("template rendering", () => {
  const ctx = {
    firstName: "Tyreese",
    lastName: "Burton",
    email: "t@example.com",
    unsubscribeUrl: "https://x.test/api/unsubscribe/abc",
  };
  it("replaces all supported tokens", () => {
    const out = renderTemplate("Hi {{firstName}} {{lastName}} ({{email}}) — {{unsubscribeUrl}}", ctx);
    expect(out).toBe("Hi Tyreese Burton (t@example.com) — https://x.test/api/unsubscribe/abc");
  });
  it("tolerates whitespace inside braces and leaves unknown tokens alone", () => {
    const out = renderTemplate("Hi {{ firstName }}, {{bogus}}", ctx);
    expect(out).toBe("Hi Tyreese, {{bogus}}");
  });
  it("renders empty string for missing names", () => {
    const out = renderTemplate("Hi {{firstName}}!", { ...ctx, firstName: null });
    expect(out).toBe("Hi !");
  });
});

describe("CSV parsing", () => {
  it("parses quoted fields with commas and escaped quotes", () => {
    const rows = parseCsv('email,name\n"a@b.com","Doe, John"\n"c@d.com","Say ""hi"""\n');
    expect(rows).toEqual([
      ["email", "name"],
      ["a@b.com", "Doe, John"],
      ["c@d.com", 'Say "hi"'],
    ]);
  });
  it("maps rows to contacts with passthrough custom fields", () => {
    const rows = parseCsv("email,first_name,last_name,vehicle\nt@x.com,Tyreese,Burton,F-150\n");
    const { contacts, errors } = mapRowsToContacts(rows, { email: 0, firstName: 1, lastName: 2 });
    expect(errors).toEqual([]);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      email: "t@x.com",
      firstName: "Tyreese",
      lastName: "Burton",
      fields: { vehicle: "F-150" },
    });
  });
  it("rejects rows with bad emails and reports row numbers", () => {
    const rows = parseCsv("email\nnot-an-email\nok@x.com\n");
    const { contacts, errors } = mapRowsToContacts(rows, { email: 0 });
    expect(contacts.map((c) => c.email)).toEqual(["ok@x.com"]);
    expect(errors).toEqual(["row 2: invalid or missing email"]);
  });
  it("guesses column mapping from common header names", () => {
    expect(guessMapping(["Email", "First Name", "Last_Name", "Phone"])).toEqual({
      email: 0,
      firstName: 1,
      lastName: 2,
    });
    expect(guessMapping(["phone"])).toBeNull();
  });
});

describe("API keys", () => {
  it("generates a unique key whose hash verifies", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.raw).not.toBe(b.raw);
    expect(a.raw.startsWith("rh_")).toBe(true);
    expect(hashApiKey(a.raw)).toBe(a.hash);
  });
});
