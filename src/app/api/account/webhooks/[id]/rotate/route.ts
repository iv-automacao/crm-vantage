// ============================================================
// POST /api/account/webhooks/[id]/rotate — gera um novo secret pro endpoint
// (invalida o antigo). Devolve o secret UMA vez, como o POST de criação.
// Restrito a admin+ via requireRole('admin'); isolado por account_id + RLS.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { generateWebhookSecret } from "@/lib/webhooks/secret";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = await checkRateLimit(
      `adminAction:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    // Leitura assíncrona dos params — padrão Next 16.
    const { id } = await params;

    // Novo secret — devolvido UMA vez ao admin nesta resposta.
    const secret = generateWebhookSecret();

    // RLS + filtro por account_id garantem isolamento entre contas.
    const { data, error } = await ctx.supabase
      .from("webhook_endpoints")
      .update({ secret })
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("[POST /api/account/webhooks/[id]/rotate] error:", error);
      return NextResponse.json(
        { error: "Falha ao rotacionar o token" },
        { status: 500 },
      );
    }

    // maybeSingle() retorna null quando nenhuma linha corresponde (não encontrado
    // ou pertence a outra conta).
    if (!data) {
      return NextResponse.json(
        { error: "Endpoint não encontrado" },
        { status: 404 },
      );
    }

    // `secret` devolvido UMA vez — o admin copia agora ou rotaciona de novo.
    return NextResponse.json({ id: data.id, secret });
  } catch (err) {
    return toErrorResponse(err);
  }
}
