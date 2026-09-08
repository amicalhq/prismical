import {
  AI_ERROR_CODES,
  SKILL_RUN_ERROR_CODES,
  type AiErrorAction,
  type AiErrorActionKind,
  type AiErrorDetails,
  type AiUserError,
  type AiUserErrorSeverity,
} from './ai-errors.js';

/**
 * User-facing copy for AI errors, rendered SERVER-SIDE into `details.user` so every client (web,
 * desktop, mobile) shows the same words and offers the same recovery actions without shipping a
 * release. A client only needs to know the handful of {@link AiErrorActionKind}s; a new cause, a
 * reworded message, or a different action for an existing cause is a core deploy.
 *
 * Lives in api-contracts (built, dependency-free) because core's build does not bundle
 * source-only packages, and because the desktop's local lane renders the same copy for the same
 * codes. Every locale must carry every key — `ai-error-copy.test.ts` enforces it.
 *
 * Copy rules: plain words, no provider payloads, no status codes, hyphens not dashes, and every
 * user-fixable cause names the fix. Provider names are proper nouns and stay untranslated.
 */

type Entry = { title: string; body?: string; localBody?: string };

interface Copy {
  keyInvalid: Entry;
  keyMissing: Entry;
  quotaExceeded: Entry;
  rateLimited: Entry;
  modelNotFound: Entry;
  contextTooLong: Entry;
  contextTooLongAsk: Entry;
  toolsUnsupported: Entry;
  rejected: Entry;
  unavailable: Entry;
  cloudUnavailable: Entry;
  notConfigured: Entry;
  selectionInvalid: Entry;
  instanceNotFound: Entry;
  byokNotAllowed: Entry;
  outputTooLong: Entry;
  outputTooLongByok: Entry;
  noResult: Entry;
  noResultAsk: Entry;
  /** OUTPUT_DECLINED — today only the naming lane, answering `title: null` as its prompt allows. */
  declinedTitle: Entry;
  toolBudget: Entry;
  noteEmpty: Entry;
  noteAndTranscriptEmpty: Entry;
  noTranscript: Entry;
  transcriptFinalizing: Entry;
  titleInvalid: Entry;
  titleTimeout: Entry;
  titleChanged: Entry;
  selectionRequired: Entry;
  stepsExhausted: Entry;
  outputTruncated: Entry;
  fallbackToCloud: Entry;
  askFailed: Entry;
  transcriptionQuota: Entry;
  recordingLengthExceeded: Entry;
  /** Transcription-surface bodies: no "use Prismical Cloud" mid-recording (nothing can bind it). */
  keyInvalidTranscription: Entry;
  keyMissingTranscription: Entry;
  quotaExceededTranscription: Entry;
  instanceNotFoundTranscription: Entry;
  byokNotAllowedTranscription: Entry;
  /** Plan gates (Settings → Billing is the fix, so every one offers `open-billing`). */
  askNotInPlan: Entry;
  aiCreditsExhausted: Entry;
  byokNotInPlan: Entry;
  generic: Entry;
  /** Fallback subject names when the caller has no skill name. */
  subject: { skill: string; ask: string; transcription: string };
  actions: Record<AiErrorActionKind, string>;
}

export const AI_ERROR_COPY_LOCALES = ['en', 'de', 'es', 'ja', 'zh-TW'] as const;
export type AiErrorCopyLocale = (typeof AI_ERROR_COPY_LOCALES)[number];

const en: Copy = {
  keyInvalid: {
    localBody: 'Update it in Settings.',
    title: 'Your {{provider}} key was rejected.',
    body: 'Update it in Settings, or use Prismical Cloud for now.',
  },
  keyMissing: {
    localBody: 'Add one in Settings.',
    title: 'No API key is saved for {{provider}}.',
    body: 'Add one in Settings, or use Prismical Cloud for now.',
  },
  quotaExceeded: {
    localBody: 'Top it up with {{provider}}.',
    title: 'Your {{provider}} account is out of credit.',
    body: 'Top it up with {{provider}}, or use Prismical Cloud for now.',
  },
  rateLimited: { title: '{{provider}} is busy right now.', body: 'Try again in a minute.' },
  modelNotFound: {
    title: 'The model you chose isn’t available any more.',
    body: 'Pick another model in Settings.',
  },
  contextTooLong: {
    title: 'This note is too long for {{name}} to process in one go.',
    body: 'Try it on a selection, or shorten the note.',
  },
  contextTooLongAsk: {
    title: 'This conversation is too long for the model.',
    body: 'Start a new chat, or tag fewer notes.',
  },
  toolsUnsupported: {
    title: 'The model you chose can’t run {{name}}.',
    body: 'It can’t use the tools {{name}} needs. Pick another model in Settings.',
  },
  rejected: {
    title: '{{provider}} rejected this request.',
    body: 'Pick a different model in Settings.',
  },
  unavailable: { title: '{{provider}} isn’t responding.', body: 'Try again in a few minutes.' },
  cloudUnavailable: {
    title: 'Prismical Cloud is having trouble right now.',
    body: 'Try again in a few minutes.',
  },
  notConfigured: {
    localBody: 'Add an API key or connect a local runtime in Settings → AI models.',
    title: 'AI isn’t set up for this workspace yet.',
    body: 'Add your own API key in Settings to keep working.',
  },
  selectionInvalid: {
    title: 'The selected model can’t be used for this.',
    body: 'Pick another model in Settings.',
  },
  instanceNotFound: {
    localBody: 'Pick another model in Settings.',
    title: 'The AI provider you chose was removed.',
    body: 'Pick another model in Settings, or use Prismical Cloud.',
  },
  byokNotAllowed: {
    title: 'Your own API key can’t be used here.',
    body: 'Use Prismical Cloud for this.',
  },
  outputTooLong: {
    title: 'This note is too long for {{name}} to rewrite in one go.',
    body: 'Try it on a selection, or append a summary instead.',
  },
  outputTooLongByok: {
    title: 'This note is too long for {{name}} to rewrite in one go.',
    body: 'Try it on a selection, append a summary instead, or pick a model with a larger output limit.',
  },
  noResult: { title: '{{name}} didn’t produce a result this time.', body: 'Try again.' },
  noResultAsk: { title: 'The model didn’t answer this time.', body: 'Try again.' },
  declinedTitle: { title: 'Not enough content to name this note yet.' },
  toolBudget: {
    title: '{{name}} ran out of steps before finishing.',
    body: 'Try again, or simplify what the skill uses.',
  },
  noteEmpty: { title: 'Add some content to this note before running {{name}}.' },
  noteAndTranscriptEmpty: {
    title: 'This note has no text or transcript yet.',
    body: 'Add text or record audio before running {{name}}.',
  },
  noTranscript: {
    title: 'This recording has no transcript to enhance.',
    body: 'Check the transcript or make a new recording.',
  },
  transcriptFinalizing: {
    title: 'The final transcript is still being prepared.',
    body: 'Try {{name}} again shortly.',
  },
  titleInvalid: { title: '{{name}} couldn’t come up with a title.', body: 'Try again.' },
  titleTimeout: { title: 'Naming took too long.', body: 'Try again.' },
  titleChanged: {
    title: 'The title changed while {{name}} ran.',
    body: 'Click again to rename it.',
  },
  selectionRequired: {
    title: 'Select some text first.',
    body: '{{name}} rewrites the text you select.',
  },
  stepsExhausted: {
    title: 'I ran out of steps before finishing.',
    body: 'Ask again, or narrow the question.',
  },
  outputTruncated: {
    title: 'The answer was cut short.',
    body: 'Ask to continue, or narrow the question.',
  },
  fallbackToCloud: {
    title: 'The model you chose isn’t available, so this ran on Prismical Cloud.',
    body: 'Pick another model in Settings to use your own key again.',
  },
  askFailed: { title: 'Ask AI couldn’t answer.', body: 'Try again in a moment.' },
  generic: { title: 'Couldn’t run {{name}}.', body: 'Try again in a moment.' },
  transcriptionQuota: {
    title: 'Cloud transcription paused for this session.',
    body: 'Audio is still being recorded, but the rest of it won’t be transcribed. Upgrade for more, or add your own key in Settings.',
  },
  recordingLengthExceeded: {
    title: 'This recording reached your plan’s length limit.',
    body: 'Everything up to the limit is saved. Start a new recording to keep going, or upgrade for longer sessions.',
  },
  keyInvalidTranscription: {
    title: 'Your {{provider}} key was rejected.',
    body: 'Update it in Settings. The rest of this recording won’t be transcribed.',
  },

  keyMissingTranscription: {
    title: 'No API key is saved for {{provider}}.',
    body: 'Add one in Settings. The rest of this recording won’t be transcribed.',
  },

  quotaExceededTranscription: {
    title: 'Your {{provider}} account is out of credit.',
    body: 'Top it up with {{provider}}. The rest of this recording won’t be transcribed.',
  },

  instanceNotFoundTranscription: {
    title: 'The transcription provider you chose was removed.',
    body: 'Pick another one in Settings. The rest of this recording won’t be transcribed.',
  },

  byokNotAllowedTranscription: {
    title: 'Your own API key can’t be used for transcription here.',
    body: 'Switch to Prismical Cloud in Settings. The rest of this recording won’t be transcribed.',
  },

  askNotInPlan: {
    title: 'Ask AI isn’t included in your plan.',
    body: 'Upgrade to ask questions across your notes.',
  },
  aiCreditsExhausted: {
    title: 'You’ve used this month’s AI credits.',
    body: 'Credits reset at the start of next month. Upgrade for more.',
  },
  byokNotInPlan: {
    title: 'Your own API key isn’t included in your plan.',
    body: 'This ran on Prismical Cloud instead. Upgrade to use your own keys.',
  },
  subject: { skill: 'This skill', ask: 'Ask AI', transcription: 'Transcription' },
  actions: {
    retry: 'Try again',
    'open-ai-models': 'Open AI models',
    'use-cloud': 'Use Prismical Cloud',
    'choose-model': 'Choose model',
    'append-instead': 'Append instead',
    continue: 'Continue',
    'open-billing': 'See plans',
  },
};

const de: Copy = {
  keyInvalid: {
    localBody: 'Aktualisiere ihn in den Einstellungen.',
    title: 'Dein {{provider}}-Schlüssel wurde abgelehnt.',
    body: 'Aktualisiere ihn in den Einstellungen oder nutze vorerst Prismical Cloud.',
  },
  keyMissing: {
    localBody: 'Füge einen in den Einstellungen hinzu.',
    title: 'Für {{provider}} ist kein API-Schlüssel gespeichert.',
    body: 'Füge einen in den Einstellungen hinzu oder nutze vorerst Prismical Cloud.',
  },
  quotaExceeded: {
    localBody: 'Lade es bei {{provider}} auf.',
    title: 'Dein {{provider}}-Konto hat kein Guthaben mehr.',
    body: 'Lade es bei {{provider}} auf oder nutze vorerst Prismical Cloud.',
  },
  rateLimited: {
    title: '{{provider}} ist gerade ausgelastet.',
    body: 'Versuche es in einer Minute erneut.',
  },
  modelNotFound: {
    title: 'Das gewählte Modell ist nicht mehr verfügbar.',
    body: 'Wähle in den Einstellungen ein anderes Modell.',
  },
  contextTooLong: {
    title: 'Diese Notiz ist zu lang: {{name}} kann sie nicht in einem Durchgang verarbeiten.',
    body: 'Probiere es mit einer Auswahl oder kürze die Notiz.',
  },
  contextTooLongAsk: {
    title: 'Diese Unterhaltung ist zu lang für das Modell.',
    body: 'Starte einen neuen Chat oder markiere weniger Notizen.',
  },
  toolsUnsupported: {
    title: 'Das gewählte Modell kann {{name}} nicht ausführen.',
    body: 'Es kann die Tools nicht nutzen, die {{name}} braucht. Wähle in den Einstellungen ein anderes Modell.',
  },
  rejected: {
    title: '{{provider}} hat diese Anfrage abgelehnt.',
    body: 'Wähle in den Einstellungen ein anderes Modell.',
  },
  unavailable: {
    title: '{{provider}} antwortet nicht.',
    body: 'Versuche es in ein paar Minuten erneut.',
  },
  cloudUnavailable: {
    title: 'Prismical Cloud hat gerade Probleme.',
    body: 'Versuche es in ein paar Minuten erneut.',
  },
  notConfigured: {
    localBody:
      'Füge unter Einstellungen → KI-Modelle einen API-Schlüssel hinzu oder verbinde eine lokale Laufzeit.',
    title: 'KI ist für diesen Arbeitsbereich noch nicht eingerichtet.',
    body: 'Füge in den Einstellungen deinen eigenen API-Schlüssel hinzu, um weiterzuarbeiten.',
  },
  selectionInvalid: {
    title: 'Das gewählte Modell kann hierfür nicht verwendet werden.',
    body: 'Wähle in den Einstellungen ein anderes Modell.',
  },
  instanceNotFound: {
    localBody: 'Wähle in den Einstellungen ein anderes Modell.',
    title: 'Der gewählte KI-Anbieter wurde entfernt.',
    body: 'Wähle in den Einstellungen ein anderes Modell oder nutze Prismical Cloud.',
  },
  byokNotAllowed: {
    title: 'Dein eigener API-Schlüssel kann hier nicht verwendet werden.',
    body: 'Nutze dafür Prismical Cloud.',
  },
  outputTooLong: {
    title: 'Diese Notiz ist zu lang: {{name}} kann sie nicht in einem Durchgang umschreiben.',
    body: 'Probiere es mit einer Auswahl oder hänge stattdessen eine Zusammenfassung an.',
  },
  outputTooLongByok: {
    title: 'Diese Notiz ist zu lang: {{name}} kann sie nicht in einem Durchgang umschreiben.',
    body: 'Probiere es mit einer Auswahl, hänge eine Zusammenfassung an oder wähle ein Modell mit größerem Ausgabelimit.',
  },
  noResult: { title: '{{name}} hat diesmal kein Ergebnis geliefert.', body: 'Versuche es erneut.' },
  noResultAsk: { title: 'Das Modell hat diesmal nicht geantwortet.', body: 'Versuche es erneut.' },
  declinedTitle: { title: 'Noch nicht genug Inhalt, um diese Notiz zu benennen.' },
  toolBudget: {
    title: 'Die Schritte für {{name}} sind vor dem Abschluss aufgebraucht.',
    body: 'Versuche es erneut oder vereinfache, was die Fähigkeit verwendet.',
  },
  noteEmpty: { title: 'Füge dieser Notiz Inhalt hinzu, bevor du {{name}} ausführst.' },
  noteAndTranscriptEmpty: {
    title: 'Diese Notiz hat noch keinen Text und kein Transkript.',
    body: 'Füge Text hinzu oder nimm Audio auf, bevor du {{name}} ausführst.',
  },
  noTranscript: {
    title: 'Diese Aufnahme hat kein Transkript, das verbessert werden könnte.',
    body: 'Prüfe das Transkript oder starte eine neue Aufnahme.',
  },
  transcriptFinalizing: {
    title: 'Das endgültige Transkript wird noch vorbereitet.',
    body: 'Versuche {{name}} in Kürze erneut.',
  },
  titleInvalid: { title: '{{name}} konnte keinen Titel finden.', body: 'Versuche es erneut.' },
  titleTimeout: { title: 'Die Benennung hat zu lange gedauert.', body: 'Versuche es erneut.' },
  titleChanged: {
    title: 'Der Titel hat sich geändert, während {{name}} lief.',
    body: 'Klicke erneut, um ihn umzubenennen.',
  },
  selectionRequired: {
    title: 'Wähle zuerst Text aus.',
    body: '{{name}} schreibt den ausgewählten Text um.',
  },
  generic: {
    title: '{{name}} ist fehlgeschlagen.',
    body: 'Versuche es gleich noch einmal.',
  },
  stepsExhausted: {
    title: 'Mir sind die Schritte ausgegangen, bevor ich fertig war.',
    body: 'Frag noch einmal oder grenze die Frage ein.',
  },
  outputTruncated: {
    title: 'Die Antwort wurde abgeschnitten.',
    body: 'Bitte um Fortsetzung oder grenze die Frage ein.',
  },
  fallbackToCloud: {
    title: 'Das gewählte Modell ist nicht verfügbar, daher lief dies über Prismical Cloud.',
    body: 'Wähle in den Einstellungen ein anderes Modell, um wieder deinen eigenen Schlüssel zu nutzen.',
  },
  askFailed: { title: 'Ask AI konnte nicht antworten.', body: 'Versuche es gleich noch einmal.' },
  transcriptionQuota: {
    title: 'Cloud-Transkription für diese Sitzung pausiert.',
    body: 'Der Ton wird weiter aufgenommen, der Rest wird aber nicht transkribiert. Wechsle den Tarif oder füge in den Einstellungen deinen eigenen Schlüssel hinzu.',
  },
  recordingLengthExceeded: {
    title: 'Diese Aufnahme hat die Längenbegrenzung deines Tarifs erreicht.',
    body: 'Alles bis zur Grenze ist gespeichert. Starte eine neue Aufnahme, um weiterzumachen, oder wechsle den Tarif für längere Sitzungen.',
  },
  keyInvalidTranscription: {
    title: 'Dein {{provider}}-Schlüssel wurde abgelehnt.',
    body: 'Aktualisiere ihn in den Einstellungen. Der Rest dieser Aufnahme wird nicht transkribiert.',
  },

  keyMissingTranscription: {
    title: 'Für {{provider}} ist kein API-Schlüssel gespeichert.',
    body: 'Füge einen in den Einstellungen hinzu. Der Rest dieser Aufnahme wird nicht transkribiert.',
  },

  quotaExceededTranscription: {
    title: 'Dein {{provider}}-Konto hat kein Guthaben mehr.',
    body: 'Lade es bei {{provider}} auf. Der Rest dieser Aufnahme wird nicht transkribiert.',
  },

  instanceNotFoundTranscription: {
    title: 'Der gewählte Transkriptionsanbieter wurde entfernt.',
    body: 'Wähle in den Einstellungen einen anderen. Der Rest dieser Aufnahme wird nicht transkribiert.',
  },

  byokNotAllowedTranscription: {
    title: 'Dein eigener API-Schlüssel kann hier nicht zum Transkribieren verwendet werden.',
    body: 'Wechsle in den Einstellungen zu Prismical Cloud. Der Rest dieser Aufnahme wird nicht transkribiert.',
  },

  askNotInPlan: {
    title: 'Ask AI ist in deinem Plan nicht enthalten.',
    body: 'Führe ein Upgrade durch, um Fragen zu deinen Notizen zu stellen.',
  },
  aiCreditsExhausted: {
    title: 'Du hast die KI-Credits dieses Monats aufgebraucht.',
    body: 'Die Credits werden zu Beginn des nächsten Monats zurückgesetzt. Führe ein Upgrade durch, um mehr zu erhalten.',
  },
  byokNotInPlan: {
    title: 'Dein eigener API-Schlüssel ist in deinem Plan nicht enthalten.',
    body: 'Stattdessen lief dies über Prismical Cloud. Führe ein Upgrade durch, um eigene Schlüssel zu verwenden.',
  },
  subject: { skill: 'Diese Fähigkeit', ask: 'Ask AI', transcription: 'Die Transkription' },
  actions: {
    retry: 'Erneut versuchen',
    'open-ai-models': 'KI-Modelle öffnen',
    'use-cloud': 'Prismical Cloud verwenden',
    'choose-model': 'Modell wählen',
    'append-instead': 'Stattdessen anhängen',
    continue: 'Fortsetzen',
    'open-billing': 'Pläne ansehen',
  },
};

const es: Copy = {
  keyInvalid: {
    localBody: 'Actualízala en Ajustes.',
    title: 'Tu clave de {{provider}} fue rechazada.',
    body: 'Actualízala en Ajustes o usa Prismical Cloud por ahora.',
  },
  keyMissing: {
    localBody: 'Añade una en Ajustes.',
    title: 'No hay ninguna clave de API guardada para {{provider}}.',
    body: 'Añade una en Ajustes o usa Prismical Cloud por ahora.',
  },
  quotaExceeded: {
    localBody: 'Recárgala en {{provider}}.',
    title: 'Tu cuenta de {{provider}} se quedó sin crédito.',
    body: 'Recárgala en {{provider}} o usa Prismical Cloud por ahora.',
  },
  rateLimited: {
    title: '{{provider}} está saturado ahora mismo.',
    body: 'Inténtalo de nuevo en un minuto.',
  },
  modelNotFound: {
    title: 'El modelo que elegiste ya no está disponible.',
    body: 'Elige otro modelo en Ajustes.',
  },
  contextTooLong: {
    title: 'Esta nota es demasiado larga para que {{name}} la procese de una vez.',
    body: 'Prueba con una selección o acorta la nota.',
  },
  contextTooLongAsk: {
    title: 'Esta conversación es demasiado larga para el modelo.',
    body: 'Empieza un chat nuevo o etiqueta menos notas.',
  },
  toolsUnsupported: {
    title: 'El modelo que elegiste no puede ejecutar {{name}}.',
    body: 'No puede usar las herramientas que {{name}} necesita. Elige otro modelo en Ajustes.',
  },
  rejected: {
    title: '{{provider}} rechazó esta solicitud.',
    body: 'Elige otro modelo en Ajustes.',
  },
  unavailable: { title: '{{provider}} no responde.', body: 'Inténtalo de nuevo en unos minutos.' },
  cloudUnavailable: {
    title: 'Prismical Cloud tiene problemas ahora mismo.',
    body: 'Inténtalo de nuevo en unos minutos.',
  },
  notConfigured: {
    localBody: 'Añade una clave de API o conecta un motor local en Ajustes → Modelos de IA.',
    title: 'La IA aún no está configurada para este espacio de trabajo.',
    body: 'Añade tu propia clave de API en Ajustes para seguir trabajando.',
  },
  selectionInvalid: {
    title: 'El modelo seleccionado no se puede usar para esto.',
    body: 'Elige otro modelo en Ajustes.',
  },
  instanceNotFound: {
    localBody: 'Elige otro modelo en Ajustes.',
    title: 'El proveedor de IA que elegiste fue eliminado.',
    body: 'Elige otro modelo en Ajustes o usa Prismical Cloud.',
  },
  byokNotAllowed: {
    title: 'Tu propia clave de API no se puede usar aquí.',
    body: 'Usa Prismical Cloud para esto.',
  },
  outputTooLong: {
    title: 'Esta nota es demasiado larga para que {{name}} la reescriba de una vez.',
    body: 'Prueba con una selección o añade un resumen en su lugar.',
  },
  outputTooLongByok: {
    title: 'Esta nota es demasiado larga para que {{name}} la reescriba de una vez.',
    body: 'Prueba con una selección, añade un resumen o elige un modelo con un límite de salida mayor.',
  },
  noResult: {
    title: '{{name}} no produjo ningún resultado esta vez.',
    body: 'Inténtalo de nuevo.',
  },
  noResultAsk: { title: 'El modelo no respondió esta vez.', body: 'Inténtalo de nuevo.' },
  declinedTitle: { title: 'Aún no hay suficiente contenido para nombrar esta nota.' },
  toolBudget: {
    title: '{{name}} se quedó sin pasos antes de terminar.',
    body: 'Inténtalo de nuevo o simplifica lo que usa la habilidad.',
  },
  noteEmpty: { title: 'Añade contenido a esta nota antes de ejecutar {{name}}.' },
  noteAndTranscriptEmpty: {
    title: 'Esta nota aún no tiene texto ni transcripción.',
    body: 'Añade texto o graba audio antes de ejecutar {{name}}.',
  },
  noTranscript: {
    title: 'Esta grabación no tiene transcripción que mejorar.',
    body: 'Revisa la transcripción o haz una grabación nueva.',
  },
  transcriptFinalizing: {
    title: 'La transcripción final todavía se está preparando.',
    body: 'Vuelve a probar {{name}} en un momento.',
  },
  titleInvalid: { title: '{{name}} no pudo proponer un título.', body: 'Inténtalo de nuevo.' },
  titleTimeout: { title: 'Poner el título tardó demasiado.', body: 'Inténtalo de nuevo.' },
  titleChanged: {
    title: 'El título cambió mientras se ejecutaba {{name}}.',
    body: 'Haz clic de nuevo para renombrarlo.',
  },
  selectionRequired: {
    title: 'Selecciona texto primero.',
    body: '{{name}} reescribe el texto que selecciones.',
  },
  generic: { title: 'No se pudo ejecutar {{name}}.', body: 'Inténtalo de nuevo en un momento.' },
  stepsExhausted: {
    title: 'Me quedé sin pasos antes de terminar.',
    body: 'Pregunta de nuevo o acota la pregunta.',
  },
  outputTruncated: {
    title: 'La respuesta se cortó.',
    body: 'Pide que continúe o acota la pregunta.',
  },
  fallbackToCloud: {
    title: 'El modelo que elegiste no está disponible.',
    body: 'Esto se ejecutó en Prismical Cloud. Elige otro modelo en Ajustes para volver a usar tu propia clave.',
  },
  askFailed: { title: 'Ask AI no pudo responder.', body: 'Inténtalo de nuevo en un momento.' },
  transcriptionQuota: {
    title: 'Transcripción en la nube pausada en esta sesión.',
    body: 'El audio se sigue grabando, pero el resto no se transcribirá. Mejora tu plan o añade tu propia clave en Ajustes.',
  },
  recordingLengthExceeded: {
    title: 'Esta grabación alcanzó el límite de duración de tu plan.',
    body: 'Todo lo anterior al límite está guardado. Inicia otra grabación para continuar, o mejora tu plan para sesiones más largas.',
  },
  keyInvalidTranscription: {
    title: 'Tu clave de {{provider}} fue rechazada.',
    body: 'Actualízala en Ajustes. El resto de esta grabación no se transcribirá.',
  },

  keyMissingTranscription: {
    title: 'No hay ninguna clave de API guardada para {{provider}}.',
    body: 'Añade una en Ajustes. El resto de esta grabación no se transcribirá.',
  },

  quotaExceededTranscription: {
    title: 'Tu cuenta de {{provider}} no tiene crédito.',
    body: 'Recárgala en {{provider}}. El resto de esta grabación no se transcribirá.',
  },

  instanceNotFoundTranscription: {
    title: 'El proveedor de transcripción que elegiste se eliminó.',
    body: 'Elige otro en Ajustes. El resto de esta grabación no se transcribirá.',
  },

  byokNotAllowedTranscription: {
    title: 'Tu propia clave de API no se puede usar aquí para transcribir.',
    body: 'Cambia a Prismical Cloud en Ajustes. El resto de esta grabación no se transcribirá.',
  },

  askNotInPlan: {
    title: 'Ask AI no está incluido en tu plan.',
    body: 'Mejora tu plan para hacer preguntas sobre tus notas.',
  },
  aiCreditsExhausted: {
    title: 'Has usado los créditos de IA de este mes.',
    body: 'Los créditos se reinician al comienzo del próximo mes. Mejora tu plan para tener más.',
  },
  byokNotInPlan: {
    title: 'Tu propia clave de API no está incluida en tu plan.',
    body: 'Esto se ejecutó en Prismical Cloud en su lugar. Mejora tu plan para usar tus propias claves.',
  },
  subject: { skill: 'Esta habilidad', ask: 'Ask AI', transcription: 'La transcripción' },
  actions: {
    retry: 'Intentar de nuevo',
    'open-ai-models': 'Abrir modelos de IA',
    'use-cloud': 'Usar Prismical Cloud',
    'choose-model': 'Elegir modelo',
    'append-instead': 'Añadir en su lugar',
    continue: 'Continuar',
    'open-billing': 'Ver planes',
  },
};

const ja: Copy = {
  keyInvalid: {
    localBody: '設定で更新してください。',
    title: '{{provider}}のキーが拒否されました。',
    body: '設定で更新するか、当面は Prismical Cloud を使ってください。',
  },
  keyMissing: {
    localBody: '設定で追加してください。',
    title: '{{provider}}のAPIキーが保存されていません。',
    body: '設定で追加するか、当面は Prismical Cloud を使ってください。',
  },
  quotaExceeded: {
    localBody: '{{provider}}でチャージしてください。',
    title: '{{provider}}アカウントのクレジットが不足しています。',
    body: '{{provider}}でチャージするか、当面は Prismical Cloud を使ってください。',
  },
  rateLimited: {
    title: '{{provider}}が混み合っています。',
    body: '1分ほどしてからもう一度お試しください。',
  },
  modelNotFound: {
    title: '選択したモデルは利用できなくなりました。',
    body: '設定で別のモデルを選んでください。',
  },
  contextTooLong: {
    title: 'このノートは長すぎて{{name}}で一度に処理できません。',
    body: '選択範囲で試すか、ノートを短くしてください。',
  },
  contextTooLongAsk: {
    title: 'この会話はモデルには長すぎます。',
    body: '新しいチャットを始めるか、タグ付けするノートを減らしてください。',
  },
  toolsUnsupported: {
    title: '選択したモデルでは{{name}}を実行できません。',
    body: '{{name}}が必要とするツールを使えません。設定で別のモデルを選んでください。',
  },
  rejected: {
    title: '{{provider}}がこのリクエストを拒否しました。',
    body: '設定で別のモデルを選んでください。',
  },
  unavailable: { title: '{{provider}}が応答しません。', body: '数分後にもう一度お試しください。' },
  cloudUnavailable: {
    title: 'Prismical Cloud に問題が発生しています。',
    body: '数分後にもう一度お試しください。',
  },
  notConfigured: {
    localBody: '設定 → AIモデルでAPIキーを追加するか、ローカルランタイムに接続してください。',
    title: 'このワークスペースではAIがまだ設定されていません。',
    body: '設定で自分のAPIキーを追加すると続行できます。',
  },
  selectionInvalid: {
    title: '選択したモデルはここでは使えません。',
    body: '設定で別のモデルを選んでください。',
  },
  instanceNotFound: {
    localBody: '設定で別のモデルを選んでください。',
    title: '選択したAIプロバイダーは削除されました。',
    body: '設定で別のモデルを選ぶか、Prismical Cloud を使ってください。',
  },
  byokNotAllowed: {
    title: 'ここでは自分のAPIキーを使えません。',
    body: 'Prismical Cloud を使ってください。',
  },
  outputTooLong: {
    title: 'このノートは長すぎて{{name}}で一度に書き換えられません。',
    body: '選択範囲で試すか、代わりに要約を追記してください。',
  },
  outputTooLongByok: {
    title: 'このノートは長すぎて{{name}}で一度に書き換えられません。',
    body: '選択範囲で試す、要約を追記する、または出力上限の大きいモデルを選んでください。',
  },
  noResult: {
    title: '{{name}}は今回結果を生成できませんでした。',
    body: 'もう一度お試しください。',
  },
  noResultAsk: { title: 'モデルが今回は応答しませんでした。', body: 'もう一度お試しください。' },
  declinedTitle: { title: 'このノートに名前を付けるには内容がまだ足りません。' },
  toolBudget: {
    title: '{{name}}は完了前にステップを使い切りました。',
    body: 'もう一度試すか、スキルが使うものを簡素化してください。',
  },
  noteEmpty: { title: '{{name}}を実行する前に、このノートに内容を追加してください。' },
  noteAndTranscriptEmpty: {
    title: 'このノートにはまだテキストも文字起こしもありません。',
    body: '{{name}}を実行する前に、テキストを追加するか音声を録音してください。',
  },
  noTranscript: {
    title: 'この録音には強化できる文字起こしがありません。',
    body: '文字起こしを確認するか、新しく録音してください。',
  },
  transcriptFinalizing: {
    title: '最終的な文字起こしをまだ準備しています。',
    body: 'しばらくしてから{{name}}をもう一度お試しください。',
  },
  titleInvalid: {
    title: '{{name}}はタイトルを提案できませんでした。',
    body: 'もう一度お試しください。',
  },
  titleTimeout: {
    title: 'タイトル付けに時間がかかりすぎました。',
    body: 'もう一度お試しください。',
  },
  titleChanged: {
    title: '{{name}}の実行中にタイトルが変更されました。',
    body: 'もう一度クリックして名前を付け直してください。',
  },
  selectionRequired: {
    title: '先にテキストを選択してください。',
    body: '{{name}}は選択したテキストを書き換えます。',
  },
  generic: {
    title: '{{name}}を実行できませんでした。',
    body: '少ししてからもう一度お試しください。',
  },
  stepsExhausted: {
    title: '完了する前にステップを使い切りました。',
    body: 'もう一度質問するか、質問を絞ってください。',
  },
  outputTruncated: {
    title: '回答が途中で切れました。',
    body: '続きを頼むか、質問を絞ってください。',
  },
  fallbackToCloud: {
    title: '選択したモデルが利用できないため、Prismical Cloud で実行しました。',
    body: '自分のキーを再び使うには、設定で別のモデルを選んでください。',
  },
  askFailed: {
    title: 'Ask AI は回答できませんでした。',
    body: '少ししてからもう一度お試しください。',
  },
  transcriptionQuota: {
    title: 'このセッションのクラウド文字起こしを一時停止しました。',
    body: '音声の録音は続きますが、これ以降は文字起こしされません。アップグレードするか、設定で自分のキーを追加してください。',
  },
  recordingLengthExceeded: {
    title: 'この録音はプランの長さの上限に達しました。',
    body: '上限までの内容は保存されています。続けるには新しい録音を開始するか、より長く録音できるプランにアップグレードしてください。',
  },
  keyInvalidTranscription: {
    title: '{{provider}}のキーが拒否されました。',
    body: '設定で更新してください。この録音の残りは文字起こしされません。',
  },

  keyMissingTranscription: {
    title: '{{provider}}のAPIキーが保存されていません。',
    body: '設定で追加してください。この録音の残りは文字起こしされません。',
  },

  quotaExceededTranscription: {
    title: '{{provider}}アカウントの残高がありません。',
    body: '{{provider}}でチャージしてください。この録音の残りは文字起こしされません。',
  },

  instanceNotFoundTranscription: {
    title: '選択した文字起こしプロバイダーは削除されました。',
    body: '設定で別のものを選んでください。この録音の残りは文字起こしされません。',
  },

  byokNotAllowedTranscription: {
    title: 'ここでは自分のAPIキーを文字起こしに使えません。',
    body: '設定でPrismical Cloudに切り替えてください。この録音の残りは文字起こしされません。',
  },

  askNotInPlan: {
    title: 'Ask AI は現在のプランに含まれていません。',
    body: 'ノート全体に質問するにはアップグレードしてください。',
  },
  aiCreditsExhausted: {
    title: '今月の AI クレジットを使い切りました。',
    body: 'クレジットは来月初めにリセットされます。さらに使うにはアップグレードしてください。',
  },
  byokNotInPlan: {
    title: '自分の API キーは現在のプランに含まれていません。',
    body: '代わりに Prismical Cloud で実行しました。自分のキーを使うにはアップグレードしてください。',
  },
  subject: { skill: 'このスキル', ask: 'Ask AI', transcription: '文字起こし' },
  actions: {
    retry: 'もう一度試す',
    'open-ai-models': 'AIモデルを開く',
    'use-cloud': 'Prismical Cloud を使う',
    'choose-model': 'モデルを選ぶ',
    'append-instead': '代わりに追記する',
    continue: '続ける',
    'open-billing': 'プランを見る',
  },
};

const zhTW: Copy = {
  keyInvalid: {
    localBody: '請到設定更新。',
    title: '你的 {{provider}} 金鑰被拒絕。',
    body: '請到設定更新，或暫時改用 Prismical Cloud。',
  },
  keyMissing: {
    localBody: '請到設定新增。',
    title: '尚未儲存 {{provider}} 的 API 金鑰。',
    body: '請到設定新增，或暫時改用 Prismical Cloud。',
  },
  quotaExceeded: {
    localBody: '請到 {{provider}} 儲值。',
    title: '你的 {{provider}} 帳戶額度已用完。',
    body: '請到 {{provider}} 儲值，或暫時改用 Prismical Cloud。',
  },
  rateLimited: { title: '{{provider}} 目前很忙碌。', body: '請一分鐘後再試。' },
  modelNotFound: {
    title: '你選擇的模型已無法使用。',
    body: '請到設定選擇其他模型。',
  },
  contextTooLong: {
    title: '這則筆記太長，{{name}} 無法一次處理。',
    body: '請試著選取部分內容，或縮短筆記。',
  },
  contextTooLongAsk: {
    title: '這段對話對模型來說太長了。',
    body: '請開始新的對話，或減少標記的筆記。',
  },
  toolsUnsupported: {
    title: '你選擇的模型無法執行 {{name}}。',
    body: '它無法使用 {{name}} 需要的工具。請到設定選擇其他模型。',
  },
  rejected: {
    title: '{{provider}} 拒絕了這個請求。',
    body: '請到設定選擇其他模型。',
  },
  unavailable: { title: '{{provider}} 沒有回應。', body: '請幾分鐘後再試。' },
  cloudUnavailable: {
    title: 'Prismical Cloud 目前發生問題。',
    body: '請幾分鐘後再試。',
  },
  notConfigured: {
    localBody: '請到設定 → AI 模型新增 API 金鑰，或連接本機執行環境。',
    title: '這個工作區尚未設定 AI。',
    body: '請到設定新增你自己的 API 金鑰以繼續使用。',
  },
  selectionInvalid: {
    title: '所選模型無法用於此操作。',
    body: '請到設定選擇其他模型。',
  },
  instanceNotFound: {
    localBody: '請到設定選擇其他模型。',
    title: '你選擇的 AI 供應商已被移除。',
    body: '請到設定選擇其他模型，或改用 Prismical Cloud。',
  },
  byokNotAllowed: { title: '這裡無法使用你自己的 API 金鑰。', body: '請改用 Prismical Cloud。' },
  outputTooLong: {
    title: '這則筆記太長，{{name}} 無法一次重寫。',
    body: '請試著選取部分內容，或改為附加摘要。',
  },
  outputTooLongByok: {
    title: '這則筆記太長，{{name}} 無法一次重寫。',
    body: '請試著選取部分內容、改為附加摘要，或選擇輸出上限更大的模型。',
  },
  noResult: { title: '{{name}} 這次沒有產生結果。', body: '請再試一次。' },
  noResultAsk: { title: '模型這次沒有回應。', body: '請再試一次。' },
  declinedTitle: { title: '內容還不足以為這則筆記命名。' },
  toolBudget: {
    title: '{{name}} 在完成前用盡了步驟。',
    body: '請再試一次，或簡化技能使用的工具。',
  },
  noteEmpty: { title: '執行 {{name}} 前，請先在這則筆記加入內容。' },
  noteAndTranscriptEmpty: {
    title: '這則筆記還沒有文字或轉錄稿。',
    body: '執行 {{name}} 前，請先加入文字或錄音。',
  },
  noTranscript: {
    title: '這段錄音沒有可強化的轉錄稿。',
    body: '請檢查轉錄稿，或重新錄音。',
  },
  transcriptFinalizing: {
    title: '最終轉錄稿仍在準備中。',
    body: '請稍後再試 {{name}}。',
  },
  titleInvalid: { title: '{{name}} 想不出標題。', body: '請再試一次。' },
  titleTimeout: { title: '命名花費的時間太長。', body: '請再試一次。' },
  titleChanged: { title: '{{name}} 執行期間標題已變更。', body: '請再點一次以重新命名。' },
  selectionRequired: { title: '請先選取文字。', body: '{{name}} 會重寫你選取的文字。' },
  generic: { title: '無法執行 {{name}}。', body: '請稍後再試。' },
  stepsExhausted: {
    title: '我在完成前用盡了步驟。',
    body: '請再問一次，或縮小問題範圍。',
  },
  outputTruncated: {
    title: '回答被截斷了。',
    body: '請要求繼續，或縮小問題範圍。',
  },
  fallbackToCloud: {
    title: '你選擇的模型無法使用，因此這次改用 Prismical Cloud 執行。',
    body: '請到設定選擇其他模型，以繼續使用你自己的金鑰。',
  },
  askFailed: { title: 'Ask AI 無法回答。', body: '請稍後再試。' },
  transcriptionQuota: {
    title: '本次工作階段的雲端轉錄已暫停。',
    body: '錄音會繼續，但之後的內容不會轉錄。升級方案，或到設定新增你自己的金鑰。',
  },
  recordingLengthExceeded: {
    title: '這段錄音已達到你方案的長度上限。',
    body: '上限之前的內容都已儲存。開始新的錄音即可繼續，或升級方案以錄製更長的內容。',
  },
  keyInvalidTranscription: {
    title: '你的 {{provider}} 金鑰遭拒絕。',
    body: '請到設定更新。這段錄音的其餘部分不會轉錄。',
  },

  keyMissingTranscription: {
    title: '尚未儲存 {{provider}} 的 API 金鑰。',
    body: '請到設定新增。這段錄音的其餘部分不會轉錄。',
  },

  quotaExceededTranscription: {
    title: '你的 {{provider}} 帳戶已無餘額。',
    body: '請到 {{provider}} 儲值。這段錄音的其餘部分不會轉錄。',
  },

  instanceNotFoundTranscription: {
    title: '你選擇的轉錄提供者已被移除。',
    body: '請到設定選擇另一個。這段錄音的其餘部分不會轉錄。',
  },

  byokNotAllowedTranscription: {
    title: '這裡無法用你自己的 API 金鑰轉錄。',
    body: '請到設定切換為 Prismical Cloud。這段錄音的其餘部分不會轉錄。',
  },

  askNotInPlan: {
    title: 'Ask AI 不包含在你的方案中。',
    body: '升級後即可針對你的筆記提問。',
  },
  aiCreditsExhausted: {
    title: '本月的 AI 點數已用完。',
    body: '點數會在下個月初重置。升級可取得更多點數。',
  },
  byokNotInPlan: {
    title: '你的方案不包含使用自己的 API 金鑰。',
    body: '這次改以 Prismical Cloud 執行。升級後即可使用自己的金鑰。',
  },
  subject: { skill: '這個技能', ask: 'Ask AI', transcription: '轉錄' },
  actions: {
    retry: '再試一次',
    'open-ai-models': '開啟 AI 模型',
    'use-cloud': '使用 Prismical Cloud',
    'choose-model': '選擇模型',
    'append-instead': '改為附加',
    continue: '繼續',
    'open-billing': '查看方案',
  },
};

export const AI_ERROR_COPY: Record<AiErrorCopyLocale, Copy> = { en, de, es, ja, 'zh-TW': zhTW };

/** Provider ids as configured → the name users know. Unknown ids show as-is. */
const PROVIDER_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  fireworks: 'Fireworks',
  groq: 'Groq',
  deepgram: 'Deepgram',
  google: 'Google',
  mistral: 'Mistral',
  ollama: 'Ollama',
  'prismical-cloud': 'Prismical Cloud',
};
export const providerDisplayName = (provider: string | undefined): string =>
  provider ? (PROVIDER_NAMES[provider] ?? provider) : 'the provider';

/** `en`, `en-US`, `zh-Hant-TW` → a supported copy locale (default `en`). */
export function matchAiErrorCopyLocale(locale: string | undefined | null): AiErrorCopyLocale {
  if (!locale) return 'en';
  const lower = locale.toLowerCase();
  if (lower.startsWith('zh')) return 'zh-TW';
  const base = lower.split(/[-_]/)[0] ?? lower;
  return (AI_ERROR_COPY_LOCALES as readonly string[]).includes(base)
    ? (base as AiErrorCopyLocale)
    : 'en';
}

const interpolate = (s: string, params: Record<string, string>): string =>
  s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => params[k] ?? '');

export interface DescribeAiErrorInput {
  code: string;
  details?: AiErrorDetails;
  locale?: string | null;
  /** `skill` (a skill run, incl. naming), `ask` (Ask AI), `transcription`. */
  surface: 'skill' | 'ask' | 'transcription';
  /** Local mode cannot offer a Cloud fallback. Defaults to true. */
  cloudAvailable?: boolean;
  /** The skill's display name, for `{{name}}`. */
  skillName?: string;
  /**
   * Skill output mode — "append instead" is offered ONLY for a whole-note replace: an inline
   * rewrite must keep targeting the selection, and an append cannot append harder.
   */
  mode?: string;
  /** Title runs (the naming skill) can't change mode, so no output-mode actions are offered. */
  outputTarget?: 'note-body' | 'note-title';
  /** NOTE_EMPTY: whether the skill also reads the transcript (drives the wording). */
  includesTranscript?: boolean;
}

/**
 * The user-facing description for an AI error: localized title/body, a severity, and the
 * recovery actions a client should offer, in order. Pure and deterministic — core calls it when
 * it writes the error envelope; the desktop local lane calls it for the same codes.
 */
export function describeAiError(input: DescribeAiErrorInput): AiUserError {
  const copy = AI_ERROR_COPY[matchAiErrorCopyLocale(input.locale)];
  const details = input.details ?? {};
  const byok = details.lane === 'your-key';
  const params = {
    provider: byok ? providerDisplayName(details.provider) : 'Prismical Cloud',
    name: input.skillName ?? copy.subject[input.surface],
  };
  const act = (...kinds: AiErrorActionKind[]): AiErrorAction[] =>
    kinds
      // "Use Prismical Cloud" only makes sense when the failing call ran on the user's own key.
      .filter(k => k !== 'use-cloud' || (byok && input.cloudAvailable !== false))
      .map(kind => ({ kind, label: copy.actions[kind] }));
  const pick = (
    entry: Entry,
    severity: AiUserErrorSeverity,
    actions: AiErrorAction[] = []
  ): AiUserError => {
    const body = input.cloudAvailable === false ? (entry.localBody ?? entry.body) : entry.body;
    return {
      title: interpolate(entry.title, params),
      ...(body ? { body: interpolate(body, params) } : {}),
      severity,
      actions,
    };
  };
  const isAsk = input.surface === 'ask';
  const isTranscription = input.surface === 'transcription';

  switch (input.code) {
    case AI_ERROR_CODES.PROVIDER_KEY_INVALID:
      return pick(
        isTranscription ? copy.keyInvalidTranscription : copy.keyInvalid,
        'warning',
        act('open-ai-models', 'use-cloud')
      );
    case AI_ERROR_CODES.PROVIDER_KEY_MISSING:
      return pick(
        isTranscription ? copy.keyMissingTranscription : copy.keyMissing,
        'warning',
        act('open-ai-models', 'use-cloud')
      );
    case AI_ERROR_CODES.PROVIDER_QUOTA_EXCEEDED:
      return pick(
        isTranscription ? copy.quotaExceededTranscription : copy.quotaExceeded,
        'warning',
        act('use-cloud', 'open-ai-models')
      );
    case AI_ERROR_CODES.PROVIDER_RATE_LIMITED:
      return pick(copy.rateLimited, 'warning', act('retry'));
    case AI_ERROR_CODES.PROVIDER_MODEL_NOT_FOUND:
      return pick(copy.modelNotFound, 'warning', act('choose-model', 'use-cloud'));
    case AI_ERROR_CODES.PROVIDER_CONTEXT_TOO_LONG:
      return pick(isAsk ? copy.contextTooLongAsk : copy.contextTooLong, 'warning');
    case AI_ERROR_CODES.PROVIDER_TOOLS_UNSUPPORTED:
      return pick(copy.toolsUnsupported, 'warning', act('choose-model', 'use-cloud'));
    case AI_ERROR_CODES.PROVIDER_REJECTED:
      // A 4xx the provider gave for the request itself will not change on retry.
      return pick(copy.rejected, 'error', act('choose-model', 'use-cloud'));
    case AI_ERROR_CODES.PROVIDER_UNAVAILABLE:
      return pick(byok ? copy.unavailable : copy.cloudUnavailable, 'error', act('retry'));
    case AI_ERROR_CODES.MODEL_NOT_CONFIGURED:
      return pick(copy.notConfigured, 'warning', act('open-ai-models'));
    case AI_ERROR_CODES.MODEL_SELECTION_INVALID:
      return pick(copy.selectionInvalid, 'warning', act('choose-model', 'use-cloud'));
    case AI_ERROR_CODES.INSTANCE_NOT_FOUND:
      return pick(
        isTranscription ? copy.instanceNotFoundTranscription : copy.instanceNotFound,
        'warning',
        act('choose-model', 'use-cloud')
      );
    case AI_ERROR_CODES.BYOK_NOT_ALLOWED:
      return pick(
        isTranscription ? copy.byokNotAllowedTranscription : copy.byokNotAllowed,
        'warning',
        isTranscription ? act('open-ai-models') : act('use-cloud')
      );
    case AI_ERROR_CODES.ASK_STEPS_EXHAUSTED:
      return pick(copy.stepsExhausted, 'warning', act('retry'));
    case AI_ERROR_CODES.ASK_OUTPUT_TRUNCATED:
      return pick(copy.outputTruncated, 'info', act('continue'));
    case AI_ERROR_CODES.ASK_REQUEST_FAILED:
      return pick(copy.askFailed, 'error', act('retry'));
    case AI_ERROR_CODES.TRANSCRIPTION_QUOTA_EXCEEDED:
      // Billing FIRST: the dock renders only the first action a client can perform, and the fix
      // for a spent allowance is a bigger one. BYOK stays offered behind it.
      return pick(copy.transcriptionQuota, 'warning', act('open-billing', 'open-ai-models'));
    case AI_ERROR_CODES.RECORDING_LENGTH_EXCEEDED:
      // Billing, not models: a longer session is something the plan sells, not something a
      // different provider key would unlock.
      return pick(copy.recordingLengthExceeded, 'warning', act('open-billing'));
    case AI_ERROR_CODES.ASK_NOT_IN_PLAN:
      return pick(copy.askNotInPlan, 'warning', act('open-billing'));
    case AI_ERROR_CODES.AI_CREDITS_EXHAUSTED:
      return pick(copy.aiCreditsExhausted, 'warning', act('open-billing'));
    case AI_ERROR_CODES.BYOK_NOT_IN_PLAN:
      // A notice on a run that already went to Prismical Cloud: informative, never blocking.
      return pick(copy.byokNotInPlan, 'info', act('open-billing'));
    case AI_ERROR_CODES.MODEL_FALLBACK_TO_CLOUD:
      // The instance that was chosen is GONE (deleted), so its provider is unknown by the time
      // this fires — the copy names "the model you chose" rather than a provider.
      return pick(copy.fallbackToCloud, 'info', act('choose-model'));

    case SKILL_RUN_ERROR_CODES.OUTPUT_TOO_LONG:
      return pick(
        byok ? copy.outputTooLongByok : copy.outputTooLong,
        'warning',
        input.mode === 'replace-doc' && input.outputTarget !== 'note-title'
          ? act('append-instead')
          : []
      );
    case SKILL_RUN_ERROR_CODES.OUTPUT_MALFORMED:
    case SKILL_RUN_ERROR_CODES.OUTPUT_NOT_SUBMITTED:
    case SKILL_RUN_ERROR_CODES.OUTPUT_EMPTY:
      return pick(isAsk ? copy.noResultAsk : copy.noResult, 'error', act('retry'));
    case SKILL_RUN_ERROR_CODES.OUTPUT_DECLINED:
      // The model withheld output its prompt lets it withhold — a correct answer, so `info` like
      // NOTE_EMPTY rather than an alarm, and deliberately NO retry: re-running reproduces the same
      // answer and bills for it again (the argument the OUTPUT_TOO_LONG comment makes).
      //
      // One copy string, because the naming lane is the only emitter. It is also the only lane
      // whose prompt says when to withhold, so there is no model-authored reason to show and
      // nothing to phrase per surface.
      return pick(copy.declinedTitle, 'info');
    case SKILL_RUN_ERROR_CODES.TOOL_BUDGET_EXHAUSTED:
      return pick(copy.toolBudget, 'error', act('retry'));
    case SKILL_RUN_ERROR_CODES.NOTE_EMPTY:
      return pick(input.includesTranscript ? copy.noteAndTranscriptEmpty : copy.noteEmpty, 'info');
    case SKILL_RUN_ERROR_CODES.NO_TRANSCRIPT:
      return pick(copy.noTranscript, 'info');
    case SKILL_RUN_ERROR_CODES.TRANSCRIPT_FINALIZING:
      return pick(copy.transcriptFinalizing, 'info');
    case SKILL_RUN_ERROR_CODES.TITLE_INVALID:
      return pick(copy.titleInvalid, 'error', act('retry'));
    case SKILL_RUN_ERROR_CODES.TITLE_TIMEOUT:
      return pick(copy.titleTimeout, 'error', act('retry'));
    case SKILL_RUN_ERROR_CODES.TITLE_CHANGED:
      return pick(copy.titleChanged, 'info');
    case SKILL_RUN_ERROR_CODES.SELECTION_REQUIRED:
      return pick(copy.selectionRequired, 'info');
    default:
      return pick(copy.generic, 'error', act('retry'));
  }
}
