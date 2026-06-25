// ============================================================
// GET  /api/account/api-keys  — lista as chaves da conta (sem segredo)
// POST /api/account/api-keys  — cria uma chave nova (devolve a crua 1x)
//
// Gestão restrita a admin+ (Dono + Admins) via requireRole('admin').
// O segredo cru só existe na resposta do POST — depois disso, só o
// hash vive no banco (padrão dos convites em account_invitations).
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  generateApiKey,
  sanitizeScopes,
} from "@/lib/auth/api-keys";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

/** Máximo de chaves ativas por conta — barra acúmulo acidental. */
const MAX_ACTIVE_KEYS = 20;

export async function GET() {
  try {
    const ctx = await requireRole("admin");

    // RLS (api_keys_select, admin-only) já restringe à conta; o filtro
    // explícito é defesa em profundidade.
    const { data, error } = await ctx.supabase
      .from("api_keys")
      .select(
        "id, name, prefix, scopes, created_at, last_used_at, revoked_at, created_by_user_id",
      )
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[GET /api/account/api-keys] fetch error:", error);
      return NextResponse.json(
        { error: "Falha ao carregar chaves de API" },
        { status: 500 },
      );
    }

    return NextResponse.json({ keys: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");

    const limit = await checkRateLimit(
      `adminAction:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json(
        { error: "O nome da chave é obrigatório" },
        { status: 400 },
      );
    }
    if (name.length > 100) {
      return NextResponse.json(
        { error: "O nome da chave deve ter no máximo 100 caracteres" },
        { status: 400 },
      );
    }

    // Limite de chaves ativas por conta.
    const { count, error: countError } = await ctx.supabase
      .from("api_keys")
      .select("id", { count: "exact", head: true })
      .eq("account_id", ctx.accountId)
      .is("revoked_at", null);
    if (countError) {
      console.error("[POST /api/account/api-keys] count error:", countError);
      return NextResponse.json(
        { error: "Falha ao criar a chave" },
        { status: 500 },
      );
    }
    if ((count ?? 0) >= MAX_ACTIVE_KEYS) {
      return NextResponse.json(
        {
          error: `Limite de ${MAX_ACTIVE_KEYS} chaves ativas atingido. Revogue alguma antes de criar outra.`,
        },
        { status: 409 },
      );
    }

    const scopes = sanitizeScopes(body?.scopes);
    const { key, tokenHash, prefix } = generateApiKey();

    const { data, error } = await ctx.supabase
      .from("api_keys")
      .insert({
        account_id: ctx.accountId,
        name,
        token_hash: tokenHash,
        prefix,
        scopes,
        created_by_user_id: ctx.userId,
      })
      .select("id, name, prefix, scopes, created_at")
      .single();

    if (error || !data) {
      console.error("[POST /api/account/api-keys] insert error:", error);
      return NextResponse.json(
        { error: "Falha ao criar a chave" },
        { status: 500 },
      );
    }

    // `key` é devolvido UMA vez — o cliente copia agora ou perde.
    return NextResponse.json({ ...data, key }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
