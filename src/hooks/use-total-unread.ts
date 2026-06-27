"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Conversation } from "@/types";
import { useAuth } from "@/hooks/use-auth";
import {
  agentSeesOnlyAssigned,
  conversationVisibleTo,
} from "@/lib/leads/visibility";

/**
 * Count of conversations with at least one unread inbound message for
 * the current user. Used by the sidebar to surface a green dot on the
 * Inbox nav entry when the user is elsewhere in the app.
 *
 * Lives on its own realtime channel (distinct from the inbox page's
 * "inbox-realtime") so both can coexist without sharing state.
 */
export function useTotalUnread(): number {
  const [total, setTotal] = useState(0);
  const { user, accountRole, profileLoading } = useAuth();
  const userId = user?.id ?? null;

  // Keep a live local mirror of {id: unread_count} so INSERT/UPDATE/DELETE
  // events can adjust the total in O(1) without refetching.
  const countsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    // Aguarda o perfil resolver antes de contar — evita inflar o badge com
    // todas as conversas durante o ciclo transitório em que accountRole é null.
    if (profileLoading) return;

    const supabase = createClient();
    let cancelled = false;

    // Carga inicial. A RLS escopa por CONTA (todos os membros da conta veem
    // tudo no banco). O escopo por colaborador (agent vê só os leads dele)
    // é feito aqui no app: filtramos por assigned_agent_id quando necessário.
    (async () => {
      let query = supabase
        .from("conversations")
        .select("id, unread_count");

      if (agentSeesOnlyAssigned(accountRole) && userId) {
        query = query.eq("assigned_agent_id", userId);
      }

      const { data, error } = await query;
      if (cancelled || error || !data) return;

      const map = new Map<string, number>();
      let sum = 0;
      for (const row of data as { id: string; unread_count: number }[]) {
        const n = row.unread_count ?? 0;
        map.set(row.id, n);
        if (n > 0) sum += 1;
      }
      countsRef.current = map;
      setTotal(sum);
    })();

    const channel = supabase
      .channel("total-unread-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        (payload) => {
          const map = countsRef.current;
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as Partial<Conversation>;
            // O countsRef só contém ids visíveis ao usuário (a carga inicial e
            // o ramo INSERT/UPDATE já filtram por conversationVisibleTo). Deletar
            // um id ausente no Map é no-op seguro — não precisa re-filtrar aqui.
            if (oldRow.id) map.delete(oldRow.id);
          } else {
            const row = payload.new as Conversation;
            // Ignorar conversas que o colaborador não pode enxergar —
            // não incrementar o badge para leads de outros atendentes.
            if (!conversationVisibleTo(row, accountRole, userId)) return;
            map.set(row.id, row.unread_count ?? 0);
          }
          // Recompute — cheap, conversations per user stay small.
          let sum = 0;
          for (const n of map.values()) if (n > 0) sum += 1;
          setTotal(sum);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [userId, accountRole, profileLoading]);

  return total;
}
