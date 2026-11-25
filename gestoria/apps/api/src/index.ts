import { createAppDb, createOwnerDb, withSessionLock } from "@gestoria/db"
import { serve } from "@hono/node-server"
import { deliverOutbox, purgeOutbox, refreshStates, reviewStoreTeams } from "./acuerdo.js"
import { createApp } from "./app.js"
import { reviewAccountCopies } from "./cuenta.js"
import { readEnv } from "./env.js"
import { defaultLinkAdapters } from "./link-de-pago.js"
import { readSecretsKey } from "./secretos.js"
import { runArgos } from "./sofi/argos.js"
import { modelFromEnv } from "./sofi/modelo.js"

const env = readEnv()
const ownerDb = createOwnerDb(env.GESTORIA_DATABASE_URL)
const appDb = createAppDb(env.GESTORIA_APP_DATABASE_URL)
const account = { url: env.GESTORIA_ACCOUNT_URL, eventsSecret: env.GESTORIA_ACCOUNT_EVENTS_SECRET }

// El link de pago necesita la llave de las credenciales y la dirección pública del servidor.
const secretsKey = env.GESTORIA_API_URL ? readSecretsKey(env.GESTORIA_SECRETS_KEY) : null
if (!secretsKey)
  console.warn(
    "gestoria-api: sin GESTORIA_SECRETS_KEY y GESTORIA_API_URL no se puede conectar un link de pago.",
  )
const link = {
  adapters: defaultLinkAdapters(),
  secretsKey,
  apiURL: env.GESTORIA_API_URL ?? env.GESTORIA_WEB_URL,
}
// El modelo de Sofi (B5). Sin clave, Sofi no responde y la pantalla lo dice.
const model = modelFromEnv({ ...env, NODE_ENV: process.env.NODE_ENV })
if (!model)
  console.warn("gestoria-api: sin GESTORIA_OPENAI_API_KEY Sofi no responde (ni en la prueba).")
// El acuerdo con la administración (B7): en la misma entrada de la cuenta, con su propio secreto.
const contract = { url: env.GESTORIA_ACCOUNT_URL, secret: env.GESTORIA_CONTRACT_SECRET }
const app = createApp({
  appDb,
  ownerDb,
  account,
  webURL: env.GESTORIA_WEB_URL,
  link,
  model,
  contract,
})
serve({ fetch: app.fetch, port: env.GESTORIA_PORT }, (info) => {
  console.log(`gestoria-api: escuchando en el puerto ${info.port}`)
})

// La revisión diaria de la copia de las cuentas: cada hora toma las que no se revisaron en el
// día. Sin el secreto de los avisos no hay revisión (lo dice al arrancar).
if (!account.eventsSecret)
  console.warn(
    "gestoria-api: sin GESTORIA_ACCOUNT_EVENTS_SECRET no llegan los avisos de la cuenta ni corre la revisión diaria.",
  )
const HOUR = 3_600_000
async function review() {
  try {
    const run = await reviewAccountCopies(ownerDb, account)
    if (run.reviewed > 0 || run.failed)
      console.log(
        `gestoria-api: revisión de cuentas, ${run.reviewed} revisada(s)${run.failed ? "; la cuenta no respondió" : ""}`,
      )
  } catch (error) {
    console.error("gestoria-api: la revisión de cuentas falló", error)
  }
}
setTimeout(() => void review(), 60_000).unref()
setInterval(() => void review(), HOUR).unref()

// Argos (B5): cada 15 minutos mira las tiendas con Sofi encendida y le encarga los seguimientos.
// Si hay dos servidores, corre en uno solo (candado de la base).
async function argos() {
  try {
    const run = await withSessionLock(ownerDb, "argos", () => runArgos(ownerDb, appDb))
    if (run?.written)
      console.log(`gestoria-api: Argos le encargó ${run.written} seguimiento(s) a Sofi`)
  } catch (error) {
    console.error("gestoria-api: Argos falló", error)
  }
}
setTimeout(() => void argos(), 90_000).unref()
setInterval(() => void argos(), 15 * 60_000).unref()

// El acuerdo con la administración (B7): cada 30 segundos envía lo que espera en la bandeja de
// salida (con la misma clave al reintentar) y pregunta el estado de las tiendas a las que les
// toca. Un solo servidor a la vez. Sin el secreto, los avisos se guardan y esperan.
let nextPurge = 0
async function agreement() {
  try {
    const run = await withSessionLock(ownerDb, "gestoria_acuerdo", async () => {
      const delivered = await deliverOutbox(ownerDb, contract)
      await refreshStates(ownerDb, contract)
      // Una vez por hora (la primera, al arrancar): lo que ya salió hace más de una semana se borra
      // (la administración ya lo tiene) y el equipo de cada tienda se revisa contra lo último que
      // se le avisó a la cuenta. La primera vuelta tras desplegar es la carga inicial (ADR 0216).
      if (Date.now() >= nextPurge) {
        nextPurge = Date.now() + HOUR
        await purgeOutbox(ownerDb)
        const teams = await reviewStoreTeams(ownerDb)
        if (teams) console.log(`gestoria-api: ${teams} equipo(s) de tienda por avisar a la cuenta`)
      }
      return delivered
    })
    if (run?.failed)
      console.warn(`gestoria-api: ${run.failed} aviso(s) a la administración quedan por reintentar`)
  } catch (error) {
    console.error("gestoria-api: el acuerdo con la administración falló", error)
  }
}
if (contract.secret) setInterval(() => void agreement(), 30_000).unref()
else
  console.warn(
    "gestoria-api: sin GESTORIA_CONTRACT_SECRET no se avisa ni se pregunta nada a la administración.",
  )
