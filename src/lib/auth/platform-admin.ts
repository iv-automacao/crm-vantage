// ============================================================
// Super admin de plataforma (VANTAGE) — allowlist por env.
//
// Por que env e não tabela: o admin de plataforma fica IMUTÁVEL sem
// acesso de deploy. Uma tabela poderia ser escrita por um service-role
// vazado ou falha de RLS; o env não. Checagem 100% server-side; o
// e-mail (já verificado pelo Supabase) nunca decide nada no client.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { ForbiddenError, UnauthorizedError } from "./account";

/** Faz parse do CSV `PLATFORM_ADMIN_EMAILS` em um set normalizado. */
export function parsePlatformAdminEmails(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
}

/** Versão pura/injetável (testável sem env). */
export function isPlatformAdminWith(
  allow: Set<string>,
  email: string | null | undefined,
): boolean {
  if (!email) return false;
  return allow.has(email.trim().toLowerCase());
}

/** Lê a allowlist do ambiente e checa o e-mail. */
export function isPlatformAdmin(email: string | null | undefined): boolean {
  return isPlatformAdminWith(
    parsePlatformAdminEmails(process.env.PLATFORM_ADMIN_EMAILS),
    email,
  );
}

/**
 * Exige que o caller seja super admin de plataforma. Lança
 * `UnauthorizedError` (sem sessão) ou `ForbiddenError` (não é admin /
 * e-mail não confirmado). Retorna o client SSR + identidade.
 */
export async function requirePlatformAdmin(): Promise<{
  supabase: SupabaseClient;
  userId: string;
  email: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) throw new UnauthorizedError();

  // E-mail tem que estar confirmado — senão alguém poderia cadastrar
  // um e-mail da allowlist sem provar posse e cair como admin.
  if (!user.email || !user.email_confirmed_at) {
    throw new ForbiddenError("Acesso restrito");
  }
  if (!isPlatformAdmin(user.email)) {
    throw new ForbiddenError("Acesso restrito");
  }

  return { supabase, userId: user.id, email: user.email };
}
