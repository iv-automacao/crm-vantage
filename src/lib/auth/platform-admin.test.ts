import { describe, expect, it } from "vitest";
import { parsePlatformAdminEmails, isPlatformAdminWith } from "./platform-admin";

describe("parsePlatformAdminEmails", () => {
  it("faz split por vírgula, normaliza lowercase e trim", () => {
    const set = parsePlatformAdminEmails(" Iago@Vantage.com , dev@vantage.com ");
    expect(set.has("iago@vantage.com")).toBe(true);
    expect(set.has("dev@vantage.com")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("ignora entradas vazias e retorna set vazio pra undefined", () => {
    expect(parsePlatformAdminEmails(undefined).size).toBe(0);
    expect(parsePlatformAdminEmails("").size).toBe(0);
    expect(parsePlatformAdminEmails("a@b.com,,").size).toBe(1);
  });
});

describe("isPlatformAdminWith", () => {
  const allow = parsePlatformAdminEmails("iago@vantage.com");
  it("é case-insensitive", () => {
    expect(isPlatformAdminWith(allow, "IAGO@vantage.com")).toBe(true);
  });
  it("rejeita e-mail fora da lista, null e vazio", () => {
    expect(isPlatformAdminWith(allow, "outro@x.com")).toBe(false);
    expect(isPlatformAdminWith(allow, null)).toBe(false);
    expect(isPlatformAdminWith(allow, "")).toBe(false);
  });
});
