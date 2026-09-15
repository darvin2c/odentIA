/**
 * Seed de dev determinista para prueba manual del panel.
 *
 * Solo manual (`pnpm db:seed`); NUNCA en CI ni importado por tests
 * (cada test crea sus fixtures mínimas). Idempotente: borra solo las
 * orgs/usuarios semilla y los recrea. Prerrequisito: `seed:cie10` antes
 * (los códigos K02.1/K04.0/Z01.2 deben existir; si falta alguno el script
 * falla rápido nombrándolo, sin skips silenciosos).
 *
 * Regla permanente: toda función nueva que añada pantalla o entidad debe
 * extender este archivo con su escenario mínimo en la misma PR.
 */
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { createOwnerDb } from "@odentia/db";
import { account, invitation, member, organization, user } from "@odentia/db/schema/auth";
import {
  agentConfig,
  channelConnection,
  contact,
  contactIdentity,
  conversation,
  crmTask,
  customFieldDef,
  message,
  pipeline,
  pipelineStage,
} from "@odentia/db/schema/crm";
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org";
import {
  clinicalNote,
  encounter,
  encounterProcedure,
  encounterTooth,
  odontogramEntry,
  orgCounter,
  patient,
  patientAllergy,
  patientAnamnesis,
  patientCondition,
  patientDocument,
  patientMedication,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical";
import { inArray, sql } from "drizzle-orm";
import { ensureDefaultPipeline } from "./pipelines.js";
import { createFieldDef } from "./fields.js";
import { createConnection } from "./connections.js";
import { createContact } from "./contacts.js";
import { completeTask, createTask } from "./tasks.js";
import { upsertAgentConfig } from "./agentConfig.js";
import { createPatient } from "./patients.js";
import {
  addAllergy,
  addAnamnesis,
  addClinicalNote,
  addCondition,
  addMedication,
  addOdontogramEntries,
  voidOdontogramEntry,
} from "./clinical.js";
import { addPlanItem } from "./plan.js";
import { addEncounterProcedure, createEncounter, finalizeEncounter } from "./encounters.js";
import { secretsKeyFromEnv } from "./secrets.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL es obligatoria para sembrar (rol owner)");
const secretsKey = secretsKeyFromEnv(process.env.SECRETS_KEY);

const db = createOwnerDb(databaseUrl);

const ORG_A = "seed-org-dental-smile";
const ORG_B = "seed-org-clinica-norte";
const SEED_ORGS = [ORG_A, ORG_B];
const ANA_ID = "seed-user-ana";
const LUIS_ID = "seed-user-luis";
const CORA_ID = "seed-user-cora";
const PASSWORD = "Demo1234";
// Teléfono compartido del hogar Rosa/Jorge. No puede modelarse con dos filas
// de contact_identity: el unique (organization_id, channel, external_user_id)
// lo impide (ver comentario de invariante en el schema). Rosa lo porta como
// identidad whatsapp; Jorge lo referencia en sus notas.
const SHARED_PHONE = "+51987654999";

const hoursAgo = (h: number): Date => new Date(Date.now() - h * 3_600_000);
const daysAgo = (d: number): Date => new Date(Date.now() - d * 86_400_000);
const tomorrowIso = (): string => new Date(Date.now() + 86_400_000).toISOString();

async function wipeSeed(): Promise<void> {
  await db.delete(message).where(inArray(message.organizationId, SEED_ORGS));
  await db.delete(crmTask).where(inArray(crmTask.organizationId, SEED_ORGS));
  await db.delete(contactIdentity).where(inArray(contactIdentity.organizationId, SEED_ORGS));
  await db.delete(conversation).where(inArray(conversation.organizationId, SEED_ORGS));
  await db.delete(encounterProcedure).where(inArray(encounterProcedure.organizationId, SEED_ORGS));
  await db.delete(encounterTooth).where(inArray(encounterTooth.organizationId, SEED_ORGS));
  await db.delete(clinicalNote).where(inArray(clinicalNote.organizationId, SEED_ORGS));
  await db.delete(odontogramEntry).where(inArray(odontogramEntry.organizationId, SEED_ORGS));
  await db.delete(patientDocument).where(inArray(patientDocument.organizationId, SEED_ORGS));
  await db.delete(patientAnamnesis).where(inArray(patientAnamnesis.organizationId, SEED_ORGS));
  await db.delete(patientAllergy).where(inArray(patientAllergy.organizationId, SEED_ORGS));
  await db.delete(patientCondition).where(inArray(patientCondition.organizationId, SEED_ORGS));
  await db.delete(patientMedication).where(inArray(patientMedication.organizationId, SEED_ORGS));
  await db.delete(treatmentPlanItem).where(inArray(treatmentPlanItem.organizationId, SEED_ORGS));
  await db.delete(encounter).where(inArray(encounter.organizationId, SEED_ORGS));
  await db.delete(patient).where(inArray(patient.organizationId, SEED_ORGS));
  await db.delete(contact).where(inArray(contact.organizationId, SEED_ORGS));
  await db.delete(pipelineStage).where(inArray(pipelineStage.organizationId, SEED_ORGS));
  await db.delete(pipeline).where(inArray(pipeline.organizationId, SEED_ORGS));
  await db.delete(channelConnection).where(inArray(channelConnection.organizationId, SEED_ORGS));
  await db.delete(customFieldDef).where(inArray(customFieldDef.organizationId, SEED_ORGS));
  await db.delete(agentConfig).where(inArray(agentConfig.organizationId, SEED_ORGS));
  await db.delete(orgCounter).where(inArray(orgCounter.organizationId, SEED_ORGS));
  await db.delete(branch).where(inArray(branch.organizationId, SEED_ORGS));
  await db.delete(orgProfile).where(inArray(orgProfile.organizationId, SEED_ORGS));
  await db.delete(auditEvent).where(inArray(auditEvent.organizationId, SEED_ORGS));
  await db.delete(member).where(inArray(member.organizationId, SEED_ORGS));
  await db.delete(invitation).where(inArray(invitation.organizationId, SEED_ORGS));
  await db.delete(organization).where(inArray(organization.id, SEED_ORGS));
  await db.execute(sql`delete from "verification" where "identifier" ilike '%@odentia.dev%'`);
  await db.delete(user).where(inArray(user.id, [ANA_ID, LUIS_ID, CORA_ID]));
}

async function seedConversation(args: {
  orgId: string;
  contactId: string;
  connectionId: string;
  thread: string;
  status?: string;
  agentStatus?: string;
  assignedUserId?: string | null;
  unreadCount?: number;
  lastInboundAt?: Date | null;
  lastOutboundAt?: Date | null;
  lastMessageAt?: Date | null;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(conversation)
    .values({
      organizationId: args.orgId,
      contactId: args.contactId,
      channelConnectionId: args.connectionId,
      externalThreadId: args.thread,
      status: args.status ?? "open",
      assignedUserId: args.assignedUserId ?? null,
      agentStatus: args.agentStatus ?? "on",
      unreadCount: args.unreadCount ?? 0,
      lastInboundAt: args.lastInboundAt ?? null,
      lastOutboundAt: args.lastOutboundAt ?? null,
      lastMessageAt: args.lastMessageAt ?? null,
    })
    .returning({ id: conversation.id });
  if (!row) throw new Error(`No se pudo crear la conversación ${args.thread}`);
  return row;
}

async function seedMessage(args: {
  orgId: string;
  conversationId: string;
  direction: string;
  senderKind: string;
  senderUserId?: string | null;
  body: string;
  externalId: string;
  status: string;
  createdAt: Date;
}): Promise<void> {
  const [row] = await db
    .insert(message)
    .values({
      organizationId: args.orgId,
      conversationId: args.conversationId,
      direction: args.direction,
      senderKind: args.senderKind,
      senderUserId: args.senderUserId ?? null,
      contentType: "text",
      body: args.body,
      externalId: args.externalId,
      status: args.status,
      createdAt: args.createdAt,
    })
    .returning({ id: message.id });
  if (!row) throw new Error(`No se pudo crear el mensaje ${args.externalId}`);
}

async function countWhere(table: string, orgId: string): Promise<number> {
  const rows = (await db.execute(
    sql.raw(`select count(*)::int as n from "${table}" where "organization_id" = '${orgId}'`),
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

await wipeSeed();

// --- Identidad fija ---
await db.insert(organization).values([
  { id: ORG_A, name: "Dental Smile", slug: "dental-smile", createdAt: new Date() },
  { id: ORG_B, name: "Clínica Norte", slug: "clinica-norte", createdAt: new Date() },
]);
await db.insert(user).values([
  { id: ANA_ID, name: "Dra. Ana Torres", firstName: "Ana", lastName: "Torres", email: "ana@odentia.dev", emailVerified: true },
  { id: LUIS_ID, name: "Luis Prado", firstName: "Luis", lastName: "Prado", email: "luis@odentia.dev", emailVerified: true },
  { id: CORA_ID, name: "Dra. Cora Vega", firstName: "Cora", lastName: "Vega", email: "cora@odentia.dev", emailVerified: true },
]);
const passwordHash = await hashPassword(PASSWORD);
await db.insert(account).values(
  [ANA_ID, LUIS_ID, CORA_ID].map((userId) => ({
    id: randomUUID(),
    accountId: userId,
    providerId: "credential",
    userId,
    password: passwordHash,
  })),
);
await db.insert(member).values([
  { id: randomUUID(), organizationId: ORG_A, userId: ANA_ID, role: "owner", createdAt: new Date() },
  { id: randomUUID(), organizationId: ORG_A, userId: LUIS_ID, role: "member", createdAt: new Date() },
  { id: randomUUID(), organizationId: ORG_B, userId: LUIS_ID, role: "member", createdAt: new Date() },
  { id: randomUUID(), organizationId: ORG_B, userId: CORA_ID, role: "owner", createdAt: new Date() },
]);
await db.insert(orgProfile).values([
  { organizationId: ORG_A, legalName: "Dental Smile S.A.C.", fiscalDocNumber: "20601234567" },
  { organizationId: ORG_B, legalName: "Clínica Norte S.A.C.", fiscalDocNumber: "20550987654" },
]);
const [miraflores] = await db
  .insert(branch)
  .values([
    { organizationId: ORG_A, name: "Sede Miraflores", ubigeo: "150122" },
    { organizationId: ORG_A, name: "Sede Surco", ubigeo: "150140" },
  ])
  .returning({ id: branch.id });
if (!miraflores) throw new Error("No se pudo crear la sucursal Sede Miraflores");
await db.insert(branch).values([{ organizationId: ORG_B, name: "Sede Lima" }]);

// --- CRM con servicios ---
const pipeA = await ensureDefaultPipeline(db, ORG_A);
const pipeB = await ensureDefaultPipeline(db, ORG_B);

await createFieldDef(db, ORG_A, { key: "dni", label: "DNI", type: "text" });
await createFieldDef(db, ORG_A, { key: "fecha_nacimiento", label: "Fecha de nacimiento", type: "date" });
await createFieldDef(db, ORG_A, {
  key: "aseguradora",
  label: "Aseguradora",
  type: "select",
  options: ["Rimac", "Pacifico", "Particular"],
});

const connA = await createConnection(
  db,
  ORG_A,
  secretsKey,
  {
    channel: "whatsapp",
    provider: "whatsapp_cloud_api",
    displayName: "WhatsApp Dental Smile",
    config: {
      phoneNumberId: "seed",
      displayPhoneNumber: "+51 999 888 777",
      accessToken: "seed-dev",
    },
  },
  { fetch, validateExternal: false },
);
const connB = await createConnection(
  db,
  ORG_B,
  secretsKey,
  {
    channel: "whatsapp",
    provider: "whatsapp_cloud_api",
    displayName: "WhatsApp Norte",
    config: {
      phoneNumberId: "seed",
      displayPhoneNumber: "+51 999 888 776",
      accessToken: "seed-dev",
    },
  },
  { fetch, validateExternal: false },
);

// --- Contactos A (reparto por etapa según posición) ---
const CONTACTS_A = [
  { name: "Rosa Quispe", phone: SHARED_PHONE },
  { name: "Jorge Mamani", phone: "+51987654302" },
  { name: "Elena Huamán", phone: "+51987654303" },
  { name: "Carlos Paredes", phone: "+51987654304" },
  { name: "Lucía Fernández", phone: "+51987654305" },
  { name: "Miguel Torres", phone: "+51987654306" },
  { name: "Carmen Rojas", phone: "+51987654307" },
  { name: "Diego Salazar", phone: "+51987654308" },
  { name: "Patricia León", phone: "+51987654309" },
  { name: "Andrés Vega", phone: "+51987654310" },
];
const contactIdByName = new Map<string, string>();
for (let i = 0; i < CONTACTS_A.length; i++) {
  const c = CONTACTS_A[i]!;
  const stageId = pipeA.stages[i % pipeA.stages.length]!.id;
  const notes =
    c.name === "Jorge Mamani" ? `Teléfono familiar compartido: ${SHARED_PHONE} (titular: Rosa Quispe)` : undefined;
  const created = await createContact(db, ORG_A, { displayName: c.name, stageId, notes });
  await db.insert(contactIdentity).values({
    organizationId: ORG_A,
    contactId: created.id,
    channel: "whatsapp",
    externalUserId: c.phone,
    displayName: c.name,
    isPrimary: true,
  });
  contactIdByName.set(c.name, created.id);
}

// --- Conversaciones A ---
const convRosa = await seedConversation({
  orgId: ORG_A,
  contactId: contactIdByName.get("Rosa Quispe")!,
  connectionId: connA.id,
  thread: "seed-thread-1",
  unreadCount: 3,
  lastInboundAt: hoursAgo(1),
  lastMessageAt: hoursAgo(1),
});
await seedMessage({
  orgId: ORG_A, conversationId: convRosa.id, direction: "inbound", senderKind: "contact",
  body: "Hola, ¿tienen cita para mañana por dolor de muela?", externalId: "seed-msg-1",
  status: "received", createdAt: hoursAgo(3),
});
await seedMessage({
  orgId: ORG_A, conversationId: convRosa.id, direction: "inbound", senderKind: "contact",
  body: "Es un dolor fuerte en la muela de abajo, del lado derecho", externalId: "seed-msg-2",
  status: "received", createdAt: hoursAgo(2),
});
await seedMessage({
  orgId: ORG_A, conversationId: convRosa.id, direction: "inbound", senderKind: "contact",
  body: "¿Atienden por la tarde? Trabajo hasta las 5", externalId: "seed-msg-3",
  status: "received", createdAt: hoursAgo(1),
});

const convJorge = await seedConversation({
  orgId: ORG_A,
  contactId: contactIdByName.get("Jorge Mamani")!,
  connectionId: connA.id,
  thread: "seed-thread-2",
  assignedUserId: LUIS_ID,
  lastInboundAt: hoursAgo(5),
  lastOutboundAt: hoursAgo(4),
  lastMessageAt: hoursAgo(4),
});
await seedMessage({
  orgId: ORG_A, conversationId: convJorge.id, direction: "inbound", senderKind: "contact",
  body: "Buenas tardes, quiero cotizar una endodoncia", externalId: "seed-msg-4",
  status: "read", createdAt: hoursAgo(5),
});
await seedMessage({
  orgId: ORG_A, conversationId: convJorge.id, direction: "outbound", senderKind: "user",
  senderUserId: LUIS_ID,
  body: "Hola Jorge, claro que sí. ¿Podrías venir mañana para una evaluación? El precio depende del caso.",
  externalId: "seed-msg-5", status: "read", createdAt: hoursAgo(4),
});

const elenaClosedAt = daysAgo(2);
const convElena = await seedConversation({
  orgId: ORG_A,
  contactId: contactIdByName.get("Elena Huamán")!,
  connectionId: connA.id,
  thread: "seed-thread-3",
  status: "closed",
  lastInboundAt: elenaClosedAt,
  lastOutboundAt: new Date(elenaClosedAt.getTime() + 600_000),
  lastMessageAt: new Date(elenaClosedAt.getTime() + 600_000),
});
await seedMessage({
  orgId: ORG_A, conversationId: convElena.id, direction: "inbound", senderKind: "contact",
  body: "Hola, quiero confirmar mi cita de limpieza de mañana", externalId: "seed-msg-6",
  status: "read", createdAt: elenaClosedAt,
});
await seedMessage({
  orgId: ORG_A, conversationId: convElena.id, direction: "outbound", senderKind: "agent",
  body: "Hola Elena, tu cita de limpieza quedó confirmada para mañana a las 10:00 am.",
  externalId: "seed-msg-7", status: "read", createdAt: new Date(elenaClosedAt.getTime() + 600_000),
});

const convCarlos = await seedConversation({
  orgId: ORG_A,
  contactId: contactIdByName.get("Carlos Paredes")!,
  connectionId: connA.id,
  thread: "seed-thread-4",
  agentStatus: "off",
  unreadCount: 1,
  lastInboundAt: hoursAgo(6),
  lastMessageAt: hoursAgo(6),
});
await seedMessage({
  orgId: ORG_A, conversationId: convCarlos.id, direction: "inbound", senderKind: "contact",
  body: "¿Cuánto cuesta una extracción de muela del juicio?", externalId: "seed-msg-8",
  status: "received", createdAt: hoursAgo(6),
});

// --- Tareas A ---
await createTask(db, ORG_A, {
  title: "Llamar a Rosa para confirmar cita",
  contactId: contactIdByName.get("Rosa Quispe")!,
  assigneeUserId: LUIS_ID,
  dueAt: tomorrowIso(),
  createdBy: "user",
});
const budget = await createTask(db, ORG_A, { title: "Enviar presupuesto de endodoncia", createdBy: "user" });
await completeTask(db, ORG_A, budget.id);
await createTask(db, ORG_A, {
  title: "Revisar stock de anestesia",
  assigneeUserId: ANA_ID,
  createdBy: "user",
});

// --- Agente A (B sin fila: ejercita el default deshabilitado) ---
await upsertAgentConfig(db, ORG_A, {
  enabled: true,
  model: null,
  systemPrompt: "Eres el asistente de Dental Smile. Responde en español, tono amable.",
  handoffKeywords: ["humano", "asesor", "recepcion"],
  maxTurns: 10,
});

// --- Pacientes + clínica (org A) ---
const PATIENTS_A = [
  { name: "Rosa Quispe", doc: "45678901", birth: "1990-05-14", sex: "F" },
  { name: "Elena Huamán", doc: "45678902", birth: "1985-11-02", sex: "F" },
  { name: "Carlos Paredes", doc: "45678903", birth: "1978-03-21", sex: "M" },
  { name: "Lucía Fernández", doc: "45678904", birth: "1995-07-30", sex: "F" },
  { name: "Miguel Torres", doc: "45678905", birth: "1982-01-17", sex: "M" },
  { name: "Carmen Rojas", doc: "45678906", birth: "1992-09-08", sex: "F" },
];
const patientIdByName = new Map<string, string>();
for (const p of PATIENTS_A) {
  const row = await createPatient(db, ORG_A, ANA_ID, {
    contactId: contactIdByName.get(p.name)!,
    docType: "DNI",
    docNumber: p.doc,
    birthDate: p.birth,
    sex: p.sex,
    phone: p.name === "Rosa Quispe" ? SHARED_PHONE : CONTACTS_A.find((c) => c.name === p.name)?.phone,
    registeredBranchId: miraflores.id,
  });
  patientIdByName.set(p.name, row.id);
}

const rosaPatientId = patientIdByName.get("Rosa Quispe")!;
await addAllergy(db, ORG_A, ANA_ID, rosaPatientId, {
  substance: "Penicilina",
  reaction: "Urticaria",
  severity: "severa",
});
await addCondition(db, ORG_A, ANA_ID, rosaPatientId, { name: "Hipertensión arterial", status: "activa" });
await addMedication(db, ORG_A, ANA_ID, rosaPatientId, {
  name: "Losartán",
  dose: "50 mg",
  frequency: "1 vez al día",
});
await addAnamnesis(db, ORG_A, ANA_ID, rosaPatientId, { motivo: "Dolor molar", diagnosticoCie10: ["K02.1"] });
await addAnamnesis(db, ORG_A, ANA_ID, rosaPatientId, {
  motivo: "Dolor molar",
  evolucion: "Persiste dolor a la masticación en pieza 36",
  diagnosticoCie10: ["K02.1", "K04.0"],
});
const obt36 = await addPlanItem(db, ORG_A, ANA_ID, rosaPatientId, {
  title: "Obturación pieza 36",
  toothNumber: 36,
  diagnosisCode: "K02.1",
  priceCents: 18000,
  currency: "PEN",
});
await addPlanItem(db, ORG_A, ANA_ID, rosaPatientId, {
  title: "Endodoncia pieza 46",
  toothNumber: 46,
  diagnosisCode: "K04.0",
  priceCents: 45000,
});
const draft = await createEncounter(db, ORG_A, ANA_ID, rosaPatientId, {
  reason: "Dolor molar inferior derecho",
  teeth: [36, 46],
  branchId: miraflores.id,
});
await addOdontogramEntries(db, ORG_A, ANA_ID, rosaPatientId, {
  toothNumber: 36,
  condition: "caries",
  surfaces: ["oclusal"],
  diagnosisCode: "K02.1",
  encounterId: draft.id,
});
await addOdontogramEntries(db, ORG_A, ANA_ID, rosaPatientId, {
  toothNumber: 46,
  condition: "caries",
  encounterId: draft.id,
});
const desgaste = await addOdontogramEntries(db, ORG_A, ANA_ID, rosaPatientId, {
  toothNumber: 26,
  condition: "desgaste",
});
const desgasteId = desgaste[0]?.id;
if (!desgasteId) throw new Error("No se pudo crear la entrada de odontograma de la pieza 26");
await voidOdontogramEntry(db, ORG_A, ANA_ID, desgasteId);
await addClinicalNote(db, ORG_A, ANA_ID, rosaPatientId, {
  note: "Paciente con dolor a la percusión en pieza 36; se planifica obturación y endodoncia en 46.",
  diagnosisCode: "K02.1",
  encounterId: draft.id,
});
await addEncounterProcedure(db, ORG_A, ANA_ID, rosaPatientId, draft.id, {
  description: "Obturación con resina pieza 36",
  toothNumber: 36,
  diagnosisCode: "K02.1",
  planItemId: obt36.id,
});
await finalizeEncounter(db, ORG_A, ANA_ID, rosaPatientId, draft.id);
await addClinicalNote(db, ORG_A, ANA_ID, rosaPatientId, {
  note: "Control post-obturación: sin dolor, oclusión estable. Pendiente endodoncia pieza 46.",
});

const elenaPatientId = patientIdByName.get("Elena Huamán")!;
await addAllergy(db, ORG_A, ANA_ID, elenaPatientId, {
  substance: "Látex",
  reaction: "Enrojecimiento",
  severity: "leve",
});
await addClinicalNote(db, ORG_A, ANA_ID, elenaPatientId, {
  note: "Control de rutina sin hallazgos",
  diagnosisCode: "Z01.2",
});
await addPlanItem(db, ORG_A, ANA_ID, elenaPatientId, { title: "Limpieza dental", priceCents: 12000 });

// --- Volumen para paginación: 40 contactos+pacientes ---
for (let i = 1; i <= 40; i++) {
  const n = String(i).padStart(2, "0");
  const created = await createContact(db, ORG_A, {
    displayName: `Paciente Demo ${n}`,
    stageId: pipeA.stages[0]!.id,
  });
  await createPatient(db, ORG_A, ANA_ID, { contactId: created.id, phone: `+519000000${n}` });
}

// --- Org B mínima (aislamiento visual) ---
const sofia = await createContact(db, ORG_B, { displayName: "Sofía Ramos", stageId: pipeB.stages[0]!.id });
const hugo = await createContact(db, ORG_B, { displayName: "Hugo Díaz", stageId: pipeB.stages[1]!.id });
await db.insert(contactIdentity).values([
  {
    organizationId: ORG_B, contactId: sofia.id, channel: "whatsapp",
    externalUserId: "+51987654401", displayName: "Sofía Ramos", isPrimary: true,
  },
  {
    organizationId: ORG_B, contactId: hugo.id, channel: "whatsapp",
    externalUserId: "+51987654402", displayName: "Hugo Díaz", isPrimary: true,
  },
]);
await createPatient(db, ORG_B, CORA_ID, {
  contactId: sofia.id,
  docType: "DNI",
  docNumber: "60111222",
  birthDate: "1993-04-25",
  sex: "F",
});
const convSofia = await seedConversation({
  orgId: ORG_B,
  contactId: sofia.id,
  connectionId: connB.id,
  thread: "seed-thread-B1",
  unreadCount: 1,
  lastInboundAt: hoursAgo(2),
  lastMessageAt: hoursAgo(2),
});
await seedMessage({
  orgId: ORG_B, conversationId: convSofia.id, direction: "inbound", senderKind: "contact",
  body: "Hola, ¿tienen disponibilidad para una limpieza dental esta semana?",
  externalId: "seed-msg-B1", status: "received", createdAt: hoursAgo(2),
});

// --- Resumen ---
async function summary(orgId: string, label: string): Promise<string> {
  const tables = ["contact", "patient", "conversation", "message", "encounter", "task"] as const;
  const counts: string[] = [];
  for (const t of tables) counts.push(`${t}=${await countWhere(t, orgId)}`);
  return `org ${label} (${orgId}): ${counts.join(" ")}`;
}
console.log("seed-dev ok");
console.log(await summary(ORG_A, "dental-smile"));
console.log(await summary(ORG_B, "clinica-norte"));
console.log("credenciales (password Demo1234): ana@odentia.dev, luis@odentia.dev, cora@odentia.dev");
process.exit(0);
