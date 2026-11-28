import {
  type Db,
  MAX_PHOTO_BYTES,
  type PhotoType,
  STORE_IMAGE_KINDS,
  type StoreImageKind,
} from "@gestoria/db"
import { APP_CONTRACT_PATHS, CONTRACT_MAX_RECEIPT_BYTES } from "@odentia/contract"
import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { cors } from "hono/cors"
import { requestId } from "hono/request-id"
import type { JWTVerifyGetKey } from "jose"
import { ZodError, type z } from "zod"
import {
  askAriadna,
  askForHelp,
  askSupport,
  type ContractConfig,
  helpAskInput,
  helpCases,
  helpFeedbackInput,
  helpRequestInput,
  helpScreen,
  planReceiptInput,
  planView,
  sendHelpFeedback,
  sendReceipt,
  supportInput,
} from "./acuerdo.js"
import { receiveAdminRequest } from "./acuerdo-pedidos.js"
import {
  choicesInput,
  deviceInput,
  deviceState,
  removeDevice,
  saveChoices,
  saveDevice,
  storeChoices,
  subscribeInput,
} from "./avisos.js"
import { cashBox, cashDay, receiveCash, receiveInput } from "./caja.js"
import {
  createExchange,
  exchangeInput,
  previewExchange,
  recordRefund,
  refundInput,
} from "./cambios.js"
import {
  addPhoto,
  catalog,
  createProduct,
  deleteProduct,
  imageType,
  photoContent,
  productDetail,
  productInput,
  productPatch,
  removePhoto,
  removeVariant,
  updateProduct,
  updateVariant,
  variantPatch,
} from "./catalogo.js"
import {
  customerDetail,
  customerPatch,
  listCustomers,
  markDistinct,
  mergeCustomers,
  pairInput,
  separateCustomer,
  similarCustomers,
  updateCustomer,
} from "./clientes.js"
import {
  configOverview,
  createDelivery,
  createPayment,
  deleteDelivery,
  deletePayment,
  deliveryInput,
  deliveryPatch,
  paymentInput,
  paymentPatch,
  paymentsAndDeliveries,
  updateDelivery,
  updatePayment,
} from "./configuracion.js"
import {
  type AccountConfig,
  AccountError,
  accountKeys,
  type Person,
  readAccountToken,
  receiveAccountEvent,
  syncAccountCopy,
} from "./cuenta.js"
import { dayQuery, dispatchBoard, dispatchCount } from "./despachos.js"
import { exampleSheet, MAX_SHEET_BYTES, uploadSheet } from "./hoja.js"
import { timeZoneInput } from "./hora.js"
import { storeHome } from "./inicio.js"
import { defaultLinkAdapters } from "./link-de-pago.js"
import {
  brandInput,
  checkLinkName,
  type ImageChange,
  imageKindOf,
  saveStoreBrand,
  setStoreData,
  storeBrand,
  storeDataInput,
  storeImageContent,
} from "./marca.js"
import {
  addReceipt,
  assignCourier,
  cancelInput,
  cancelOrder,
  changeInput,
  changeOrder,
  connectPaymentLink,
  courierInput,
  createOrder,
  createPaymentLink,
  deliverInput,
  disconnectPaymentLink,
  type LinkDeps,
  linkConnectionInput,
  listOrders,
  markDelivered,
  markMissed,
  markShipped,
  missedInput,
  noteSentByYou,
  ORDER_FILTERS,
  type OrderFilter,
  orderDetail,
  orderInput,
  paymentLinkStatus,
  previewChange,
  quoteInput,
  quoteOrder,
  receiptInput,
  receiptPhoto,
  receiveLinkNotice,
  reschedule,
  rescheduleInput,
  reviewInput,
  reviewPayment,
  sellable,
  sentByYouInput,
  setShipping,
  shipInput,
  shippingInput,
  undoInput,
  undoPayment,
} from "./pedidos.js"
import { correctFact, factInput } from "./perfil.js"
import { skipInput, skipStep } from "./primeros-pasos.js"
import { setDeliverySlots, slotsInput } from "./repartidores.js"
import { argosBoard } from "./sofi/argos.js"
import {
  agentSettings,
  agentSettingsInput,
  conversationView,
  customerMessageInput,
  newTestConversation,
  returnToSofi,
  saveAgentSettings,
  writeAsCustomer,
} from "./sofi/conversaciones.js"
import type { ChatModel } from "./sofi/modelo.js"
import { reportPeriod, storeReport } from "./sofi/reportes.js"
import { addMovement, kardex, movementInput } from "./stock.js"
import {
  acceptInvitation,
  answerSupport,
  changeRole,
  constraintError,
  createStore,
  endSupport,
  inStore,
  invitationInput,
  inviteToStore,
  leaveSupport,
  myStores,
  mySupportState,
  newStoreInput,
  removeMember,
  revokeInvitation,
  roleInput,
  StoreError,
  setStoreTimeZone,
  storeSummary,
  storeTeam,
} from "./tiendas.js"

export interface AppDeps {
  /** El rol de la aplicación: todo pedido de una persona, dentro de las reglas de su tienda. */
  appDb: Db
  /** El dueño de la base: la copia de las cuentas y los avisos. */
  ownerDb: Db
  account: AccountConfig
  /** La dirección de la app (`https://app.gestoria24.com`): el único origen que la llama y la base de los enlaces. */
  webURL: string
  /** El link de pago: sus proveedores, la llave de las credenciales y la dirección de este servidor. */
  link?: LinkDeps
  /** El modelo de Sofi (B5); null o sin él, Sofi no responde y la pantalla lo dice. */
  model?: ChatModel | null
  /** El acuerdo con la administración (B7); sin secreto, no se envía ni se pregunta. */
  contract?: ContractConfig
  /** La clave pública VAPID de los avisos al celular (tablero 15); sin ella no se ofrecen. */
  vapidPublicKey?: string
}

type Env = { Variables: { person: Person } }

/** Lo más que pesa un aviso de la cuenta o un pedido de la app. */
const MAX_BODY_BYTES = 64 * 1024
/** Una foto (ya achicada por la pantalla) y una hoja del catálogo pesan más: su ruta tiene su tope. */
const PHOTO_UPLOAD = /^\/api\/tiendas\/[^/]+\/productos\/[^/]+\/fotos$/
/** «Guardar» de Tu marca lleva el logo y la portada, cada una con su tope, y unos pocos campos. */
const BRAND_SAVE = /^\/api\/tiendas\/[^/]+\/marca$/
const SHEET_UPLOAD = /^\/api\/tiendas\/[^/]+\/catalogo\/hoja$/
/** La captura de un pago va en un formulario con su monto: la foto y un poco más. */
/** Los avisos del link de pago que se atienden por tienda en un minuto (Mercado Pago manda pocos). */
const MAX_LINK_NOTICES = 120
const LINK_NOTICE_WINDOW_MS = 60_000
const RECEIPT_UPLOAD = /^\/api\/tiendas\/[^/]+\/pedidos\/[^/]+\/(comprobante|entregado)$/
/** El comprobante del plan (una foto o un PDF) va a la administración: su propio tope. */
const PLAN_RECEIPT_UPLOAD = /^\/api\/tiendas\/[^/]+\/plan\/comprobante$/
/**
 * Lo que se escribe a Sofi en una prueba, por tienda, cada diez minutos: cada mensaje llama al
 * modelo y cuesta. Una conversación de prueba larga cabe de sobra.
 */
const MAX_TEST_MESSAGES = 60
const TEST_WINDOW_MS = 10 * 60_000

function errorBody(c: Context, code: string, message: string, fields?: Record<string, string>) {
  return {
    error: { code, message, ...(fields ? { fields } : {}) },
    requestId: c.get("requestId") as string | undefined,
  }
}

async function bodyOf<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw new StoreError(400, "VALIDATION_ERROR", "El pedido no se pudo leer")
  }
  return schema.parse(raw)
}

/**
 * El servidor de gestorIA (ADR 0203): su API, aparte de la de las clínicas. Reconoce a la
 * persona por el token de la cuenta (`Authorization: Bearer`), nunca por una cookie: su
 * pantalla está en otro origen y no hay sesión propia que robar.
 */
export function createApp(deps: AppDeps) {
  const keys: JWTVerifyGetKey = accountKeys(deps.account)
  const webOrigin = new URL(deps.webURL).origin
  const link: LinkDeps = deps.link ?? {
    adapters: defaultLinkAdapters(),
    secretsKey: null,
    apiURL: deps.webURL,
  }
  const app = new Hono<Env>()
  const contract: ContractConfig = deps.contract ?? { url: deps.account.url, secret: "" }

  app.use("*", requestId())
  app.use(
    "/api/*",
    cors({
      origin: (origin) => (origin === webOrigin ? origin : ""),
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE"],
      maxAge: 7200,
    }),
  )

  app.onError((error, c) => {
    if (error instanceof AccountError)
      return c.json(
        errorBody(c, error.code, error.message),
        error.code === "UNAUTHORIZED" ? 401 : 403,
      )
    if (error instanceof StoreError)
      return c.json(errorBody(c, error.code, error.message, error.fields), error.status)
    if (error instanceof ZodError) {
      const fields: Record<string, string> = {}
      for (const issue of error.issues) {
        const key = issue.path.join(".")
        if (key && !fields[key]) fields[key] = issue.message
      }
      return c.json(
        errorBody(c, "VALIDATION_ERROR", error.issues[0]?.message ?? "Revisa los datos", fields),
        400,
      )
    }
    const known = constraintError(error)
    if (known) return c.json(errorBody(c, known.code, known.message, known.fields), known.status)
    // Dos pedidos iguales a la vez (invitar dos veces, aceptar dos veces): uno gana.
    const cause = (error as { cause?: { code?: string } }).cause
    if ((error as { code?: string }).code === "23505" || cause?.code === "23505")
      return c.json(
        errorBody(c, "CONFLICT", "Eso ya se hizo hace un momento. Recarga para verlo."),
        409,
      )
    console.error("gestoria-api:", error)
    return c.json(errorBody(c, "INTERNAL", "Algo falló de nuestro lado. Inténtalo de nuevo."), 500)
  })

  // Tope de tamaño leído mientras llega (también sin `content-length`), según la ruta.
  const limit = (maxSize: number, message: string) =>
    bodyLimit({
      maxSize,
      onError: (c) => c.json(errorBody(c, "PAYLOAD_TOO_LARGE", message), 413),
    })
  const small = limit(MAX_BODY_BYTES, "Pedido demasiado grande")
  const photo = limit(MAX_PHOTO_BYTES, "La foto pesa demasiado. Prueba con otra más chica.")
  const brandSave = limit(
    2 * MAX_PHOTO_BYTES + 16 * 1024,
    "El logo o la portada pesan demasiado. Prueba con otra más chica.",
  )
  const sheet = limit(MAX_SHEET_BYTES, "La hoja es muy grande: divídela en partes")
  const receipt = limit(
    MAX_PHOTO_BYTES + 16 * 1024,
    "La captura pesa demasiado. Prueba con otra más chica.",
  )
  const planReceipt = limit(
    CONTRACT_MAX_RECEIPT_BYTES + 16 * 1024,
    "El archivo pesa demasiado: hasta 1,5 MB.",
  )
  app.use("*", (c, next) => {
    if (c.req.method === "POST" && PHOTO_UPLOAD.test(c.req.path)) return photo(c, next)
    if (c.req.method === "POST" && BRAND_SAVE.test(c.req.path)) return brandSave(c, next)
    if (c.req.method === "POST" && SHEET_UPLOAD.test(c.req.path)) return sheet(c, next)
    if (c.req.method === "POST" && RECEIPT_UPLOAD.test(c.req.path)) return receipt(c, next)
    if (c.req.method === "POST" && PLAN_RECEIPT_UPLOAD.test(c.req.path)) return planReceipt(c, next)
    return small(c, next)
  })

  app.get("/health", (c) => c.json({ ok: true }))

  // Los avisos firmados de la cuenta (Standard Webhooks): de servidor a servidor, sin CORS.
  app.post("/avisos/cuenta", async (c) => {
    if (Number(c.req.header("content-length") ?? "0") > MAX_BODY_BYTES)
      return c.json(errorBody(c, "PAYLOAD_TOO_LARGE", "Aviso demasiado grande"), 413)
    const body = await c.req.text()
    if (body.length > MAX_BODY_BYTES)
      return c.json(errorBody(c, "PAYLOAD_TOO_LARGE", "Aviso demasiado grande"), 413)
    const result = await receiveAccountEvent(deps.ownerDb, deps.account, {
      headers: c.req.raw.headers,
      body,
    })
    return c.json({ message: result.message }, result.status)
  })

  // Lo que pide la administración (ADR 0214): firmado con el secreto del acuerdo, de servidor a
  // servidor. Sin el secreto no existe.
  app.post(APP_CONTRACT_PATHS.requests, async (c) => {
    const body = await c.req.text()
    const result = await receiveAdminRequest(deps.ownerDb, contract, {
      headers: c.req.raw.headers,
      body,
    })
    return c.json(result.body, result.status)
  })

  // Los avisos del proveedor del link de pago (B4): de servidor a servidor. El pago se lee del
  // proveedor; el aviso solo dice cuál mirar. Cada aviso consulta al proveedor con la cuenta de
  // la tienda: con un tope por tienda, nadie la gasta mandando avisos inventados.
  const noticesBy = new Map<string, { since: number; count: number }>()
  app.post("/avisos/link-de-pago/:storeId", async (c) => {
    const storeId = c.req.param("storeId")
    const now = Date.now()
    const seen = noticesBy.get(storeId)
    if (!seen || now - seen.since > LINK_NOTICE_WINDOW_MS)
      noticesBy.set(storeId, { since: now, count: 1 })
    else if (++seen.count > MAX_LINK_NOTICES)
      return c.json(errorBody(c, "TOO_MANY", "Demasiados avisos; reintenta en un minuto"), 429)
    if (noticesBy.size > 10_000) noticesBy.clear()
    const body = await c.req.text()
    const result = await receiveLinkNotice(
      deps.ownerDb,
      storeId,
      { query: new URL(c.req.url).searchParams, headers: c.req.raw.headers, body },
      link,
    )
    return c.json({ message: result.message }, result.status)
  })

  // Todo lo de /api pide el token de la cuenta y una copia activa.
  app.use("/api/*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next()
    const header = c.req.header("authorization") ?? ""
    const token = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header)?.[1]
    if (!token) return c.json(errorBody(c, "UNAUTHORIZED", "Entra con tu cuenta para seguir."), 401)
    const claims = await readAccountToken(token, deps.account, keys)
    const person = await syncAccountCopy(deps.ownerDb, claims)
    c.set("person", { ...person, staffVerified: claims.staffVerified === true })
    return next()
  })

  app.get("/api/yo", async (c) => {
    const { staffVerified: _, ...person } = c.get("person")
    return c.json({ person, ...(await myStores(deps.appDb, c.get("person"))) })
  })

  app.post("/api/tiendas", async (c) => {
    const input = await bodyOf(c, newStoreInput)
    return c.json({ store: await createStore(deps.appDb, c.get("person"), input) }, 201)
  })

  app.get("/api/tiendas/:id", async (c) =>
    c.json({ store: await storeSummary(deps.appDb, c.get("person"), c.req.param("id")) }),
  )

  // La hora de la tienda (ADR 0222): con ella se cuenta «hoy».
  app.patch("/api/tiendas/:id/hora", async (c) => {
    const input = await bodyOf(c, timeZoneInput)
    return c.json({
      store: await setStoreTimeZone(deps.appDb, c.get("person"), c.req.param("id"), input),
    })
  })

  // Configuración › Datos de la tienda y Tu marca (lienzo «gestorIA como odentIA», tablero 10).
  app.patch("/api/tiendas/:id/datos", async (c) => {
    const input = await bodyOf(c, storeDataInput)
    return c.json({
      store: await setStoreData(deps.appDb, c.get("person"), c.req.param("id"), input),
    })
  })
  app.get("/api/tiendas/:id/marca", async (c) =>
    c.json({ brand: await storeBrand(deps.appDb, c.get("person"), c.req.param("id")) }),
  )
  // «Guardar» de Tu marca: todo de una vez, en un formulario con el logo y la portada si cambian.
  app.post("/api/tiendas/:id/marca", async (c) => {
    let form: FormData
    try {
      form = await c.req.formData()
    } catch {
      throw new StoreError(400, "VALIDATION_ERROR", "Tu marca no se pudo leer")
    }
    const parsed = brandInput.safeParse({
      publicName: String(form.get("publicName") ?? ""),
      brandColor: String(form.get("brandColor") ?? ""),
      link: form.get("link") ? String(form.get("link")) : null,
    })
    if (!parsed.success) throw parsed.error
    const remove = new Set(form.getAll("quitar").map(String))
    const images: Partial<Record<StoreImageKind, ImageChange>> = {}
    for (const kind of STORE_IMAGE_KINDS) {
      const file = form.get(kind)
      if (file instanceof File && file.size > 0)
        images[kind] = new Uint8Array(await file.arrayBuffer())
      else if (remove.has(kind)) images[kind] = "quitar"
    }
    return c.json({
      brand: await saveStoreBrand(
        deps.appDb,
        c.get("person"),
        c.req.param("id"),
        parsed.data,
        images,
      ),
    })
  })
  // Lo que se dice del nombre del link mientras se escribe (antes que `:kind`).
  app.get("/api/tiendas/:id/marca/link", async (c) =>
    c.json({
      check: await checkLinkName(
        deps.appDb,
        c.get("person"),
        c.req.param("id"),
        (c.req.query("nombre") ?? "").slice(0, 80),
      ),
    }),
  )
  app.get("/api/tiendas/:id/marca/:kind", async (c) => {
    const kind = imageKindOf(c.req.param("kind"))
    const image = await storeImageContent(deps.appDb, c.get("person"), c.req.param("id"), kind)
    return c.body(new Uint8Array(image.content), 200, {
      "content-type": image.contentType,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      // Cambia con la misma dirección: la pantalla la pide con su versión (`?v=`).
      "cache-control": "private, max-age=86400",
    })
  })

  app.get("/api/tiendas/:id/equipo", async (c) =>
    c.json(await storeTeam(deps.appDb, c.get("person"), c.req.param("id"))),
  )

  app.post("/api/tiendas/:id/invitaciones", async (c) => {
    const input = await bodyOf(c, invitationInput)
    const invitation = await inviteToStore(deps.appDb, c.get("person"), c.req.param("id"), input)
    return c.json(
      { invitation: { ...invitation, link: `${webOrigin}/invitacion/${invitation.id}` } },
      201,
    )
  })

  app.delete("/api/tiendas/:id/invitaciones/:invitationId", async (c) => {
    await revokeInvitation(
      deps.appDb,
      c.get("person"),
      c.req.param("id"),
      c.req.param("invitationId"),
    )
    return c.body(null, 204)
  })

  app.patch("/api/tiendas/:id/equipo/:userId", async (c) => {
    const { role } = await bodyOf(c, roleInput)
    await changeRole(deps.appDb, c.get("person"), c.req.param("id"), c.req.param("userId"), role)
    return c.body(null, 204)
  })

  app.delete("/api/tiendas/:id/equipo/:userId", async (c) => {
    await removeMember(deps.appDb, c.get("person"), c.req.param("id"), c.req.param("userId"))
    return c.body(null, 204)
  })

  app.post("/api/invitaciones/:id/aceptar", async (c) =>
    c.json(await acceptInvitation(deps.appDb, c.get("person"), c.req.param("id"))),
  )

  // Configuración abre con «Lo que falta para vender» (lienzo «gestorIA · Configuración, de
  // nuevo», tablero 3): cómo está cada parte, con lo guardado en cada una.
  app.get("/api/tiendas/:id/configuracion/resumen", async (c) =>
    c.json(await configOverview(deps.appDb, c.get("person"), c.req.param("id"))),
  )

  // La configuración (B3): medios de pago y formas de entrega.
  app.get("/api/tiendas/:id/pagos-y-entregas", async (c) =>
    c.json(await paymentsAndDeliveries(deps.appDb, c.get("person"), c.req.param("id"))),
  )
  app.post("/api/tiendas/:id/medios-de-pago", async (c) => {
    const input = await bodyOf(c, paymentInput)
    const method = await createPayment(deps.appDb, c.get("person"), c.req.param("id"), input)
    return c.json({ method }, 201)
  })
  app.patch("/api/tiendas/:id/medios-de-pago/:methodId", async (c) => {
    const patch = await bodyOf(c, paymentPatch)
    const { id, methodId } = c.req.param()
    return c.json({ method: await updatePayment(deps.appDb, c.get("person"), id, methodId, patch) })
  })
  app.delete("/api/tiendas/:id/medios-de-pago/:methodId", async (c) => {
    const { id, methodId } = c.req.param()
    await deletePayment(deps.appDb, c.get("person"), id, methodId)
    return c.body(null, 204)
  })
  app.post("/api/tiendas/:id/formas-de-entrega", async (c) => {
    const input = await bodyOf(c, deliveryInput)
    const method = await createDelivery(deps.appDb, c.get("person"), c.req.param("id"), input)
    return c.json({ method }, 201)
  })
  app.patch("/api/tiendas/:id/formas-de-entrega/:methodId", async (c) => {
    const patch = await bodyOf(c, deliveryPatch)
    const { id, methodId } = c.req.param()
    return c.json({
      method: await updateDelivery(deps.appDb, c.get("person"), id, methodId, patch),
    })
  })
  app.delete("/api/tiendas/:id/formas-de-entrega/:methodId", async (c) => {
    const { id, methodId } = c.req.param()
    await deleteDelivery(deps.appDb, c.get("person"), id, methodId)
    return c.body(null, 204)
  })

  // El catálogo (B3): productos, variantes, fotos, stock y la hoja.
  app.patch("/api/tiendas/:id/franjas", async (c) => {
    const input = await bodyOf(c, slotsInput)
    return c.json(await setDeliverySlots(deps.appDb, c.get("person"), c.req.param("id"), input))
  })
  app.get("/api/tiendas/:id/catalogo", async (c) =>
    c.json(await catalog(deps.appDb, c.get("person"), c.req.param("id"))),
  )
  app.get("/api/tiendas/:id/catalogo/hoja-de-ejemplo", async (c) => {
    // Se pide desde la tienda, como todo lo de /api; la hoja no lleva datos de nadie.
    await inStore(deps.appDb, c.get("person"), c.req.param("id"), "catalogo.ver", async () => {})
    return c.body(exampleSheet(), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="catalogo-ejemplo.csv"',
    })
  })
  app.post("/api/tiendas/:id/catalogo/hoja", async (c) => {
    const text = await c.req.text()
    const confirm = c.req.query("confirmar") === "1"
    return c.json(await uploadSheet(deps.appDb, c.get("person"), c.req.param("id"), text, confirm))
  })
  app.post("/api/tiendas/:id/productos", async (c) => {
    const input = await bodyOf(c, productInput)
    const product = await createProduct(deps.appDb, c.get("person"), c.req.param("id"), input)
    return c.json({ product }, 201)
  })
  app.get("/api/tiendas/:id/productos/:productId", async (c) => {
    const { id, productId } = c.req.param()
    return c.json({ product: await productDetail(deps.appDb, c.get("person"), id, productId) })
  })
  app.patch("/api/tiendas/:id/productos/:productId", async (c) => {
    const patch = await bodyOf(c, productPatch)
    const { id, productId } = c.req.param()
    return c.json({
      product: await updateProduct(deps.appDb, c.get("person"), id, productId, patch),
    })
  })
  app.delete("/api/tiendas/:id/productos/:productId", async (c) => {
    const { id, productId } = c.req.param()
    await deleteProduct(deps.appDb, c.get("person"), id, productId)
    return c.body(null, 204)
  })
  app.post("/api/tiendas/:id/productos/:productId/fotos", async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    const { id, productId } = c.req.param()
    return c.json({ photo: await addPhoto(deps.appDb, c.get("person"), id, productId, bytes) }, 201)
  })
  app.get("/api/tiendas/:id/fotos/:photoId", async (c) => {
    const { id, photoId } = c.req.param()
    const photo = await photoContent(deps.appDb, c.get("person"), id, photoId)
    return c.body(new Uint8Array(photo.content), 200, {
      "content-type": photo.contentType,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      // La foto no cambia (otra foto es otro id); solo quien la pidió la guarda.
      "cache-control": "private, max-age=86400, immutable",
    })
  })
  app.delete("/api/tiendas/:id/fotos/:photoId", async (c) => {
    const { id, photoId } = c.req.param()
    await removePhoto(deps.appDb, c.get("person"), id, photoId)
    return c.body(null, 204)
  })
  app.patch("/api/tiendas/:id/variantes/:variantId", async (c) => {
    const patch = await bodyOf(c, variantPatch)
    const { id, variantId } = c.req.param()
    return c.json({
      product: await updateVariant(deps.appDb, c.get("person"), id, variantId, patch),
    })
  })
  app.delete("/api/tiendas/:id/variantes/:variantId", async (c) => {
    const { id, variantId } = c.req.param()
    return c.json({ product: await removeVariant(deps.appDb, c.get("person"), id, variantId) })
  })
  app.get("/api/tiendas/:id/variantes/:variantId/kardex", async (c) => {
    const { id, variantId } = c.req.param()
    return c.json(await kardex(deps.appDb, c.get("person"), id, variantId))
  })
  app.post("/api/tiendas/:id/variantes/:variantId/movimientos", async (c) => {
    const input = await bodyOf(c, movementInput)
    const { id, variantId } = c.req.param()
    const movement = await addMovement(deps.appDb, c.get("person"), id, variantId, input)
    return c.json({ movement }, 201)
  })

  // Inicio (tablero 5): lo que le toca a cada rol, las cifras del día y los primeros pasos de una
  // tienda nueva (tablero 16), que se saltan con «No lo necesito».
  app.get("/api/tiendas/:id/inicio", async (c) =>
    c.json(await storeHome(deps.appDb, c.get("person"), c.req.param("id"))),
  )
  app.post("/api/tiendas/:id/primeros-pasos/saltar", async (c) => {
    const input = await bodyOf(c, skipInput)
    return c.json(await skipStep(deps.appDb, c.get("person"), c.req.param("id"), input))
  })

  // Los pedidos (B4): armar, cobrar y entregar.
  app.get("/api/tiendas/:id/pedidos", async (c) => {
    const filter = (c.req.query("filtro") ?? "abiertos") as OrderFilter
    if (!Object.hasOwn(ORDER_FILTERS, filter))
      throw new StoreError(400, "VALIDATION_ERROR", "Ese filtro no existe")
    return c.json(await listOrders(deps.appDb, c.get("person"), c.req.param("id"), filter))
  })
  app.get("/api/tiendas/:id/pedidos/para-vender", async (c) =>
    c.json(await sellable(deps.appDb, c.get("person"), c.req.param("id"))),
  )
  app.post("/api/tiendas/:id/pedidos/calcular", async (c) => {
    const input = await bodyOf(c, quoteInput)
    return c.json(await quoteOrder(deps.appDb, c.get("person"), c.req.param("id"), input))
  })
  app.post("/api/tiendas/:id/pedidos", async (c) => {
    const input = await bodyOf(c, orderInput)
    const order = await createOrder(deps.appDb, c.get("person"), c.req.param("id"), input)
    return c.json({ order }, 201)
  })
  app.get("/api/tiendas/:id/pedidos/:orderId", async (c) => {
    const { id, orderId } = c.req.param()
    return c.json({ order: await orderDetail(deps.appDb, c.get("person"), id, orderId) })
  })
  app.post("/api/tiendas/:id/pedidos/:orderId/link", async (c) => {
    const { id, orderId } = c.req.param()
    return c.json(await createPaymentLink(deps.appDb, c.get("person"), id, orderId, link))
  })
  app.post("/api/tiendas/:id/pedidos/:orderId/comprobante", async (c) => {
    const { id, orderId } = c.req.param()
    let form: FormData
    try {
      form = await c.req.formData()
    } catch {
      throw new StoreError(400, "VALIDATION_ERROR", "El comprobante no se pudo leer")
    }
    const file = form.get("captura")
    const input = receiptInput.parse({
      amountCents: Number(form.get("amountCents")),
      operation: String(form.get("operation") ?? ""),
      methodId: String(form.get("methodId") ?? ""),
    })
    const photo =
      file instanceof File && file.size > 0 ? new Uint8Array(await file.arrayBuffer()) : null
    const order = await addReceipt(deps.appDb, c.get("person"), id, orderId, input, photo)
    return c.json({ order })
  })
  app.post("/api/tiendas/:id/pedidos/:orderId/pagos/:paymentId/revision", async (c) => {
    const input = await bodyOf(c, reviewInput)
    const { id, orderId, paymentId } = c.req.param()
    return c.json({
      order: await reviewPayment(deps.appDb, c.get("person"), id, orderId, paymentId, input),
    })
  })
  app.post("/api/tiendas/:id/pedidos/:orderId/pagos/:paymentId/deshacer", async (c) => {
    const input = await bodyOf(c, undoInput)
    const { id, orderId, paymentId } = c.req.param()
    return c.json({
      order: await undoPayment(deps.appDb, c.get("person"), id, orderId, paymentId, input),
    })
  })
  app.get("/api/tiendas/:id/pedidos/:orderId/pagos/:paymentId/captura", async (c) => {
    const { id, orderId, paymentId } = c.req.param()
    const photo = await receiptPhoto(deps.appDb, c.get("person"), id, orderId, paymentId)
    return c.body(new Uint8Array(photo.content), 200, {
      "content-type": photo.contentType,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=86400, immutable",
    })
  })
  app.post("/api/tiendas/:id/pedidos/:orderId/salio", async (c) => {
    const input = await bodyOf(c, shipInput)
    const { id, orderId } = c.req.param()
    return c.json({ order: await markShipped(deps.appDb, c.get("person"), id, orderId, input) })
  })
  // «Entregado», con lo cobrado en la puerta y, si se quiere, la foto del voucher del POS (entonces
  // llega como formulario: `datos` con lo cobrado y `voucher` con la foto).
  app.post("/api/tiendas/:id/pedidos/:orderId/entregado", async (c) => {
    const { id, orderId } = c.req.param()
    let input: z.infer<typeof deliverInput>
    let voucher: { photo: Uint8Array; type: PhotoType } | null = null
    if ((c.req.header("content-type") ?? "").startsWith("multipart/form-data")) {
      let form: FormData
      try {
        form = await c.req.formData()
      } catch {
        throw new StoreError(400, "VALIDATION_ERROR", "Lo cobrado no se pudo leer")
      }
      try {
        input = deliverInput.parse(JSON.parse(String(form.get("datos") ?? "{}")))
      } catch (error) {
        if (error instanceof ZodError) throw error
        throw new StoreError(400, "VALIDATION_ERROR", "Lo cobrado no se pudo leer")
      }
      const file = form.get("voucher")
      if (file instanceof File && file.size > 0) {
        const photo = new Uint8Array(await file.arrayBuffer())
        if (photo.length > MAX_PHOTO_BYTES)
          throw new StoreError(400, "PHOTO_TOO_LARGE", "La foto pesa demasiado. Prueba con otra.")
        const type = imageType(photo)
        if (!type) throw new StoreError(400, "PHOTO_TYPE", "Sube la foto en JPG, PNG o WebP")
        voucher = { photo, type }
      }
    } else input = await bodyOf(c, deliverInput)
    return c.json({
      order: await markDelivered(deps.appDb, c.get("person"), id, orderId, input, voucher),
    })
  })
  // Corregir sin anular (ADR 0226): cambiar, no se entregó y pasar a otro día.
  app.post("/api/tiendas/:id/pedidos/:orderId/cambiar/calcular", async (c) => {
    const input = await bodyOf(c, changeInput)
    const { id, orderId } = c.req.param()
    return c.json(await previewChange(deps.appDb, c.get("person"), id, orderId, input))
  })
  app.post("/api/tiendas/:id/pedidos/:orderId/cambiar", async (c) => {
    const input = await bodyOf(c, changeInput)
    const { id, orderId } = c.req.param()
    return c.json({ order: await changeOrder(deps.appDb, c.get("person"), id, orderId, input) })
  })
  app.post("/api/tiendas/:id/pedidos/:orderId/no-se-entrego", async (c) => {
    const input = await bodyOf(c, missedInput)
    const { id, orderId } = c.req.param()
    return c.json({ order: await markMissed(deps.appDb, c.get("person"), id, orderId, input) })
  })
  app.post("/api/tiendas/:id/pedidos/:orderId/pasar-a", async (c) => {
    const input = await bodyOf(c, rescheduleInput)
    const { id, orderId } = c.req.param()
    return c.json({ order: await reschedule(deps.appDb, c.get("person"), id, orderId, input) })
  })
  // Cambiar o devolver después de entregar (tablero 17): un pedido nuevo, enlazado al entregado.
  app.post("/api/tiendas/:id/pedidos/:orderId/cambio/calcular", async (c) => {
    const input = await bodyOf(c, exchangeInput)
    const { id, orderId } = c.req.param()
    return c.json(await previewExchange(deps.appDb, c.get("person"), id, orderId, input))
  })
  app.post("/api/tiendas/:id/pedidos/:orderId/cambio", async (c) => {
    const input = await bodyOf(c, exchangeInput)
    const { id, orderId } = c.req.param()
    return c.json(await createExchange(deps.appDb, c.get("person"), id, orderId, input), 201)
  })
  // «Anotar la devolución»: el dinero que la tienda devolvió de lo que sobra, con su medio.
  app.post("/api/tiendas/:id/pedidos/:orderId/devolucion", async (c) => {
    const input = await bodyOf(c, refundInput)
    const { id, orderId } = c.req.param()
    return c.json({ order: await recordRefund(deps.appDb, c.get("person"), id, orderId, input) })
  })
  // Despachos (entrega 3): quién lo lleva, la agencia y «Avisar» (enviado por usted).
  app.post("/api/tiendas/:id/pedidos/:orderId/repartidor", async (c) => {
    const input = await bodyOf(c, courierInput)
    const { id, orderId } = c.req.param()
    return c.json({ order: await assignCourier(deps.appDb, c.get("person"), id, orderId, input) })
  })
  app.post("/api/tiendas/:id/pedidos/:orderId/envio", async (c) => {
    const input = await bodyOf(c, shippingInput)
    const { id, orderId } = c.req.param()
    return c.json({ order: await setShipping(deps.appDb, c.get("person"), id, orderId, input) })
  })
  app.post("/api/tiendas/:id/pedidos/:orderId/avisado", async (c) => {
    const input = await bodyOf(c, sentByYouInput)
    const { id, orderId } = c.req.param()
    return c.json({ order: await noteSentByYou(deps.appDb, c.get("person"), id, orderId, input) })
  })
  app.post("/api/tiendas/:id/pedidos/:orderId/anular", async (c) => {
    const input = await bodyOf(c, cancelInput)
    const { id, orderId } = c.req.param()
    return c.json({ order: await cancelOrder(deps.appDb, c.get("person"), id, orderId, input) })
  })

  // Despachos (entrega 3): las entregas de un día y lo que el menú cuenta.
  app.get("/api/tiendas/:id/despachos", async (c) => {
    const day = dayQuery.parse(c.req.query("dia") || undefined)
    return c.json(await dispatchBoard(deps.appDb, c.get("person"), c.req.param("id"), day))
  })
  app.get("/api/tiendas/:id/despachos/resumen", async (c) =>
    c.json(await dispatchCount(deps.appDb, c.get("person"), c.req.param("id"))),
  )

  // Las clientas (entrega 4): la lista, la ficha, «¿Es la misma clienta?», unir y separar.
  app.get("/api/tiendas/:id/clientes", async (c) =>
    c.json(
      await listCustomers(deps.appDb, c.get("person"), c.req.param("id"), c.req.query("buscar")),
    ),
  )
  // «?de=…»: solo las de esa ficha (desde su aviso).
  app.get("/api/tiendas/:id/clientes/parecidas", async (c) =>
    c.json(
      await similarCustomers(deps.appDb, c.get("person"), c.req.param("id"), c.req.query("de")),
    ),
  )
  app.post("/api/tiendas/:id/clientes/unir", async (c) => {
    const input = await bodyOf(c, pairInput)
    return c.json(await mergeCustomers(deps.appDb, c.get("person"), c.req.param("id"), input))
  })
  app.post("/api/tiendas/:id/clientes/distintas", async (c) => {
    const input = await bodyOf(c, pairInput)
    await markDistinct(deps.appDb, c.get("person"), c.req.param("id"), input)
    return c.body(null, 204)
  })
  app.get("/api/tiendas/:id/clientes/:customerId", async (c) => {
    const { id, customerId } = c.req.param()
    return c.json({ customer: await customerDetail(deps.appDb, c.get("person"), id, customerId) })
  })
  app.patch("/api/tiendas/:id/clientes/:customerId", async (c) => {
    const patch = await bodyOf(c, customerPatch)
    const { id, customerId } = c.req.param()
    return c.json(await updateCustomer(deps.appDb, c.get("person"), id, customerId, patch))
  })
  app.post("/api/tiendas/:id/clientes/:customerId/separar", async (c) => {
    const { id, customerId } = c.req.param()
    return c.json(await separateCustomer(deps.appDb, c.get("person"), id, customerId))
  })
  // «Corregir» un dato de «Lo que Argos sabe de ella»: queda «Lo puso la tienda».
  app.post("/api/tiendas/:id/clientes/:customerId/datos", async (c) => {
    const input = await bodyOf(c, factInput)
    const { id, customerId } = c.req.param()
    return c.json(await correctFact(deps.appDb, c.get("person"), id, customerId, input))
  })

  // El link de pago de la tienda (B4): se conecta en Pagos y entregas.
  app.get("/api/tiendas/:id/link-de-pago", async (c) =>
    c.json(await paymentLinkStatus(deps.appDb, c.get("person"), c.req.param("id"), link)),
  )
  app.patch("/api/tiendas/:id/link-de-pago", async (c) => {
    const input = await bodyOf(c, linkConnectionInput)
    return c.json(
      await connectPaymentLink(deps.appDb, c.get("person"), c.req.param("id"), input, link),
    )
  })
  app.delete("/api/tiendas/:id/link-de-pago", async (c) => {
    await disconnectPaymentLink(deps.appDb, c.get("person"), c.req.param("id"))
    return c.body(null, 204)
  })

  // Sofi (B5): lo que pone el dueño y la conversación de prueba.
  const sofi = { appDb: deps.appDb, lockDb: deps.ownerDb, model: deps.model ?? null, link }
  app.get("/api/tiendas/:id/sofi", async (c) =>
    c.json(
      await agentSettings(deps.appDb, c.get("person"), c.req.param("id"), Boolean(sofi.model)),
    ),
  )
  app.patch("/api/tiendas/:id/sofi", async (c) => {
    const input = await bodyOf(c, agentSettingsInput)
    return c.json({
      settings: await saveAgentSettings(deps.appDb, c.get("person"), c.req.param("id"), input),
    })
  })
  app.post("/api/tiendas/:id/sofi/pruebas", async (c) =>
    c.json(await newTestConversation(deps.appDb, c.get("person"), c.req.param("id")), 201),
  )
  app.get("/api/tiendas/:id/conversaciones/:conversationId", async (c) => {
    const { id, conversationId } = c.req.param()
    return c.json({
      conversation: await conversationView(deps.appDb, c.get("person"), id, conversationId),
    })
  })
  const testsBy = new Map<string, { since: number; count: number }>()
  app.post("/api/tiendas/:id/conversaciones/:conversationId/cliente", async (c) => {
    const input = await bodyOf(c, customerMessageInput)
    const { id, conversationId } = c.req.param()
    // Primero el permiso: quien no es del equipo no gasta el cupo de la tienda.
    await inStore(deps.appDb, c.get("person"), id, "ventas.atender", async () => {})
    const now = Date.now()
    const seen = testsBy.get(id)
    if (!seen || now - seen.since > TEST_WINDOW_MS) testsBy.set(id, { since: now, count: 1 })
    else if (++seen.count > MAX_TEST_MESSAGES)
      throw new StoreError(
        429,
        "TOO_MANY",
        "Muchos mensajes de prueba seguidos. Espera unos minutos y sigue.",
      )
    if (testsBy.size > 10_000) testsBy.clear()
    return c.json(await writeAsCustomer(sofi, c.get("person"), id, conversationId, input))
  })
  app.post("/api/tiendas/:id/conversaciones/:conversationId/devolver", async (c) => {
    const { id, conversationId } = c.req.param()
    return c.json({
      conversation: await returnToSofi(deps.appDb, c.get("person"), id, conversationId),
    })
  })

  // Caja (entrega 3): lo cobrado del día y «Recibí» el efectivo. Solo Dueño y Administrador.
  app.get("/api/tiendas/:id/caja", async (c) => {
    const day = cashDay.parse(c.req.query("dia") || undefined)
    return c.json(await cashBox(deps.appDb, c.get("person"), c.req.param("id"), day))
  })
  app.post("/api/tiendas/:id/caja/recibi", async (c) => {
    const input = await bodyOf(c, receiveInput)
    return c.json(await receiveCash(deps.appDb, c.get("person"), c.req.param("id"), input), 201)
  })

  // Reportes y Argos (B5): solo Dueño y Administrador.
  app.get("/api/tiendas/:id/reportes", async (c) => {
    const period = reportPeriod.parse(c.req.query("periodo") ?? undefined)
    return c.json(await storeReport(deps.appDb, c.get("person"), c.req.param("id"), period))
  })
  app.get("/api/tiendas/:id/argos", async (c) =>
    c.json(await argosBoard(deps.appDb, c.get("person"), c.req.param("id"))),
  )

  // «Plan y pagos» (B7): lo que dice la administración de la tienda, pedirle ayuda y subirle un
  // comprobante. Solo el Dueño.
  app.get("/api/tiendas/:id/plan", async (c) =>
    c.json(await planView(deps.appDb, deps.ownerDb, contract, c.get("person"), c.req.param("id"))),
  )
  app.post("/api/tiendas/:id/plan/ayuda", async (c) => {
    const input = await bodyOf(c, supportInput)
    await askSupport(deps.appDb, contract, c.get("person"), c.req.param("id"), input)
    return c.body(null, 204)
  })
  app.post("/api/tiendas/:id/plan/comprobante", async (c) => {
    let form: FormData
    try {
      form = await c.req.formData()
    } catch {
      throw new StoreError(400, "VALIDATION_ERROR", "El comprobante no se pudo leer")
    }
    const file = form.get("archivo")
    const input = planReceiptInput.parse({
      chargeId: String(form.get("chargeId") ?? ""),
      amountCents: Number(form.get("amountCents")),
      methodCode: String(form.get("methodCode") ?? ""),
      note: String(form.get("note") ?? "") || undefined,
    })
    const bytes =
      file instanceof File && file.size > 0 ? new Uint8Array(await file.arrayBuffer()) : null
    await sendReceipt(deps.appDb, contract, c.get("person"), c.req.param("id"), input, bytes)
    return c.body(null, 204)
  })

  // La Ayuda (ADR 0227): el panel común de todas las apps pide aquí la pantalla, le pregunta a
  // Ariadna con la guía de gestorIA, dice si le sirvió y escribe a soporte. «Tus casos con
  // soporte» es de quien puede escribirle (`ayuda.pedir`).
  app.get("/api/tiendas/:id/ayuda/screen", async (c) =>
    c.json({
      data: await helpScreen(
        deps.appDb,
        c.get("person"),
        c.req.param("id"),
        (c.req.query("path") ?? "/").slice(0, 300),
      ),
    }),
  )
  app.post("/api/tiendas/:id/ayuda/ask", async (c) => {
    const input = await bodyOf(c, helpAskInput)
    return c.json({
      data: await askAriadna(deps.appDb, contract, c.get("person"), c.req.param("id"), input),
    })
  })
  app.post("/api/tiendas/:id/ayuda/ask/:askId/feedback", async (c) => {
    const { id, askId } = c.req.param()
    const { helpful } = await bodyOf(c, helpFeedbackInput)
    await sendHelpFeedback(deps.appDb, contract, c.get("person"), id, askId, { helpful })
    return c.body(null, 204)
  })
  app.post("/api/tiendas/:id/ayuda/ask/:askId/none", async (c) => {
    const { id, askId } = c.req.param()
    await sendHelpFeedback(deps.appDb, contract, c.get("person"), id, askId, { noneFits: true })
    return c.body(null, 204)
  })
  app.post("/api/tiendas/:id/ayuda/requests", async (c) => {
    const input = await bodyOf(c, helpRequestInput)
    await askForHelp(deps.appDb, contract, c.get("person"), c.req.param("id"), input)
    return c.body(null, 204)
  })
  app.get("/api/tiendas/:id/ayuda/casos", async (c) =>
    c.json(await helpCases(deps.appDb, c.get("person"), c.req.param("id"))),
  )

  // Soporte de gestorIA (ADR 0214): el Dueño o un Administrador lo deja entrar, o no, y lo saca.
  app.post("/api/tiendas/:id/soporte/:accessId/aceptar", async (c) => {
    const { id, accessId } = c.req.param()
    await answerSupport(deps.appDb, c.get("person"), id, accessId, true)
    return c.body(null, 204)
  })
  app.post("/api/tiendas/:id/soporte/:accessId/rechazar", async (c) => {
    const { id, accessId } = c.req.param()
    await answerSupport(deps.appDb, c.get("person"), id, accessId, false)
    return c.body(null, 204)
  })
  app.post("/api/tiendas/:id/soporte/:accessId/quitar", async (c) => {
    const { id, accessId } = c.req.param()
    await endSupport(deps.appDb, c.get("person"), id, accessId)
    return c.body(null, 204)
  })
  // Soporte mirando (ADR 0219): cómo está su entrada (lo dice el servidor, con su motivo) y
  // «Salir», que termina solo la mirada.
  app.get("/api/tiendas/:id/soporte/mio", async (c) =>
    c.json(await mySupportState(deps.appDb, c.get("person"), c.req.param("id"))),
  )
  app.post("/api/tiendas/:id/soporte/salir", async (c) => {
    await leaveSupport(deps.appDb, c.get("person"), c.req.param("id"))
    return c.body(null, 204)
  })

  // Los avisos al celular (tablero 15): la clave con que el navegador se suscribe y cada celular,
  // que es de la persona (le llega lo de todas sus tiendas). Qué le llega sale de su rol al enviar.
  app.get("/api/avisos/clave", (c) => c.json({ publicKey: deps.vapidPublicKey || null }))
  app.post("/api/avisos/celular", async (c) => {
    if (!deps.vapidPublicKey)
      return c.json(
        errorBody(c, "UNAVAILABLE", "Los avisos al celular todavía no están disponibles"),
        503,
      )
    const input = await bodyOf(c, subscribeInput)
    return c.json(await saveDevice(deps.appDb, deps.ownerDb, c.get("person"), input))
  })
  // ¿Este celular recibe hoy mis avisos? Otra persona pudo activarlos después en el mismo navegador.
  app.post("/api/avisos/celular/estado", async (c) => {
    const input = await bodyOf(c, deviceInput)
    return c.json(await deviceState(deps.appDb, c.get("person"), input))
  })
  app.delete("/api/avisos/celular", async (c) => {
    const input = await bodyOf(c, deviceInput)
    return c.json(await removeDevice(deps.appDb, c.get("person"), input))
  })
  // Configuración › Avisos al celular: qué le llega de esta tienda, entre lo que su rol resuelve.
  app.get("/api/tiendas/:id/avisos", async (c) =>
    c.json(await storeChoices(deps.appDb, c.get("person"), c.req.param("id"))),
  )
  app.patch("/api/tiendas/:id/avisos", async (c) => {
    const input = await bodyOf(c, choicesInput)
    return c.json(await saveChoices(deps.appDb, c.get("person"), c.req.param("id"), input))
  })

  app.notFound((c) => c.json(errorBody(c, "NOT_FOUND", "Recurso no encontrado"), 404))
  return app
}
