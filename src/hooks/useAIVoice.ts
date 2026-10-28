/**
 * useAIVoice — primary TTS hook for GradPrep AI
 *
 * Audio source (in priority order):
 *   1. Local Piper voice service (dev) — VITE_VOICE_SERVICE_URL must be set.
 *   2. Piper via Supabase Edge Function (voice-tts) — PIPER_SERVICE_URL secret
 *      must be set in Supabase Edge Function Secrets.
 *
 * The Web Speech API is used only when a caller explicitly requests a
 * non-English language, because the configured Piper voices are English-only.
 *
 * English conversations continue using the configured HFC Piper voices.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { findVoiceForLanguage, getVoiceTtsEndpoints, type PiperVoiceId } from '@/lib/voiceTts';

export type VoicePersona = 'amds' | 'siddu' | 'lusy' | 'male' | 'female';
export type { PiperVoiceId } from '@/lib/voiceTts';

interface SpeakOptions {
  persona?: VoicePersona;
  voiceId?: PiperVoiceId;   // explicit voice_id overrides persona
  speed?: number;
  language?: string;
}

interface UseAIVoiceResult {
  isSpeaking: boolean;
  isLoading: boolean;
  speak: (text: string, options?: SpeakOptions) => Promise<void>;
  cancel: () => void;
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
const TTS_ENDPOINTS = getVoiceTtsEndpoints(
  SUPABASE_URL,
  import.meta.env.DEV ? import.meta.env.VITE_VOICE_SERVICE_URL : undefined,
  import.meta.env.DEV,
);

// Global singleton so only one voice speaks at a time
let activeVoiceOwner: symbol | null = null;
let stopActiveVoice: (() => void) | null = null;

/** Normalise agent names so the TTS engine pronounces them naturally. */
export function humanizeForSpeech(text: string): string {
  return text
    .replace(/\bS\.?I\.?D\.?D\.?U\.?\b/gi, 'Siddu')
    .replace(/\bAMDS\b/gi, 'Siddu')
    .replace(/\bL\.?U\.?S\.?Y\.?\b/gi, 'Lucy')
    .replace(/\bLusy\b/g, 'Lucy')
    .replace(/\bA\.M\.D\.S\.?\b/gi, 'Siddu')
    .replace(/[*_#`]+/g, '');
}

const canUseWebSpeech = typeof window !== 'undefined' && 'speechSynthesis' in window;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAIVoice(): UseAIVoiceResult {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isLoading, setIsLoading]   = useState(false);

  const requestIdRef    = useRef(0);
  const abortRef        = useRef<AbortController | null>(null);
  const audioRef        = useRef<HTMLAudioElement | null>(null);
  const ownerRef        = useRef(Symbol('ai-voice'));
  const playResolveRef  = useRef<(() => void) | null>(null);

  /** Stop everything immediately and resolve any pending speak() Promise. */
  const cancel = useCallback(() => {
    requestIdRef.current += 1;
    if (activeVoiceOwner === ownerRef.current) {
      activeVoiceOwner = null;
      stopActiveVoice  = null;
    }

    abortRef.current?.abort();
    abortRef.current = null;

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }

    // Clear any stale Web Speech utterances that may have been queued before
    // this session started. This does NOT trigger a new synthesis.
    if (canUseWebSpeech) {
      window.speechSynthesis.cancel();
    }

    // Resolve the dangling speak() Promise so callers (say()) can continue.
    const resolve = playResolveRef.current;
    playResolveRef.current = null;
    resolve?.();

    setIsSpeaking(false);
    setIsLoading(false);
  }, []);

  useEffect(() => cancel, [cancel]);

  const speak = useCallback(
    async (rawText: string, options: SpeakOptions = {}): Promise<void> => {
      const text = humanizeForSpeech((rawText || '').trim());
      if (!text) return;

      if (activeVoiceOwner && activeVoiceOwner !== ownerRef.current) {
        stopActiveVoice?.();
      }
      cancel();
      activeVoiceOwner = ownerRef.current;
      stopActiveVoice  = cancel;
      const requestId = requestIdRef.current;
      const persona   = options.persona ?? 'lusy';
      const speed     = options.speed ?? 1;
      const language  = options.language?.trim() ?? '';

      setIsLoading(true);
      setIsSpeaking(true);

      const finish = () => {
        if (requestId !== requestIdRef.current) return;
        if (activeVoiceOwner === ownerRef.current) {
          activeVoiceOwner = null;
          stopActiveVoice  = null;
        }
        playResolveRef.current = null;
        setIsSpeaking(false);
        setIsLoading(false);
      };

      if (language && !language.toLowerCase().startsWith('en')) {
        if (!canUseWebSpeech) {
          toast.error('Multilingual voice playback is not supported in this browser.');
          finish();
          return;
        }

        const voice = await new Promise<SpeechSynthesisVoice | undefined>((resolve) => {
          const speechSynthesis = window.speechSynthesis;
          const voices = speechSynthesis.getVoices();
          if (voices.length) {
            resolve(findVoiceForLanguage(voices, language));
            return;
          }

          const finishLoadingVoices = () => {
            speechSynthesis.removeEventListener('voiceschanged', finishLoadingVoices);
            clearTimeout(timeout);
            resolve(findVoiceForLanguage(speechSynthesis.getVoices(), language));
          };
          const timeout = setTimeout(finishLoadingVoices, 1500);
          speechSynthesis.addEventListener('voiceschanged', finishLoadingVoices, { once: true });
        });
        if (requestId !== requestIdRef.current) return;
        if (!voice) {
          toast.error(`No ${language} speech voice is installed on this device. LUSY's text reply is still available.`);
          finish();
          return;
        }

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = language;
        utterance.voice = voice;
        utterance.rate = speed;
        await new Promise<void>((resolve) => {
          playResolveRef.current = resolve;
          utterance.onstart = () => setIsLoading(false);
          utterance.onend = () => {
            finish();
            resolve();
          };
          utterance.onerror = () => {
            toast.error('The selected language voice could not play on this device.');
            finish();
            resolve();
          };
          window.speechSynthesis.speak(utterance);
        });
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;

      // ── Piper TTS (local service or Supabase Edge Function) ─────────────
      try {
        const response = await fetch(TTS_ENDPOINTS.synthesizeUrl, {
          method:  'POST',
          signal:  controller.signal,
          headers: {
            'Content-Type': 'application/json',
            apikey:         SUPABASE_KEY,
            Authorization:  `Bearer ${SUPABASE_KEY}`,
          },
          body: JSON.stringify({
            text,
            persona,
            voice_id: options.voiceId,
            speed,
          }),
        });

        if (requestId !== requestIdRef.current) return;

        if (response.ok) {
          const contentType = response.headers.get('content-type') || '';

          if (contentType.includes('audio/')) {
            // ── Piper returned WAV audio — play it ──────────────────────
            const audioBlob = await response.blob();
            if (requestId !== requestIdRef.current) return;

            const audioUrl = URL.createObjectURL(audioBlob);
            const audio    = new Audio(audioUrl);
            audioRef.current = audio;
            setIsLoading(false);

            await new Promise<void>((resolve) => {
              playResolveRef.current = resolve;

              audio.onended = () => {
                URL.revokeObjectURL(audioUrl);
                audioRef.current = null;
                finish();
                resolve();
              };
              audio.onerror = () => {
                URL.revokeObjectURL(audioUrl);
                audioRef.current = null;
                finish();
                resolve();
              };
              audio.play().catch(() => {
                URL.revokeObjectURL(audioUrl);
                audioRef.current = null;
                finish();
                resolve();
              });
            });
            return;
          }

          // Non-audio JSON response — Piper config error or explicit error body.
          const data = await response.json().catch(() => null);
          const errMsg = data?.error ?? 'unexpected non-audio response from voice-tts';
          console.error(
            `[useAIVoice] Piper returned JSON instead of audio (persona=${persona} voice_id=${options.voiceId ?? 'unset'}):`,
            errMsg,
            '— check that PIPER_SERVICE_URL is set in Supabase Edge Function Secrets.',
          );
          toast.error('Voice service unavailable — check Piper configuration.', { id: 'piper-error', duration: 5000 });
        } else {
          // HTTP error — Piper not configured or down.
          const body = await response.text().catch(() => '');
          console.error(
            `[useAIVoice] Piper HTTP ${response.status} (persona=${persona} voice_id=${options.voiceId ?? 'unset'}):`,
            body.slice(0, 300),
            import.meta.env.DEV
              ? '— Is the voice service running? Start it with: cd voice-service && python main.py'
              : '— Check that PIPER_SERVICE_URL is set in Supabase Edge Function Secrets.',
          );
          toast.error(
            import.meta.env.DEV
              ? 'Voice service not running — start it with: cd voice-service && python main.py'
              : 'Voice service unavailable. Please try again later.',
            { id: 'piper-error', duration: 6000 },
          );
        }
      } catch (err) {
        if ((err as Error)?.name === 'AbortError' || requestId !== requestIdRef.current) return;
        console.error(
          `[useAIVoice] Network error reaching Piper (persona=${persona}):`,
          (err as Error).message,
          import.meta.env.DEV
            ? '— Is the voice service running? Start it with: cd voice-service && python main.py'
            : '— Check that PIPER_SERVICE_URL is reachable from the Supabase Edge Function.',
        );
        toast.error(
          import.meta.env.DEV
            ? 'Voice service not running — start it with: cd voice-service && python main.py'
            : 'Voice service unavailable. Please try again later.',
          { id: 'piper-error', duration: 6000 },
        );
      }

      // English Piper is unavailable; do not silently substitute another voice.
      if (requestId !== requestIdRef.current) return;
      finish();
    },
    [cancel],
  );

  return { isSpeaking, isLoading, speak, cancel };
}
