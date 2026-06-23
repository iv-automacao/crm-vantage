// ============================================================
// GET /api/admin/accounts/stats
//
// Retorna contagens de contas por status para o overview do
// painel admin. Usa count: 'exact' + head: true (zero rows
// transferidas, só o header count) — eficiente mesmo com
// tabela grande.
//
// Gate: requirePlatformAdmin (sem rate limit — leitura simples).
// ============================================================

import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform-admin";
import { supabaseAdmin } from "@/lib/flows/admin-client";

const STATUSES = ["pending", "active", "suspended", "rejected"] as const;
type AccountStatus = (typeof STATUSES)[number];

export async function GET() {
  try {
    // Gate de plataforma — primeiro check, sempre.
    await requirePlatformAdmin();

    const db = supabaseAdmin();

    // Conta por status em paralelo — 4 queries leves simultâneas.
    const results = await Promise.all(
      STATUSES.map((s) =>
        db
          .from("accounts")
          .select("id", { count: "exact", head: true })
          .eq("status", s),
      ),
    );

    // Verifica erros em qualquer das queries.
    for (let i = 0; i < results.length; i++) {
      if (results[i].error) {
        console.error(
          `[GET /api/admin/accounts/stats] erro ao contar status '${STATUSES[i]}':`,
          results[i].error,
        );
        return NextResponse.json(
          { error: "Falha ao buscar estatísticas" },
          { status: 500 },
        );
      }
    }

    // Monta o objeto de resposta indexado por status.
    const counts = Object.fromEntries(
      STATUSES.map((s, i) => [s, results[i].count ?? 0]),
    ) as Record<AccountStatus, number>;

    return NextResponse.json({
      pending: counts.pending,
      active: counts.active,
      suspended: counts.suspended,
      rejected: counts.rejected,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
