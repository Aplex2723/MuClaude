# Menú de barra para MuClaude

## Problem Statement
¿Cómo podríamos llegar a cualquier cuenta de Claude en un clic sin que
MuClaude ocupe un lugar permanente en el Dock?

## Recommended Direction
Un ícono en la barra de menú de macOS con un menú nativo (`Tray` + `Menu`),
sin popover web. Cerrar la ventana la oculta y quita MuClaude del Dock;
⌘Q y la entrada "Salir" cierran la app de verdad. El menú es corto a
propósito: una fila por instancia, abrir la ventana y salir.

Cada fila usa el ícono real del launcher (`app.getFileIcon`), así se ve igual
que en el Dock. El menú se reconstruye en cada clic para no quedarse viejo
tras crear o eliminar instancias.

Dos consecuencias que hay que resolver desde el principio:
- **Actualizaciones:** el updater instala "al salir". Una app de barra de menú
  casi nunca sale, así que el menú necesita "Reiniciar para actualizar"
  cuando el estado del updater es `ready`.
- **Guardias de cierre:** `dirtyCount` y `applying` hoy se comprueban en
  `close`. Si cerrar solo oculta, los cambios sin aplicar sobreviven y el
  aviso solo se mantiene para "Salir".

## Key Assumptions to Validate
- [ ] El menú se reconstruye en cada clic sin parpadeo: la lógica está probada con 12 instancias
      (`scripts/test-menubar.js`); falta mirarlo a ojo en una barra de menú real.
- [x] ~~`app.getFileIcon` devuelve el ícono coloreado del launcher~~ **Falso**: en macOS devuelve el ícono
      genérico de ".app" (probado también fuera del sandbox). Se lee el `AppIcon.icns` del launcher y se
      convierte con `sips` (~25 ms, en caché por fecha de modificación del launcher).
- [x] Con la política "accessory" activa, la ventana vuelve a ser enfocable desde el menú: `app.dock.hide()` /
      `app.dock.show()` probado en Electron real (`npm run test:menubar-ui`).
- [ ] Una actualización descargada se puede instalar desde el menú: el menú y los guardias están probados;
      falta una actualización real. `quitAndInstall` cierra las ventanas, por eso `quitting` se activa antes.

## MVP Scope
Dentro:
- Ícono de barra (imagen plantilla monocroma).
- Filas de instancias Desktop con su ícono y nombre; clic abre o enfoca (`instance:open`).
- "Abrir MuClaude" y "Salir".
- X oculta la ventana; el Dock aparece solo con la ventana visible.
- "Reiniciar para actualizar" cuando `updater` está en estado `ready`.
- Ajuste opcional "Iniciar al abrir sesión", apagado por defecto, que arranca oculto.

Fuera: todo lo de la lista de abajo.

## Not Doing (and Why)
- Perfiles de Code y entornos externos en el menú: decidido dejarlos para después.
- Popover o ventana web en la barra: un menú nativo es más simple y accesible.
- Indicador "abierta" y atajo global: valen la pena, pero van después de validar el menú.
- Soporte Windows (bandeja del sistema): la app es macOS primero, y la idea es de barra de menú.
- Arranque al iniciar sesión activado por defecto: es intrusivo en una app sin notarizar.

## Open Questions
- [x] ¿⌘Q con el menú de barra debe salir siempre o preguntar? Pregunta solo si hay cambios sin aplicar, igual
      que antes con cerrar la ventana; con una aplicación en curso, avisa y no sale.
- [x] ¿Cómo se ve el ícono de barra? Un interruptor (la forma del ícono de la app) como imagen plantilla,
      generado por `desktop/scripts/make-tray-icons.js`.
- [x] ¿Qué pasa con 0 instancias? Solo "Abrir MuClaude" y "Salir".
