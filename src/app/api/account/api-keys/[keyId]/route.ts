// ============================================================
// DELETE /api/account/api-keys/[keyId] — revoga uma chave.
//
// Revogação = setar `revoked_at` (soft, mantém a linha pra auditoria
// e pra exibir "revogada em…" na UI). Admin+ apenas. O endpoint
// externo só aceita chaves com `revoked_at IS NULL`, então a revogação
// tem efeito imediato.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ keyId: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `adminAction:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { keyId } = await params;

    // RLS (admin-only) + filtro explícito por account_id garantem que
    // não dá pra revogar chave de outra conta. `.is('revoked_at', null)`
    // torna a operação idempotente e detecta "não encontrada / já
    // revogada" pra retornar 404.
    const { data, error } = await ctx.supabase
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", keyId)
      .eq("account_id", ctx.accountId)
      .is("revoked_at", null)
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("[DELETE /api/account/api-keys/[keyId]] error:", error);
      return NextResponse.json(
        { error: "Falha ao revogar a chave" },
        { status: 500 },
      );
    }
    if (!data) {
      return NextResponse.json(
        { error: "Chave não encontrada ou já revogada" },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
