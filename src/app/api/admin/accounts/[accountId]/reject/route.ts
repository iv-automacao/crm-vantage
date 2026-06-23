// ============================================================
// POST /api/admin/accounts/[accountId]/reject
//
// Reprova uma conta. Aceita status 'pending', 'active' ou
// 'suspended' — não permite reprovar o que já está 'rejected'.
// Retorna 404 se a conta não existe ou já está rejeitada.
// Sem aviso por e-mail nesta v1.
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
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    const admin = await requirePlatformAdmin();

    // Rate limit por admin.
    const limit = checkRateLimit(
      `adminAction:${admin.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { accountId } = await params;
    const body = await request.json().catch(() => null);

    // Motivo opcional — trimado e limitado a 500 chars.
    const reason =
      typeof body?.reason === "string"
        ? body.reason.trim().slice(0, 500)
        : null;

    const { data: updated, error } = await supabaseAdmin()
      .from("accounts")
      .update({ status: "rejected", status_reason: reason })
      .eq("id", accountId)
      .in("status", ["pending", "active", "suspended"])
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("[POST /api/admin/accounts/reject] erro:", error);
      return NextResponse.json(
        { error: "Falha ao reprovar conta" },
        { status: 500 },
      );
    }

    if (!updated) {
      // Conta não encontrada ou já estava rejeitada.
      return NextResponse.json(
        { error: "Conta não encontrada" },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
