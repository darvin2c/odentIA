/**
 * El hilo de un correo de la administración (ADR 0196), que se arma al leer: la clave de sus
 * cabeceras (la cadena de `References` e `In-Reply-To` hasta el primer correo que conocemos) y
 * quién puede entrar en él. Lo usan la Bandeja (`admin-inbox.ts`, que lo vuelve a exportar), la
 * respuesta y Kairós; va aparte para que todos lo lean igual sin dependencias en círculo.
 */
import type { SaasInboundMatch } from "@odentia/db/schema/admin-arm"
import { type SQL, sql } from "drizzle-orm"

const MESSAGE_ID = /<[^<>\s]+>/

/**
 * Cuántos pasos sube la clave por la cadena de un hilo (`headerThreadKeyOf`). Una cadena con
 * más pasos se corta ahí, y una en círculo no da vueltas sin fin.
 */
export const THREAD_CHAIN_MAX = 25

/**
 * Cómo se ligó un correo a su cliente cuando lo dijo su correo exacto (una persona de esa
 * clínica, su solicitud en la web o alguien del equipo de su cuenta) o una persona de
 * Administración: con esto entra en un hilo de esa clínica (`threadKeyOf`). Por el hilo (`hilo`)
 * no cuenta: ya estaba en él.
 */
export const THREAD_PERSON_MATCHES = [
  "contacto",
  "solicitud",
  "miembro",
  "persona",
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
   * verificar, el From puede ser de cualquiera: no entra en otro hilo.
   */
  senderVerified?: boolean
  /** De un correo que llegó: su cliente y cómo se ligó (`matched_by`). */
  clientId?: string | null
  matchedBy?: string | null
}

/** El Message-ID al que apunta: el primero de su `References` o, si no trae, el de su `In-Reply-To`. */
function pointerOf(message: ThreadHeaders): string | null {
  return firstMessageId(message.references) ?? firstMessageId(message.inReplyTo)
}

/**
 * El hilo al que apunta un correo por sus cabeceras: se sube por la cadena (el primer Message-ID
 * de su `References` o, si no trae, el de su `In-Reply-To`) mientras ese Message-ID sea de un
 * envío nuestro o de un correo que llegó (`parentOf`), hasta el que no apunta a nada (el primero
 * del hilo) o hasta uno que no conocemos (ese id es la clave). Así una cadena que solo trae
 * `In-Reply-To`, y lo que responde a ella, queda entera en el hilo de su primer correo. Hasta
 * `THREAD_CHAIN_MAX` pasos. Sin cabeceras del hilo, su propio Message-ID. Es la clave de un envío
 * nuestro tal cual; un correo que llegó entra ahí solo si quien lo envía está en ese hilo
 * (`threadKeyOf`). Sin pasar a minúsculas (un Message-ID distingue). Gemela de `chainKeySql`.
 */
export function headerThreadKeyOf(
  message: ThreadHeaders,
  parentOf?: (messageId: string) => ThreadHeaders | null | undefined,
): string | null {
  const first = pointerOf(message)
  if (!first) return message.messageId?.trim() || null
  let key: string = first
  for (let step = 0; step < THREAD_CHAIN_MAX; step++) {
    const parent: ThreadHeaders | null | undefined = parentOf?.(key)
    const next: string | null = parent ? pointerOf(parent) : null
    if (!next || next === key) return key
    key = next
  }
  return key
}

/**
 * La clave del hilo de un correo que llegó: la de sus cabeceras (`headerThreadKeyOf`) solo si su
 * remitente está verificado (`senderVerified`) y está en ese hilo; si no, su propio Message-ID.
 * Está en el hilo quien ya escribe en él (`fromAddress`, sin mayúsculas, entre lo que dice
 * `addressesIn`: lo que lee `threadAddressSql`) y quien es de la clínica del hilo: su correo se
 * ligó a ella por su correo exacto o lo ligó una persona (`THREAD_PERSON_MATCHES`), y el hilo es
 * de esa clínica (`clientsIn`: lo que lee `threadClientSql`). Quien conoce el Message-ID de un
 * hilo ajeno no entra en él, y un From sin verificar tampoco aunque sea el de alguien del hilo:
 * su correo es su propia conversación, no se le responde por ese hilo y «Mejorar» no le lee lo
 * de otros. `addressesIn` es obligatorio: sin saber quién está en el hilo no hay clave. Gemela de
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
  const byPerson = (THREAD_PERSON_MATCHES as readonly string[]).includes(message.matchedBy ?? "")
  return message.clientId && byPerson && (clientsIn?.(key) ?? []).includes(message.clientId)
    ? key
    : own
}

/**
 * La clave del hilo de un envío nuestro por correo: la del correo que responde, si responde uno;
 * si no (lo que escribimos primero), la de su `References` (`headerThreadKeyOf`) o la suya. Así
 * una respuesta siempre queda en el hilo del correo que contesta.
 */
export function outreachThreadKeyOf(
  outreach: { references: string | null; messageId: string | null },
  repliedEmailKey?: string | null,
  parentOf?: (messageId: string) => ThreadHeaders | null | undefined,
): string | null {
  return (
    repliedEmailKey ??
    headerThreadKeyOf({ references: outreach.references, messageId: outreach.messageId }, parentOf)
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
 * La cadena de un hilo en SQL, desde el Message-ID al que apunta un correo o un envío
 * (`pointer`): cada paso es un envío nuestro o un correo que llegó con ese Message-ID (por los
 * índices únicos de su `message_id`; primero lo nuestro) y lo que él apunta (`pointerOf`: lo
 * nuestro no trae `In-Reply-To`). Sigue mientras apunte a otro, hasta `THREAD_CHAIN_MAX` pasos;
 * la última fila es la clave. Deja abierta la cláusula `with recursive chain(ptr, step)`.
 */
function chainSql(pointer: SQL): SQL {
  const outRef = firstIdSql(sql.raw(`po."references"`))
  const inPointer = sql`coalesce(${firstIdSql(sql.raw(`pe."references"`))}, ${firstIdSql(sql.raw("pe.in_reply_to"))})`
  return sql`with recursive chain(ptr, step) as (
      select ${pointer}, 0
      union all
      select nx.ptr, ch.step + 1 from chain ch
      cross join lateral (
        (select ${outRef} as ptr from admin.saas_outreach po where po.message_id = ch.ptr limit 1)
        union all
        (select ${inPointer} from admin.saas_inbound_email pe where pe.message_id = ch.ptr limit 1)
        limit 1) nx
      where ch.ptr is not null and ch.step < ${sql.raw(String(THREAD_CHAIN_MAX))}
        and nx.ptr is not null and nx.ptr <> ch.ptr)`
}

/** `headerThreadKeyOf` en SQL: la clave de la cadena desde `pointer`; sin él, `own`. */
function chainKeySql(pointer: SQL, own: SQL): SQL<string | null> {
  return sql<string | null>`coalesce((${chainSql(pointer)}
    select ch.ptr from chain ch order by ch.step desc limit 1), ${own})`
}

/** Los Message-ID de la cadena desde `pointer` (él incluido), para un `in (…)`. */
function chainIdsSql(pointer: SQL): SQL {
  return sql`(${chainSql(pointer)} select ch.ptr from chain ch where ch.ptr is not null)`
}

/** Lo que apunta una fila de `saas_inbound_email` con ese alias: el `pointerOf` de sus cabeceras. */
function inboundPointerSql(alias: string): SQL<string | null> {
  const e = columnsOf(alias)
  return sql<
    string | null
  >`coalesce(${firstIdSql(e(`"references"`))}, ${firstIdSql(e("in_reply_to"))})`
}

/**
 * `headerThreadKeyOf` en SQL sobre una fila de `saas_inbound_email` con ese alias: la clave de
 * la cadena desde lo que apuntan sus cabeceras o, si no apuntan a nada, su propio Message-ID.
 */
function headerThreadKeySql(alias: string): SQL<string | null> {
  const e = columnsOf(alias)
  return chainKeySql(inboundPointerSql(alias), sql`nullif(btrim(${e("message_id")}), '')`)
}

/**
 * La clave de las cabeceras de un envío nuestro con ese alias, sin mirar quién está en el hilo:
 * la del correo que responde (`headerThreadKeySql`) o, si no responde uno, la de la cadena de su
 * `References` o su propio Message-ID. Con esta se sabe de qué clínica es un hilo
 * (`threadClientSql`): lo que le escribimos a una clínica es de ella.
 */
function outreachHeaderKeySql(alias: string): SQL<string | null> {
  const o = columnsOf(alias)
  return sql<string | null>`(case when ${o("in_reply_to_email_id")} is not null
    then (select ${headerThreadKeySql("he")} from admin.saas_inbound_email he
      where he.id = ${o("in_reply_to_email_id")})
    else ${outreachChainKeySql(alias)} end)`
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
 * Si un correo ligado a `client` entra en el hilo `key` por ser de esa clínica: se ligó por su
 * correo exacto o lo ligó una persona (`matched`, uno de `THREAD_PERSON_MATCHES`), y el hilo es
 * de esa clínica: su primer correo es de ella o le escribimos ahí (un envío nuestro a ella con
 * esas cabeceras). Así el colega que contesta desde otra dirección entra si es una persona de la
 * clínica, o en cuanto alguien liga su correo a ella; quien solo conoce el Message-ID, no (su
 * correo no es de esa clínica). `key`, `client` y `matched` son columnas ya leídas.
 */
function threadClientSql(key: SQL, client: SQL, matched: SQL): SQL<boolean> {
  const byPerson = sql.join(
    THREAD_PERSON_MATCHES.map((match) => sql`${match}`),
    sql`, `,
  )
  return sql<boolean>`(${client} is not null and ${matched} in (${byPerson}) and (
    exists (select 1 from admin.saas_inbound_email se where se.message_id = ${key}
      and se.client_id = ${client})
    or exists (select 1 from admin.saas_outreach co where co.client_id = ${client}
      and co.channel = 'correo' and ${outreachHeaderKeySql("co")} = ${key})))`
}

/**
 * `threadKeyOf` en SQL sobre una fila de `saas_inbound_email` con ese alias: la clave de sus
 * cabeceras (`headerThreadKeySql`) si su remitente está verificado y está en ese hilo (ya escribe
 * en él, `threadAddressSql`, o es de su clínica, `threadClientSql`); si no, su propio Message-ID.
 * Gemela de `threadKeyOf`: cambian juntas.
 */
export function emailThreadKeySql(alias: string): SQL<string | null> {
  const e = columnsOf(alias)
  // `offset 0`: que la clave de las cabeceras se lea una vez; sin él, PostgreSQL la vuelve a
  // armar (con sus búsquedas por la cadena) en cada lugar donde se usa.
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

/**
 * `outreachThreadKeyOf` en SQL sobre una fila de `saas_outreach` con ese alias: si no responde un
 * correo, la de la cadena de su `References` o su propio Message-ID (como `outreachHeaderKeySql`).
 */
export function outreachThreadKeySql(alias: string): SQL<string | null> {
  const o = columnsOf(alias)
  return sql<string | null>`(case when ${o("in_reply_to_email_id")} is not null
    then (select ${emailThreadKeySql("ie")} from admin.saas_inbound_email ie
      where ie.id = ${o("in_reply_to_email_id")})
    else ${outreachChainKeySql(alias)} end)`
}

/**
 * La clave de un envío nuestro que no responde un correo: la de la cadena de su `References` o
 * su propio Message-ID. La usan `outreachThreadKeySql` y la lista de la Bandeja.
 */
export function outreachChainKeySql(alias: string): SQL<string | null> {
  const o = columnsOf(alias)
  return chainKeySql(firstIdSql(o(`"references"`)), sql`nullif(btrim(${o("message_id")}), '')`)
}

/**
 * Los Message-ID de la cadena de una fila de `saas_inbound_email` con ese alias, para un
 * `in (…)`: lo que apuntan sus cabeceras y cada correo o envío que sigue hacia el primero.
 */
export function emailChainIdsSql(alias: string): SQL {
  return chainIdsSql(inboundPointerSql(alias))
}

/** La clave de las cabeceras de una fila de `saas_inbound_email`, sin mirar quién está en el hilo. */
export function emailHeaderKeySql(alias: string): SQL<string | null> {
  return headerThreadKeySql(alias)
}
