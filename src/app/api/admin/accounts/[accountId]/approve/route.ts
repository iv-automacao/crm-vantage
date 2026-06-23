// ============================================================
// POST /api/admin/accounts/[accountId]/approve
//
// Aprova uma conta pendente: status='active', carimba account_type,
// approved_at e approved_by_user_id. Idempotente: a condição
// .eq('status','pending') garante que só age uma vez — se já foi
// aprovada/reprovada, retorna { success: true, already: true }.
//
// O aviso por e-mail é disparado via after() (fire-and-forget
// pós-resposta) e SOMENTE se uma linha foi realmente atualizada e
// o owner tem e-mail cadastrado.
// ============================================================

import { NextResponse, after } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform-admin";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { notifyAccountApproved } from "@/lib/notify/approval";

const VALID_TYPES = ["ia_client", "self_serve", "internal"] as const;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    const admin = await requirePlatformAdmin();

    // Rate limit por admin — evita disparos em massa acidentais.
    const limit = checkRateLimit(
      `adminAction:${admin.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { accountId } = await params;
    const body = await request.json().catch(() => null);
    const accountType =
      typeof body?.account_type === "string" ? body.account_type : "";

    if (!(VALID_TYPES as readonly string[]).includes(accountType)) {
      return NextResponse.json(
        {
          error:
            "account_type inválido — deve ser: ia_client | self_serve | internal",
        },
        { status: 400 },
      );
    }

    const db = supabaseAdmin();

    // Atualiza só se a conta ainda está 'pending' → idempotência.
    const { data: updated, error } = await db
      .from("accounts")
      .update({
        status: "active",
        account_type: accountType,
        approved_at: new Date().toISOString(),
        approved_by_user_id: admin.userId,
        status_reason: null,
      })
      .eq("id", accountId)
      .eq("status", "pending")
      .select("id, owner_user_id")
      .maybeSingle();

    if (error) {
      console.error("[POST /api/admin/accounts/approve] erro:", error);
      return NextResponse.json({ error: "Falha ao aprovar conta" }, { status: 500 });
    }

    if (!updated) {
      // Conta já aprovada, reprovada, suspensa ou inexistente — no-op.
      return NextResponse.json({ success: true, already: true }, { status: 200 });
    }

    // Busca e-mail/nome do owner para o aviso.
    const { data: owner, error: ownerError } = await db
      .from("profiles")
      .select("email, full_name")
      .eq("user_id", updated.owner_user_id)
      .maybeSingle();

    if (ownerError) {
      console.warn("[POST approve] falha ao buscar owner para aviso:", ownerError);
    }

    // Dispara o aviso somente se o owner tem e-mail.
    if (owner?.email) {
      after(() =>
        notifyAccountApproved({
          accountId: updated.id,
          email: owner.email,
          name: owner.full_name ?? "",
        }),
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
