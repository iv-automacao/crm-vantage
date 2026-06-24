import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX,
  displayPrefix,
  extractBearerToken,
  generateApiKey,
  hashApiKey,
  sanitizeScopes,
  SCOPE_CONTACTS_WRITE,
  SCOPE_MESSAGES_SEND,
} from "./api-keys";

describe("generateApiKey", () => {
  it("produces a key with the VANTAGE prefix and a matching hash", () => {
    const { key, tokenHash, prefix } = generateApiKey();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    // hash devolvido bate com o hash determinístico da chave crua
    expect(tokenHash).toBe(hashApiKey(key));
    // prefixo de exibição também começa com o prefixo fixo
    expect(prefix.startsWith(API_KEY_PREFIX)).toBe(true);
  });

  it("generates distinct keys on each call", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).not.toBe(b.key);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  it("has at least 256 bits of entropy in the secret part", () => {
    const { key } = generateApiKey();
    const secret = key.slice(API_KEY_PREFIX.length);
    // base64url de 32 bytes = 43 chars
    expect(secret.length).toBeGreaterThanOrEqual(43);
  });
});

describe("hashApiKey", () => {
  it("is deterministic and matches a raw SHA-256", () => {
    const key = "vtg_sk_exemplo";
    const expected = crypto.createHash("sha256").update(key).digest("hex");
    expect(hashApiKey(key)).toBe(expected);
    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  it("produces different hashes for different inputs", () => {
    expect(hashApiKey("a")).not.toBe(hashApiKey("b"));
  });
});

describe("displayPrefix", () => {
  it("masks the middle of the secret", () => {
    const key = API_KEY_PREFIX + "abcd1234567890wxyz";
    const shown = displayPrefix(key);
    expect(shown).toBe(`${API_KEY_PREFIX}abcd…wxyz`);
    // não vaza o miolo
    expect(shown).not.toContain("1234567890");
  });
});

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed header", () => {
    expect(extractBearerToken("Bearer vtg_sk_abc")).toBe("vtg_sk_abc");
  });

  it("is case-insensitive on the scheme and trims whitespace", () => {
    expect(extractBearerToken("bearer   vtg_sk_xyz  ")).toBe("vtg_sk_xyz");
  });

  it("returns null for missing or malformed headers", () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
    expect(extractBearerToken("Basic abc")).toBeNull();
    expect(extractBearerToken("vtg_sk_no_scheme")).toBeNull();
  });
});

describe("sanitizeScopes", () => {
  it("mantém só scopes válidos", () => {
    expect(sanitizeScopes(["contacts:write", "inventado:x"])).toEqual([SCOPE_CONTACTS_WRITE]);
  });
  it("default messages:send quando vazio/ inválido", () => {
    expect(sanitizeScopes([])).toEqual([SCOPE_MESSAGES_SEND]);
    expect(sanitizeScopes(undefined)).toEqual([SCOPE_MESSAGES_SEND]);
    expect(sanitizeScopes("x")).toEqual([SCOPE_MESSAGES_SEND]);
  });
  it("dedup", () => {
    expect(sanitizeScopes(["contacts:read", "contacts:read"])).toEqual(["contacts:read"]);
  });
});
