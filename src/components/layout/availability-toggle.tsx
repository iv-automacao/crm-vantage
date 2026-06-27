'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { useAuth } from '@/hooks/use-auth'
import { Switch } from '@/components/ui/switch'

// Intervalo do heartbeat (deve ser bem menor que a janela de presença de 5min
// do backend, pra tolerar um ping perdido).
const PING_INTERVAL_MS = 2 * 60_000

/**
 * Controle de disponibilidade do vendedor (papel 'agent').
 * - Presença automática: enquanto a aba está visível, pinga a presença a cada
 *   2min. Fechar a aba / sair dispara um beacon que zera a presença na hora.
 * - Botão "Pausar leads": online por padrão (recebendo); pode pausar o
 *   recebimento sem ficar ausente nem deslogar.
 * Visível apenas para 'agent' — admin/owner/viewer não recebem leads.
 */
export function LeadAvailabilityControl() {
  const { profile } = useAuth()
  // Renderiza só para agentes (após o hook do contexto, sem hook próprio antes).
  if (profile?.account_role !== 'agent') return null
  return <LeadAvailabilityControlInner />
}

/**
 * Componente interno separado para evitar hooks após return condicional.
 */
function LeadAvailabilityControlInner() {
  // is_available = "recebendo leads". null = carregando (desabilita o switch).
  const [receiving, setReceiving] = useState<boolean | null>(null)

  // Carrega o estado inicial de "recebendo" no mount.
  useEffect(() => {
    fetch('/api/account/presence')
      .then((r) => r.json())
      .then((data: { is_available?: boolean }) => {
        setReceiving(data.is_available ?? true)
      })
      .catch(() => {
        // Falha silenciosa: assume recebendo (default do modelo).
        setReceiving(true)
      })
  }, [])

  // Heartbeat enquanto a aba está VISÍVEL + beacon de saída imediata.
  useEffect(() => {
    const ping = () =>
      fetch('/api/account/presence', { method: 'POST' }).catch(() => {})

    // Saída imediata: zera a presença ao fechar a aba / navegar pra fora.
    // sendBeacon carrega o cookie de sessão same-origin e sobrevive ao unload.
    const goOffline = () => {
      const blob = new Blob([JSON.stringify({ offline: true })], {
        type: 'application/json',
      })
      navigator.sendBeacon('/api/account/presence', blob)
    }

    let interval: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (interval) return
      ping() // ping imediato ao (re)tornar visível
      interval = setInterval(ping, PING_INTERVAL_MS)
    }
    const stop = () => {
      if (interval) {
        clearInterval(interval)
        interval = null
      }
    }

    const onVisibility = () => {
      // Trocar de aba só PAUSA o ping (não dispara beacon) — o vendedor cai por
      // expiração da janela de 5min. Evita piscar online/offline em troca rápida.
      if (document.visibilityState === 'visible') start()
      else stop()
    }

    // bfcache: back/forward RESTAURA a página sem remontar o componente, então
    // este useEffect NÃO roda de novo. O pagehide acima zerou a presença ao
    // entrar no bfcache; o pageshow com persisted=true religa o heartbeat na
    // volta (start() já faz ping imediato + reinicia o intervalo).
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted && document.visibilityState === 'visible') start()
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', goOffline)
    window.addEventListener('pageshow', onPageShow)

    // Só inicia se a aba já está visível no mount.
    if (document.visibilityState === 'visible') start()

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', goOffline)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [])

  const handleToggle = async (nextReceiving: boolean) => {
    // Atualização otimista.
    setReceiving(nextReceiving)
    try {
      const res = await fetch('/api/account/presence', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_available: nextReceiving }),
      })
      if (!res.ok) throw new Error('Falha ao atualizar recebimento')
    } catch {
      // Rollback.
      setReceiving(!nextReceiving)
      toast.error('Não foi possível atualizar o recebimento de leads.')
    }
  }

  const loaded = receiving !== null

  return (
    <div className="flex items-center gap-1.5">
      <Switch
        checked={receiving ?? true}
        disabled={!loaded}
        onCheckedChange={handleToggle}
        aria-label={receiving ? 'Recebendo leads' : 'Pausado'}
      />
      {/* Label oculta em telas muito pequenas para caber no header de 56px. */}
      <span
        className={[
          'hidden sm:inline text-xs font-medium select-none',
          loaded && receiving
            ? 'text-green-600 dark:text-green-400'
            : 'text-muted-foreground',
        ].join(' ')}
      >
        {loaded && receiving ? 'Recebendo leads' : 'Pausado'}
      </span>
    </div>
  )
}
