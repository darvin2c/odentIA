/**
 * @odentia/services: lógica de negocio del CRM omnicanal.
 *
 * Convención: toda función recibe un `tx: Db` que YA corre dentro de
 * `withOrgContext(db, orgId, ...)` (RLS por GUC `app.org_id`). Las rutas API
 * y el worker abren el contexto; los servicios nunca lo abren (así componen
 * varias operaciones en una sola transacción).
 */
export * from "./agentConfig.js"
export * from "./budgets.js"
export * from "./clinical.js"
export * from "./connections.js"
export * from "./contacts.js"
export * from "./conversations.js"
export * from "./cursors.js"
export * from "./encounters.js"
export * from "./errors.js"
export * from "./fields.js"
export * from "./patient-history.js"
export * from "./patient-registration.js"
export * from "./procedure-codings.js"
export * from "./patients.js"
export * from "./pipelines.js"
export * from "./plan.js"
export * from "./secrets.js"
export * from "./service-catalog.js"
export * from "./storage.js"
export * from "./tasks.js"
