"use client";

// Botão de logout do muro /pending. A página é server component fora do
// AuthProvider, então não dá pra usar o useAuth().signOut aqui — criamos
// o client do browser direto e encerramos a sessão. Sem isto, a conta
// pending fica presa: "Voltar ao login" não desloga e o middleware
// devolve pro muro (usuário autenticado não-ativo).
import { useState } from "react";

import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const [loading, setLoading] = useState(false);

  async function handleSignOut() {
    setLoading(true);
    try {
      const supabase = createClient();
      await supabase.auth.signOut();
    } finally {
      // Hard redirect pra limpar qualquer estado em memória e cair no
      // /login já deslogado (o middleware não devolve mais pro muro).
      window.location.href = "/login";
    }
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={loading}
      className="mt-6 inline-block text-sm text-primary hover:underline disabled:opacity-50"
    >
      {loading ? "Saindo…" : "Sair da conta"}
    </button>
  );
}
