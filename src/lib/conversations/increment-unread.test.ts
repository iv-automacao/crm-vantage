import { describe, it, expect, vi } from 'vitest'
import { incrementConversationUnread } from './increment-unread'

const CONVERSATION = 'conv-1'
const TEXT = 'Olá, tudo bem?'

// `db` fake: `.rpc` controlável; `.from` é um mock que devolve um objeto vazio.
// O wrapper NÃO deve chamar `.from` (o incremento mora na RPC) — a asserção
// `not.toHaveBeenCalled` trava isso (se alguém regredir pro read-modify-write,
// a asserção falha).
function fakeDb(rpcResult: { error?: unknown }) {
  return {
    rpc: vi.fn().mockResolvedValue(rpcResult),
    from: vi.fn(() => ({})),
  }
}
type DbArg = Parameters<typeof incrementConversationUnread>[0]

describe('incrementConversationUnread', () => {
  it('chama a RPC increment_conversation_unread com conversationId e texto', async () => {
    const db = fakeDb({ error: null })
    await incrementConversationUnread(db as unknown as DbArg, CONVERSATION, TEXT)
    expect(db.rpc).toHaveBeenCalledWith('increment_conversation_unread', {
      p_conversation_id: CONVERSATION,
      p_last_message_text: TEXT,
    })
  })

  it('NÃO faz UPDATE em memória via db.from (incremento é atômico na RPC)', async () => {
    const db = fakeDb({ error: null })
    await incrementConversationUnread(db as unknown as DbArg, CONVERSATION, TEXT)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('repassa o texto exatamente como recebido (fallback mora no call site, não no wrapper)', async () => {
    const db = fakeDb({ error: null })
    await incrementConversationUnread(db as unknown as DbArg, CONVERSATION, '')
    expect(db.rpc).toHaveBeenCalledWith('increment_conversation_unread', {
      p_conversation_id: CONVERSATION,
      p_last_message_text: '',
    })
  })

  it('best-effort: não relança quando a RPC devolve erro', async () => {
    const db = fakeDb({ error: { message: 'boom' } })
    await expect(
      incrementConversationUnread(db as unknown as DbArg, CONVERSATION, TEXT),
    ).resolves.toBeUndefined()
  })
})
