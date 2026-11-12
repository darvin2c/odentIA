# 0184 · Soporte mira la clínica con un rol, en solo lectura

Fecha: 2026-11-12 · Estado: aceptada · Precisa la [0181](0181-quien-ve-un-caso-de-soporte.md) en qué puede ver soporte con el permiso de la clínica

## Problema

Para revisar que la historia anterior de una clínica nueva quedó bien cargada, soporte necesita mirar sus pantallas: pacientes, historia y documentos. Hasta ahora el permiso de soporte («acceso diagnóstico») solo abría, en la administración, una lista de la configuración: nunca una pantalla de la clínica ni un paciente. Además, el permiso no decía a qué persona de soporte se daba, admitía varios vigentes a la vez, no dejaba quién lo quitaba y seguía vivo si el caso se resolvía. La clínica no veía qué se había mirado.

El contrato de encargo vigente ya promete lo que el diseño tiene que cumplir: soporte ve los datos de una clínica solo con su permiso, por caso, una hora como máximo, revocable, y cada acceso y cada intento quedan registrados.

## Decisión y motivo

- **La clínica elige con qué rol mira soporte.** «Solo la configuración» es el diagnóstico de siempre. Si no, elige un rol de su equipo (Recepción, Caja, el profesional, Administrador; en vistIA, también Ventas y Taller), y soporte ve lo que vería ese rol. Se reusa la matriz de permisos: no hace falta otra forma de recortar qué se ve. Lo decidió el dueño del producto frente a elegir pacientes uno por uno.
- **Soporte entra a la misma app de la clínica**, no a una copia en la administración. Lo hace con un pase de un solo uso que dura un minuto y que solo se guarda como hash (`support_access_session`). La app lo canjea por una sesión propia, en su cookie, que no es la de Better Auth ni da membresía, y que vale lo mismo que el permiso.
- **No puede escribir, y no depende solo de la pantalla.** Hay tres frenos en el servidor:
  - todo lo que no sea GET o HEAD responde 403;
  - las transacciones de la clínica son de solo lectura en la base (`runReadOnly`, `set transaction read only`);
  - una respuesta que sería una descarga (PDF, CSV, adjunto) se cambia por un 403.
  La pantalla, además, esconde los botones de escribir.
- **Los archivos pasan por la API** mientras mira soporte (`runWithFileProxy`): una dirección firmada del almacenamiento seguiría sirviendo 15 minutos después de quitar el acceso.
- **Cada ficha que abre queda anotada antes de mostrarse**, en la misma bitácora que «Consultas a la historia». Si no se puede anotar, no se muestra. La clínica lo ve en el caso y en la ficha, como «Soporte de odentIA · nombre».
- **Un solo permiso vigente por clínica**, garantizado en la base. Dar otro cierra el anterior, así el tope de una hora no se encadena abriendo casos. El permiso es de una persona de soporte: la que lo pidió o, si la clínica lo dio sin pedido, la primera que lo usa. Termina solo si se resuelve el caso o si quien lo dio deja de ser propietaria o administradora. Dar y quitar quedan en la auditoría y en «Actividad del equipo», con quién y por qué terminó.
- **Todo el equipo ve la franja mientras dura**, y no se puede cerrar. No copia el texto del caso. Quitarlo, solo la propietaria y los administradores.
- **Dar acceso sin que lo pidan es un botón en Ayuda.** Abre el caso que exige el contrato en la misma operación. Soporte también puede pedirlo con un rol y un tiempo, y la clínica lo confirma o lo cambia.

## Alternativas descartadas

- *Elegir pacientes uno por uno, y de cada uno solo partes de la ficha.* Fue la propuesta de la mesa, por proporcionalidad. El dueño del producto prefirió el rol: usa los permisos que ya existen y es más simple de entender. Con el rol del profesional, soporte puede abrir a cualquier paciente, y por eso cada ficha queda anotada y a la vista de la clínica.
- *Vistas de lectura dentro de la administración.* No son las pantallas reales, que es lo que se quería revisar, y duplicarían pantallas.
- *Hacer a soporte miembro temporal de la clínica.* Aparecería en Equipo y en las listas del equipo, rompe que el personal nunca es miembro, y si la baja falla queda con acceso.
- *Entrar como la propietaria.* Suplanta a una persona y deja el rastro a su nombre.

## Consecuencias

- El acceso por rol no tiene una marca para lo sensible (VIH, salud mental, violencia): soporte ve lo que ve el rol. Lo único que se protege aparte es la historia bloqueada, que no se abre con ningún rol. Una marca para lo sensible queda como pendiente con clínica y abogado.
- Abrir un documento es bajarlo al navegador: no se ofrece descargar ni imprimir, y la API no sirve descargas, pero lo que se ve en pantalla se ve.
- La «clínica que no paga» en solo lectura podrá reusar los mismos frenos.
- El panel de la cuenta solo da el acceso a la configuración: mirar con un rol se da desde la Ayuda de la clínica.

## Referencias

- **Servicios:** `packages/services/src/admin-support.ts` (`grantSupportAccess`, `revokeSupportAccess`, `giveSupportAccessFromHelp`, `requestSupportAccess`), `support-session.ts` (pase, canje, sesión), `clinic-notices.ts` (la franja), `storage.ts` (`runWithFileProxy`).
- **Base:** `packages/db/src/schema/admin-support.ts` (`support_access_grant`, `support_access_session`), `packages/db/src/context.ts` (`runReadOnly`), migración `0106_acceso_soporte_por_rol`.
- **API:** `apps/api/src/lib/support-session.ts` (sesión, frenos, archivos), `apps/api/src/routes/patients.ts` (anotar antes de mostrar).
- **Pantallas:** `packages/clinic-app/src/components/support-access.tsx`, `support-cases.tsx`, `routes/public/soporte.tsx`, `lib/support-mode.ts`; `apps/admin/src/routes/_app/support.tsx`.
