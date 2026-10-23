# 0082 · «Mi calendario»: la agenda en el calendario de quien atiende

- **Fecha:** 2026-10-23
- **Estado:** aceptada (lote 2 del issue 46; el lote 1 es la ADR 0081)

## Problema

Quien atiende usa su propio calendario (Google, Apple, Outlook) para todo su día y hoy tiene que abrir odentIA para saber cuál es su próxima cita. Un calendario externo es de un tercero: lo que entra ahí sale de la clínica y lo ve quien mire su celular o el calendario que comparte. El enlace de suscripción no lleva sesión, así que cualquiera que lo copie ve lo mismo.

## Decisión y motivo

- **Un enlace privado por persona y por clínica**, solo para leer (`webcal`). Lo crea quien atiende pacientes (`clinical.write`) desde la Agenda («Mi calendario»). El token no se guarda: se recalcula con la clave del servidor y el id del enlace, como «Su enlace» (ADR 0037); la base guarda su huella.
- **Lo mínimo de cada cita:** «Paciente · R. P.», la hora, la sede con su dirección, la unidad dental y un enlace a la cita que pide entrar a odentIA. Nunca el nombre, el servicio ni el motivo, y **ninguna clínica puede elegir mostrar más** (decisiones 1 y 11).
- **Citas de hoy a 90 días**, sin las canceladas. «Por confirmar» no se marca: el calendario puede tardar y la marca quedaría vieja. El `UID` y el `SEQUENCE` son los del archivo de la cita (ADR 0081), así una cita que ya llegó por correo no se duplica.
- **Cambiar o apagar:** «Cambiar enlace» deja inservible el anterior al momento; «Dejar de compartir» lo apaga. La Administración lo apaga desde Equipo sin ver el enlace. Se apaga solo, la siguiente vez que se pide, si la persona ya no es del equipo o ya no atiende. Revocar deja historia; nada se borra.
- **Registro de uso pequeño:** una fila por enlace, día y programa (Google Calendar, el calendario del iPhone…), con cuántas veces y la primera y la última hora. Sin direcciones IP, borrada a los 90 días. Se cuenta el programa y no el lugar porque Google pide desde muchos servidores: contar direcciones daría avisos falsos.
- **Aviso de uso nuevo:** el primer programa y los del primer día son de quien lo creó. Después, un programa que no reconoció avisa una vez en la campana y en el panel, con «Cambiar enlace» o «Fui yo».
- **Cuánto tarda no lo prometemos:** el archivo pide refrescar cada hora (`REFRESH-INTERVAL`), pero cada calendario decide; la pantalla solo dice que puede tardar y que odentIA no lo controla.

## Alternativas descartadas

- **Nombre completo con permiso de la clínica** (lo dejaba abierto el issue): la salud es dato sensible y el calendario es de un tercero; un ajuste más para un riesgo que las iniciales evitan.
- **Sincronizar en las dos direcciones** (mover una cita desde Google): pide la cuenta de cada persona en cada proveedor y reglas de conflicto; la Agenda sigue siendo el único lugar donde se cambia una cita.
- **Anotar cada pedido o la dirección IP:** el iPhone pide cada pocos minutos; con eso el registro crece sin aportar más que la fila del día.
- **Un enlace para todas las clínicas de la persona:** cada clínica debe poder apagar el suyo sin tocar el de otra.

## Consecuencias

- Quien atiende ve su día completo en su calendario, pero un cambio puede tardar en llegar (Google, hasta un día). Para lo de hoy, la Agenda.
- Dos pacientes con las mismas iniciales se distinguen por la hora; el enlace de la cita lleva a la persona correcta.
- Un `User-Agent` falso puede pasar por Google: el aviso ayuda, no garantiza. Si hiciera falta más, se puede sumar el país de la dirección sin guardarla.
- Revisar si un país donde vendamos pide algo distinto para datos de salud en calendarios de terceros.

## Referencias

- `packages/services/src/calendar-feeds.ts`, `icalendar.ts` (`calendarFeedFile`); migraciones `0083` y `0084`.
- `apps/api/src/routes/calendar-feeds.ts` (`/api/agenda/calendar` y `/api/public/calendar/<token>.ics`).
- `apps/dental-clinic/src/components/agenda/my-calendar-drawer.tsx`; Equipo en `settings.team.tsx`.
- Lienzo «Suscribir mi agenda (issue 46, lote 2)», aprobado el 2026-10-23.
