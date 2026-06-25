import { describe, expect, it } from "vitest";
import {
  generateWebhookSecret,
  isValidWebhookUrl,
  WEBHOOK_SECRET_PREFIX,
} from "./secret";

describe("generateWebhookSecret", () => {
  it("começa com o prefixo correto", () => {
    const secret = generateWebhookSecret();
    expect(secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
  });

  it("gera valores distintos em cada chamada", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).not.toBe(b);
  });

  it("tem comprimento mínimo esperado (prefixo + 43 chars base64url)", () => {
    const secret = generateWebhookSecret();
    // WEBHOOK_SECRET_PREFIX.length + base64url(32 bytes) = 6 + 43 = 49
    expect(secret.length).toBeGreaterThan(40);
    const payload = secret.slice(WEBHOOK_SECRET_PREFIX.length);
    expect(payload.length).toBeGreaterThanOrEqual(43);
  });

  it("payload só contém caracteres base64url válidos", () => {
    const secret = generateWebhookSecret();
    const payload = secret.slice(WEBHOOK_SECRET_PREFIX.length);
    // base64url: A-Z a-z 0-9 - _  (sem = de padding no Node por padrão)
    expect(/^[A-Za-z0-9\-_]+$/.test(payload)).toBe(true);
  });
});

describe("isValidWebhookUrl", () => {
  it("aceita URLs https://", () => {
    expect(isValidWebhookUrl("https://example.com/hook")).toBe(true);
    expect(isValidWebhookUrl("https://meu-servidor.com.br/webhook")).toBe(true);
  });

  it("aceita URLs http://", () => {
    expect(isValidWebhookUrl("http://localhost:5678/webhook")).toBe(true);
  });

  it("rejeita string vazia", () => {
    expect(isValidWebhookUrl("")).toBe(false);
  });

  it("rejeita string com espaços apenas", () => {
    expect(isValidWebhookUrl("   ")).toBe(false);
  });

  it("rejeita outros protocolos", () => {
    expect(isValidWebhookUrl("ftp://example.com")).toBe(false);
    expect(isValidWebhookUrl("ws://example.com")).toBe(false);
    expect(isValidWebhookUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejeita valores não-string", () => {
    expect(isValidWebhookUrl(null)).toBe(false);
    expect(isValidWebhookUrl(undefined)).toBe(false);
    expect(isValidWebhookUrl(42)).toBe(false);
    expect(isValidWebhookUrl({})).toBe(false);
  });
});
