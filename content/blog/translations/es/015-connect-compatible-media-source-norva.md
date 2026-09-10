---
language: "es"
source_slug: "connect-compatible-media-source-norva"
source_sha256: "8efa2f6c3971568d3ed277e8cdd99305ea755c0d2b3628b40aefe9cc0d3bf659"
title: "Cómo conectar una fuente multimedia compatible a Norva"
seo_title: "Cómo conectar una fuente multimedia compatible a Norva"
meta_description: "Prepara, conecta y verifica una fuente multimedia compatible autorizada en Norva, protegiendo las credenciales y dejando claras las observaciones del diagnóstico."
excerpt: "Conecta una fuente compatible autorizada mediante la gestión actual de Norva, protege sus ajustes, espera a que cargue el catálogo y verifica un elemento conocido antes de añadir más fuentes."
topic_cluster: "Configuración y cuenta de Norva"
sources_heading: "Fuentes"
next_step_heading: "Tu siguiente paso"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Cómo conectar una fuente multimedia compatible a Norva

> **En pocas palabras:** En la web, abre el menú de tu cuenta, después Settings (Ajustes) y TV service (Servicio de TV). Elige M3U link para una URL completa de lista de reproducción o Xtream login para datos compatibles de un proveedor. Conecta solo una fuente que te pertenezca o que estés autorizado a usar, mantén privadas sus credenciales y verifica un elemento conocido antes de añadir más fuentes. Norva es un reproductor; no proporciona la fuente ni los medios.

**Qué se comprobó:** el 10 de septiembre de 2026 utilizamos una cuenta de prueba con sesión iniciada en la aplicación web en producción para revisar los formularios y enviar un acceso Xtream de prueba aportado por el usuario. Una revisión posterior confirmó **Ready** (Lista), el filtrado lingüístico por fuente y una búsqueda que abría un título con doce versiones. Las capturas web son directas, sin modificar y sin datos privados de conexión. No se probó una importación M3U ni un recorrido nativo de teléfono/TV; la reproducción correcta sigue siendo una comprobación aparte.

## Antes de empezar

Confirma las cuatro condiciones:

- Controlas la cuenta de Norva.
- La fuente te pertenece o tienes permiso para usarla.
- Sus condiciones permiten la conexión prevista.
- Norva admite actualmente el método de conexión de la fuente.

Obtén los datos oficiales directamente del propietario de la fuente o de su página de cuenta. No uses ajustes reenviados sin un origen claro.

Consulta [Qué preparar antes de añadir tu fuente multimedia](/blog/prepare-media-source-setup/) para disponer de una ficha previa.

## Paso 1: usar un acceso oficial a Norva

Abre Norva desde su sitio oficial o la aplicación instalada. Comprueba la dirección o identidad de la aplicación antes de introducir información de cuenta o fuente.

Inicia sesión en la cuenta y el perfil previstos. Si utilizas un dispositivo compartido o prestado, no guardes credenciales privadas salvo que sea de confianza y las condiciones de la fuente lo permitan.

**Resultado observable:** la cuenta se abre normalmente y puedes acceder a los controles de gestión de fuentes.

## Paso 2: localizar la gestión de fuentes

En la web, abre el menú de cuenta, elige **Settings** (Ajustes) y después la pestaña **TV Service** (Servicio de TV). Estos textos en inglés se traducen al seleccionar otro idioma de interfaz. Si la aplicación se abre en Inicio, sigue esta ruta de menú; no des por hecho que un enlace guardado a los ajustes de fuente abrió el panel correcto.

Elige **Add playlist** (Añadir lista de reproducción) o **Add provider** (Añadir proveedor) para abrir **Add TV service** (Añadir servicio de TV). Dentro, las pestañas **M3U link** (Enlace M3U) y **Xtream login** (Acceso Xtream) permiten adaptar el formulario a los datos que realmente recibiste.

Antes de introducir nada, comprueba si ya existe otra fuente. Añadir la misma dos veces puede crear categorías aparentemente duplicadas y complicar el diagnóstico posterior.

**Resultado observable:** aparece un formulario de fuente o una opción de conexión admitida.

## Paso 3: seleccionar un método compatible documentado

Haz esta distinción antes de pegar nada:

| Qué tienes | Opción en Norva | Primera comprobación |
| --- | --- | --- |
| Una dirección completa de lista de reproducción | M3U link | La URL completa procede de tu fuente autorizada, no de una página de descarga de aplicaciones. |
| Dirección y credenciales de servidor compatibles, o un enlace Xtream completo | Xtream login | El propietario confirma el formato y tu permiso para conectarlo. |
| Solo un usuario y una contraseña de otra aplicación | My provider only gave me an app login | Pide un formato de fuente compatible; no adivines la dirección del servidor. |

![Formulario M3U de Norva con el campo Playlist URL, nombre de servicio opcional y botón Add.](/assets/blog/source-m3u-live-web-20260910.jpg "Formulario M3U web en producción, 10 de septiembre de 2026. Los campos están vacíos; la imagen no demuestra una importación M3U completada.")

Para **M3U link**, introduce la dirección completa en **Playlist URL**. El formulario describe una dirección `http` o `https` y ofrece `.m3u`, `.m3u8` y `get.php` como indicios habituales, no como prueba de permiso o compatibilidad. **Service name** (Nombre del servicio) es opcional: un apodo neutro ayuda a distinguir fuentes sin revelar credenciales.

![Formulario Xtream de Norva con el primer paso de conexión y opciones de enlace completo o datos manuales del servidor.](/assets/blog/source-xtream-live-web-20260910.jpg "Paso inicial de Xtream en producción, capturado antes de introducir el acceso de prueba. Continue lleva a elegir el periodo de acceso, no directamente a una importación completada.")

Para **Xtream login**, el recorrido actual empieza en **Connect provider** (Conectar proveedor). Usa **Provider URL or complete Xtream link** (URL del proveedor o enlace Xtream completo), o despliega **Enter server login manually** (Introducir manualmente los datos de acceso al servidor) si recibiste ese formato. Revisa cada paso posterior en pantalla; **Continue** (Continuar) no confirma que la fuente ya esté conectada.

Haz corresponder cada valor solicitado con los datos oficiales de la fuente. Evita añadir espacios, cambiar mayúsculas y minúsculas o «corregir» una dirección salvo que lo indique su documentación.

La política de privacidad de Norva dice que los ajustes de fuente se usan para conectar el servicio a esa fuente en nombre del usuario. Revísala antes de enviar ajustes sensibles.

### Si solo tienes credenciales de una aplicación

Selecciona **My provider only gave me an app login** (Mi proveedor solo me dio credenciales de una aplicación). El panel explica por qué no se pueden importar sin más las credenciales de otra aplicación como fuente de Norva y proporciona un mensaje para pedir un enlace M3U compatible o datos de servidor Xtream. Contacta con el propietario por su canal oficial; no pegues contraseñas en publicaciones públicas de soporte.

![Panel de ayuda de Norva que explica que un acceso de aplicación necesita datos de fuente compatibles para conectarse.](/assets/blog/source-app-login-help-live-web-20260910.jpg "Ayuda web en producción para credenciales limitadas a una aplicación; no se muestra una cuenta de proveedor ni un enlace privado.")

## Paso 4: introducir los ajustes en privado

Usa copiar y pegar cuando resulte práctico y revisa el principio y el final de cada valor no secreto. Mantén contraseñas, enlaces privados, usuarios y tokens fuera de:

- capturas de pantalla;
- grabaciones de pantalla;
- conversaciones públicas de soporte;
- notas de análisis;
- documentos compartidos;
- herramientas de historial del portapapeles en las que no confíes.

Si un televisor dificulta la introducción segura, usa el proceso documentado de vinculación o cuenta en lugar de exponer las credenciales.

**Resultado observable:** los campos obligatorios están completos sin secretos expuestos.

## Paso 5: guardar una vez y permitir la primera carga

En el formulario M3U, usa **Add** (Añadir) una vez tras revisar la URL. En Xtream, **Continue** abre **Provider access period** (Periodo de acceso al proveedor). Las opciones visibles son **Duration bought** (Duración comprada), **Start and end dates** (Fechas de inicio y fin) y **Add this later** (Añadir más tarde). Registra solo condiciones que conozcas; esto es independiente de tu plan de Norva.

En nuestra prueba no se habían facilitado fechas de acceso, por lo que elegimos **Add this later**, después **Continue**, revisamos **Add later / No new dates** (Añadir más tarde / Sin nuevas fechas) y usamos **Finish without dates** (Terminar sin fechas) una vez. El contador pasó de cinco pasos a tres para esta ruta más corta. No inventes fechas para completar la configuración.

![Elección del periodo de acceso de Norva con Add this later seleccionado y el contador en el paso dos de tres.](/assets/blog/source-access-period-live-web-20260910.jpg "Ruta real de prueba: continuar sin registrar un periodo de acceso. No se configuró ninguna compra, renovación ni recordatorio en este recorrido.")

Norva abrió **Preparing your catalog** (Preparando tu catálogo), mostró **Importing** (Importando) y marcó la comprobación de conexión como **Done** (Hecha). Los recuentos de títulos detectados empezaron a crecer mientras seguía la preparación. Son observaciones distintas: aceptar credenciales no significa que todos los títulos estén listos para reproducirse.

![Panel de preparación del catálogo de Norva para una fuente de prueba con nombre neutro, con Importing y etapas separadas de conexión y catálogo.](/assets/blog/source-importing-live-web-20260910.jpg "Estado intermedio real de importación, no un catálogo terminado. Recuentos y progreso reflejan esta fuente de prueba al capturarla; no prometen velocidad ni capacidad.")

El reproductor puede necesitar tiempo para obtener categorías, información del catálogo o datos de la guía. No envíes ni quites la fuente repetidamente mientras siga una carga normal.

No se puede prometer un tiempo de carga universal. El tamaño de la fuente, la conexión y el dispositivo pueden afectar al primer resultado.

**Resultado observable:** Norva acepta los ajustes o muestra un error concreto que puedes registrar.

## Paso 6: verificar un elemento conocido

Cuando la biblioteca alcance un estado estable:

1. comprueba la sección principal esperada;
2. abre una categoría esperada;
3. busca un elemento conocido;
4. verifica el título, año o identidad del episodio si están disponibles;
5. revisa la información de idioma o subtítulos aportada por la fuente;
6. no supongas que la ausencia de metadatos opcionales implica que toda la conexión falló.

Por ejemplo, elige un título cuya presencia confirme el propietario. Si su categoría carga pero no aparece el título, anota ese resultado específico. Si aparece pero no se reproduce, la carga del catálogo funcionó; la reproducción sigue requiriendo otra prueba. Ninguna observación demuestra que toda la fuente funcione o esté averiada.

**Observado en el seguimiento:** la misma fuente figuraba como **Ready** en **Settings → TV Service**. Abrimos **Movies**, elegimos **Blog walkthrough test** en **Source** y usamos **Audio language → Albanian** (Idioma del audio → Albanés). Las tarjetas devueltas mostraban **Albanian**. Tras **Clear all** (Borrar todo), buscar un título conocido abrió su ficha con doce versiones, año y sinopsis. No fue necesario duplicar la fuente ni reenviarla manualmente.

![Filtros de películas de Norva con la fuente de prueba y audio albanés seleccionados, junto a controles separados de categoría y subtítulos.](/assets/blog/catalog-audio-filter-live-web-20260910.jpg "Seguimiento tras alcanzar Ready, 10 de septiembre de 2026. El número mostrado es una instantánea de la fuente de prueba de este usuario, no una promesa sobre contenido o capacidad del catálogo de Norva.")

### No confundas una etiqueta de fuente con una pista de audio verificada

El filtro de audio actual reúne etiquetas lingüísticas reconocidas e información de pistas detectadas en archivos en un mismo control de navegación. Eso hace que una etiqueta de fuente sea útil para encontrar una versión, pero no convierte un país, nombre de colección o prefijo de título en prueba de las pistas del archivo. Cuando haya información real de pistas, úsala para elegir la versión. Una indicación regional como **Nordic languages** (Lenguas nórdicas) no identifica un idioma hablado concreto.

Comprueba cada capa por separado:

| Resultado visible | Qué establece | Qué falta comprobar |
|---|---|---|
| La fuente muestra Ready | Norva informa de que el catálogo está listo | Metadatos y compatibilidad de reproducción de cada elemento |
| Aparece un título bajo la fuente elegida | El elemento se encuentra en el catálogo actual | Otros elementos y la versión seleccionada |
| Aparece una categoría de fuente | Se recibió una etiqueta de agrupación | Si existe un género cinematográfico verificado |
| Un filtro de idioma devuelve una versión | La información lingüística disponible coincide con el filtro | Pistas realmente seleccionables en ese archivo y reproductor |
| Language unidentified (Idioma no identificado) | No se muestra un resultado de idioma de audio utilizable | Disponibilidad real de pistas y estado del análisis |
| Se abre la página del reproductor | Funcionó la navegación al reproductor | Fotogramas de vídeo, avance de reproducción y audio utilizable |

El último seguimiento probó la navegación del catálogo, no la reproducción de vídeo. Un intento anterior de configuración abrió el reproductor sin confirmar que avanzara el vídeo antes de volver con **Back** (Atrás). Por ello, no presentamos Ready, las etiquetas lingüísticas ni las imágenes como prueba de una sesión de visionado satisfactoria.

## Paso 7: probar una acción de cuenta

Añade un favorito o guarda un pequeño progreso de reproducción. Vuelve a la biblioteca y confirma el estado visible.

Así se prueba la diferencia entre los datos de la fuente y el contexto de cuenta. No se demuestra que todos los elementos, formatos o dispositivos sean compatibles.

Nuestro favorito de prueba estaba presente al abrir de nuevo el catálogo más tarde. Después lo quitamos y recargamos para confirmar el estado original. El retorno inmediato desde la ficha no había mostrado el estado actualizado: esta observación valida la persistencia de ese elemento, no una respuesta instantánea ni la sincronización entre dispositivos.

El plan más amplio de primera sesión está en [Primeros pasos con Norva](/blog/norva-getting-started/).

## Si la conexión es parcial

Un resultado parcial informa más que «no funciona». Registra qué capa funcionó:

- ¿Se aceptaron los ajustes?
- ¿Apareció alguna categoría?
- ¿Cargaron los títulos, pero fallaron las imágenes?
- ¿Cargó la información del catálogo, pero quedaron vacíos los datos de la guía?
- ¿Se abrió un elemento conocido?
- ¿Falló la reproducción solo en un dispositivo?

Cambia una variable cada vez. Revisa los datos de fuente antes de reinstalar la aplicación. Conserva una captura del error con los datos sensibles ocultos solo tras confirmar que no contiene credenciales.

## Seguridad y limpieza de cuenta

Después de configurar correctamente:

- revisa los dispositivos de confianza;
- retira los que ya no controles;
- mantén privado el registro de la fuente;
- anota dónde revisar permisos y condiciones;
- desconecta la fuente si termina la autorización;
- cambia las credenciales expuestas mediante el proceso oficial del propietario.

Las páginas de privacidad y eliminación de cuenta de Norva describen los controles disponibles para los datos de cuenta de Norva.

## Limitaciones

Conectar correctamente no significa que todos los campos de fuente estén completos, que cada formato funcione en todos los dispositivos o que haya acceso sin conexión. Idiomas y subtítulos dependen de la fuente y el medio. El uso sin conexión depende del dispositivo, la fuente y los derechos asociados.

La evidencia cubre los controles web actuales, un envío Xtream, un estado Ready posterior, el filtrado de audio por fuente, búsqueda y detalles de un título, y persistencia y retirada de un favorito tras reabrir. No demuestra que todas las fichas estén completas o sean reproducibles. No se validó la reproducción correcta ni la respuesta inmediata de favoritos. Esta prueba web no validó una importación M3U, un recorrido nativo de teléfono/TV, uso sin conexión ni continuidad entre dispositivos.

## Preguntas frecuentes

### ¿Por qué añadir solo una fuente al principio?

Proporciona una base clara. Si aparece una categoría, un título o un error, sabes qué fuente lo produjo.

### ¿Debo compartir con soporte una captura de conexión?

Solo después de ocultar todas las contraseñas, enlaces privados, usuarios, tokens e identificadores personales. Usa el canal oficial de soporte de Norva.

### ¿Qué ocurre si Norva acepta los ajustes pero no aparece nada?

Espera la carga inicial normal y verifica los datos y la conexión. Anota si el resultado está completamente vacío o parcialmente cargado antes de contactar con soporte.

## Tu siguiente paso

[Abrir Norva y conectar tu fuente](https://norva.tv/app)

Tras iniciar sesión, usa el menú de cuenta, **Settings** y después **TV Service**, como se muestra arriba.

## Fuentes

- [Cómo funciona Norva](https://norva.tv/#how-it-works)
- [Condiciones de uso de Norva](https://norva.tv/terms)
- [Política de privacidad de Norva](https://norva.tv/privacy)
- [Soporte de Norva](https://norva.tv/support)
