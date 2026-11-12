/**
 * Dejar un borrador de la carga en la administración (`import:dejar`, ADR 0183): la skill
 * sube el plan de configuración (`clinica.json`), el plan de pacientes (`plan.json`) o el
 * informe a la clínica (`informe-N.json`), con su PDF, a la ficha del cliente › Alta. Ahí
 * una persona de Administración lo aprueba, lo ensaya, lo carga y lo envía.
 *
 * La llave de la skill solo deposita: no aprueba, no carga, no envía ni lee pacientes. Se lee
 * de `ODENTIA_ADMIN_KEY` o de `~/odentia-cargas/.llave-administracion` y nunca se imprime.
 *
 * Aquí está lo que se puede probar sin red: qué archivo es, el cuerpo de la petición, la
 * llave y cómo se dice cada error. El comando vive en `clinic-import-cli.ts`.
 */
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { SaasImportDraftKind } from "@odentia/db/schema/admin-arm"
import { clinicImportPlanSchema } from "./clinic-import-plan.js"
import { progressReportSchema } from "./clinic-progress-report.js"
import { clinicSetupPlanSchema } from "./clinic-setup-plan.js"
import { fieldPath } from "./errors.js"

/** La API de producción; `ODENTIA_API_URL` la cambia (local: `http://localhost:3001`). */
export const DEFAULT_API_URL = "https://api.odentia32.com"

/** El tope del cuerpo que acepta la ruta (`bodyLimit` de `/api/admin-skill/drafts`). */
export const DRAFT_MAX_BYTES = 12 * 1024 * 1024

/** El tope del PDF que acompaña al borrador (lo mismo exige la ruta). */
export const DRAFT_PDF_MAX_BYTES = 8 * 1024 * 1024

/** Dónde guarda la llave quien acompaña el alta, con permisos 600. */
export const ADMIN_KEY_FILE = join("odentia-cargas", ".llave-administracion")

export const DRAFT_KIND_WORDS: Record<SaasImportDraftKind, string> = {
  plan_configuracion: "el plan de configuración de la clínica",
  plan_pacientes: "el plan de pacientes",
  informe: "el informe a la clínica",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Qué archivo es, por su forma: `clinica.json` lleva `kind: "clinica"`; el plan de pacientes,
 * `sources` y `people`; el informe, `companion`, `stage` y `done`. No lo valida: eso lo hace
 * `checkDraftPayload`, con el mismo esquema que usa el servidor.
 */
export function detectDraftKind(payload: unknown): SaasImportDraftKind {
  if (isRecord(payload)) {
    if (payload.kind === "clinica") return "plan_configuracion"
    if (Array.isArray(payload.people) && Array.isArray(payload.sources)) return "plan_pacientes"
    if (
      isRecord(payload.companion) &&
      typeof payload.stage === "string" &&
      Array.isArray(payload.done)
    )
      return "informe"
  }
  throw new Error(
    "No reconozco el archivo: se dejan clinica.json (de import:clinica), plan.json (de import:prepare) o informe-N.json",
  )
}

/**
 * El archivo contra su esquema, antes de subirlo. Los errores dicen dónde y nunca repiten
 * un dato: del plan de pacientes, ni el mensaje del esquema (podría citar el valor).
 */
export function checkDraftPayload(kind: SaasImportDraftKind, payload: unknown): string[] {
  const schema =
    kind === "plan_configuracion"
      ? clinicSetupPlanSchema
      : kind === "plan_pacientes"
        ? clinicImportPlanSchema
        : progressReportSchema
  const checked = schema.safeParse(payload)
  if (checked.success) return []
  return checked.error.issues.slice(0, 20).map((issue) => {
    const where = fieldPath(issue.path) || "(raíz)"
    return kind === "plan_pacientes"
      ? `${where}: este dato no es válido`
      : `${where}: ${issue.message}`
  })
}

/** El número del borrador: el del informe es el suyo; el de los planes, `--numero` o 1. */
export function draftNumber(kind: SaasImportDraftKind, payload: unknown, given?: string): number {
  const asked = given === undefined ? undefined : Number(given)
  if (asked !== undefined && (!Number.isInteger(asked) || asked < 1 || asked > 99))
    throw new Error("--numero va de 1 a 99")
  if (kind === "informe") {
    const own = isRecord(payload) ? payload.number : undefined
    if (typeof own !== "number") throw new Error("El informe no dice su número («number»)")
    if (asked !== undefined && asked !== own)
      throw new Error(`El informe es el N.º ${own}: no se deja como N.º ${asked}`)
    return own
  }
  return asked ?? 1
}

/** Lo que cada tipo exige de la clínica antes de subir: el plan de configuración lleva su dirección. */
export function checkDraftClinic(
  kind: SaasImportDraftKind,
  payload: unknown,
  organizationSlug: string,
): string | null {
  if (kind !== "plan_configuracion" || !isRecord(payload)) return null
  const slug = typeof payload.slug === "string" ? payload.slug.trim().toLowerCase() : ""
  return slug === organizationSlug.trim().toLowerCase()
    ? null
    : `El plan es de «${slug || "sin dirección"}», no de «${organizationSlug}»: revisa --clinica o el «slug» del plan`
}

export interface DraftRequestBody {
  organizationSlug: string
  kind: SaasImportDraftKind
  number: number
  /** El JSON del archivo, tal cual. */
  payload: unknown
  /** El PDF que lo acompaña; sin PDF (un plan de pacientes) no va. */
  pdfBase64?: string
  /** El nombre del PDF dado con `--pdf`; sin él, la administración le pone uno. */
  pdfFilename?: string
}

/** El cuerpo de `POST /api/admin-skill/drafts`. */
export function draftRequestBody(input: {
  organizationSlug: string
  kind: SaasImportDraftKind
  number: number
  payload: unknown
  pdf?: Uint8Array | null
  pdfFilename?: string
}): DraftRequestBody {
  const body: DraftRequestBody = {
    organizationSlug: input.organizationSlug.trim().toLowerCase(),
    kind: input.kind,
    number: input.number,
    payload: input.payload,
  }
  if (input.pdf?.length) {
    body.pdfBase64 = Buffer.from(input.pdf).toString("base64")
    if (input.pdfFilename) body.pdfFilename = input.pdfFilename
  }
  return body
}

/** Un PDF de verdad empieza con `%PDF-`. */
export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length > 5 && Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-"
}

export function draftsUrl(env: Record<string, string | undefined>): string {
  return `${(env.ODENTIA_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, "")}/api/admin-skill/drafts`
}

export interface AdminKey {
  key: string
  /** De dónde salió, para decirlo sin mostrarla. */
  from: string
  /** Un aviso que no la frena: el archivo lo pueden leer otros. */
  warning?: string
}

/**
 * La llave de la skill: `ODENTIA_ADMIN_KEY` o el archivo `~/odentia-cargas/.llave-administracion`.
 * Si el sistema tiene permisos de archivo (no Windows) y el archivo lo pueden leer otros, avisa.
 * Ningún mensaje lleva la llave.
 */
export function readAdminKey(
  env: Record<string, string | undefined>,
  options: { home?: string; platform?: NodeJS.Platform } = {},
): AdminKey {
  const fromEnv = env.ODENTIA_ADMIN_KEY?.trim()
  if (fromEnv) return { key: checkKeyShape(fromEnv), from: "ODENTIA_ADMIN_KEY" }
  const path = join(options.home ?? homedir(), ADMIN_KEY_FILE)
  let text: string
  try {
    text = readFileSync(path, "utf-8")
  } catch {
    throw new Error(
      `No encuentro la llave de la skill: ni ODENTIA_ADMIN_KEY ni ${path}. Créala en la administración, Equipo › Llaves de la skill, y guárdala en ese archivo con permisos 600`,
    )
  }
  const key = checkKeyShape(text.trim())
  const platform = options.platform ?? process.platform
  let warning: string | undefined
  if (platform !== "win32") {
    const mode = statSync(path).mode & 0o777
    if (mode & 0o077)
      warning = `El archivo de la llave lo pueden leer otros (permisos ${mode.toString(8)}): ciérralo con «chmod 600 ${path}»`
  }
  return { key, from: path, warning }
}

function checkKeyShape(key: string): string {
  if (!/^sk_[A-Za-z0-9_-]{20,}$/.test(key))
    throw new Error(
      "La llave guardada no tiene la forma de una llave de la skill (empieza con «sk_»): cópiala otra vez completa",
    )
  return key
}

/** El error de la API (`{ error: { code, message, fields } }`) en palabras, sin la llave. */
export function explainDropFailure(status: number, body: unknown): string {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null
  const message = error && typeof error.message === "string" ? error.message : null
  const fields =
    error && isRecord(error.fields)
      ? Object.entries(error.fields)
          .filter(([, value]) => typeof value === "string")
          .map(([field, value]) => `  - ${field}: ${value}`)
      : []
  const detail = [message, ...fields].filter(Boolean).join("\n")
  if (status === 401)
    return "La administración no reconoce la llave: venció, la revocaron o está mal copiada. Crea otra en Equipo › Llaves de la skill y guárdala otra vez."
  if (status === 403)
    return `La llave no puede dejar borradores${message ? ` (${message})` : ""}: solo vale la de una persona de Administración con su cuenta activa.`
  if (status === 413)
    return `El archivo es demasiado grande para dejarlo: con su PDF pasa de ${DRAFT_MAX_BYTES / 1024 / 1024} MB. Achica las imágenes del plan (logo, hoja membretada) o el PDF.`
  if (status === 409)
    return (
      detail ||
      "Ya hay un borrador con ese número para esta clínica: usa el número siguiente (--numero)."
    )
  if (status === 400)
    return `La administración no aceptó el archivo:\n${detail || "datos no válidos"}`
  if (status === 503)
    return `La administración no pudo guardar el borrador ahora${message ? ` (${message})` : ""}: mira la ficha del cliente › Alta y, si no está, prueba más tarde.`
  return `La administración respondió ${status}${detail ? `:\n${detail}` : ""}`
}

export type DropResult =
  | { ok: true; status: number; data: Record<string, unknown> }
  | { ok: false; status: number | null; message: string }

/**
 * Hace la petición. No reintenta: un corte a mitad no dice si quedó, y el mismo número
 * no se deja dos veces (lo dice la administración con un 409).
 */
export async function postDraft(
  url: string,
  key: string,
  body: DraftRequestBody,
  fetchFn: typeof fetch = fetch,
): Promise<DropResult> {
  const text = JSON.stringify(body)
  if (Buffer.byteLength(text) > DRAFT_MAX_BYTES)
    return { ok: false, status: 413, message: explainDropFailure(413, null) }
  let response: Response
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: text,
    })
  } catch {
    return {
      ok: false,
      status: null,
      message: `No se pudo conectar con ${new URL(url).origin}. Si se cortó a mitad, mira la ficha del cliente › Alta antes de volver a dejarlo.`,
    }
  }
  let data: unknown = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!response.ok)
    return {
      ok: false,
      status: response.status,
      message: explainDropFailure(response.status, data),
    }
  // La respuesta de la ruta: `{ data: { id, clientId, organizationId, kind, number, status, replaced } }`.
  const result = isRecord(data) && isRecord(data.data) ? data.data : {}
  return { ok: true, status: response.status, data: result }
}
