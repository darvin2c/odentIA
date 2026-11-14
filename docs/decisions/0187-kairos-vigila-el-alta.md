# 0187 · Kairós vigila el alta

Fecha: 2026-11-14 · Estado: aceptada · Cambia el borrado de la [0186](0186-correo-de-la-administracion.md) y de la [0185](0185-el-arm-de-la-administracion.md); extiende los pasos de Alta de la 0185 y la carga de la [0183](0183-la-carga-corre-en-el-servidor.md)

## Problema

- Desde la 0186, todo correo a `soporte@` con adjuntos se borraba a los 30 días con su texto, porque no se sabía cuál era la carga de datos. Así se borraban contratos, capturas y comprobantes que nadie pidió borrar, y no quedaba dicho qué había sido la carga.
- El alta se calculaba al leer, desde los hechos de hoy: retrocedía si se borraban sesiones, cambiaba la versión del contrato, llegaba una invitación nueva o se desactivaba un WhatsApp. Nadie veía cuánto llevaba cada clínica ni dónde se quedaba.
- WhatsApp contaba como «conectado» sin que Meta lo hubiera verificado, y «Datos recibidos» se daba por hecho con cualquier correo a `soporte@`.
- El equipo es chico: los plazos de la carga (cargarla, avisar antes de que se borre, pedirla otra vez) y lo que se traba tienen que llegar a Hoy, no buscarse.

## Decisión y motivo

1. **Se borra solo lo que Administración marca como la carga.** «Es la carga de datos» se marca desde Hoy o desde la ficha › Documentos, sobre el adjunto que ya llegó, sin volver a subirlo (`markClientFileCarga`: pasa de `correo` a `archivo_clinica`). Se borra a los 30 días de **llegar**, con el texto de su correo; si se marca después, se borra al marcarlo, con auditoría, y la pantalla lo dice antes del sí. La fecha la da el servidor (el día de Lima). La marca no se deshace: la base lo impide (`saas_client_file_carga_guard`). Lo que nadie marca se guarda. Un correo sin cliente no se marca: primero se dice de qué cliente es.
2. **Kairós sugiere, no decide.** Al desplegar, lo de `soporte@` que estaba programado para borrarse deja de estarlo (`client_file.retention_lifted`). Kairós pregunta «¿Es la carga de datos?», solo a Administración y una vez por archivo, por lo que estaba programado y por cada Excel, CSV o Word que llega, juzgado por su tipo y su nombre, sin abrirlo. La pregunta vence a los 30 días de llegar el archivo, no a las 48 h, y a los 25 días pasa a urgente. Va primero en Hoy.
3. **El alta guarda la primera vez de cada paso** (`saas_client_milestone`) y no retrocede. Solo hay dos pérdidas: el primer pago revertido (no queda ningún pago confirmado y hay uno reversado; uno devuelto no la causa) y los datos borrados sin cargar. La base no deja mover una primera vez. Lo calcula una sola función (`computeOnboarding`) para la ficha, el Embudo «Alta», los reportes y la pasada de Kairós, que los guarda (`syncOnboardingMilestones`).
4. **«No aplica», con su motivo, lo marca una persona** en Equipo, WhatsApp y Pacientes (Pacientes, solo Administración). El paso deja de contar en el total y de esperarse.
5. **WhatsApp está conectado cuando Meta verificó la dirección o llegó el primer mensaje.** Sin las credenciales de Meta, el paso dice «Espera a Meta». «Datos recibidos» cuenta solo lo marcado como la carga; lo de `soporte@` cuenta como respaldo solo si la clínica ya tuvo una carga.
6. **Las tareas llevan `admin_only` en una columna**, y una de cobro lo es siempre. Soporte no las ve en ninguna parte, y asignarle una da 400 en el campo del responsable.
7. **Los plazos de la carga.** A los 2 días de marcarla, «Cargar los datos de…»; a 5 días o menos de borrarse, la urgente «…: se borran en N días»; si se borró sin cargar, Kairós prepara el mensaje para pedirla otra vez. También vigila la carga con errores («Revisar los N que no entraron»), la propietaria que no acepta, las invitaciones del equipo vencidas, la prueba que termina y el alta trabada (7 días sin avanzar, contados desde que se empezó a vigilar; nunca durante la prueba vigente en «Primer pago»). La tarea va a quien hizo la última carga, si no al responsable, si no a nadie; solo a personal activo y, si es solo de Administración, a alguien de Administración.
8. **Los mensajes a la clínica salen solo con el sí de una persona**, como todo lo de Kairós (0185).
9. **El Embudo suma «Alta»**: Bienvenida, Sus datos, Arranque, Primer pago y Pagó, con lo que falta, a quién le toca y cuánto lleva. Reportes › Alta dice cuántas pagaron, en cuántos días y dónde se quedan, con la misma regla.

## Alternativas descartadas

- *Seguir borrando por buzón.* Borra lo que nadie pidió borrar y no dice qué fue la carga.
- *Una fila nueva al marcar* (copiar el adjunto como `archivo_clinica`). La clave del objeto es única y habría dos documentos del mismo archivo, uno que se borra y otro que no.
- *Que Kairós decida la carga por el tipo del archivo.* Un Excel puede ser un comprobante; marcarlo borra, y eso lo decide una persona.
- *Guardar el estado del alta en vez de calcularlo.* Quedaría atrás de la ficha. Se guarda solo la primera vez de cada paso; el estado se calcula.
- *Que una versión nueva del contrato reabra el alta.* Esa aceptación es de la clínica en la app, no un paso del alta que se pierda.

## Consecuencias

- Lo que nadie marca se guarda: el riesgo pasa de borrar de más a guardar de más. Kairós lo pregunta y lo sube en Hoy para que alguien decida.
- Las clínicas que tenían «Datos recibidos» solo por un correo a `soporte@`, sin carga, lo pierden al desplegar y salen como «¿Es la carga de datos?».
- Mientras se despliega, el worker y la API anteriores todavía pueden registrar un adjunto de `soporte@` con fecha de borrado, sin su correo y como llegado ahora, después de que corrió la 0118. Cada pasada de Kairós lo levanta como la 0118 (`liftLeftoverCorreoRetention`: sin fecha de borrado, con `client_file.retention_lifted` y ligado a su correo con la hora del correo), y Kairós lo pregunta. Lo que el worker anterior borre en esos minutos (los adjuntos viejos de `soporte@` sin ligar que ya vencían) no lo puede impedir el código nuevo.
- Kairós cierra solo lo que ya se resolvió: el pago revertido cuando vuelve a haber un pago confirmado, la prueba por terminar al pagar o al salir de prueba, el alta trabada cuando avanza o deja de estarlo (una abierta por cliente), los plazos de la carga cuando su archivo ya no está (avisa por el que se borra primero) y el pedido de los datos borrados cuando se cargan después. En Hoy caben dos posibles cargas que no son urgentes; las demás esperan en Kairós.
- Los adjuntos de un correo a `soporte@` sin cliente se guardan hasta que se liga y se marca. La sugerencia de ligarlo dice «puede ser la carga de datos» cuando trae un Excel, CSV o Word.
- **Pendiente legal.** El contrato de encargo (`apps/web/src/lib/legal/encargo.ts:63`), la página de proveedores (`apps/web/src/lib/legal/subencargados.ts:52`) y el aviso de cambios (`packages/auth/src/legal.ts:30`) prometen borrar los archivos de la carga y su correo «al terminar la carga o, a más tardar, a los 30 días» de recibidos. Con esta decisión, lo que nadie marca se guarda, y la copia que el Email Worker reenvía primero al buzón de siempre (0185) no se borra desde el ARM. Este cambio no toca esos textos: lo decide el dueño.
- **Recortes.** No se marca lo que llega por WhatsApp (todavía no llegan sus archivos) ni un documento subido a mano como `otro`; la marca no se deshace; el Embudo «Alta» y su reporte calculan por cliente (N+1), que alcanza con decenas de clínicas y pide otra entrega cuando crezcan; el resumen semanal de Kairós no cita las cifras del alta; si falla el storage al borrar un documento a mano, queda el objeto y ninguna limpieza lo reintenta; un check en la base (`archivo_clinica` o sin fecha de borrado) queda para una entrega posterior; la demo tiene una sola cuenta nueva (Demo Datos): Arranque y Primer pago se ven en las pruebas.
- Revisar si casi todo lo que Kairós pregunta como posible carga resulta serlo: entonces podría proponerse marcarlo con una sola confirmación.

## Referencias

- Esquema: migraciones `0118_kairos_vigila_el_alta` y `0119_kairos_vigila_el_alta_reglas` (disparadores y relleno); `packages/db/src/schema/admin-arm.ts`.
- Servicios: `packages/services/src/admin-client-files.ts` (`markClientFileCarga`, `dueClientFileDeletions`), `admin-onboarding.ts` (`computeOnboarding`, `syncOnboardingMilestones`, `altaBoard`, «No aplica»), `admin-kairos.ts` (reglas del alta y `posible_carga`), `admin-reports.ts` (`altaReport`), `admin-alta-sql.ts`, `admin-sales.ts` y `admin-clients.ts` (`taskHiddenFromSupport`).
- API: `apps/api/src/routes/admin-clients.ts` (`/files/:fileId/carga`, `/onboarding/:step/not-applicable`, `/pipeline/alta`) y `admin-reports.ts` (`/reports/alta`).
- Pantallas: `apps/admin/src/components/arm/client-files-tab.tsx`, `email-drawer.tsx`, `kairos-items.tsx`, `client-onboarding-tab.tsx` y `alta-pipeline.tsx`.
- Skill de carga: `.claude/skills/odentia-carga/SKILL.md`.
