// ============================================================
// GET  /api/account/webhooks  — lista endpoints da conta (sem secret)
// POST /api/account/webhooks  — cria endpoint novo (devolve secret 1x)
//
// Restrito a admin+ via requireRole('admin').
// O secret cru só existe na resposta do POST — depois disso, só o
// valor em `webhook_endpoints.secret` vive no banco (usado pra assinar
// payloads na entrega). Espelha o padrão de /api/account/api-keys.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { generateWebhookSecret, isValidWebhookUrl } from "@/lib/webhooks/secret";

/** Máximo de endpoints ativos por conta — evita acúmulo acidental. */
const MAX_ACTIVE_ENDPOINTS = 10;

export async function GET() {
  try {
    const ctx = await requireRole("admin");

    // RLS garante isolamento por conta; filtro explícito é defesa em profundidade.
    // O campo `secret` não é selecionado — nunca retornar pós-criação.
    const { data, error } = await ctx.supabase
      .from("webhook_endpoints")
      .select("id, url, description, is_active, created_at")
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[GET /api/account/webhooks] fetch error:", error);
      return NextResponse.json(
        { error: "Falha ao carregar endpoints de webhook" },
        { status: 500 },
      );
    }

    return NextResponse.json({ endpoints: data ?? [] });
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
    const url = typeof body?.url === "string" ? body.url.trim() : "";

    // Validação da URL: obrigatória, deve ser http(s).
    if (!isValidWebhookUrl(url)) {
      return NextResponse.json(
        { error: "URL inválida — informe uma URL começando com http:// ou https://" },
        { status: 400 },
      );
    }

    const description =
      typeof body?.description === "string" ? body.description.trim() || null : null;

    // Limite de endpoints ativos por conta.
    const { count, error: countError } = await ctx.supabase
      .from("webhook_endpoints")
      .select("id", { count: "exact", head: true })
      .eq("account_id", ctx.accountId)
      .eq("is_active", true);

    if (countError) {
      console.error("[POST /api/account/webhooks] count error:", countError);
      return NextResponse.json(
        { error: "Falha ao criar o endpoint" },
        { status: 500 },
      );
    }

    if ((count ?? 0) >= MAX_ACTIVE_ENDPOINTS) {
      return NextResponse.json(
        {
          error: `Limite de ${MAX_ACTIVE_ENDPOINTS} endpoints ativos atingido. Desative algum antes de criar outro.`,
        },
        { status: 409 },
      );
    }

    // Secret gerado aqui — devolvido UMA vez ao admin na resposta.
    const secret = generateWebhookSecret();

    const { data, error } = await ctx.supabase
      .from("webhook_endpoints")
      .insert({
        account_id: ctx.accountId,
        url,
        secret,
        description,
        created_by_user_id: ctx.userId,
      })
      .select("id, url, description, is_active, created_at")
      .single();

    if (error || !data) {
      console.error("[POST /api/account/webhooks] insert error:", error);
      return NextResponse.json(
        { error: "Falha ao criar o endpoint" },
        { status: 500 },
      );
    }

    // `secret` devolvido UMA vez — o admin copia agora ou perde.
    return NextResponse.json({ ...data, secret }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
