# 0141 · En una clínica nueva todo viene encendido

Fecha: 2026-11-05 · Estado: aceptada · Sustituye a [0026](0026-recordar-la-cita-viene-prendida.md) · Precisa [0012](0012-asistente-clinico-sugiere-y-el-odontologo-confirma.md), [0014](0014-reservar-desde-un-enlace-personal.md), [0015](0015-administrador-lineas-prendidas-o-apagadas.md), [0037](0037-su-enlace-y-portal-en-un-paso.md), [0071](0071-metas-descargar-y-el-resumen-del-lunes.md) y [0101](0101-registrar-por-el-chat-con-un-solo-si.md), siguiendo [0117](0117-consentimientos-activos-y-hoja-editable.md) · Deja como están [0085](0085-cobro-por-tipo-de-accion.md) y [0107](0107-verificacion-en-dos-pasos-del-equipo.md)

## Problema

Una clínica nueva nacía con casi todo apagado: Sofi, Argos, Clío, el registro de pacientes, el portal y el resumen del lunes. Solo «Recordar la cita» venía prendida (0026), y ni eso funcionaba: sin Sofi ni Argos no sale ningún recordatorio. La clínica mediana no busca cada interruptor, y la pantalla de conectar WhatsApp prometía algo que no pasaba. El alta asistida, cuyo perfil ya existía, ni siquiera traía «Recordar la cita».

## Decisión y motivo

El usuario lo decidió el 2026-11-05 (ronda de QA del 2026-11-04): «todo encendido» por defecto en una clínica nueva; las que ya existen no cambian.

- **Cuándo:** `setUpNewClinic` (`packages/services/src/new-clinic.ts`) corre al guardar los datos de la clínica mientras aún no tiene ninguna sede, ni archivada (`PUT /org-profile`). Vale en los dos caminos: el registro propio y el alta asistida.
- **Qué enciende**, cada cosa con la misma operación que usaría una persona, a nombre de quien crea la clínica y con su registro en Actividad del equipo:
  - Sofi, Clío y Argos;
  - todas las líneas del catálogo de Argos;
  - el registro de pacientes con un aviso de privacidad sugerido;
  - el portal con todo su alcance;
  - el resumen del lunes de quien la crea;
  - el presupuesto del mes, con la cuota del plan (o la del plan de lista de su producto durante la prueba).
- **Solo lo que aún no tiene estado:** repetirlo no cambia lo que alguien ya decidió, y una clínica que ya tenía sede no cambia. No cambia ningún valor por defecto de la base ni del código: «sin fila = apagado» sigue valiendo para las de antes.
- **El aviso de privacidad sugerido** se arma con los datos de la clínica: quién es, para qué usa los datos, quién más los trata y que algunos están fuera del país, cuánto se guardan y cómo pedir verlos o borrarlos; en Perú, la Ley 29733. Como los consentimientos de 0117:
  - dice «Sugerido, sin revisar» (`patient_registration_config.notice_suggested_at`) hasta que alguien de la clínica lo cambia o marca «Lo revisé»;
  - mientras tanto, se vuelve a armar si cambian la razón social, el RUC o la dirección.
  No se presenta como cumplimiento legal.
- **Cada sede nueva nace con su primera unidad** («Unidad dental 1», «Consultorio 1»): sin ella no se reserva.
- **Se dice donde se decide**, con su enlace para apagarlo:
  - Inicio, recién creada: «Tu clínica viene con esto encendido», solo lo que está encendido de verdad;
  - al conectar un canal: «Sofi responde desde ahora»;
  - el costo de Clío, en su página y junto a «Dictar la atención»;
  - Registro de pacientes: «Sugerido, sin revisar»;
  - el portal y Argos dicen que una clínica nueva los trae encendidos.
- **Siguen apagados, a propósito:**
  - la verificación en dos pasos obligatoria: bloquearía el alta de quien aún no la configuró (0107);
  - «Sumar solas» las preguntas a Argos: gastaría sin preguntar (0085).

## Alternativas descartadas

- *Cambiar los valores por defecto de la base o del código:* encendería también las clínicas que ya existen, sin que nadie de ellas lo decida.
- *Una marca «ya se preparó» en el perfil:* un dato más para lo mismo que dice «aún no tiene sede».
- *Un aviso que pida confirmar cada cosa antes de usarla:* frena el alta; la UX de odentIA avisa y deja decidir.

## Consecuencias

- Una clínica nueva recuerda las citas, responde y registra desde que conecta su canal. Lo que hacen los agentes no gasta más que la cuota del plan sin que la clínica lo decida.
- El aviso de privacidad queda publicado sin que nadie de la clínica lo haya leído: por eso se marca «sin revisar» en Configuración y en Inicio.
- Las pruebas de extremo a extremo parten de una clínica de antes (`asClinicFromBefore` en `e2e/fixtures.ts`). La que nace encendida se prueba aparte, con `born: "encendida"` y en el alta por la interfaz.

## Referencias

- `packages/services/src/new-clinic.ts`, `packages/services/src/automation.ts` (`turnOnNewClinicLines`), `packages/services/src/saas-billing.ts` (`setNewClinicSpendCap`), `packages/services/src/branches.ts` (`createBranch`), `apps/api/src/app.ts` (`PUT /org-profile`).
- `packages/db/drizzle/0048_aviso_sugerido.sql`.
