import type { Db } from "@odentia/db"
import { SAAS_IMPORT_DRAFT_KINDS, saasSkillKey } from "@odentia/db/schema/admin-arm"
import { user } from "@odentia/db/schema/auth"
import {
  checkImportDraft,
  clientFileDeleteAfter,
  clientFileKey,
  depositImportDraft,
  registerClientFile,
  resolveSkillKey,
  ServiceError,
  type SkillActor,
  type Storage,
  writeAdminAudit,
} from "@odentia/services"
import { eq } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { errorBody } from "../lib/error.js"
import { serviceErrorResponse, validationError } from "./helpers.js"

/**
 * La llave de la skill de la carga (ADR 0183), en un montaje público aparte
 * (`/api/admin-skill`), fuera de `/api/admin/*`: la skill no tiene cookie, ni
 * segundo factor, ni el `Origin` de la administración. Entra solo con
 * `Authorization: Bearer sk_…` y solo **deposita** borradores (plan de
 * configuración, plan de pacientes, informe) en la ficha del cliente › Alta:
 * no aprueba, no ensaya, no carga, no envía y no lee clientes ni pacientes.
 * Lo aprueba y lo carga una persona de Administración con su sesión.
 */
export interface AdminSkillDeps {
  /** Conexión propietaria: las tablas del ARM viven en `admin`, sin GRANT a la app. */
  ownerDb: Db
  storage: Pick<Storage, "putAttachmentAt" | "deleteAttachment">
}

/** Un plan de configuración con su logo y su hoja en base64 pesa hasta unos 10 MB. */
export const ADMIN_SKILL_BODY_MAX = 12 * 1024 * 1024
/** El PDF que acompaña al borrador (el plan o el informe para leer). */
const PDF_MAX_BYTES = 8 * 1024 * 1024
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

const draftBody = z.strictObject({
  organizationSlug: z
    .string("Falta la clínica")
    .trim()
    .min(2, "Falta la clínica")
    .max(63, "La dirección de la clínica, 63 caracteres como mucho"),
  kind: z.enum(SAAS_IMPORT_DRAFT_KINDS, "Tipo de borrador no válido"),
  number: z
    .number("Falta el número")
    .int("El número es entero")
    .min(1, "El número empieza en 1")
    .max(99, "El número va hasta 99"),
  payload: z.unknown().refine((value) => value !== undefined && value !== null, "Falta el archivo"),
  pdfBase64: z
    .string("El PDF va en base64")
    .max(Math.ceil((PDF_MAX_BYTES * 4) / 3) + 4, "El PDF no puede pasar de 8 MB")
    .regex(BASE64, "El PDF va en base64")
    .optional(),
  pdfFilename: z.string().trim().min(1).max(200, "El nombre del PDF, 200 caracteres").optional(),
})

const PDF_NAMES: Record<(typeof SAAS_IMPORT_DRAFT_KINDS)[number], string> = {
  plan_configuracion: "plan-configuracion",
  plan_pacientes: "plan-pacientes",
  informe: "informe",
}

function bearerToken(c: Context): string | null {
  const header = c.req.header("authorization")
  if (!header || !/^Bearer /i.test(header)) return null
  const token = header.slice("Bearer ".length).trim()
  return token || null
}

function noKey(c: Context) {
  c.header("WWW-Authenticate", 'Bearer realm="administracion"')
  return c.json(
    errorBody(
      c,
      "SKILL_KEY_REQUIRED",
      "Falta la llave de la skill: mándala en Authorization: Bearer sk_…",
    ),
    401,
  )
}

export function createAdminSkillRoute(deps: AdminSkillDeps) {
  const app = new Hono()

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    await next()
  })

  /**
   * La persona dueña de la llave, con su rol de hoy. Sin llave o con una que no
   * vale: 401 (siempre el mismo, sin decir por qué). De Soporte: 403 y queda en
   * la auditoría, porque la llave sí era válida.
   */
  const keyActor = async (c: Context): Promise<SkillActor | Response> => {
    const token = bearerToken(c)
    if (!token) return noKey(c)
    try {
      const actor = await deps.ownerDb.transaction((tx) => resolveSkillKey(tx as Db, token))
      if (actor.role !== "admin") {
        await deps.ownerDb.transaction((tx) =>
          writeAdminAudit(tx as Db, actor, {
            action: "skill.key_denied",
            entityId: actor.keyId,
            metadata: { via: "skill", keyId: actor.keyId, path: c.req.path.slice(0, 120) },
          }),
        )
        return c.json(
          errorBody(
            c,
            "SKILL_KEY_FORBIDDEN",
            "La llave es de una persona de Soporte: solo Administración deja borradores de la carga",
          ),
          403,
        )
      }
      return actor
    } catch (error) {
      if (error instanceof ServiceError && error.status === 401) {
        c.header("WWW-Authenticate", 'Bearer realm="administracion", error="invalid_token"')
      }
      const response = serviceErrorResponse(c, error)
      if (response) return response
      throw error
    }
  }

  /** Para que la skill compruebe su llave antes de subir nada. Deja auditoría. */
  app.get("/whoami", async (c) => {
    const actor = await keyActor(c)
    if (actor instanceof Response) return actor
    const data = await deps.ownerDb.transaction(async (tx) => {
      const [row] = await tx
        .select({
          label: saasSkillKey.label,
          expiresAt: saasSkillKey.expiresAt,
          name: user.name,
          email: user.email,
        })
        .from(saasSkillKey)
        .innerJoin(user, eq(user.id, saasSkillKey.userId))
        .where(eq(saasSkillKey.id, actor.keyId))
        .limit(1)
      await writeAdminAudit(tx as Db, actor, {
        action: "skill.key_checked",
        entityId: actor.keyId,
        metadata: { via: "skill", keyId: actor.keyId },
      })
      return {
        keyId: actor.keyId,
        label: row?.label ?? "",
        scope: actor.scope,
        expiresAt: row?.expiresAt ?? null,
        user: { userId: actor.userId, name: row?.name ?? "", email: row?.email ?? "" },
        role: actor.role,
        can: ["depositar"],
      }
    })
    return c.json({ data }, 200)
  })

  const tooLarge = (c: Context) =>
    c.json(
      errorBody(c, "BODY_TOO_LARGE", "El borrador pesa más de 12 MB: divide el plan en dos"),
      413,
    )

  /**
   * Deja un borrador `lista`. Comprueba primero (sin escribir), sube el JSON y
   * el PDF al bucket privado fuera de la transacción y después registra el PDF
   * como documento del cliente y deposita, volviendo a comprobar la llave. Si
   * el registro falla, borra lo subido; el JSON de un borrador devuelto que se
   * reemplaza se borra después del commit.
   */
  app.post(
    "/drafts",
    bodyLimit({ maxSize: ADMIN_SKILL_BODY_MAX, onError: tooLarge }),
    async (c) => {
      const actor = await keyActor(c)
      if (actor instanceof Response) return actor
      const token = bearerToken(c) as string
      const parsed = draftBody.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return validationError(c, parsed.error.issues)
      const input = parsed.data
      let pdf: Uint8Array | null = null
      if (input.pdfBase64) {
        pdf = new Uint8Array(Buffer.from(input.pdfBase64, "base64"))
        const isPdf =
          pdf.byteLength >= 5 && Buffer.from(pdf.subarray(0, 5)).toString("latin1") === "%PDF-"
        if (!isPdf || pdf.byteLength > PDF_MAX_BYTES)
          return c.json(
            errorBody(c, "VALIDATION", "El PDF no es un PDF real o pasa de 8 MB", {
              pdfBase64: "El PDF no es un PDF real o pasa de 8 MB",
            }),
            400,
          )
      }
      if (!deps.storage.putAttachmentAt)
        return c.json(
          errorBody(
            c,
            "STORAGE_UNAVAILABLE",
            "El almacenamiento no está disponible: inténtalo de nuevo",
          ),
          503,
        )
      const target = {
        organizationSlug: input.organizationSlug,
        kind: input.kind,
        number: input.number,
      }
      let clientId: string
      try {
        clientId = (
          await deps.ownerDb.transaction((tx) =>
            checkImportDraft(tx as Db, actor, { ...target, payload: input.payload }),
          )
        ).clientId
      } catch (error) {
        const response = serviceErrorResponse(c, error)
        if (response) return response
        throw error
      }

      // Fuera de la transacción: primero se sube, después se registra.
      const uploaded: string[] = []
      const removeUploaded = async () => {
        for (const key of uploaded) await deps.storage.deleteAttachment(key).catch(() => {})
      }
      const payloadKey = clientFileKey(clientId, "json")
      const pdfKey = pdf ? clientFileKey(clientId, "pdf") : null
      try {
        await deps.storage.putAttachmentAt(
          payloadKey,
          new TextEncoder().encode(JSON.stringify(input.payload)),
          "application/json",
        )
        uploaded.push(payloadKey)
        if (pdf && pdfKey) {
          await deps.storage.putAttachmentAt(pdfKey, pdf, "application/pdf")
          uploaded.push(pdfKey)
        }
      } catch (error) {
        console.error("admin-skill: no se pudo subir el borrador", error)
        await removeUploaded()
        return c.json(
          errorBody(c, "STORAGE_UNAVAILABLE", "No se pudo guardar el borrador: inténtalo de nuevo"),
          503,
        )
      }

      let result: Awaited<ReturnType<typeof depositImportDraft>>
      try {
        result = await deps.ownerDb.transaction(async (tx) => {
          // La llave pudo revocarse mientras subía: se vuelve a comprobar en la misma transacción.
          const current = await resolveSkillKey(tx as Db, token)
          if (current.role !== "admin")
            throw new ServiceError(
              "SKILL_KEY_FORBIDDEN",
              403,
              "La llave es de una persona de Soporte: solo Administración deja borradores de la carga",
            )
          let pdfFileId: string | null = null
          if (pdf && pdfKey) {
            const file = await registerClientFile(tx as Db, current, {
              clientId,
              kind: input.kind === "informe" ? "informe" : "plan_carga",
              filename:
                input.pdfFilename ??
                `${PDF_NAMES[input.kind]}-${input.organizationSlug}-${input.number}.pdf`,
              objectKey: pdfKey,
              contentType: "application/pdf",
              sizeBytes: pdf.byteLength,
              adminOnly: true,
              // El plan de pacientes trae sus datos: su PDF no se guarda más de 30 días.
              ...(input.kind === "plan_pacientes"
                ? { deleteAfter: clientFileDeleteAfter(new Date()) }
                : {}),
              source: "skill",
            })
            pdfFileId = file.id
          }
          return depositImportDraft(tx as Db, current, {
            ...target,
            payload: input.payload,
            payloadKey,
            pdfFileId,
          })
        })
      } catch (error) {
        await removeUploaded()
        const response = serviceErrorResponse(c, error)
        if (response) return response
        throw error
      }
      if (result.replacedPayloadKey)
        await deps.storage.deleteAttachment(result.replacedPayloadKey).catch((error) => {
          console.error("admin-skill: no se borró el JSON del borrador reemplazado", error)
        })
      return c.json(
        {
          data: {
            id: result.id,
            clientId: result.clientId,
            organizationId: result.organizationId,
            kind: input.kind,
            number: input.number,
            status: "lista" as const,
            replaced: result.replacedPayloadKey !== null,
          },
        },
        201,
      )
    },
  )

  app.all("*", (c) =>
    c.json(errorBody(c, "NOT_FOUND", "La llave de la skill solo deja borradores"), 404),
  )

  return app
}
