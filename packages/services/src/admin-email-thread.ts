/**
 * El hilo de un correo de la administración (ADR 0196), que se arma al leer: la clave de sus
 * cabeceras y quién puede entrar en él. Lo usan la Bandeja (`admin-inbox.ts`, que lo vuelve a
 * exportar), la respuesta y Kairós; va aparte para que todos lo lean igual sin dependencias en
 * círculo.
 */
import type { SaasInboundMatch } from "@odentia/db/schema/admin-arm"
import { type SQL, sql } from "drizzle-orm"

const MESSAGE_ID = /<[^<>\s]+>/

/**
 * Cuántos correos que solo traen `In-Reply-To` sube la clave de un hilo (`headerThreadKeyOf`): una
 * cadena más larga se corta ahí. Lo que respondemos lleva primero el Message-ID de su hilo
 * (`replyReferences`), así que la cadena solo crece con los correos seguidos que nadie contestó.
 */
export const THREAD_CHAIN_MAX = 50

/**
 * Cómo se ligó al llegar el correo de una persona de esa clínica: su correo exacto es el de un
 * contacto, el de su solicitud en la web o el de alguien del equipo de su cuenta. Con esto entra en
 * un hilo de esa clínica (`threadKeyOf`). Ligado por una persona o por el hilo, no: eso dice de
 * quién es el correo, no que quien lo escribe sea parte de ese hilo.
 */
export const THREAD_PERSON_MATCHES = [
  "contacto",
  "solicitud",
  "miembro",
] as const satisfies readonly SaasInboundMatch[]

/** El primer Message-ID (`<…>`) de una cabecera, tal como viene (sin pasar a minúsculas); nulo si no trae. */
export function firstMessageId(value: string | null | undefined): string | null {
  return (value ?? "").match(MESSAGE_ID)?.[0] ?? null
}

/** Las cabeceras de un correo que dicen de qué hilo es. Un envío nuestro no trae `inReplyTo`. */
export interface ThreadHeaders {
  references?: string | null
  inReplyTo?: string | null
  messageId: string | null
  /** De un correo que llegó: quién lo envía (su From). */
  fromAddress?: string | null
  /**
   * De un correo que llegó: si su remitente está verificado (SPF/DKIM de su dominio). Sin
   * verificar, el From puede ser de cualquiera: no entra en otro hilo ni se sube por él.
   */
  senderVerified?: boolean
  /** De un correo que llegó: su cliente y cómo se ligó (`matched_by`). */
  clientId?: string | null
  matchedBy?: string | null
}

/**
 * El hilo al que apunta un correo por sus cabeceras: el primer Message-ID de su `References`; si
 * no trae, se sube por su `In-Reply-To` mientras sea de un envío nuestro o de un correo verificado
 * que conocemos (`parentOf`): el que trae `References` da su primer Message-ID, lo nuestro sin
 * `References` es el primero del hilo, y uno que no conocemos, sin verificar o que ya se pasó en
 * la cadena es la clave. Así una cadena que solo trae `In-Reply-To` queda en el hilo de su primer
 * correo, y un `References` nunca se cambia por lo que diga otro correo. Hasta `THREAD_CHAIN_MAX`
 * pasos. Sin esas cabeceras, su propio Message-ID. Es la clave de un envío nuestro tal cual; un
 * correo que llegó entra ahí solo si quien lo envía está en ese hilo (`threadKeyOf`). Sin pasar a
 * minúsculas (un Message-ID distingue). Gemela de `headerThreadKeySql`: cambian juntas.
 */
export function headerThreadKeyOf(
  message: ThreadHeaders,
  parentOf?: (messageId: string) => ThreadHeaders | null | undefined,
): string | null {
  const root = firstMessageId(message.references)
  if (root) return root
  const first = firstMessageId(message.inReplyTo)
  if (!first) return message.messageId?.trim() || null
  const seen = new Set<string>([first])
  let key: string = first
  for (let step = 0; step < THREAD_CHAIN_MAX; step++) {
    const parent: ThreadHeaders | null | undefined = parentOf?.(key)
    if (!parent || parent.senderVerified === false) return key
    const ref = firstMessageId(parent.references)
    if (ref) return ref
    const next = firstMessageId(parent.inReplyTo)
    if (!next || seen.has(next)) return key
    seen.add(next)
    key = next
  }
  return key
}

/**
 * La clave del hilo de un correo que llegó: la de sus cabeceras (`headerThreadKeyOf`) solo si su
 * remitente está verificado (`senderVerified`) y está en ese hilo; si no, su propio Message-ID.
 * Está en el hilo quien ya escribe en él (`fromAddress`, sin mayúsculas, entre lo que dice
 * `addressesIn`: lo que lee `threadAddressSql`) y la persona de la clínica del hilo: su correo se
 * ligó a ella al llegar por su correo exacto (`THREAD_PERSON_MATCHES`) y el hilo es de esa
 * clínica (`clientsIn`: lo que lee `threadClientSql`). Quien conoce el Message-ID de un hilo ajeno
 * no entra en él, y un From sin verificar tampoco aunque sea el de alguien del hilo: su correo es
 * su propia conversación, no se le responde por ese hilo y «Mejorar» no le lee lo de otros.
 * `addressesIn` es obligatorio: sin saber quién está en el hilo no hay clave. Gemela de
 * `emailThreadKeySql`: cambian juntas.
 */
export function threadKeyOf(
  message: ThreadHeaders,
  parentOf: ((messageId: string) => ThreadHeaders | null | undefined) | undefined,
  addressesIn: (key: string) => readonly string[],
  clientsIn?: (key: string) => readonly string[],
): string | null {
  const own = message.messageId?.trim() || null
  const key = headerThreadKeyOf(message, parentOf)
  if (!key || key === own) return key
  if (!message.senderVerified) return own
  const from = message.fromAddress?.trim().toLowerCase()
  const known = new Set(addressesIn(key).map((address) => address.trim().toLowerCase()))
  if (from && known.has(from)) return key
  const person = (THREAD_PERSON_MATCHES as readonly string[]).includes(message.matchedBy ?? "")
  return message.clientId && person && (clientsIn?.(key) ?? []).includes(message.clientId)
    ? key
    : own
}

/**
 * La clave del hilo de un envío nuestro por correo: la del correo que responde, si responde uno;
 * si no (lo que escribimos primero), el primer Message-ID de su `References` o el suyo. Así una
 * respuesta siempre queda en el hilo del correo que contesta.
 */
export function outreachThreadKeyOf(
  outreach: { references: string | null; messageId: string | null },
  repliedEmailKey?: string | null,
): string | null {
  return (
    repliedEmailKey ??
    headerThreadKeyOf({ references: outreach.references, messageId: outreach.messageId })
  )
}

const ALIAS = /^[a-z_][a-z0-9_]*$/
/**
 * `firstMessageId` en SQL: la misma expresión regular (`[:space:]` es el `\s` de PostgreSQL). Los
 * índices de `references` e `in_reply_to` (migración 0140) son de esta expresión exacta: si cambia,
 * cambian con ella (lo comprueba el EXPLAIN de `admin-inbox.test.ts`).
 */
export const firstIdSql = (expr: SQL) => sql`substring(${expr} from '<[^<>[:space:]]+>')`

function columnsOf(alias: string) {
  if (!ALIAS.test(alias)) throw new Error(`Alias inválido: ${alias}`)
  return (name: string) => sql.raw(`${alias}.${name}`)
}

/**
 * La subida por `In-Reply-To` de `headerThreadKeyOf` en SQL, desde el Message-ID `start`: cada paso
 * es un envío nuestro o un correo verificado con ese Message-ID (por los índices únicos de su
 * `message_id`; primero lo nuestro). El que trae `References` da su primer Message-ID y ahí
 * termina (`fin`); el que solo trae `In-Reply-To` sigue por él si no se pasó ya (`path`), hasta
 * `THREAD_CHAIN_MAX` pasos. La última fila es la clave. Deja abierta `with recursive chain(…)`.
 */
function chainSql(start: SQL): SQL {
  const outRef = firstIdSql(sql.raw(`po."references"`))
  const inRef = firstIdSql(sql.raw(`pe."references"`))
  const inReply = firstIdSql(sql.raw("pe.in_reply_to"))
  return sql`with recursive chain(ptr, fin, step, path) as (
      select ${start}, false, 0, array[${start}]
      union all
      select nx.ptr, nx.fin, ch.step + 1, ch.path || nx.ptr from chain ch
      cross join lateral (
        (select ${outRef} as ptr, true as fin from admin.saas_outreach po
          where po.message_id = ch.ptr limit 1)
        union all
        (select coalesce(${inRef}, ${inReply}), ${inRef} is not null from admin.saas_inbound_email pe
          where pe.message_id = ch.ptr and pe.sender_verified limit 1)
        limit 1) nx
      where not ch.fin and ch.ptr is not null and ch.step < ${sql.raw(String(THREAD_CHAIN_MAX))}
        and nx.ptr is not null and (nx.fin or not (nx.ptr = any(ch.path))))`
}

/**
 * `headerThreadKeyOf` en SQL sobre una fila de `saas_inbound_email` con ese alias: el primer
 * Message-ID de su `References`; si no trae, la subida por su `In-Reply-To` (`chainSql`); si
 * tampoco, su propio Message-ID. Con `References` no se busca nada.
 */
function headerThreadKeySql(alias: string): SQL<string | null> {
  const e = columnsOf(alias)
  return sql<string | null>`coalesce(${firstIdSql(e(`"references"`))},
    (${chainSql(firstIdSql(e("in_reply_to")))} select ch.ptr from chain ch order by ch.step desc limit 1),
    nullif(btrim(${e("message_id")}), ''))`
}

/**
 * Si `sender` (ya sin mayúsculas) está en el hilo `key`: lo escribió quien empezó el hilo (el
 * correo con ese Message-ID o, si no conocemos ninguno con él, el primero que llegó apuntándole),
 * le escribimos ahí (un envío nuestro con ese Message-ID, o que lo continúa por su `References`
 * sin responder un correo) o le respondimos un correo cuyas cabeceras apuntan a ese hilo. Así, a
 * quien le respondimos, su correo y los que siguen entran en el hilo (la doctora que contesta lo
 * que le escribimos a la clínica: su primer correo es su propia conversación hasta que le
 * respondemos); quien solo copia las cabeceras, no. `key` y `sender` son columnas ya leídas; sin
 * el Message-ID de un hilo nadie entra (`null`).
 */
function threadAddressSql(key: SQL, sender: SQL): SQL<boolean> {
  const firstRef = (alias: string) => firstIdSql(sql.raw(`${alias}."references"`))
  const firstReply = (alias: string) => firstIdSql(sql.raw(`${alias}.in_reply_to`))
  return sql<boolean>`(
    exists (select 1 from admin.saas_inbound_email re where re.message_id = ${key}
      and lower(btrim(re.from_address)) = ${sender})
    or exists (select 1 from admin.saas_outreach ro where ro.message_id = ${key}
      and ro.channel = 'correo' and lower(btrim(ro.to_address)) = ${sender})
    or exists (select 1 from admin.saas_outreach rr where rr.channel = 'correo'
      and rr.in_reply_to_email_id is null and ${firstRef("rr")} = ${key}
      and lower(btrim(rr.to_address)) = ${sender})
    or (not exists (select 1 from admin.saas_inbound_email ke where ke.message_id = ${key})
      and not exists (select 1 from admin.saas_outreach ko where ko.message_id = ${key})
      and ${sender} = (select lower(btrim(fe.from_address)) from admin.saas_inbound_email fe
        where ${firstRef("fe")} = ${key}
          or (${firstRef("fe")} is null and ${firstReply("fe")} = ${key})
        order by fe.received_at, fe.id limit 1))
    or exists (select 1 from admin.saas_outreach lo
      join admin.saas_inbound_email le on le.id = lo.in_reply_to_email_id
      where lo.channel = 'correo' and lower(btrim(lo.to_address)) = ${sender}
        and ${headerThreadKeySql("le")} = ${key}))`
}

/**
 * Si el hilo `key` es de la clínica `client` por lo que no escribe quien llega: su primer correo
 * es de ella, o lo empezamos o lo seguimos nosotros escribiéndole a ella (un envío nuestro que no
 * responde un correo, con ese Message-ID o con él primero en su `References`; por sus índices). Lo
 * que respondimos no cuenta: sus cabeceras vienen del correo que respondía, que las puso quien
 * escribió. `key` y `client` son columnas o valores ya leídos.
 */
function threadOfClientSql(key: SQL, client: SQL): SQL<boolean> {
  return sql<boolean>`(exists (select 1 from admin.saas_inbound_email se
      where se.message_id = ${key} and se.client_id = ${client})
    or exists (select 1 from admin.saas_outreach co where co.channel = 'correo'
      and co.in_reply_to_email_id is null and co.client_id = ${client}
      and (co.message_id = ${key} or ${firstIdSql(sql.raw(`co."references"`))} = ${key})))`
}

/**
 * Si un correo ligado a `client` entra en el hilo `key` por ser de una persona de esa clínica: se
 * ligó al llegar por su correo exacto (`matched`, uno de `THREAD_PERSON_MATCHES`) y el hilo es de
 * esa clínica (`threadOfClientSql`). Así el colega registrado que contesta desde otra dirección
 * entra con su primer correo; quien solo conoce el Message-ID, no (su correo no es de una persona
 * de esa clínica). `key`, `client` y `matched` son columnas ya leídas.
 */
function threadClientSql(key: SQL, client: SQL, matched: SQL): SQL<boolean> {
  const person = sql.join(
    THREAD_PERSON_MATCHES.map((match) => sql`${match}`),
    sql`, `,
  )
  return sql<boolean>`(${client} is not null and ${matched} in (${person})
    and ${threadOfClientSql(key, client)})`
}

/**
 * `threadKeyOf` en SQL sobre una fila de `saas_inbound_email` con ese alias: la clave de sus
 * cabeceras (`headerThreadKeySql`) si su remitente está verificado y está en ese hilo (ya escribe
 * en él, `threadAddressSql`, o es una persona de su clínica, `threadClientSql`); si no, su propio
 * Message-ID. Gemela de `threadKeyOf`: cambian juntas.
 */
export function emailThreadKeySql(alias: string): SQL<string | null> {
  const e = columnsOf(alias)
  // `offset 0`: que la clave de las cabeceras se lea una vez; sin él, PostgreSQL la vuelve a
  // armar (con su subida por la cadena) en cada lugar donde se usa.
  return sql<string | null>`(select (case when tk.key is null or tk.key = tk.own then tk.key
        when not tk.verified then tk.own
        when ${threadAddressSql(sql.raw("tk.key"), sql.raw("tk.sender"))} then tk.key
        when ${threadClientSql(sql.raw("tk.key"), sql.raw("tk.client"), sql.raw("tk.matched"))} then tk.key
        else tk.own end)
    from (select ${headerThreadKeySql(alias)} as key, nullif(btrim(${e("message_id")}), '') as own,
      lower(btrim(${e("from_address")})) as sender, ${e("sender_verified")} as verified,
      ${e("client_id")} as client, ${e("matched_by")} as matched
      offset 0) tk)`
}

/** `outreachThreadKeyOf` en SQL sobre una fila de `saas_outreach` con ese alias. */
export function outreachThreadKeySql(alias: string): SQL<string | null> {
  const o = columnsOf(alias)
  return sql<string | null>`(case when ${o("in_reply_to_email_id")} is not null
    then (select ${emailThreadKeySql("ie")} from admin.saas_inbound_email ie
      where ie.id = ${o("in_reply_to_email_id")})
    else coalesce(${firstIdSql(o(`"references"`))}, nullif(btrim(${o("message_id")}), '')) end)`
}

/**
 * Los Message-ID de la subida por el `In-Reply-To` de una fila de `saas_inbound_email` con ese
 * alias (`chainSql`, él incluido), para un `in (…)`: el que solo trae `In-Reply-To` nombra solo a
 * su padre, y lo nuestro que contesta puede estar más arriba.
 */
export function emailChainIdsSql(alias: string): SQL {
  const e = columnsOf(alias)
  return sql`(${chainSql(firstIdSql(e("in_reply_to")))} select ch.ptr from chain ch where ch.ptr is not null)`
}

/** La clave de las cabeceras de una fila de `saas_inbound_email`, sin mirar quién está en el hilo. */
export function emailHeaderKeySql(alias: string): SQL<string | null> {
  return headerThreadKeySql(alias)
}

/**
 * La clínica del hilo `key` por los mismos hechos de `threadOfClientSql` (su primer correo, o lo
 * que empezamos o seguimos escribiéndole; lo más nuevo primero): con esto se sugiere de quién es el
 * correo de un colega que contesta desde otra dirección (`admin-inbox.ts`). Cambian juntas.
 */
export function threadClientIdSql(key: SQL): SQL<string | null> {
  return sql<string | null>`coalesce(
    (select se.client_id from admin.saas_inbound_email se
      where se.message_id = ${key} and se.client_id is not null limit 1),
    (select co.client_id from admin.saas_outreach co where co.channel = 'correo'
      and co.in_reply_to_email_id is null and co.client_id is not null
      and (co.message_id = ${key} or ${firstIdSql(sql.raw(`co."references"`))} = ${key})
      order by co.created_at desc, co.id desc limit 1))`
}
