import { Button, Spinner, cn } from "@odentia/ui"
import { MicIcon } from "lucide-react"
import type { ComponentProps } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { ListeningIndicator } from "./listening-indicator.js"
import { listeningClock, useListeningStatus } from "./use-listening-status.js"
import { useMicLevel } from "./use-mic-level.js"

interface SpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null
  onend: ((this: SpeechRecognition, ev: Event) => void) | null
  onresult:
    | ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void)
    | null
  onerror:
    | ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void)
    | null
}

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList
  resultIndex: number
}

interface SpeechRecognitionResultList {
  readonly length: number
  item(index: number): SpeechRecognitionResult
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionResult {
  readonly length: number
  item(index: number): SpeechRecognitionAlternative
  [index: number]: SpeechRecognitionAlternative
  isFinal: boolean
}

interface SpeechRecognitionAlternative {
  transcript: string
  confidence: number
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition
    webkitSpeechRecognition: new () => SpeechRecognition
  }
}

type SpeechInputMode = "speech-recognition" | "media-recorder" | "none"

export type SpeechInputProps = ComponentProps<typeof Button> & {
  onTranscriptionChange?: (text: string) => void
  /**
   * Callback for when audio is recorded using MediaRecorder fallback.
   * This is called in browsers that don't support the Web Speech API (Firefox, Safari).
   * The callback receives an audio Blob that should be sent to a transcription service.
   * Return the transcribed text, which will be passed to onTranscriptionChange.
   */
  onAudioRecorded?: (audioBlob: Blob) => Promise<string>
  lang?: string
}

const detectSpeechInputMode = (): SpeechInputMode => {
  if (typeof window === "undefined") {
    return "none"
  }

  if ("SpeechRecognition" in window || "webkitSpeechRecognition" in window) {
    return "speech-recognition"
  }

  if ("MediaRecorder" in window && "mediaDevices" in navigator) {
    return "media-recorder"
  }

  return "none"
}

export const SpeechInput = ({
  className,
  onTranscriptionChange,
  onAudioRecorded,
  lang = "en-US",
  ...props
}: SpeechInputProps) => {
  const [isListening, setIsListening] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [mode] = useState<SpeechInputMode>(detectSpeechInputMode)
  const [isRecognitionReady, setIsRecognitionReady] = useState(false)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [meterStream, setMeterStream] = useState<MediaStream | null>(null)
  // Secuencia de la petición en curso: si cambia (reintento/desmontaje),
  // el getUserMedia tardío se descarta en vez de medir o grabar.
  const mediaRequestRef = useRef(0)
  const unmountedRef = useRef(false)
  const audioChunksRef = useRef<Blob[]>([])
  const onTranscriptionChangeRef = useRef<
    SpeechInputProps["onTranscriptionChange"]
  >(onTranscriptionChange)
  const onAudioRecordedRef =
    useRef<SpeechInputProps["onAudioRecorded"]>(onAudioRecorded)
  // Anuncio estable del estado (escucha/parada), no de los niveles: el
  // aria-label del botón no es aria-live y no anuncia el cambio.
  const [announcement, setAnnouncement] = useState<string | null>(null)
  const announced = useRef(false)
  useEffect(() => {
    if (!announced.current) {
      announced.current = true
      return
    }
    setAnnouncement(isListening ? "Escuchando" : "Dictado detenido")
  }, [isListening])


  // Keep refs in sync
  onTranscriptionChangeRef.current = onTranscriptionChange
  onAudioRecordedRef.current = onAudioRecorded

  // Initialize Speech Recognition when mode is speech-recognition
  useEffect(() => {
    if (mode !== "speech-recognition") {
      return
    }

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition
    const speechRecognition = new SpeechRecognition()

    speechRecognition.continuous = true
    speechRecognition.interimResults = true
    speechRecognition.lang = lang

    const handleStart = () => {
      setIsListening(true)
    }

    const handleEnd = () => {
      setIsListening(false)
    }

    const handleResult = (event: Event) => {
      const speechEvent = event as SpeechRecognitionEvent
      let finalTranscript = ""

      for (
        let i = speechEvent.resultIndex;
        i < speechEvent.results.length;
        i += 1
      ) {
        const result = speechEvent.results[i]
        if (result.isFinal) {
          finalTranscript += result[0]?.transcript ?? ""
        }
      }

      if (finalTranscript) {
        onTranscriptionChangeRef.current?.(finalTranscript)
      }
    }

    const handleError = () => {
      setIsListening(false)
    }

    speechRecognition.addEventListener("start", handleStart)
    speechRecognition.addEventListener("end", handleEnd)
    speechRecognition.addEventListener("result", handleResult)
    speechRecognition.addEventListener("error", handleError)

    recognitionRef.current = speechRecognition
    setIsRecognitionReady(true)

    return () => {
      speechRecognition.removeEventListener("start", handleStart)
      speechRecognition.removeEventListener("end", handleEnd)
      speechRecognition.removeEventListener("result", handleResult)
      speechRecognition.removeEventListener("error", handleError)
      // stop() lanza si nunca empezó: la limpieza no puede romper el desmontaje.
      try {
        speechRecognition.stop()
      } catch {
        // Ya parado o nunca iniciado: nada que detener.
      }
      recognitionRef.current = null
      setIsRecognitionReady(false)
    }
  }, [mode, lang])

  // Al desmontar se descarta: el stop de esta limpieza dispara el evento
  // "stop", pero handleStop lo detecta y no sube audio ni toca estado.
  // También invalida el getUserMedia en vuelo para que no mida ni grabe.
  useEffect(
    () => {
      unmountedRef.current = false
      return () => {
      unmountedRef.current = true
      mediaRequestRef.current += 1
      const recorder = mediaRecorderRef.current
      mediaRecorderRef.current = null
      if (recorder?.state === "recording") {
        recorder.stop()
      }
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          track.stop()
        }
        streamRef.current = null
      }
      }
    },
    []
  )

  // Start MediaRecorder recording. El id de petición descarta el getUserMedia
  // tardío (doble toque o desmontaje en vuelo): ese flujo se cierra sin
  // medir, grabar ni tocar estado, así nunca hay dos micrófonos abiertos.
  const startMediaRecorder = useCallback(async () => {
    if (!onAudioRecordedRef.current) {
      return
    }
    const request = mediaRequestRef.current + 1
    mediaRequestRef.current = request
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      if (!unmountedRef.current && mediaRequestRef.current === request) setIsListening(false)
      return
    }
    if (unmountedRef.current || mediaRequestRef.current !== request) {
      for (const track of stream.getTracks()) {
        track.stop()
      }
      return
    }
    try {
      streamRef.current = stream
      // El nivel se mide sobre este mismo flujo: no se pide otro micrófono.
      setMeterStream(stream)
      const mediaRecorder = new MediaRecorder(stream)
      audioChunksRef.current = []

      const handleDataAvailable = (event: BlobEvent) => {
        if (event.data.size > 0 && mediaRequestRef.current === request) {
          audioChunksRef.current.push(event.data)
        }
      }

      const handleStop = async () => {
        for (const track of stream.getTracks()) {
          track.stop()
        }
        // Lo parado por la limpieza de desmontaje se descarta: no sube
        // audio ni deja el botón en "procesando" fuera de pantalla.
        if (unmountedRef.current || mediaRequestRef.current !== request) return
        streamRef.current = null
        setMeterStream(null)

        const audioBlob = new Blob(audioChunksRef.current, {
          type: "audio/webm",
        })

        if (audioBlob.size > 0 && onAudioRecordedRef.current) {
          setIsProcessing(true)
          try {
            const transcript = await onAudioRecordedRef.current(audioBlob)
            if (transcript && !unmountedRef.current) {
              onTranscriptionChangeRef.current?.(transcript)
            }
          } catch {
            // Error handling delegated to the onAudioRecorded caller
          } finally {
            if (!unmountedRef.current) setIsProcessing(false)
          }
        }
      }

      const handleError = () => {
        if (unmountedRef.current || mediaRequestRef.current !== request) return
        setIsListening(false)
        for (const track of stream.getTracks()) {
          track.stop()
        }
        streamRef.current = null
        setMeterStream(null)
      }
      mediaRecorder.addEventListener("dataavailable", handleDataAvailable)
      mediaRecorder.addEventListener("stop", handleStop)
      mediaRecorder.addEventListener("error", handleError)

      mediaRecorderRef.current = mediaRecorder
      mediaRecorder.start()
      setIsListening(true)
    } catch {
      for (const track of stream.getTracks()) {
        track.stop()
      }
      streamRef.current = null
      setMeterStream(null)
      if (!unmountedRef.current && mediaRequestRef.current === request) setIsListening(false)
    }
  }, [])

  // Stop MediaRecorder recording
  const stopMediaRecorder = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop()
    }
    setIsListening(false)
  }, [])

  const toggleListening = useCallback(() => {
    if (mode === "speech-recognition" && recognitionRef.current) {
      // start()/stop() lanzan si el estado cambió entre el toque y la
      // llamada (doble toque): se vuelve a reposo en vez de romper.
      try {
        if (isListening) {
          recognitionRef.current.stop()
        } else {
          recognitionRef.current.start()
        }
      } catch {
        setIsListening(false)
      }
    } else if (mode === "media-recorder") {
      if (isListening) {
        stopMediaRecorder()
      } else {
        startMediaRecorder()
      }
    }
  }, [mode, isListening, startMediaRecorder, stopMediaRecorder])
  // El reconocimiento no expone su flujo: en ese modo se mide con un
  // getUserMedia paralelo de solo-nivel. En modo grabadora se reutiliza el
  // flujo ya abierto, sin pedir otro micrófono.
  const metering = useMicLevel({ stream: meterStream, active: isListening, acquire: mode === "speech-recognition" })
  const { seconds, silent } = useListeningStatus(isListening, metering)
  // El silencio se anuncia una vez al empezar; el reloj nunca.
  useEffect(() => {
    if (silent) setAnnouncement("No te oigo; revisa el micrófono")
  }, [silent])

  // Determine if button should be disabled
  const isDisabled =
    mode === "none" ||
    (mode === "speech-recognition" && !isRecognitionReady) ||
    (mode === "media-recorder" && !onAudioRecorded) ||
    isProcessing

  // Mientras escucha, el botón se abre en una píldora con la onda de la marca,
  // «Escuchando» y el reloj, como el dictado (lienzo del dictado, decisión 4):
  // en todo lugar que escucha se ve que escucha. Tras ocho segundos sin voz
  // dice «No te oigo». El estado lo anuncia el texto fuera del botón.
  return (
    <>
    <Button
      {...props}
      className={cn(
        "rounded-full bg-primary text-primary-foreground transition-all duration-300 hover:bg-[color-mix(in_oklab,var(--primary),black_12%)] hover:text-primary-foreground",
        className,
        isListening && "w-auto gap-1.5 pr-3 pl-2",
        isListening && silent && "bg-warning-strong text-warning-strong-foreground hover:bg-warning-strong hover:text-warning-strong-foreground",
      )}
      aria-label={isListening ? "Terminar de dictar" : props["aria-label"]}
      title={isListening ? "Terminar de dictar" : props.title}
      disabled={isDisabled}
      onClick={toggleListening}
    >
      {isProcessing ? <Spinner /> : null}
      {!isProcessing && isListening ? (
        <>
          <ListeningIndicator state="listening" level={metering.level} size="sm" color="inherit" announce={false} />
          <span aria-hidden className="text-xs font-semibold whitespace-nowrap">
            {silent ? "No te oigo" : "Escuchando"} <span className="font-medium tabular-nums opacity-80">{listeningClock(seconds)}</span>
          </span>
        </>
      ) : null}
      {!isProcessing && !isListening ? <MicIcon className="size-4" /> : null}
    </Button>
    {announcement !== null ? <span role="status" className="sr-only">{announcement}</span> : null}
    </>
  )
}
