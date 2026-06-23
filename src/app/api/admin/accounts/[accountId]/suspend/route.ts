// ============================================================
// POST /api/admin/accounts/[accountId]/suspend
//
// Suspende uma conta ativa. A condição .eq('status','active')
// garante idempotência — se a conta já estava suspensa,
// reprovada ou não existe, retorna 404.
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

    // Rate limit por admin — evita ações em massa acidentais.
    const limit = checkRateLimit(
      `adminAction:${admin.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { accountId } = await params;

    // Atualiza somente se a conta está ativa → transição válida.
    const { data: updated, error } = await supabaseAdmin()
      .from("accounts")
      .update({ status: "suspended" })
      .eq("id", accountId)
      .eq("status", "active")
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("[POST /api/admin/accounts/suspend] erro:", error);
      return NextResponse.json(
        { error: "Falha ao suspender conta" },
        { status: 500 },
      );
    }

    if (!updated) {
      // Conta não encontrada ou já não estava ativa.
      return NextResponse.json(
        { error: "Conta não encontrada ou não está ativa" },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
