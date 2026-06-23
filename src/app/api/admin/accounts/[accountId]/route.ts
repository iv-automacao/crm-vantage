// ============================================================
// DELETE /api/admin/accounts/[accountId]
//
// Hard delete destrutivo. Apaga a linha em `accounts` (FK CASCADE
// remove profiles, contatos, conversas, etc.) e o usuário em
// auth.users via supabaseAdmin().auth.admin.deleteUser.
//
// Guarda-corpos obrigatórios:
//   1. Admin não pode deletar a própria conta.
//   2. Admin não pode deletar a conta de outro platform admin.
//
// O delete do auth user é best-effort: falha gera console.warn
// mas não aborta a resposta (a linha accounts já foi removida).
//
// Gate: requirePlatformAdmin + rate limit adminAction.
// ============================================================

import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { isPlatformAdmin, requirePlatformAdmin } from "@/lib/auth/platform-admin";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    // Gate de plataforma — primeiro check, sempre.
    const admin = await requirePlatformAdmin();

    // Rate limit por admin — operação destrutiva.
    const limit = checkRateLimit(
      `adminAction:${admin.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { accountId } = await params;
    const db = supabaseAdmin();

    // Carrega a conta alvo para os guarda-corpos.
    const { data: target, error: fetchError } = await db
      .from("accounts")
      .select("id, owner_user_id")
      .eq("id", accountId)
      .maybeSingle();

    if (fetchError) {
      console.error("[DELETE /api/admin/accounts] erro ao buscar conta:", fetchError);
      return NextResponse.json(
        { error: "Falha ao buscar conta" },
        { status: 500 },
      );
    }

    if (!target) {
      return NextResponse.json(
        { error: "Conta não encontrada" },
        { status: 404 },
      );
    }

    // Guarda-corpo 1: admin não pode deletar a própria conta.
    if (target.owner_user_id === admin.userId) {
      return NextResponse.json(
        { error: "Você não pode deletar a própria conta" },
        { status: 403 },
      );
    }

    // Guarda-corpo 2: não pode deletar conta de outro platform admin.
    const { data: ownerProfile, error: profileError } = await db
      .from("profiles")
      .select("email")
      .eq("user_id", target.owner_user_id)
      .maybeSingle();

    if (profileError) {
      console.error("[DELETE /api/admin/accounts] erro ao buscar profile do owner:", profileError);
      return NextResponse.json(
        { error: "Falha ao verificar permissões" },
        { status: 500 },
      );
    }

    if (isPlatformAdmin(ownerProfile?.email ?? null)) {
      return NextResponse.json(
        { error: "Não é possível deletar a conta de um admin de plataforma" },
        { status: 403 },
      );
    }

    // Hard delete da conta — FK CASCADE apaga tudo relacionado.
    const { error: deleteError } = await db
      .from("accounts")
      .delete()
      .eq("id", accountId);

    if (deleteError) {
      console.error("[DELETE /api/admin/accounts] erro ao deletar conta:", deleteError);
      return NextResponse.json(
        { error: "Falha ao deletar conta" },
        { status: 500 },
      );
    }

    // Remove o usuário do auth — best-effort (não aborta em caso de falha).
    try {
      await supabaseAdmin().auth.admin.deleteUser(target.owner_user_id);
    } catch (authErr) {
      console.warn(
        "[DELETE /api/admin/accounts] falha ao remover auth user (conta DB já apagada):",
        authErr,
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
