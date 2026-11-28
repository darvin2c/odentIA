import {
  type Db,
  MAX_MEDIA_PHOTO_BYTES,
  MAX_PHOTO_BYTES,
  MAX_VIDEO_BYTES,
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
import { ZodError, type z, z as zod } from "zod"
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
import type { Storage } from "./archivos.js"
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
  addLoadPhoto,
  createFromLoad,
  discardLoad,
  joinLoadItems,
  loadBulkPatch,
  loadDetail,
  loadItemPatch,
  loadPhotoPatch,
  loadSheet,
  moveLoadPhoto,
  openLoad,
  removeLoadPhoto,
  storeLoads,
  updateLoadItem,
  updateLoadItems,
} from "./cargas.js"
import {
  catalog,
  createProduct,
  deleteProduct,
  imageType,
  photoPatch,
  productDetail,
  productHistory,
  productInput,
  productPatch,
  removeVariant,
  updatePhoto,
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
  createPayment,
  deletePayment,
  paymentInput,
  paymentPatch,
  paymentQrContent,
  putPaymentQr,
  removePaymentQr,
  updatePayment,
} from "./cobros.js"
import {
  changeZone,
  configOverview,
  createDelivery,
  deleteDelivery,
  deliveryInput,
  deliveryPatch,
  paymentsAndDeliveries,
  updateDelivery,
  zoneChange,
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
import {
  applyLimaTemplate,
  deliveryRulesInput,
  deliverySetup,
  setDeliveryRules,
  templateInput,
} from "./entregas.js"
import {
  addCourier,
  courierAddInput,
  courierPatchInput,
  removeCourier,
  storeCouriers,
  updateCourier,
} from "./equipo-repartidores.js"
import { gridInput, saveGrid, simulateInput, simulatePrice } from "./ficha.js"
import { exampleSheet, MAX_SHEET_BYTES, uploadSheet } from "./hoja.js"
import { timeZoneInput } from "./hora.js"
import { storeHome } from "./inicio.js"
import { clientIp, createRateLimit } from "./limite.js"
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
  addPhoto,
  addVideo,
  chooseCutout,
  photoContent,
  productMedia,
  proposeCutout,
  publicMedia,
  removePhoto,
  removeVideo,
  updateVideo,
  videoInput,
  videoPatch,
} from "./medios.js"
import {
  connectInput,
  createTrialLink,
  disconnectPaymentLink,
  finishConnect,
  finishInput,
  paymentLinkStatus,
  receiveConnectNotice,
  startConnect,
} from "./pasarela.js"
import {
  addReceipt,
  assignCourier,
  cancelInput,
  cancelOrder,
  changeInput,
  changeOrder,
  courierInput,
  createOrder,
  createPaymentLink,
  deliverInput,
  type LinkDeps,
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
import {
  addSavedQuestion,
  answerQuestion,
  answerQuestions,
  groupAnswerInput,
  openQuestions,
  answerInput as questionAnswerInput,
  savedQuestionInput,
  saveInput,
  saveQuestion,
  unsaveQuestion,
} from "./preguntas.js"
import { skipInput, skipStep } from "./primeros-pasos.js"
import {
  aiCap,
  applyAll,
  DEFAULT_PHOTOS_CAP,
  discardProposal,
  improveText,
  loadProposals,
  type PhotoAi,
  productProposals,
  proposeForLoadItem,
  proposeForProduct,
  proposeGroups,
  rewriteInput,
  useInput,
  useProposal,
} from "./propuestas.js"
import { setDeliverySlots, slotsInput } from "./repartidores.js"
import { templateInput as rubroTemplateInput, saveTemplate, storeTemplates } from "./rubros.js"
import { argosBoard } from "./sofi/argos.js"
import {
  agentSettings,
  agentSettingsInput,
  agentStateInput,
  conversationView,
  customerMessageInput,
  newTestConversation,
  payTestOrder,
  placeTestOrder,
  quoteTestCart,
  returnToSofi,
  saveAgentSettings,
  setAgentEnabled,
  tellAnswer,
  testCart,
  testOrderInput,
  testPayInput,
  writeAsCustomer,
} from "./sofi/conversaciones.js"
import type { ChatModel } from "./sofi/modelo.js"
import { reportPeriod, storeReport } from "./sofi/reportes.js"
import {
  addAnswer,
  answerGap,
  answerInput,
  changeAnswer,
  dismissGap,
  gapAnswerInput,
  gapDismissInput,
  knowledgeView,
  removeAnswer,
} from "./sofi/saber.js"
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
  noteInvitationShared,
  removeMember,
  revokeInvitation,
  roleInput,
  StoreError,
  setStoreTimeZone,
  storeSummary,
  storeTeam,
} from "./tiendas.js"
import { previewShowcase, publicShowcase } from "./vitrina.js"

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
  /**
   * Dónde se guardan las fotos y los videos del producto (ADR 0236). Sin él no se suben (503) y
   * solo se ven las fotos que todavía están en la base.
   */
  storage?: Storage | null
  /**
   * La IA de fotos (lienzo «La ficha del producto»): el modelo que mira y el tope de fotos por día
   * y tienda. Sin modelo, la IA no está y se carga a mano.
   */
  photosModel?: ChatModel | null
  photosCapPerDay?: number
  /** Los topes de la vitrina pública por minuto (por IP y por tienda); las pruebas los bajan. */
  showcaseLimits?: { perIp: number; perStore: number }
}

type Env = { Variables: { person: Person } }

/** «Usar esta» o «Dejar la original» de la foto sin fondo; «Juntar» de «Cargar muchos». */
const cutoutChoice = zod.object({ usar: zod.boolean() })
const joinInput = zod.object({ from: zod.array(zod.uuid()).min(1).max(300) })

/** Lo más que pesa un aviso de la cuenta o un pedido de la app. */
const MAX_BODY_BYTES = 64 * 1024
// Una foto, un video y una hoja del catálogo pesan más: cada ruta tiene su tope.
/** Las fotos del producto y de «Cargar muchos» van al almacenamiento (ADR 0236): hasta 8 MB. */
const MEDIA_PHOTO_UPLOAD =
  /^\/api\/tiendas\/[^/]+\/(productos\/[^/]+\/fotos|fotos\/[^/]+\/sin-fondo|cargas\/[^/]+\/fotos)$/
/** El video, con su póster, en un formulario: hasta 16 MB más la imagen. */
const VIDEO_UPLOAD = /^\/api\/tiendas\/[^/]+\/productos\/[^/]+\/videos$/
/** «Guardar» de Tu marca lleva el logo y la portada, cada una con su tope, y unos pocos campos. */
const BRAND_SAVE = /^\/api\/tiendas\/[^/]+\/marca$/
const SHEET_UPLOAD = /^\/api\/tiendas\/[^/]+\/(catalogo|cargas\/[^/]+)\/hoja$/
/** El QR de Yape o Plin (Cobros): una imagen, con el tope de una foto. */
const QR_UPLOAD = /^\/api\/tiendas\/[^/]+\/medios-de-pago\/[^/]+\/qr$/
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
  // Sofi (B5): la misma tubería para una conversación de verdad, la prueba y sus avisos.
  const sofi = {
    appDb: deps.appDb,
    lockDb: deps.ownerDb,
    model: deps.model ?? null,
    link,
    storage: deps.storage ?? null,
  }
  /**
   * «Que Sofi se lo diga»: Sofi le escribe a cada clienta que preguntó. Corre después de responder
   * (cada una llama al modelo): si falla, la respuesta ya quedó guardada y se ve en el registro.
   */
  const tellLater = (
    storeId: string,
    told: { conversationId: string; product: string }[],
    answer: string,
  ) => {
    if (told.length === 0) return
    void tellAnswer(sofi, storeId, told, answer).catch((error) =>
      console.error("gestoria-api: Sofi no pudo decir la respuesta", error),
    )
  }
  const ai: PhotoAi = {
    model: deps.photosModel ?? null,
    storage: deps.storage,
    capPerDay: deps.photosCapPerDay ?? DEFAULT_PHOTOS_CAP,
  }

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
  const mediaPhoto = limit(
    MAX_MEDIA_PHOTO_BYTES,
    "La foto pesa demasiado: hasta 8 MB. Prueba con otra.",
  )
  const video = limit(
    MAX_VIDEO_BYTES + MAX_MEDIA_PHOTO_BYTES + 64 * 1024,
    "El video pesa demasiado: WhatsApp acepta hasta 16 MB. Prueba con uno más corto.",
  )
  const receipt = limit(
    MAX_PHOTO_BYTES + 16 * 1024,
    "La captura pesa demasiado. Prueba con otra más chica.",
  )
  const planReceipt = limit(
    CONTRACT_MAX_RECEIPT_BYTES + 16 * 1024,
    "El archivo pesa demasiado: hasta 1,5 MB.",
  )
  app.use("*", (c, next) => {
    if (c.req.method === "POST" && MEDIA_PHOTO_UPLOAD.test(c.req.path)) return mediaPhoto(c, next)
    if (c.req.method === "POST" && VIDEO_UPLOAD.test(c.req.path)) return video(c, next)
    if (c.req.method === "POST" && BRAND_SAVE.test(c.req.path)) return brandSave(c, next)
    if (c.req.method === "POST" && SHEET_UPLOAD.test(c.req.path)) return sheet(c, next)
    if (c.req.method === "POST" && QR_UPLOAD.test(c.req.path)) return photo(c, next)
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
  const noticesBy = createRateLimit({ max: MAX_LINK_NOTICES, windowMs: LINK_NOTICE_WINDOW_MS })
  app.post("/avisos/link-de-pago/:storeId", async (c) => {
    const storeId = c.req.param("storeId")
    if (!noticesBy.hit(storeId))
      return c.json(errorBody(c, "TOO_MANY", "Demasiados avisos; reintenta en un minuto"), 429)
    const body = await c.req.text()
    const result = await receiveLinkNotice(
      deps.ownerDb,
      storeId,
      { query: new URL(c.req.url).searchParams, headers: c.req.raw.headers, body },
      link,
    )
    return c.json({ message: result.message }, result.status)
  })

  // La vitrina pública (`<tienda>.gestoria24.com/<producto>`): las fotos y los videos de un producto
  // que se ve en la web, con enlaces que vencen en una hora. Sin cuenta: es lo público de la tienda.
  // Cualquiera la llama y cada pedido firma enlaces: un tope por quien pide y otro por tienda,
  // holgados para una clienta que mira el catálogo.
  const showcaseByIp = createRateLimit({ max: deps.showcaseLimits?.perIp ?? 60, windowMs: 60_000 })
  const showcaseByStore = createRateLimit({
    max: deps.showcaseLimits?.perStore ?? 1_200,
    windowMs: 60_000,
  })
  // El mismo tope para todo lo de la vitrina (la página del producto y sus fotos): una visita
  // cuenta igual por cualquiera de las dos.
  const showcaseTooMany = (c: Context) => {
    if (
      showcaseByIp.hit(clientIp(c.req.raw.headers)) &&
      showcaseByStore.hit(c.req.param("link") ?? "")
    )
      return null
    c.header("retry-after", "60")
    return c.json(
      errorBody(c, "TOO_MANY", "Demasiadas visitas seguidas. Prueba en un minuto."),
      429,
    )
  }
  app.get("/vitrina/:link/:producto/medios", async (c) => {
    c.header("access-control-allow-origin", "*")
    const limited = showcaseTooMany(c)
    if (limited) return limited
    const media = await publicMedia(
      deps.ownerDb,
      deps.storage,
      c.req.param("link"),
      c.req.param("producto"),
    )
    c.header("x-content-type-options", "nosniff")
    if (!media)
      return c.json(errorBody(c, "NOT_FOUND", "Ese producto no está en la web de la tienda"), 404)
    // Menos que lo que valen los enlaces: lo guardado nunca trae uno vencido.
    c.header("cache-control", "public, max-age=300")
    return c.json(media)
  })

  // La página pública de un producto (`<tienda>.gestoria24.com/<producto>`): solo lo vendible de un
  // producto que se ve en la web. Sin cuenta: es lo público de la tienda.
  app.get("/vitrina/:link/:producto", async (c) => {
    c.header("access-control-allow-origin", "*")
    const limited = showcaseTooMany(c)
    if (limited) return limited
    const page = await publicShowcase(
      deps.ownerDb,
      deps.storage,
      c.req.param("link"),
      c.req.param("producto"),
    )
    c.header("access-control-allow-origin", "*")
    c.header("x-content-type-options", "nosniff")
    if (!page)
      return c.json(errorBody(c, "NOT_FOUND", "Ese producto no está en la web de la tienda"), 404)
    c.header("cache-control", "public, max-age=300")
    return c.json(page)
  })

  // El aviso de Mercado Pago de que una cuenta desvinculó la aplicación (`mp-connect`): se
  // comprueba con su API antes de creerlo, y responde siempre lo mismo.
  let connectNotices = { since: 0, count: 0 }
  app.post("/avisos/mercadopago", async (c) => {
    const now = Date.now()
    if (now - connectNotices.since > LINK_NOTICE_WINDOW_MS)
      connectNotices = { since: now, count: 0 }
    if (++connectNotices.count > MAX_LINK_NOTICES)
      return c.json(errorBody(c, "TOO_MANY", "Demasiados avisos; reintenta en un minuto"), 429)
    await receiveConnectNotice(deps.ownerDb, await c.req.text(), link)
    return c.json({ message: "Recibido" })
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

  // «Enviar por WhatsApp»: se abrió el WhatsApp con la invitación (enviada por quien la invita).
  app.post("/api/tiendas/:id/invitaciones/:invitationId/enviada", async (c) =>
    c.json(
      await noteInvitationShared(
        deps.appDb,
        c.get("person"),
        c.req.param("id"),
        c.req.param("invitationId"),
      ),
    ),
  )

  // Los repartidores y su pago por entrega (tablero 9): del Dueño y el Administrador.
  app.get("/api/tiendas/:id/repartidores", async (c) =>
    c.json(await storeCouriers(deps.appDb, c.get("person"), c.req.param("id"))),
  )
  app.post("/api/tiendas/:id/repartidores", async (c) => {
    const input = await bodyOf(c, courierAddInput)
    const courier = await addCourier(deps.appDb, c.get("person"), c.req.param("id"), input)
    return c.json({ courier }, 201)
  })
  app.patch("/api/tiendas/:id/repartidores/:courierId", async (c) => {
    const input = await bodyOf(c, courierPatchInput)
    const { id, courierId } = c.req.param()
    return c.json({
      courier: await updateCourier(deps.appDb, c.get("person"), id, courierId, input),
    })
  })
  app.delete("/api/tiendas/:id/repartidores/:courierId", async (c) => {
    const { id, courierId } = c.req.param()
    return c.json(await removeCourier(deps.appDb, c.get("person"), id, courierId))
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
  // El QR de Yape o Plin: su contenido tal cual (se mira qué es por sus primeros bytes).
  app.post("/api/tiendas/:id/medios-de-pago/:methodId/qr", async (c) => {
    const { id, methodId } = c.req.param()
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    return c.json(await putPaymentQr(deps.appDb, c.get("person"), id, methodId, bytes))
  })
  app.delete("/api/tiendas/:id/medios-de-pago/:methodId/qr", async (c) => {
    const { id, methodId } = c.req.param()
    await removePaymentQr(deps.appDb, c.get("person"), id, methodId)
    return c.body(null, 204)
  })
  app.get("/api/tiendas/:id/medios-de-pago/:methodId/qr", async (c) => {
    const { id, methodId } = c.req.param()
    const image = await paymentQrContent(deps.appDb, c.get("person"), id, methodId)
    return c.body(new Uint8Array(image.content), 200, {
      "content-type": image.contentType,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      // Cambia con la misma dirección: la pantalla la pide con su versión (`?v=`).
      "cache-control": "private, max-age=86400",
    })
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
  // Una sola zona del reparto, sobre lo guardado ahora (lienzo de Configuración, tablero 7).
  app.patch("/api/tiendas/:id/formas-de-entrega/:methodId/zonas", async (c) => {
    const change = await bodyOf(c, zoneChange)
    const { id, methodId } = c.req.param()
    return c.json({
      method: await changeZone(deps.appDb, c.get("person"), id, methodId, change),
    })
  })
  app.delete("/api/tiendas/:id/formas-de-entrega/:methodId", async (c) => {
    const { id, methodId } = c.req.param()
    await deleteDelivery(deps.appDb, c.get("person"), id, methodId)
    return c.body(null, 204)
  })

  // Entregas por distrito (lienzo «gestorIA · Configuración, de nuevo», tablero 7).
  app.get("/api/tiendas/:id/entregas", async (c) =>
    c.json(await deliverySetup(deps.appDb, c.get("person"), c.req.param("id"))),
  )
  app.patch("/api/tiendas/:id/entregas/reglas", async (c) => {
    const input = await bodyOf(c, deliveryRulesInput)
    return c.json(await setDeliveryRules(deps.appDb, c.get("person"), c.req.param("id"), input))
  })
  app.post("/api/tiendas/:id/entregas/plantilla-lima", async (c) => {
    const input = await bodyOf(c, templateInput)
    const method = await applyLimaTemplate(deps.appDb, c.get("person"), c.req.param("id"), input)
    return c.json({ method })
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
  // «Subir una hoja»: CSV o Excel (.xlsx), con las tallas en filas o en columnas.
  app.post("/api/tiendas/:id/catalogo/hoja", async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    const confirm = c.req.query("confirmar") === "1"
    return c.json(await uploadSheet(deps.appDb, c.get("person"), c.req.param("id"), bytes, confirm))
  })

  // «Cargar muchos» (ADR 0236): una carga con sus fotos, sus productos y su hoja; nada pasa al
  // catálogo hasta «Crear».
  app.get("/api/tiendas/:id/cargas", async (c) =>
    c.json(await storeLoads(deps.appDb, c.get("person"), c.req.param("id"))),
  )
  app.post("/api/tiendas/:id/cargas", async (c) =>
    c.json({ load: await openLoad(deps.appDb, c.get("person"), c.req.param("id")) }, 201),
  )
  app.get("/api/tiendas/:id/cargas/:loadId", async (c) => {
    const { id, loadId } = c.req.param()
    return c.json(await loadDetail(deps.appDb, deps.storage, c.get("person"), id, loadId))
  })
  // La foto llega tal cual; `?archivo=` su nombre y `?producto=` a cuál va (id, «nuevo» o «suelta»).
  app.post("/api/tiendas/:id/cargas/:loadId/fotos", async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    const { id, loadId } = c.req.param()
    const photo = await addLoadPhoto(deps.appDb, deps.storage, c.get("person"), id, loadId, bytes, {
      fileName: c.req.query("archivo") ?? "",
      item: c.req.query("producto") || null,
    })
    return c.json({ photo }, 201)
  })
  app.patch("/api/tiendas/:id/cargas/:loadId/fotos/:photoId", async (c) => {
    const patch = await bodyOf(c, loadPhotoPatch)
    const { id, loadId, photoId } = c.req.param()
    const photo = await moveLoadPhoto(deps.appDb, c.get("person"), id, loadId, photoId, patch)
    return c.json({ photo })
  })
  app.delete("/api/tiendas/:id/cargas/:loadId/fotos/:photoId", async (c) => {
    const { id, loadId, photoId } = c.req.param()
    await removeLoadPhoto(deps.appDb, c.get("person"), id, loadId, photoId)
    return c.body(null, 204)
  })
  app.post("/api/tiendas/:id/cargas/:loadId/hoja", async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    const { id, loadId } = c.req.param()
    const result = await loadSheet(deps.appDb, c.get("person"), id, loadId, bytes)
    return c.json(result)
  })
  app.patch("/api/tiendas/:id/cargas/:loadId/productos", async (c) => {
    const input = await bodyOf(c, loadBulkPatch)
    const { id, loadId } = c.req.param()
    return c.json(await updateLoadItems(deps.appDb, c.get("person"), id, loadId, input))
  })
  app.patch("/api/tiendas/:id/cargas/:loadId/productos/:itemId", async (c) => {
    const patch = await bodyOf(c, loadItemPatch)
    const { id, loadId, itemId } = c.req.param()
    const item = await updateLoadItem(deps.appDb, c.get("person"), id, loadId, itemId, patch)
    return c.json({ item })
  })
  app.post("/api/tiendas/:id/cargas/:loadId/productos/:itemId/juntar", async (c) => {
    const { from } = await bodyOf(c, joinInput)
    const { id, loadId, itemId } = c.req.param()
    const item = await joinLoadItems(deps.appDb, c.get("person"), id, loadId, itemId, from)
    return c.json({ item })
  })
  app.post("/api/tiendas/:id/cargas/:loadId/crear", async (c) => {
    const { id, loadId } = c.req.param()
    const result = await createFromLoad(deps.appDb, c.get("person"), id, loadId)
    return c.json(result)
  })
  app.delete("/api/tiendas/:id/cargas/:loadId", async (c) => {
    const { id, loadId } = c.req.param()
    await discardLoad(deps.appDb, c.get("person"), id, loadId)
    return c.body(null, 204)
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
  // Las fotos y los videos del producto (ADR 0236): la foto llega tal cual en el cuerpo; con
  // `?color=<id>` ya es de ese color.
  app.post("/api/tiendas/:id/productos/:productId/fotos", async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    const { id, productId } = c.req.param()
    const photo = await addPhoto(
      deps.appDb,
      deps.storage,
      c.get("person"),
      id,
      productId,
      bytes,
      c.req.query("color") || null,
    )
    return c.json({ photo }, 201)
  })
  app.get("/api/tiendas/:id/productos/:productId/medios", async (c) => {
    const { id, productId } = c.req.param()
    return c.json(await productMedia(deps.appDb, deps.storage, c.get("person"), id, productId))
  })
  app.post("/api/tiendas/:id/productos/:productId/videos", async (c) => {
    const { id, productId } = c.req.param()
    let form: FormData
    try {
      form = await c.req.formData()
    } catch {
      throw new StoreError(400, "VALIDATION_ERROR", "El video no se pudo leer")
    }
    const file = form.get("video")
    const poster = form.get("poster")
    if (!(file instanceof File) || file.size === 0)
      throw new StoreError(400, "VALIDATION_ERROR", "Elige el video", { video: "Elige el video" })
    if (!(poster instanceof File) || poster.size === 0 || poster.size > MAX_MEDIA_PHOTO_BYTES)
      throw new StoreError(400, "VALIDATION_ERROR", "Falta la imagen del video", {
        poster: "Falta la imagen del video",
      })
    const input = videoInput.parse({
      colorId: form.get("colorId") ? String(form.get("colorId")) : null,
      label: String(form.get("label") ?? ""),
    })
    const created = await addVideo(deps.appDb, deps.storage, c.get("person"), id, productId, {
      ...input,
      video: new Uint8Array(await file.arrayBuffer()),
      poster: new Uint8Array(await poster.arrayBuffer()),
    })
    return c.json({ video: created }, 201)
  })
  app.patch("/api/tiendas/:id/videos/:videoId", async (c) => {
    const patch = await bodyOf(c, videoPatch)
    const { id, videoId } = c.req.param()
    return c.json({ video: await updateVideo(deps.appDb, c.get("person"), id, videoId, patch) })
  })
  app.delete("/api/tiendas/:id/videos/:videoId", async (c) => {
    const { id, videoId } = c.req.param()
    await removeVideo(deps.appDb, c.get("person"), id, videoId)
    return c.body(null, 204)
  })
  // La IA de fotos: mira y propone; usar una propuesta pasa por la operación de siempre.
  app.get("/api/tiendas/:id/ia", async (c) =>
    c.json({ cap: await aiCap(deps.appDb, c.get("person"), c.req.param("id"), ai) }),
  )
  app.post("/api/tiendas/:id/ia/mejorar-texto", async (c) => {
    const input = await bodyOf(c, rewriteInput)
    return c.json(await improveText(deps.appDb, c.get("person"), c.req.param("id"), input, ai))
  })
  app.get("/api/tiendas/:id/productos/:productId/ia", async (c) => {
    const { id, productId } = c.req.param()
    return c.json(await productProposals(deps.appDb, c.get("person"), id, productId, ai))
  })
  app.post("/api/tiendas/:id/productos/:productId/ia", async (c) => {
    const { id, productId } = c.req.param()
    return c.json(await proposeForProduct(deps.appDb, c.get("person"), id, productId, ai))
  })
  app.post("/api/tiendas/:id/productos/:productId/ia/aplicar-todos", async (c) => {
    const { id, productId } = c.req.param()
    return c.json(await applyAll(deps.appDb, c.get("person"), id, { productId }))
  })
  app.get("/api/tiendas/:id/cargas/:loadId/ia", async (c) => {
    const { id, loadId } = c.req.param()
    return c.json(await loadProposals(deps.appDb, c.get("person"), id, loadId, ai))
  })
  app.post("/api/tiendas/:id/cargas/:loadId/ia/juntar", async (c) => {
    const { id, loadId } = c.req.param()
    return c.json(await proposeGroups(deps.appDb, c.get("person"), id, loadId, ai))
  })
  app.post("/api/tiendas/:id/cargas/:loadId/productos/:itemId/ia", async (c) => {
    const { id, loadId, itemId } = c.req.param()
    return c.json(await proposeForLoadItem(deps.appDb, c.get("person"), id, loadId, itemId, ai))
  })
  app.post("/api/tiendas/:id/cargas/:loadId/productos/:itemId/ia/aplicar-todos", async (c) => {
    const { id, loadId, itemId } = c.req.param()
    return c.json(await applyAll(deps.appDb, c.get("person"), id, { loadId, itemId }))
  })
  app.post("/api/tiendas/:id/ia/propuestas/:proposalId/usar", async (c) => {
    const input = await bodyOf(c, useInput)
    const { id, proposalId } = c.req.param()
    return c.json(await useProposal(deps.appDb, c.get("person"), id, proposalId, input))
  })
  app.post("/api/tiendas/:id/ia/propuestas/:proposalId/descartar", async (c) => {
    const { id, proposalId } = c.req.param()
    return c.json(await discardProposal(deps.appDb, c.get("person"), id, proposalId))
  })
  // «La IA propone quitar el fondo»: llega la foto ya sin fondo; la original no se toca.
  app.post("/api/tiendas/:id/fotos/:photoId/sin-fondo", async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    const { id, photoId } = c.req.param()
    const photo = await proposeCutout(deps.appDb, deps.storage, c.get("person"), id, photoId, bytes)
    return c.json({ photo }, 201)
  })
  // «Usar esta» (`usar: true`) o «Dejar la original» (`usar: false`, borra la propuesta).
  app.patch("/api/tiendas/:id/fotos/:photoId/sin-fondo", async (c) => {
    const { usar } = await bodyOf(c, cutoutChoice)
    const { id, photoId } = c.req.param()
    return c.json({ photo: await chooseCutout(deps.appDb, c.get("person"), id, photoId, usar) })
  })
  app.get("/api/tiendas/:id/fotos/:photoId", async (c) => {
    const { id, photoId } = c.req.param()
    const photo = await photoContent(deps.appDb, deps.storage, c.get("person"), id, photoId)
    return c.body(new Uint8Array(photo.content), 200, {
      "content-type": photo.contentType,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      // La que se ve cambia con «Usar esta»: el navegador pregunta cada vez.
      "cache-control": "private, no-cache",
    })
  })
  app.delete("/api/tiendas/:id/fotos/:photoId", async (c) => {
    const { id, photoId } = c.req.param()
    await removePhoto(deps.appDb, c.get("person"), id, photoId)
    return c.body(null, 204)
  })
  app.patch("/api/tiendas/:id/fotos/:photoId", async (c) => {
    const patch = await bodyOf(c, photoPatch)
    const { id, photoId } = c.req.param()
    return c.json({ product: await updatePhoto(deps.appDb, c.get("person"), id, photoId, patch) })
  })

  // La ficha del producto: la plantilla de cada rubro, la cuadrícula de tallas y colores, el
  // historial y lo que Sofi no supo (lienzo «La ficha del producto»).
  app.get("/api/tiendas/:id/plantillas", async (c) =>
    c.json(await storeTemplates(deps.appDb, c.get("person"), c.req.param("id"))),
  )
  app.patch("/api/tiendas/:id/plantillas/:rubro", async (c) => {
    const input = await bodyOf(c, rubroTemplateInput)
    const { id, rubro } = c.req.param()
    return c.json({ template: await saveTemplate(deps.appDb, c.get("person"), id, rubro, input) })
  })
  app.get("/api/tiendas/:id/productos/:productId/historial", async (c) => {
    const { id, productId } = c.req.param()
    return c.json(await productHistory(deps.appDb, c.get("person"), id, productId))
  })
  app.post("/api/tiendas/:id/productos/:productId/cuadricula", async (c) => {
    const input = await bodyOf(c, gridInput)
    const { id, productId } = c.req.param()
    return c.json(await saveGrid(deps.appDb, c.get("person"), id, productId, input))
  })
  // «Probar cuánto cobraría Sofi»: la misma regla de precio de los pedidos, sin guardar nada.
  app.post("/api/tiendas/:id/productos/:productId/simular", async (c) => {
    const input = await bodyOf(c, simulateInput)
    const { id, productId } = c.req.param()
    return c.json(await simulatePrice(deps.appDb, c.get("person"), id, productId, input))
  })
  app.get("/api/tiendas/:id/preguntas", async (c) =>
    c.json(await openQuestions(deps.appDb, c.get("person"), c.req.param("id"))),
  )
  app.post("/api/tiendas/:id/productos/:productId/preguntas", async (c) => {
    const input = await bodyOf(c, savedQuestionInput)
    const { id, productId } = c.req.param()
    const product = await addSavedQuestion(deps.appDb, c.get("person"), id, productId, input)
    return c.json({ product }, 201)
  })
  app.post("/api/tiendas/:id/preguntas/:questionId/respuesta", async (c) => {
    const input = await bodyOf(c, questionAnswerInput)
    const { id, questionId } = c.req.param()
    const done = await answerQuestion(deps.appDb, c.get("person"), id, questionId, input)
    tellLater(id, done.tell, input.answer)
    return c.json({ product: done.product, told: done.tell.length })
  })
  // La línea de «Te toca»: varias preguntas iguales del mismo producto, de una vez.
  app.post("/api/tiendas/:id/preguntas/respuesta", async (c) => {
    const input = await bodyOf(c, groupAnswerInput)
    const id = c.req.param("id")
    const done = await answerQuestions(deps.appDb, c.get("person"), id, input)
    tellLater(id, done.tell, input.answer)
    return c.json({ product: done.product, told: done.tell.length })
  })
  app.post("/api/tiendas/:id/preguntas/:questionId/guardar", async (c) => {
    const input = await bodyOf(c, saveInput)
    const { id, questionId } = c.req.param()
    return c.json({
      product: await saveQuestion(deps.appDb, c.get("person"), id, questionId, input),
    })
  })
  app.post("/api/tiendas/:id/preguntas/:questionId/quitar", async (c) => {
    const { id, questionId } = c.req.param()
    return c.json({ product: await unsaveQuestion(deps.appDb, c.get("person"), id, questionId) })
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

  // La pasarela de la tienda (Cobros, tablero 6): se conecta entrando a la cuenta de Mercado Pago.
  app.get("/api/tiendas/:id/link-de-pago", async (c) =>
    c.json(await paymentLinkStatus(deps.appDb, c.get("person"), c.req.param("id"), link)),
  )
  app.post("/api/tiendas/:id/link-de-pago/conectar", async (c) => {
    const input = await bodyOf(c, connectInput)
    return c.json(await startConnect(deps.appDb, c.get("person"), c.req.param("id"), input, link))
  })
  // La vuelta de Mercado Pago, con la persona: el intento dice de qué tienda es.
  app.post("/api/link-de-pago/vuelta", async (c) => {
    const input = await bodyOf(c, finishInput)
    return c.json(await finishConnect(deps.appDb, c.get("person"), input, link))
  })
  app.post("/api/tiendas/:id/link-de-pago/prueba", async (c) =>
    c.json({ trial: await createTrialLink(deps.appDb, c.get("person"), c.req.param("id"), link) }),
  )
  app.delete("/api/tiendas/:id/link-de-pago", async (c) => {
    await disconnectPaymentLink(deps.appDb, c.get("person"), c.req.param("id"))
    return c.body(null, 204)
  })

  // Sofi (B5): lo que pone el dueño y la conversación de prueba.
  app.get("/api/tiendas/:id/sofi", async (c) =>
    c.json(
      await agentSettings(deps.appDb, c.get("person"), c.req.param("id"), Boolean(sofi.model)),
    ),
  )
  app.patch("/api/tiendas/:id/sofi", async (c) => {
    const input = await bodyOf(c, agentSettingsInput)
    return c.json(await saveAgentSettings(deps.appDb, c.get("person"), c.req.param("id"), input))
  })
  // Encender o pausar: aparte de las opciones, para que guardar una opción nunca la cambie.
  app.patch("/api/tiendas/:id/sofi/estado", async (c) => {
    const input = await bodyOf(c, agentStateInput)
    return c.json(await setAgentEnabled(deps.appDb, c.get("person"), c.req.param("id"), input))
  })
  // «Lo que sabe» y «Lo que aprendió» (ADR 0234): de quien cambia la configuración.
  app.get("/api/tiendas/:id/sofi/sabe", async (c) =>
    c.json(await knowledgeView(deps.appDb, c.get("person"), c.req.param("id"))),
  )
  app.post("/api/tiendas/:id/sofi/sabe", async (c) => {
    const input = await bodyOf(c, answerInput)
    return c.json(await addAnswer(deps.appDb, c.get("person"), c.req.param("id"), input), 201)
  })
  app.patch("/api/tiendas/:id/sofi/sabe/:answerId", async (c) => {
    const input = await bodyOf(c, answerInput)
    const { id, answerId } = c.req.param()
    return c.json(await changeAnswer(deps.appDb, c.get("person"), id, answerId, input))
  })
  app.delete("/api/tiendas/:id/sofi/sabe/:answerId", async (c) => {
    const { id, answerId } = c.req.param()
    await removeAnswer(deps.appDb, c.get("person"), id, answerId)
    return c.body(null, 204)
  })
  app.post("/api/tiendas/:id/sofi/aprendio/responder", async (c) => {
    const input = await bodyOf(c, gapAnswerInput)
    return c.json(await answerGap(deps.appDb, c.get("person"), c.req.param("id"), input), 201)
  })
  app.post("/api/tiendas/:id/sofi/aprendio/quitar", async (c) => {
    const input = await bodyOf(c, gapDismissInput)
    await dismissGap(deps.appDb, c.get("person"), c.req.param("id"), input)
    return c.body(null, 204)
  })
  app.post("/api/tiendas/:id/sofi/pruebas", async (c) =>
    c.json(await newTestConversation(deps.appDb, c.get("person"), c.req.param("id")), 201),
  )
  app.get("/api/tiendas/:id/conversaciones/:conversationId", async (c) => {
    const { id, conversationId } = c.req.param()
    return c.json({
      conversation: await conversationView(
        deps.appDb,
        c.get("person"),
        id,
        conversationId,
        deps.storage,
      ),
    })
  })
  const testsBy = new Map<string, { since: number; count: number }>()
  app.post("/api/tiendas/:id/conversaciones/:conversationId/cliente", async (c) => {
    const input = await bodyOf(c, customerMessageInput)
    const { id, conversationId } = c.req.param()
    // Primero el permiso: quien no prueba a Sofi (Configuración) no gasta el cupo de la tienda.
    await inStore(deps.appDb, c.get("person"), id, "configuracion", async () => {})
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
  // «Probar como clienta»: el carrito de la vitrina (el mismo del chat), su pedido y el pago de
  // prueba (no se cobra). Solo en una conversación de prueba.
  app.get("/api/tiendas/:id/conversaciones/:conversationId/carrito", async (c) => {
    const { id, conversationId } = c.req.param()
    return c.json(await testCart(deps.appDb, c.get("person"), id, conversationId))
  })
  app.post("/api/tiendas/:id/conversaciones/:conversationId/carrito", async (c) => {
    const input = await bodyOf(c, testOrderInput)
    const { id, conversationId } = c.req.param()
    return c.json(await placeTestOrder(deps.appDb, c.get("person"), id, conversationId, input), 201)
  })
  // Lo que cuesta el carrito de la vitrina antes de pagar (aún sin conversación): la cuenta del
  // servidor, la misma de «Pagar ahora».
  app.post("/api/tiendas/:id/vitrina/carrito/calcular", async (c) => {
    const input = await bodyOf(c, testOrderInput)
    return c.json(await quoteTestCart(deps.appDb, c.get("person"), c.req.param("id"), input))
  })
  app.post("/api/tiendas/:id/conversaciones/:conversationId/pagar", async (c) => {
    const input = await bodyOf(c, testPayInput)
    const { id, conversationId } = c.req.param()
    // Después del pago escribe Sofi (llama al modelo): cuenta en el mismo tope de la prueba.
    const seen = testsBy.get(id)
    if (seen && Date.now() - seen.since <= TEST_WINDOW_MS && ++seen.count > MAX_TEST_MESSAGES)
      throw new StoreError(
        429,
        "TOO_MANY",
        "Muchos mensajes de prueba seguidos. Espera unos minutos y sigue.",
      )
    return c.json(await payTestOrder(sofi, c.get("person"), id, conversationId, input))
  })
  // La vista previa de la ficha: la página del producto en la vitrina, aunque no se vea en la web.
  app.get("/api/tiendas/:id/productos/:productId/vitrina", async (c) => {
    const { id, productId } = c.req.param()
    return c.json(await previewShowcase(deps.appDb, deps.storage, c.get("person"), id, productId))
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
