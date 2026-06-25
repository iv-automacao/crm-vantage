// ============================================================
// POST /api/admin/accounts/[accountId]/reactivate
//
// Reativa uma conta suspensa ou reprovada. A condição
// .in('status', ['suspended','rejected']) garante que só
// contas nessas situações são afetadas — 404 caso contrário.
// Re-carimba approved_at e approved_by. Não altera account_type.
// Gate: requirePlatformAdmin + rate limit adminAction.
// ============================================================

import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform-admin";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    // Gate de plataforma — primeiro check, sempre.
    const admin = await requirePlatformAdmin();

    // Rate limit por admin — evita reativações em massa acidentais.
    const limit = await checkRateLimit(
      `adminAction:${admin.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { accountId } = await params;

    // Reativa somente contas suspensas ou reprovadas.
    // Não toca em account_type — mantém o tipo original da conta.
    const { data: updated, error } = await supabaseAdmin()
      .from("accounts")
      .update({
        status: "active",
        status_reason: null,
        approved_at: new Date().toISOString(),
        approved_by_user_id: admin.userId,
      })
      .eq("id", accountId)
      .in("status", ["suspended", "rejected"])
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("[POST /api/admin/accounts/reactivate] erro:", error);
      return NextResponse.json(
        { error: "Falha ao reativar conta" },
        { status: 500 },
      );
    }

    if (!updated) {
      // Conta não encontrada ou já estava ativa/pendente.
      return NextResponse.json(
        { error: "Conta não encontrada ou não está suspensa/reprovada" },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
