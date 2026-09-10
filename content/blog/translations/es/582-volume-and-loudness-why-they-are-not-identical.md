---
language: "es"
source_slug: "volume-and-loudness-why-they-are-not-identical"
source_sha256: "c5afea01c019d7d716ee9c9381688084918f14896336a67afc5e83d8a17ed1d1"
title: "Volumen y sonoridad: por qué no son lo mismo"
seo_title: "Volumen y sonoridad: en qué se diferencian"
meta_description: "Un control de volumen no es un medidor de sonoridad. Compara ganancia, sonoridad del programa, picos, rango dinámico y cambios de salida sin adivinar por un número."
excerpt: "El mismo ajuste de volumen puede producir niveles de escucha diferentes. Distingue ganancia, sonoridad del programa, picos y ruta de salida con un cálculo completo y una lista de comparación."
topic_cluster: "Conceptos de calidad de audio"
sources_heading: "Fuentes"
next_step_heading: "Tu siguiente paso"
translation_status: "approved"
translation_method: "ai_assisted"
---

# Volumen y sonoridad: por qué no son lo mismo

> **En resumen:** Un control de volumen cambia la ganancia en un punto de la cadena de reproducción. La sonoridad es lo fuerte que parece un sonido; las mediciones de sonoridad de programa la estiman a partir de la señal de audio mediante un método definido. La grabación, la mezcla y el procesamiento afectan a esa señal, mientras que el dispositivo de salida y el entorno de escucha también afectan a lo que oyes. La misma posición del control no garantiza el mismo nivel de escucha.

Si una película suena mucho más fuerte que otra sin tocar el mando, el control de volumen no ha cambiado necesariamente. Puede que estés oyendo otra mezcla, pista o modo de procesamiento. Empieza por separar el ajuste del control del audio sobre el que actúa, en lugar de tratar el número mostrado como una medición de toda la experiencia.

## Identifica cada etapa de ganancia

La ganancia consiste en escalar la señal en una etapa concreta. Una ganancia digital sencilla multiplica cada muestra por un valor; [la documentación de GainNode de MDN](https://developer.mozilla.org/en-US/docs/Web/API/GainNode) muestra ese principio. Un control de volumen para el usuario no tiene por qué mostrar directamente ese multiplicador, y un ajuste de «50» no es un nivel acústico universal ni garantiza la mitad de sonoridad percibida.

Registra los controles que realmente se aplican: volumen del reproductor, nivel multimedia del sistema operativo, nivel del televisor o receptor, controles de los auriculares y cualquier ajuste por pista. Algunos pueden estar vinculados, mientras que otras etapas pueden ser fijas u omitirse en la ruta elegida. Comprueba qué dispositivo produce el sonido antes de cambiar un control cada vez.

## Entiende la sonoridad de programa

[UIT-R BS.1770](https://www.itu.int/rec/R-REC-BS.1770/en) define algoritmos de medición de sonoridad de programa y de pico verdadero. Una lectura de sonoridad de programa describe una señal de audio según ese método; no mide directamente la presión sonora en tus oídos. La recomendación también señala que la sonoridad medida estima la percepción con cierta incertidumbre entre oyentes, materiales y condiciones de escucha.

Puedes encontrar **LUFS**, unidades de sonoridad referidas a la escala completa digital. Una lectura integrada abarca el programa o fragmento analizado, mientras que las lecturas a más corto plazo describen una ventana menor. Indica el método, los canales, el intervalo analizado y si la medición se realizó antes o después del procesamiento. No etiquetes una muestra breve de diálogo como resultado de toda la película.

[EBU R 128](https://tech.ebu.ch/publications/r128) utiliza mediciones de sonoridad en un marco de normalización para radiodifusión y distingue la sonoridad del nivel máximo de pico verdadero. No es un objetivo universal para todas las aplicaciones de consumo ni convierte un control de volumen en un medidor.

## Distingue los picos y el rango dinámico

Los picos de muestra describen los mayores valores absolutos de las muestras registradas; la medición de pico verdadero estima los picos de la forma de onda que pueden aparecer entre muestras. Ninguno de esos números indica durante cuánto tiempo se mantiene fuerte el programa. Un impacto breve y un diálogo sostenido pueden alcanzar el mismo pico y presentar niveles globales de escucha distintos.

El rango dinámico se refiere al contraste entre el material más suave y el más fuerte. Subir un ajuste de volumen fijo eleva ambos; no acerca selectivamente el diálogo suave a los efectos sonoros fuertes. El procesamiento del rango dinámico aborda otro problema. Por ejemplo, [las indicaciones oficiales de Sony](https://www.sony.com/electronics/support/televisions-projectors/articles/00203665) describen ajustes que modifican ese contraste en televisores y formatos de audio específicos. Es un ejemplo propio de dispositivos concretos, no una afirmación de que Norva ofrezca el mismo ajuste.

## Aportación original: ficha de ganancia y sonoridad

Este es un **ejemplo aritmético construido**, no medios medidos, una prueba de escucha ni un ajuste de volumen de Norva. Supongamos dos señales digitales con los picos de muestra de abajo y una ganancia lineal simple de 0.5. Los valores de pico sin unidad son fracciones de la escala completa digital, no decibelios ni mediciones de presión sonora. No se incluye ningún otro procesamiento.

| Señal construida | Mayor valor absoluto de muestra de entrada | Multiplicador de ganancia | Pico de muestra de salida calculado | Sonoridad del programa o nivel en los oídos |
| --- | --- | --- | --- | --- |
| A | 0.20 | 0.5 | 0.20 × 0.5 = 0.10 | Desconocido a partir de estos valores |
| B | 0.60 | 0.5 | 0.60 × 0.5 = 0.30 | Desconocido a partir de estos valores |

La misma ganancia deja picos de salida diferentes porque las señales de entrada son distintas. El pico de muestra calculado de B es tres veces el de A, pero eso **no** significa que B suene tres veces más fuerte. No hemos especificado el resto de ninguna señal, su duración, el equipo de salida ni las condiciones de escucha.

Igualar esos picos tampoco establecería una sonoridad de programa igual. Esta ficha se detiene deliberadamente en lo que demuestra la aritmética; no puede proporcionar una lectura LUFS, una clasificación de calidad ni un nivel seguro para auriculares. Un multiplicador de 0.5 tampoco implica que el control de un producto concreto deba ajustarse al 50 %.

## Compara pistas con el nivel igualado

Si la pregunta es qué pista resulta más clara, evita que el nivel sea una diferencia sin controlar. Utiliza este pequeño procedimiento con medios que estés autorizado a reproducir:

1. Identifica las etiquetas y funciones de ambas pistas. Una pista de comentarios no es la misma mezcla que la banda sonora principal; usa la [guía de la lista de pistas de audio](/blog/how-to-read-an-audio-track-list-before-playback/) si las etiquetas no están claras.
2. Elige el mismo pasaje en ambas versiones. Registra los tiempos de inicio y fin e incluye diálogo y un momento más fuerte si ese es el problema que investigas.
3. Mantén fijos el dispositivo, la ruta de salida, la posición de escucha y el estado del procesamiento. Registra los ajustes desconocidos en lugar de suponer que están desactivados.
4. Compara a un nivel bajo y cómodo. Reduce la pista que parezca más fuerte para igualar de forma aproximada el nivel percibido; no subas la más suave hasta que un efecto sonoro fuerte resulte incómodo. Si utilizas un medidor de sonoridad válido, registra su método y alcance por separado.
5. Alterna el orden y anota una observación concreta, como «el diálogo sigue siendo difícil de seguir tras igualar aproximadamente el nivel». No conviertas una preferencia informal en una afirmación de superioridad medida.

Una igualación de oído es aproximada, no un resultado de conformidad con normas. Si no puedes comparar el pasaje cómodamente, detén la comparación.

## Incluye la normalización

La normalización de sonoridad ajusta la ganancia del programa o de reproducción hacia una relación de sonoridad definida. La normalización de picos utiliza, en cambio, un criterio de pico. Ninguno de los términos significa por sí solo que el diálogo suave y los efectos sonoros fuertes se acerquen dentro de un programa; eso requeriría cambiar sus niveles relativos.

Los objetivos, el alcance de medición, la gestión de picos y los controles del usuario dependen de la implementación. Consulta la documentación de la aplicación, el televisor, el receptor o los auriculares para identificar cualquier normalización o procesamiento dinámico activo. Este artículo no establece un objetivo de normalización de Norva ni afirma que Norva aplique EBU R 128.

## Incluye la sensibilidad de salida y la habitación

Auriculares y altavoces pueden producir niveles acústicos distintos a partir de la misma señal digital o ajuste mostrado. El ajuste físico, la distancia, las reflexiones de la habitación, el ruido de fondo y el procesamiento del dispositivo también afectan a la escucha. Si cambias de salida, has cambiado la comparación aunque el número en pantalla siga siendo el mismo.

Si el ruido de la habitación enmascara detalles suaves, investiga el entorno o utiliza una [cobertura de subtitulado adecuada](/blog/captions-and-subtitles-why-the-accessibility-goals-can-differ/) en lugar de aumentar continuamente el volumen. Las [orientaciones de la OMS para una escucha segura](https://www.who.int/news-room/questions-and-answers/item/deafness-and-hearing-loss-safe-listening) destacan tanto el nivel sonoro como la duración de la exposición y recomiendan descansos y reducir la necesidad de subir el sonido en entornos ruidosos. La comodidad por sí sola no es una medición de exposición.

## Informa de una diferencia de nivel

Registra el contenido y su versión, las etiquetas exactas de pista, los tiempos del fragmento, los controles de volumen aplicables, el estado del procesamiento, la ruta y el dispositivo de salida, las condiciones de la habitación, el método de comparación y el resultado. Incluye mediciones válidas solo cuando estén disponibles, con su alcance. «Sin medición de sonoridad; procesamiento del televisor desconocido» es más útil que una estimación inventada de decibelios a partir del control.

La [guía completa de calidad de audio](/blog/the-complete-guide-to-understanding-audio-quality/) describe el resto de la cadena.

## Errores comunes y limitaciones

Evita comparar números de controles entre dispositivos, tratar la igualación de picos como igualación de sonoridad o usar una lectura de nivel sonoro del móvil no validada como prueba calibrada. Un micrófono de teléfono cerca de un altavoz tampoco mide directamente el sonido dentro de los auriculares. La escucha informal no es una prueba formal de conformidad de sonoridad, una evaluación auditiva ni una demostración de que un códec o reproductor sea mejor.

## Comprueba el nivel después de cambiar la ruta

Al cambiar de altavoces a auriculares o a un receptor, comprueba el nivel del destino antes de iniciar o reanudar la reproducción y empieza bajo. Registra las etapas de ganancia activas en lugar de copiar el número anterior. Si cambiaste la ruta y el medio al mismo tiempo, vuelve a un pasaje conocido a un nivel bajo antes de decidir que la nueva pista causó la diferencia.

## Preguntas frecuentes

### ¿El volumen es lo mismo que la sonoridad de programa?

No. El control de volumen establece la ganancia en una etapa de la reproducción. Una lectura de sonoridad de programa caracteriza la señal mediante un método de medición especificado; ninguno determina por sí solo el nivel acústico en tus oídos.

### ¿El mismo valor del control produce la misma sonoridad en dos dispositivos?

No. Difieren la estructura de ganancia, el amplificador, la sensibilidad de salida, los altavoces o auriculares, la habitación y el procesamiento.

### ¿La normalización de picos es lo mismo que la normalización de sonoridad?

No. Las mediciones de pico y sonoridad describen propiedades distintas y sirven para flujos de trabajo diferentes.

## Tu siguiente paso

Antes de comparar otra versión, registra la pista y la ruta de salida que realmente usaste. Después [explora las funciones de reproducción de Norva](https://norva.tv/#features) sin dar por hecho un modo de normalización no documentado. Norva es software de reproducción multimedia, sin contenido ni suscripción de TV incluidos; tus medios deben proceder de una fuente compatible que estés autorizado a utilizar.

## Fuentes

- [MDN: ganancia digital y GainNode](https://developer.mozilla.org/en-US/docs/Web/API/GainNode)
- [UIT-R BS.1770: sonoridad de programa y pico verdadero](https://www.itu.int/rec/R-REC-BS.1770/en)
- [EBU R 128: normalización de sonoridad](https://tech.ebu.ch/publications/r128)
- [Sony: ajustes de rango dinámico y formatos aplicables](https://www.sony.com/electronics/support/televisions-projectors/articles/00203665)
- [OMS: escucha segura, nivel y duración de exposición](https://www.who.int/news-room/questions-and-answers/item/deafness-and-hearing-loss-safe-listening)
- [Funciones de Norva](https://norva.tv/#features)
