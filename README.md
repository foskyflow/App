# Alerta Oro y Bitcoin

App web (instalable en el móvil como PWA) que muestra en tiempo real el precio del oro y del bitcoin y te avisa cuando bajan, incluso con la app cerrada.

## Qué hace
- **Tiempo real**: bitcoin en directo desde Coinbase (WebSocket); oro desde gold-api.com cada 10 s.
- **Gráfico de velas japonesas o de línea** con periodos de 1 día, 1 semana, 1 mes y 6 meses (tócalo para ver apertura, cierre, máximo y mínimo).
- Avisos por separado para el oro y el bitcoin, con notificación, sonido y vibración:
  - cuando **cae un X %** desde el máximo (por defecto 1 % el oro y 3 % el bitcoin);
  - cuando **baja de un precio** que tú eliges.
- **Avisos con la app cerrada** gracias a un vigilante en GitHub Actions y la app ntfy (ver abajo).
- Precios en € o $; el oro, por onza troy o gramo. Modo claro y oscuro.

## Avisos con la app cerrada
El workflow `.github/workflows/vigilante.yml` se ejecuta cada 5 minutos (GitHub puede retrasarlo unos minutos):
1. Lee los precios y los avisos configurados en [`avisos.json`](avisos.json).
2. Si salta un aviso, lo envía a tu móvil a través de [ntfy](https://ntfy.sh).
3. Guarda su estado y el historial de precios en la rama `datos`. La app lo usa para dibujar las velas del oro.

Para activarlo:
1. Instala la app **ntfy** en el móvil y suscríbete a un tema con un nombre difícil de adivinar (por ejemplo, `alerta-oro-` seguido de letras y números al azar).
2. En GitHub, ve a **Settings → Secrets and variables → Actions → New repository secret**. Pon `NTFY_TOPIC` como nombre y el nombre de tu tema como valor.
3. En la pestaña **Actions**, abre *Avisos con la app cerrada* y pulsa **Run workflow**. Recibirás una notificación de prueba.

Para cambiar los avisos, usa **Copiar mis avisos** en la app y pégalos en `avisos.json`. También puedes editar ese archivo directamente:

| Campo | Significado |
|---|---|
| `moneda` | `"EUR"` o `"USD"` |
| `activo` | `true` / `false` |
| `caida_porcentaje` | avisa al caer este % desde el máximo (`null` para desactivar) |
| `baja_de` | avisa al bajar de este precio, en la moneda elegida (`null` para desactivar) |
| `unidad` (solo oro) | `"onza"` o `"gramo"` |

GitHub desactiva los workflows programados si el repositorio pasa 60 días sin actividad. Si ocurre, aparecerá un botón para reactivarlo en la pestaña Actions.

## Uso en el móvil
Abre la web publicada con GitHub Pages en Safari → Compartir → *Añadir a pantalla de inicio*. Ábrela desde ese icono y pulsa **Activar notificaciones**.

No es asesoramiento financiero.
