// ============================================================
// PATCH  /api/account/webhooks/[id] — ativa/desativa endpoint
// DELETE /api/account/webhooks/[id] — remove endpoint permanentemente
//
// Restrito a admin+ via requireRole('admin').
// Padrão de leitura do parâmetro `id` copiado de
// `src/app/api/account/members/[userId]/route.ts` (Next 16 async params).
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `adminAction:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    // Leitura assíncrona dos params — padrão Next 16.
    const { id } = await params;

    const body = await request.json().catch(() => null);

    // Validação de is_active: obrigatório e booleano.
    if (typeof body?.is_active !== "boolean") {
      return NextResponse.json(
        { error: "'is_active' deve ser um boolean" },
        { status: 400 },
      );
    }

    const { is_active } = body as { is_active: boolean };

    // RLS + filtro por account_id garantem isolamento entre contas.
    const { data, error } = await ctx.supabase
      .from("webhook_endpoints")
      .update({ is_active })
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .select("id, is_active")
      .maybeSingle();

    if (error) {
      console.error("[PATCH /api/account/webhooks/[id]] error:", error);
      return NextResponse.json(
        { error: "Falha ao atualizar o endpoint" },
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

    return NextResponse.json(data);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `adminAction:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    // Leitura assíncrona dos params — padrão Next 16.
    const { id } = await params;

    // Deleção direta — RLS + filtro por account_id garantem isolamento.
    // Não checamos "encontrado ou não": remoção é idempotente por design.
    const { error } = await ctx.supabase
      .from("webhook_endpoints")
      .delete()
      .eq("id", id)
      .eq("account_id", ctx.accountId);

    if (error) {
      console.error("[DELETE /api/account/webhooks/[id]] error:", error);
      return NextResponse.json(
        { error: "Falha ao remover o endpoint" },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
