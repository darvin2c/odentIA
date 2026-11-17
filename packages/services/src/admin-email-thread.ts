/**
 * El hilo de un correo de la administración (ADR 0196), que se arma al leer: la clave de sus
 * cabeceras y quién puede entrar en él. Lo usan la Bandeja (`admin-inbox.ts`, que lo vuelve a
 * exportar), la respuesta y Kairós; va aparte para que todos lo lean igual sin dependencias en
 * círculo.
 */
import { type SQL, sql } from "drizzle-orm"

const MESSAGE_ID = /<[^<>\s]+>/

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
}

/**
 * El hilo al que apunta un correo por sus cabeceras: el primer Message-ID de su `References`; si
 * no trae, la clave de su padre (`parentOf`: el envío nuestro o el correo que llegó con el
 * Message-ID del primero de su `In-Reply-To`), o ese id si no lo conocemos; si tampoco trae
 * `In-Reply-To`, su propio Message-ID. La clave del padre se lee de sus propias cabeceras, sin
 * buscar a su padre. Es la clave de un envío nuestro tal cual; un correo que llegó entra ahí solo
 * si quien lo envía ya está en ese hilo (`threadKeyOf`). Sin pasar a minúsculas (un Message-ID
 * distingue).
 */
export function headerThreadKeyOf(
  message: ThreadHeaders,
  parentOf?: (messageId: string) => ThreadHeaders | null | undefined,
): string | null {
  const root = firstMessageId(message.references)
  if (root) return root
  const parentId = firstMessageId(message.inReplyTo)
  if (parentId) {
    const parent = parentOf?.(parentId)
    return (parent ? headerThreadKeyOf(parent) : null) ?? parentId
  }
  return message.messageId?.trim() || null
}

/**
 * La clave del hilo de un correo que llegó: la de sus cabeceras (`headerThreadKeyOf`) solo si su
 * remitente está verificado (`senderVerified`) y ya está en ese hilo (`fromAddress`, sin
 * mayúsculas, entre lo que dice `addressesIn`: lo que lee `threadAddressSql`); si no, su propio
 * Message-ID. Quien conoce el Message-ID de un hilo ajeno no entra en él, y un From sin verificar
 * tampoco aunque sea el de alguien del hilo: su correo es su propia conversación, no se le
 * responde por ese hilo y «Mejorar» no le lee lo de otros. `addressesIn` es obligatorio: sin
 * saber quién está en el hilo no hay clave. Gemela de `emailThreadKeySql`: cambian juntas.
 */
export function threadKeyOf(
  message: ThreadHeaders,
  parentOf: ((messageId: string) => ThreadHeaders | null | undefined) | undefined,
  addressesIn: (key: string) => readonly string[],
): string | null {
  const own = message.messageId?.trim() || null
  const key = headerThreadKeyOf(message, parentOf)
  if (!key || key === own) return key
  if (!message.senderVerified) return own
  const from = message.fromAddress?.trim().toLowerCase()
  const known = new Set(addressesIn(key).map((address) => address.trim().toLowerCase()))
  return from && known.has(from) ? key : own
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
/** `firstMessageId` en SQL: la misma expresión regular (`[:space:]` es el `\s` de PostgreSQL). */
export const firstIdSql = (expr: SQL) => sql`substring(${expr} from '<[^<>[:space:]]+>')`

function columnsOf(alias: string) {
  if (!ALIAS.test(alias)) throw new Error(`Alias inválido: ${alias}`)
  return (name: string) => sql.raw(`${alias}.${name}`)
}

/**
 * `headerThreadKeyOf` en SQL sobre una fila de `saas_inbound_email` con ese alias: su
 * `References`, su padre (un envío nuestro o un correo que llegó, por el índice único de su
 * `message_id`), su `In-Reply-To` o su propio Message-ID.
 */
function headerThreadKeySql(alias: string): SQL<string | null> {
  const e = columnsOf(alias)
  const parentId = firstIdSql(e("in_reply_to"))
  return sql<string | null>`coalesce(
    ${firstIdSql(e(`"references"`))},
    (select coalesce(${firstIdSql(sql.raw(`po."references"`))}, nullif(btrim(po.message_id), ''))
      from admin.saas_outreach po where po.message_id = ${parentId} limit 1),
    (select coalesce(${firstIdSql(sql.raw(`pe."references"`))}, ${firstIdSql(sql.raw("pe.in_reply_to"))},
        nullif(btrim(pe.message_id), ''))
      from admin.saas_inbound_email pe where pe.message_id = ${parentId} and pe.id <> ${e("id")} limit 1),
    ${parentId},
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
 * `threadKeyOf` en SQL sobre una fila de `saas_inbound_email` con ese alias: la clave de sus
 * cabeceras (`headerThreadKeySql`) si su remitente está verificado y ya está en ese hilo
 * (`threadAddressSql`); si no, su propio Message-ID. Gemela de `threadKeyOf`: cambian juntas.
 */
export function emailThreadKeySql(alias: string): SQL<string | null> {
  const e = columnsOf(alias)
  return sql<string | null>`(select (case when tk.key is null or tk.key = tk.own then tk.key
        when not tk.verified then tk.own
        when ${threadAddressSql(sql.raw("tk.key"), sql.raw("tk.sender"))} then tk.key
        else tk.own end)
    from (select ${headerThreadKeySql(alias)} as key, nullif(btrim(${e("message_id")}), '') as own,
      lower(btrim(${e("from_address")})) as sender, ${e("sender_verified")} as verified) tk)`
}

/** `outreachThreadKeyOf` en SQL sobre una fila de `saas_outreach` con ese alias. */
export function outreachThreadKeySql(alias: string): SQL<string | null> {
  const o = columnsOf(alias)
  return sql<string | null>`(case when ${o("in_reply_to_email_id")} is not null
    then (select ${emailThreadKeySql("ie")} from admin.saas_inbound_email ie
      where ie.id = ${o("in_reply_to_email_id")})
    else coalesce(${firstIdSql(o(`"references"`))}, nullif(btrim(${o("message_id")}), '')) end)`
}
