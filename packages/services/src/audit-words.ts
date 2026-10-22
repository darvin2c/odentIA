/**
 * «Actividad del equipo»: lo que quedó registrado, dicho con palabras.
 *
 * Cada hecho se guarda con un código (`appointment.created`); a la pantalla
 * llega una frase («Reservó una cita»), el área a la que pertenece y quién lo
 * hizo cuando no fue alguien del equipo. Un código que todavía no tiene frase
 * propia se arma con lo que se sepa de él y, si no se sabe nada, se dice de
 * forma general: el código nunca se muestra.
 *
 * Las frases son un predicado sin sujeto, para leerse después del nombre:
 * «Ana Torres · Reservó una cita».
 */

export const AUDIT_AREAS = [
  "pacientes",
  "agenda",
  "atencion",
  "cobros",
  "ventas",
  "conversaciones",
  "agente",
  "portal",
  "inventario",
  "configuracion",
] as const
export type AuditArea = (typeof AUDIT_AREAS)[number]

/** Nombre de cada área, tal como se lee en el filtro y en la fila. */
export const AUDIT_AREA_LABELS: Record<AuditArea | "otros", string> = {
  pacientes: "Pacientes",
  agenda: "Agenda",
  atencion: "Atención clínica",
  cobros: "Caja y cobros",
  ventas: "Contactos y ventas",
  conversaciones: "Conversaciones",
  agente: "Agente",
  portal: "Portal del paciente",
  inventario: "Inventario",
  configuracion: "Configuración",
  otros: "Otros",
}

/**
 * Quién lo hizo cuando el registro no trae a una persona del equipo. Solo se
 * afirma «Sofi» (el agente que atiende) o «el paciente» si el hecho es suyo por naturaleza o el
 * registro lo dice; lo demás queda como automático, sin suponer a nadie.
 */
export type AuditAuthor = "agente" | "paciente" | "sistema"

const AUTHOR_WORDS: Record<AuditAuthor, string> = {
  agente: "Sofi",
  paciente: "El paciente o su contacto",
  sistema: "Automático",
}

/** El área sale del primer tramo del código: de qué trata el registro. */
const AREA_OF_SUBJECT: Record<string, AuditArea> = {
  patient: "pacientes",
  "patient-registration": "pacientes",
  health: "pacientes",
  document: "pacientes",
  imaging_study: "pacientes",
  appointment: "agenda",
  encounter: "atencion",
  odontogram: "atencion",
  plan: "atencion",
  prescription: "atencion",
  follow_up: "atencion",
  consent: "atencion",
  form_response: "atencion",
  order: "atencion",
  note: "atencion",
  cash: "cobros",
  charge: "cobros",
  payment: "cobros",
  ticket: "cobros",
  finance: "cobros",
  budget: "cobros",
  promotion: "cobros",
  financial_document: "cobros",
  contact: "ventas",
  opportunity: "ventas",
  task: "ventas",
  conversation: "conversaciones",
  message: "conversaciones",
  agent: "agente",
  admin_line: "agente",
  automation_job: "agente",
  automation_consent: "agente",
  clinic_message: "agente",
  channel_template: "agente",
  portal: "portal",
  // «Su enlace»: lo que la persona hace en su página personal se ve junto al portal.
  personal_link: "portal",
  passkey: "portal",
  session: "portal",
  questionnaire: "portal",
  account: "portal",
  appointments: "portal",
  budgets: "portal",
  documents: "portal",
  product: "inventario",
  supplier: "inventario",
  warehouse: "inventario",
  purchase_order: "inventario",
  stock: "inventario",
  branch: "configuracion",
  org_profile: "configuracion",
  settings: "configuracion",
  specialty: "configuracion",
  form_template: "configuracion",
  consent_template: "configuracion",
  professional_profile: "configuracion",
  catalog: "configuracion",
  service_catalog: "configuracion",
  mailbox: "configuracion",
  webchat: "configuracion",
  whatsapp: "configuracion",
}

/** De qué trata, para armar la frase de un código sin frase propia. */
const SUBJECT_WORDS: Record<string, string> = {
  patient: "un paciente",
  document: "un archivo de un paciente",
  imaging_study: "una tomografía de un paciente",
  appointment: "una cita",
  encounter: "una atención",
  odontogram: "un odontograma",
  plan: "un plan de tratamiento",
  prescription: "una receta",
  follow_up: "un control",
  consent: "un consentimiento",
  form_response: "un formulario",
  order: "una orden",
  cash: "la caja",
  charge: "un cargo",
  payment: "un pago",
  ticket: "un ticket",
  budget: "un presupuesto",
  promotion: "una promoción",
  contact: "un contacto",
  opportunity: "una oportunidad",
  task: "una tarea",
  conversation: "una conversación",
  message: "un mensaje",
  agent: "el agente",
  admin_line: "una línea de Argos",
  automation_job: "un mensaje automático",
  clinic_message: "un mensaje de WhatsApp de la clínica",
  channel_template: "un mensaje de WhatsApp de la clínica",
  portal: "el portal del paciente",
  product: "un producto",
  supplier: "un proveedor",
  warehouse: "un almacén",
  purchase_order: "una orden de compra",
  stock: "las existencias",
  branch: "una sede",
  specialty: "una especialidad",
  form_template: "una plantilla de formulario",
  consent_template: "una plantilla de consentimiento",
  mailbox: "un buzón de correo",
  webchat: "el chat web",
  whatsapp: "la conexión de WhatsApp",
}

/** Qué se hizo, por la terminación del código. */
const VERB_WORDS: Record<string, string> = {
  created: "Creó",
  create: "Creó",
  updated: "Cambió",
  update: "Cambió",
  edited: "Cambió",
  deleted: "Eliminó",
  voided: "Anuló",
  cancelled: "Canceló",
  archived: "Archivó",
  archive: "Archivó",
  reactivated: "Reactivó",
  deactivated: "Desactivó",
  deactivate: "Desactivó",
  published: "Publicó",
  publish: "Publicó",
}

const APPOINTMENT_STATUS_WORDS: Record<string, string> = {
  programada: "Dejó una cita como programada",
  confirmada: "Confirmó una cita",
  cancelada: "Canceló una cita",
  atendida: "Cerró una cita con su atención",
  en_atencion: "Marcó que una cita está en atención",
  en_sala: "Marcó la llegada de un paciente a su cita",
  inasistencia: "Marcó una inasistencia",
  no_asistio: "Marcó una inasistencia",
}

interface Phrase {
  what: string
  /** Quién lo hizo si el registro no trae a una persona del equipo; por defecto, el sistema. */
  by?: AuditAuthor
}

const say = (what: string, by?: AuditAuthor): Phrase => (by ? { what, by } : { what })

/** Frase propia de cada código. Se amplía en el mismo cambio que añade un registro nuevo. */
const ACTION_WORDS: Record<string, Phrase> = {
  // Pacientes
  "patient.created": say("Registró a un paciente"),
  "patient.updated": say("Cambió los datos de un paciente"),
  "patient.avatar_updated": say("Cambió la foto de un paciente"),
  "patient.contact_set": say("Vinculó a un paciente con un contacto"),
  "patient.contact_removed": say("Quitó el vínculo entre un paciente y un contacto"),
  "patient.person_replaced": say("Cambió la persona a la que pertenece una ficha"),
  "patient.data_consent_granted": say("Registró el consentimiento de datos de un paciente"),
  "patient.data_consent_revoked": say("Registró el retiro del consentimiento de datos de un paciente"),
  "patient.responsibility_granted": say("Registró a un responsable de un paciente"),
  "patient.responsibility_revoked": say("Retiró a un responsable de un paciente"),
  "patient-registration.config_saved": say("Cambió el registro de pacientes"),
  "patient-registration.link_created": say("Creó un enlace de registro para un paciente"),
  "health.declared": say("Declaró antecedentes de salud en el registro", "paciente"),
  "health.saved": say("Guardó los antecedentes de salud de un paciente"),
  "health.allergies_declared": say("Pasó a los antecedentes las alergias que declaró un paciente en un cuestionario"),
  "health.allergy_added": say("Registró una alergia de un paciente"),
  "health.allergy_removed": say("Quitó una alergia de un paciente, con su motivo"),
  "health.allergy_restored": say("Volvió a poner una alergia de un paciente"),
  "health.allergy_coded": say("Eligió de la lista la sustancia de una alergia escrita a mano"),
  "health.allergies_reviewed": say("Revisó con un paciente sus alergias: sin cambios"),
  "document.uploaded": say("Subió un archivo a la ficha de un paciente"),
  "document.retired": say("Retiró un archivo de la ficha de un paciente"),
  "document.context_corrected": say("Corrigió a qué pertenece un archivo de un paciente"),
  "document.report_status": say("Cambió el estado del informe de una imagen"),
  "imaging_study.started": say("Empezó a subir una tomografía a la ficha de un paciente"),
  "imaging_study.completed": say("Terminó de subir una tomografía a la ficha de un paciente"),
  "imaging_study.measured": say("Guardó una medida en la tomografía de un paciente"),
  // Agenda
  "appointment.created": say("Reservó una cita"),
  "appointment.moved": say("Movió una cita"),
  "appointment.updated": say("Cambió una cita"),
  "appointment.arrived": say("Marcó que un paciente llegó a su cita"),
  "appointment.arrival_undone": say("Deshizo la llegada de un paciente a su cita"),
  "branch.appointment_default_minutes": say("Cambió lo que dura una cita regular en una sede"),
  // Atención clínica
  "encounter.created": say("Abrió una atención"),
  "encounter.appointment_joined": say("Unió una atención en curso a su cita"),
  "encounter.updated": say("Editó una atención"),
  "encounter.finalized": say("Firmó y cerró una atención"),
  "encounter.voided": say("Anuló una atención"),
  "encounter.taken_over": say("Tomó el relevo de una atención"),
  "encounter.addendum_added": say("Añadió una adenda a una atención"),
  "encounter.diagnosis_added": say("Añadió un diagnóstico"),
  "encounter.diagnosis_status": say("Cambió el estado de un diagnóstico"),
  "encounter.diagnosis_voided": say("Anuló un diagnóstico"),
  "encounter.procedure_added": say("Registró un procedimiento"),
  "encounter.procedure_voided": say("Anuló un procedimiento"),
  "encounter.dictation_suggested": say("Dictó una parte de una atención"),
  "odontogram.entry_added": say("Anotó un hallazgo en el odontograma"),
  "odontogram.entry_voided": say("Anuló un hallazgo del odontograma"),
  "odontogram.entry_resolved": say("Marcó como resuelto un hallazgo del odontograma"),
  "odontogram.assessment_sealed": say("Firmó el odontograma"),
  "odontogram.legacy_reviewed": say("Revisó un odontograma anterior"),
  "plan.created": say("Creó un plan de tratamiento"),
  "plan.item_added": say("Añadió un tratamiento al plan"),
  "plan.items_added_batch": say("Añadió varios tratamientos al plan"),
  "plan.item_updated": say("Cambió un tratamiento del plan"),
  "plan.item_planned": say("Planificó un tratamiento"),
  "plan.item_revised": say("Revisó un tratamiento del plan"),
  "plan.item_status_changed": say("Cambió el estado de un tratamiento"),
  "plan.item_direct_completed": say("Registró un tratamiento ya realizado"),
  "prescription.issued": say("Emitió una receta"),
  "prescription.cancelled": say("Anuló una receta"),
  "follow_up.created": say("Indicó un control"),
  "follow_up.scheduled": say("Programó un control"),
  "follow_up.completed": say("Marcó un control como realizado"),
  "follow_up.cancelled": say("Canceló un control"),
  "consent.create": say("Preparó un consentimiento"),
  "consent.sign": say("Registró la firma de un consentimiento"),
  "consent.revoke": say("Registró la revocación de un consentimiento"),
  "consent.pdf": say("Guardó el PDF de un consentimiento firmado"),
  "consent.revoke_pdf": say("Guardó el PDF de la revocación de un consentimiento"),
  "consent.cancel": say("Anuló un consentimiento"),
  "consent.sent_to_sign": say("Envió un consentimiento a firmar por su enlace"),
  "consent.person_signed": say("Firmó un consentimiento desde su enlace", "paciente"),
  "form_response.create": say("Empezó un formulario de un paciente"),
  "form_response.update": say("Editó un formulario de un paciente"),
  "form_response.finalize": say("Finalizó un formulario de un paciente"),
  "form_response.discard": say("Descartó un formulario de un paciente"),
  "form_response.addendum": say("Añadió una adenda a un formulario"),
  "form_response.portal_submitted": say("Envió un cuestionario desde el portal", "paciente"),
  "order.create": say("Emitió una orden"),
  "order.status": say("Cambió el estado de una orden"),
  "order.cancel": say("Canceló una orden"),
  "note.created": say("Dejó una nota"),
  // Caja y cobros
  "cash.shift_opened": say("Abrió la caja"),
  "cash.shift_closed": say("Cerró la caja"),
  "cash.movement_added": say("Registró un movimiento de caja"),
  "cash.movement_voided": say("Anuló un movimiento de caja"),
  "cash.payment_registered": say("Registró un cobro en caja"),
  "cash.egreso_recorded": say("Registró una salida de caja"),
  "charge.created": say("Registró un cargo"),
  "charge.edited": say("Cambió un cargo"),
  "charge.voided": say("Anuló un cargo"),
  "payment.created": say("Registró un pago"),
  "payment.applied": say("Aplicó un pago a un cargo"),
  "payment.application_voided": say("Deshizo la aplicación de un pago"),
  "payment.refunded": say("Registró una devolución"),
  "payment.voided": say("Anuló un pago"),
  "ticket.created": say("Emitió un ticket"),
  "ticket.voided": say("Anuló un ticket"),
  "return.created": say("Registró la devolución de un cobro"),
  "charge.returned": say("Rebajó un cargo por una devolución"),
  "finance.expense_created": say("Registró un gasto"),
  "finance.expense_voided": say("Anuló un gasto"),
  "finance.expense_gap_dismissed": say("Dijo que un mes no tuvo un tipo de gasto"),
  "finance.commission_paid": say("Registró el pago de una comisión"),
  "finance.commission_payment_voided": say("Anuló el pago de una comisión"),
  "finance.rule_created": say("Creó una regla de comisión"),
  "finance.rule_updated": say("Cambió una regla de comisión"),
  "budget.created": say("Creó un presupuesto"),
  "budget.updated": say("Cambió un presupuesto"),
  "budget.delivered": say("Entregó un presupuesto"),
  "budget.decision": say("Registró la respuesta a un presupuesto"),
  "budget.decided": say("Respondió un presupuesto", "paciente"),
  "budget.cancelled": say("Anuló un presupuesto"),
  "budget.revised": say("Hizo una nueva versión de un presupuesto"),
  "budget.items_added": say("Añadió conceptos a un presupuesto"),
  "budget.items_removed": say("Quitó conceptos de un presupuesto"),
  "budget.prices_adjusted": say("Ajustó los precios de un presupuesto"),
  "budget.option_duplicated": say("Duplicó una opción de un presupuesto"),
  "budget.option_recommended": say("Marcó la opción recomendada de un presupuesto"),
  "budget.option_removed": say("Quitó una opción de un presupuesto"),
  "promotion.created": say("Creó una promoción"),
  "promotion.updated": say("Cambió una promoción"),
  "promotion.ended": say("Terminó una promoción"),
  "financial_document.sent": say("Envió un documento de cobro"),
  "health_document.sent": say("Envió una receta, una orden o un consentimiento a la persona"),
  // Contactos y ventas
  "contact.created": say("Creó un contacto"),
  "contact.updated": say("Cambió los datos de un contacto"),
  "contact.archived": say("Archivó un contacto"),
  "contact.reactivated": say("Reactivó un contacto"),
  "contact.identity_added": say("Añadió un canal a un contacto"),
  "contact.identity_moved": say("Pasó un canal de un contacto a otro"),
  // Spam y bloqueados (ADR 0054): sin persona del equipo lo decidió el agente.
  "contact.spam_marked": say("Mandó a una persona a Spam", "agente"),
  "contact.not_spam": say("Sacó a una persona de Spam"),
  "contact.spam_left": say("Una persona salió de Spam al escribir algo para la clínica", "agente"),
  "contact.spam_left_patient": say("Sacó a una persona de Spam al registrarla como paciente"),
  "contact.blocked": say("Bloqueó a una persona"),
  "contact.unblocked": say("Desbloqueó a una persona"),
  "opportunity.created": say("Creó una oportunidad"),
  "opportunity.updated": say("Cambió una oportunidad"),
  "opportunity.moved": say("Movió una oportunidad de etapa"),
  "opportunity.stage_changed": say("Movió una oportunidad de etapa"),
  "opportunity.won": say("Cerró una oportunidad como ganada"),
  "opportunity.lost": say("Cerró una oportunidad como perdida"),
  "opportunity.closed": say("Cerró una oportunidad"),
  "opportunity.reopened": say("Reabrió una oportunidad"),
  "task.created": say("Creó una tarea"),
  "task.updated": say("Cambió una tarea"),
  "task.settled": say("Una tarea se cerró sola: su motivo ya no estaba", "sistema"),
  // Conversaciones
  "conversation.started": say("Empezó una conversación"),
  "conversation.updated": say("Cambió una conversación"),
  "conversation.closed": say("Cerró una conversación"),
  "conversation.resolved": say("Resolvió una conversación"),
  // El agente cierra por su cuenta: la frase dice por qué (ADR 0024).
  "conversation.closed_resuelta": say("Cerró una conversación: terminó la atención", "agente"),
  "conversation.closed_sin_respuesta": say("Cerró una conversación: el paciente dejó de responder", "agente"),
  "conversation.reopened": say("Reabrió una conversación"),
  "conversation.reopened_by_message": say("Reabrió una conversación al escribir", "paciente"),
  "conversation.taken": say("Tomó una conversación"),
  "conversation.released": say("Devolvió una conversación a Sofi"),
  "conversation.identity_resolved": say("Identificó a quién pertenece una conversación"),
  "message.created": say("Registró un mensaje en una conversación"),
  "message.updated": say("Actualizó el estado de un mensaje"),
  "message.media_failed": say("No pudo descargar el archivo de un mensaje"),
  "message.error": say("No pudo procesar un mensaje"),
  // Agente
  "agent.config_updated": say("Cambió la configuración del agente"),
  "agent.admin_updated": say("Cambió los ajustes de Argos"),
  "agent.admin_once": say("Pidió a Argos atender una línea solo esta vez"),
  "admin_line.updated": say("Cambió una línea de Argos"),
  "admin_line.deleted": say("Eliminó una línea de Argos"),
  "admin_line.default_on": say("Prendió «Recordar la cita» al crear la clínica"),
  "admin_line.draft_saved": say("Dejó un borrador de cambio para una línea de Argos"),
  "admin_line.draft_discarded": say("Descartó un borrador de cambio de una línea de Argos"),
  "agent.proposal_created": say("Propuso una acción", "agente"),
  "agent.proposal_confirmed": say("Confirmó en la conversación una acción propuesta", "paciente"),
  "agent.proposal_executed": say("Ejecutó una acción propuesta"),
  "agent.proposal_expired": say("Dio por caducada una propuesta sin decisión"),
  "agent.proposal_failed": say("No pudo ejecutar una acción propuesta"),
  "agent.handoff_created": say("Pasó una conversación a una persona", "agente"),
  "agent.handoff_claimed": say("Tomó una conversación que Sofi derivó"),
  "agent.handoff_retaken": say("Retomó un tema que el equipo no alcanzó a responder", "agente"),
  "agent.person_fact_added": say("Guardó un dato sobre una persona", "agente"),
  "agent.person_fact_removed": say("Quitó un dato guardado sobre una persona"),
  "agent.lesson_proposed": say("Propuso una lección para Sofi"),
  "agent.lesson_approved": say("Aprobó una lección de Sofi"),
  "agent.lesson_discarded": say("Descartó una lección propuesta"),
  "agent.lesson_edited": say("Editó una lección de Sofi"),
  "agent.lesson_restored": say("Restauró una lección de Sofi"),
  "agent.lesson_withdrawn": say("Retiró una lección de Sofi"),
  "agent.review_flagged": say("Marcó una respuesta de Sofi para corregirla"),
  "agent.review_ok": say("Marcó una respuesta de Sofi como correcta"),
  "agent.test_case_saved": say("Guardó un caso de prueba de Sofi"),
  "agent.knowledge_created": say("Creó una respuesta oficial"),
  "agent.knowledge_updated": say("Cambió una respuesta oficial"),
  "agent.knowledge_status": say("Cambió el estado de una respuesta oficial"),
  "agent.knowledge_gap_answered": say("Respondió una pregunta que Sofi no sabía"),
  "agent.error": say("Tuvo un error al responder", "agente"),
  "automation_consent.set": say("Cambió un permiso de mensajes de una persona"),
  "automation_consent.unsubscribed": say("Pidió no recibir más un tipo de mensaje", "paciente"),
  "automation_consent.asked": say("Le preguntó si le puede enviar novedades y promociones", "agente"),
  "automation_consent.stop_word": say("Escribió «BAJA» y dejó de recibir un tipo de mensaje", "paciente"),
  "clinic_message.created": say("Creó un mensaje de WhatsApp de la clínica"),
  "clinic_message.text_changed": say("Cambió el texto de un mensaje de WhatsApp de la clínica"),
  "clinic_message.reverted": say("Volvió al texto anterior de un mensaje de WhatsApp de la clínica"),
  "clinic_message.deleted": say("Archivó un mensaje de WhatsApp propio de la clínica"),
  "channel_template.requested": say("Pidió a WhatsApp la revisión de un mensaje"),
  "channel_template.request_failed": say("No pudo pedir a WhatsApp la revisión de un mensaje"),
  "channel_template.status": say("Recibió de WhatsApp el estado de un mensaje"),
  // Portal del paciente
  "portal.policy_updated": say("Cambió la configuración del portal del paciente"),
  "portal.link_issued": say("Emitió un enlace de acceso al portal"),
  "portal.link_revoked": say("Revocó un enlace de acceso al portal"),
  "portal.link_sessions_revoked": say("Cerró las sesiones abiertas con un enlace del portal"),
  "portal.session_revoked": say("Cerró una sesión del portal"),
  "portal.grant_created": say("Dio acceso al portal a una persona"),
  "portal.grant_revoked": say("Retiró el acceso al portal de una persona"),
  "portal.grant_scope_updated": say("Cambió lo que una persona puede ver en el portal"),
  "portal.access_given": say("Dio acceso al portal a una persona, con su documento a la vista"),
  "portal.access_resent": say("Envió un enlace nuevo para volver a entrar al portal"),
  "portal.passkey_registered": say("Registró su dispositivo para entrar al portal", "paciente"),
  "portal.passkey_authenticated": say("Entró al portal con su dispositivo", "paciente"),
  "portal.passkey_revoked": say("Retiró un dispositivo registrado en el portal"),
  "portal.appointment_confirmed": say("Confirmó su cita desde el portal", "paciente"),
  "portal.appointment_rescheduled": say("Cambió su cita desde el portal", "paciente"),
  "portal.appointment_cancelled": say("Canceló su cita desde el portal", "paciente"),
  "portal.budget_decided": say("Respondió un presupuesto desde el portal", "paciente"),
  "portal.document_read": say("Abrió un documento en el portal", "paciente"),
  "session.opened": say("Entró al portal", "paciente"),
  "session.switched": say("Cambió de paciente dentro del portal", "paciente"),
  "session.remembered": say("Pidió que su teléfono recuerde el portal 30 días", "paciente"),
  "account.viewed": say("Consultó su cuenta en el portal", "paciente"),
  "appointments.listed": say("Consultó sus citas en el portal", "paciente"),
  "budgets.listed": say("Consultó sus presupuestos en el portal", "paciente"),
  "documents.listed": say("Consultó sus documentos en el portal", "paciente"),
  "questionnaire.viewed": say("Abrió un cuestionario en el portal", "paciente"),
  "questionnaire.saved": say("Guardó un cuestionario sin enviarlo, en el portal", "paciente"),
  "questionnaire.submitted": say("Envió un cuestionario desde el portal", "paciente"),
  // Su enlace (ADR 0037): lo que la persona hizo en su página personal.
  "personal_link.sent": say("Le envió su enlace"),
  "personal_link.shown": say("Le mostró su enlace en la clínica"),
  "personal_link.revoked": say("Quitó su enlace"),
  "personal_link.data_sent": say("Completó sus datos desde su enlace", "paciente"),
  "personal_link.budget_decided": say("Respondió un presupuesto desde su enlace", "paciente"),
  "personal_link.messages_chosen": say("Eligió sus mensajes desde su enlace", "paciente"),
  "personal_link.paper_downloaded": say("Descargó un papel desde su enlace", "paciente"),
  // Inventario
  "stock.ingreso": say("Registró un ingreso de existencias"),
  "stock.consumo": say("Registró el uso de un insumo con un paciente"),
  "stock.ajuste": say("Ajustó las existencias de un producto"),
  "stock.traslado": say("Trasladó existencias a otra sede"),
  "stock.uso": say("Registró el uso de un producto fuera de una atención"),
  "stock.agregado": say("Agregó existencias sin compra"),
  "stock.conteo": say("Guardó un conteo del inventario"),
  "stock.baja": say("Dio de baja lo vencido de un producto"),
  "product.imported": say("Agregó productos pegando su lista"),
  "product.created": say("Creó un producto"),
  "product.updated": say("Cambió un producto"),
  "product.deactivated": say("Desactivó un producto"),
  "product.reactivated": say("Reactivó un producto"),
  "supplier.created": say("Creó un proveedor"),
  "supplier.updated": say("Cambió un proveedor"),
  "supplier.deactivated": say("Desactivó un proveedor"),
  "supplier.reactivated": say("Reactivó un proveedor"),
  "warehouse.created": say("Creó un almacén"),
  "warehouse.updated": say("Cambió un almacén"),
  "warehouse.deactivated": say("Desactivó un almacén"),
  "warehouse.reactivated": say("Reactivó un almacén"),
  "stock.service_materials_set": say("Cambió los materiales de un servicio"),
  "stock.encounter_materials_corrected": say("Corrigió los materiales usados en una atención"),
  "purchase_order.created": say("Creó una orden de compra"),
  "purchase_order.confirmed": say("Confirmó una orden de compra"),
  "purchase_order.received": say("Registró lo recibido de una orden de compra"),
  "purchase_order.updated": say("Cambió una compra en borrador"),
  "purchase_order.closed": say("Cerró una compra con lo recibido"),
  "purchase_order.cancelled": say("Canceló una orden de compra"),
  "purchase_order.cancelled_to_credit": say("Canceló una orden de compra y dejó lo pagado a favor con el proveedor"),
  "purchase_order.paid": say("Registró el pago de una compra"),
  "purchase_order.credit_used": say("Pagó una compra con lo que tenía a favor con el proveedor"),
  "purchase_order.credit_use_voided": say("Anuló el uso de lo que tenía a favor con un proveedor"),
  // Configuración
  "org_profile.upsert": say("Cambió los datos de la clínica"),
  "settings.region_updated": say("Cambió el país, la moneda o el formato de la clínica"),
  "settings.diagnosis_system_changed": say("Cambió la lista de diagnósticos de la clínica"),
  "settings.payment_method_created": say("Agregó un medio de pago"),
  "settings.payment_method_updated": say("Cambió un medio de pago"),
  "branch.create": say("Creó una sede"),
  "branch.update": say("Cambió una sede"),
  "branch.deactivate": say("Desactivó una sede"),
  "specialty.create": say("Creó una especialidad"),
  "specialty.update": say("Cambió una especialidad"),
  "specialty.professionals": say("Cambió las especialidades de un profesional"),
  "specialty.attended_by": say("Cambió quién atiende una especialidad"),
  "specialty.services": say("Cambió las especialidades de un servicio"),
  "form_template.create": say("Creó el borrador de una plantilla de formulario"),
  "form_template.update": say("Editó el borrador de una plantilla de formulario"),
  "form_template.publish": say("Publicó una versión de una plantilla de formulario"),
  "form_template.archive": say("Archivó una plantilla de formulario"),
  "consent_template.create": say("Creó el borrador de una plantilla de consentimiento"),
  "consent_template.update": say("Editó el borrador de una plantilla de consentimiento"),
  "consent_template.publish": say("Publicó una versión de una plantilla de consentimiento"),
  "consent_template.archive": say("Archivó una plantilla de consentimiento"),
  "consent_template.services": say("Cambió para qué servicios se pide un consentimiento"),
  "professional_profile.updated": say("Cambió el perfil profesional de alguien del equipo"),
  "catalog.service_created": say("Creó un servicio"),
  "catalog.service_updated": say("Cambió un servicio"),
  "service_catalog.billing_mode": say("Cambió cómo se cobra un servicio"),
  "mailbox.connected": say("Conectó un buzón de correo"),
  "mailbox.reconnected": say("Volvió a conectar un buzón de correo"),
  "mailbox.disconnected": say("Desconectó un buzón de correo"),
  "mailbox.disabled": say("Desactivó un buzón de correo que dejó de responder"),
  "webchat.created": say("Creó el chat web"),
  "webchat.updated": say("Cambió el chat web"),
  "webchat.secret_rotated": say("Cambió la clave de seguridad del chat web"),
  "whatsapp.token_renewed": say("Renovó con Meta la clave de WhatsApp antes de que venciera", "sistema"),
}

/** Lo que hace por su cuenta el agente o el paciente, aunque el código no tenga frase propia. */
const AUTHOR_OF_SUBJECT: Record<string, AuditAuthor> = {
  automation_job: "agente",
  portal: "paciente",
  passkey: "paciente",
  session: "paciente",
  questionnaire: "paciente",
}

function subjectOf(action: string): string {
  const dot = action.indexOf(".")
  return dot < 0 ? action : action.slice(0, dot)
}

/** Área a la que pertenece un registro; `otros` si su tema no se reconoce. */
export function auditAreaOf(action: string): AuditArea | "otros" {
  return AREA_OF_SUBJECT[subjectOf(action)] ?? "otros"
}

/** Los temas de un área, para filtrar la lista en la base. */
export function auditSubjectsOf(area: AuditArea): string[] {
  return Object.entries(AREA_OF_SUBJECT)
    .filter(([, value]) => value === area)
    .map(([subject]) => subject)
}

function phraseOf(action: string): Phrase {
  const own = ACTION_WORDS[action]
  if (own) return own
  const subject = subjectOf(action)
  const rest = action.slice(subject.length + 1)
  if (subject === "appointment" && rest.startsWith("status_")) {
    return say(APPOINTMENT_STATUS_WORDS[rest.slice("status_".length)] ?? "Cambió el estado de una cita")
  }
  const by = AUTHOR_OF_SUBJECT[subject]
  const about = SUBJECT_WORDS[subject]
  if (!about) return say("Hizo un cambio", by)
  const verb = VERB_WORDS[rest]
  return say(verb ? `${verb} ${about}` : `Hizo un cambio en ${about}`, by)
}

export interface AuditWords {
  /** Qué pasó, como predicado: «Reservó una cita». */
  what: string
  /** Quién lo hizo cuando no fue alguien del equipo; con una persona del equipo, su nombre manda. */
  author: string
  area: AuditArea | "otros"
  areaLabel: string
}

/**
 * Un registro dicho con palabras. Nunca devuelve el código. `origin` es lo que
 * el propio registro anotó sobre quién actuó: `agent` (los contactos) o
 * `patient` (lo que hizo la propia persona, con el actor `contact:<id>`).
 */
export function describeAuditEvent(action: string, origin?: string | null): AuditWords {
  const phrase = phraseOf(action)
  const area = auditAreaOf(action)
  return {
    what: phrase.what,
    author: AUTHOR_WORDS[origin === "agent" ? "agente" : origin === "patient" ? "paciente" : (phrase.by ?? "sistema")],
    area,
    areaLabel: AUDIT_AREA_LABELS[area],
  }
}
