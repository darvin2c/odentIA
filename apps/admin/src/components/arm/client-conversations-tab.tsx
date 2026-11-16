/**
 * La pestaña «Conversaciones» de la ficha (ADR 0196): las conversaciones de este cliente en la
 * Bandeja, de todos sus canales, con la misma vista que `/inbox`. La arma la Bandeja.
 */
export function ClientConversationsTab({ clientId }: { clientId: string }) {
  return <div data-client-id={clientId} />
}
