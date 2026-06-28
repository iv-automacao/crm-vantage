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
  it("aceita URLs https:// públicas", () => {
    expect(isValidWebhookUrl("https://example.com/hook")).toBe(true);
    expect(isValidWebhookUrl("https://hooks.vantagemanaus.com.br/webhook/x")).toBe(true);
  });

  it("aceita http:// pra host público (incluindo IP público literal)", () => {
    expect(isValidWebhookUrl("http://example.com/webhook")).toBe(true);
    expect(isValidWebhookUrl("http://203.0.113.5/webhook")).toBe(true);
  });

  it("rejeita string vazia / só espaços", () => {
    expect(isValidWebhookUrl("")).toBe(false);
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

  it("rejeita URL não-parseável", () => {
    expect(isValidWebhookUrl("http://")).toBe(false);
    expect(isValidWebhookUrl("not a url")).toBe(false);
  });

  it("bloqueia localhost e domínios internos (SSRF)", () => {
    expect(isValidWebhookUrl("http://localhost:5678/webhook")).toBe(false);
    expect(isValidWebhookUrl("http://foo.local/x")).toBe(false);
    expect(isValidWebhookUrl("http://api.localhost/x")).toBe(false);
  });

  it("bloqueia IPv4 privado / loopback / link-local / metadata (SSRF)", () => {
    expect(isValidWebhookUrl("http://127.0.0.1/x")).toBe(false);
    expect(isValidWebhookUrl("https://10.1.2.3/x")).toBe(false);
    expect(isValidWebhookUrl("http://192.168.0.1/x")).toBe(false);
    expect(isValidWebhookUrl("http://172.16.5.4/x")).toBe(false);
    expect(isValidWebhookUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isValidWebhookUrl("http://0.0.0.0/x")).toBe(false);
  });

  it("NÃO bloqueia IPv4 público fora das faixas privadas", () => {
    expect(isValidWebhookUrl("http://172.32.5.4/x")).toBe(true); // 172.32 não é privado
    expect(isValidWebhookUrl("http://8.8.8.8/x")).toBe(true);
  });

  it("bloqueia IPv6 loopback / ULA / link-local / unspecified (SSRF)", () => {
    expect(isValidWebhookUrl("http://[::1]/x")).toBe(false);
    expect(isValidWebhookUrl("http://[fc00::1]/x")).toBe(false);
    expect(isValidWebhookUrl("http://[fe80::1]/x")).toBe(false);
    expect(isValidWebhookUrl("http://[::]/x")).toBe(false);
  });

  it("bloqueia IPv4-mapped IPv6 (bypass SSRF ::ffff:)", () => {
    expect(isValidWebhookUrl("http://[::ffff:127.0.0.1]/x")).toBe(false);
    expect(isValidWebhookUrl("http://[::ffff:10.0.0.1]/x")).toBe(false);
  });
});
