import { useCallback, useEffect, useRef, useState } from 'react';
import { useSpeechRecognition } from './useSpeechRecognition';
import { useAIVoice, VoicePersona, type PiperVoiceId } from './useAIVoice';

export type ConversationStatus = 'idle' | 'speaking' | 'listening' | 'thinking' | 'paused';

interface UseVoiceConversationOptions {
  persona: VoicePersona;
  /** Explicit Piper voice_id override — persisted throughout the session. */
  voiceId?: PiperVoiceId;
  /** Given what the user just said, return what the assistant should say back. */
  getReply: (userText: string) => Promise<string>;
  onUserSpeech?: (text: string) => void;
  onAssistantSpeech?: (text: string) => void;
  onError?: (error: unknown) => void;
  /** How long a pause in speech means "the user finished their turn". */
  silenceMs?: number;
  pausedPhrase?: string;
  resumedPhrase?: string;
  /**
   * BCP-47 language tag passed to the Web Speech API recognition engine.
   * An empty tag uses the browser's default recognition language.
   */
  language?: string;
}

/** Short utterances that are ONLY a pause/stop command — no meaningful content after stripping. */
const PAUSE_RE =
  /\b(stop|pause|hold on|hold up|wait|one (sec|second|minute)|ek (minute|second)|ruko|rukiye|thodi der)\b/i;
const RESUME_RE =
  /\b(continue|resume|carry on|go ahead|go on|start again|next question|i'?m ready|ready now|chalo|shuru)\b/i;

/**
 * Matches an interruption/stop command that may appear at the START of an utterance.
 * Used while the agent is speaking to detect barge-in.
 */
const INTERRUPT_RE =
  /\b(lusy|lucy|siddu|sidhu|amds)?\s*(stop|wait|pause|hold on|ruko|one second|repeat|say (that )?again|repeat the question)\b/i;

/**
 * Strip an interruption command from the *beginning* of an utterance so the
 * meaningful remainder ("stop and explain that again" → "explain that again")
 * is preserved and sent to the LLM.
 */
const stripLeadingInterrupt = (text: string) =>
  text
    .replace(/^\s*(lusy|lucy|siddu|sidhu|amds)?\s*(stop|wait|pause|hold on|ruko|one second|repeat|say (that )?again|repeat the question)\s*(and\s+)?/i, '')
    .replace(/^[,.;:\s-]+/, '')
    .trim();

/**
 * Returns true only when the utterance is *solely* an interruption command
 * with no meaningful follow-on content.
 */
const isPureInterrupt = (text: string) => {
  const remainder = stripLeadingInterrupt(text);
  return !remainder && INTERRUPT_RE.test(text);
};

/**
 * Returns true only when the utterance is *solely* a pause command
 * (no substantive content). This prevents "stop and explain that again"
 * from triggering the paused state.
 */
const isPurePause = (text: string) => {
  const stripped = text
    .replace(PAUSE_RE, '')
    .replace(/^[,.;:\s-]+/, '')
    .trim();
  return !stripped && PAUSE_RE.test(text);
};

export function useVoiceConversation(options: UseVoiceConversationOptions) {
  const { silenceMs = 1100, language = '' } = options;

  const [status, setStatus] = useState<ConversationStatus>('idle');
  const [isActive, setIsActive] = useState(false);
  const [liveText, setLiveText] = useState('');

  const optionsRef = useRef(options);
  optionsRef.current = options;
  const personaRef = useRef<VoicePersona>(options.persona);
  personaRef.current = options.persona;

  const activeRef = useRef(false);
  const pausedRef = useRef(false);
  const busyRef = useRef(false);
  const speakingRef = useRef(false);
  const lastSpokenRef = useRef('');
  const bufferRef = useRef('');
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const takeTurnRef = useRef<() => void>(() => {});
  const wasSpeakingRef = useRef(false);

  const voiceIdRef = useRef<PiperVoiceId | undefined>(options.voiceId);
  voiceIdRef.current = options.voiceId;

  const { speak, cancel, isSpeaking } = useAIVoice();
  speakingRef.current = isSpeaking;

  const clearSilenceTimer = () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  const scheduleTurn = useCallback(() => {
    clearSilenceTimer();
    silenceTimerRef.current = setTimeout(() => takeTurnRef.current(), silenceMs);
  }, [silenceMs]);

  /**
   * Central interruption handler — called whenever we need to cut off LUSY
   * and hand the mic back. Returns the "command" portion that should be
   * queued as the next user turn (may be empty string for pure stops).
   */
  const handleBargein = useCallback(
    (rawText: string) => {
      cancel();
      // ── KEY FIX: clear busyRef on interrupt so future turns are not dropped
      busyRef.current = false;
      clearSilenceTimer();

      const command = stripLeadingInterrupt(rawText);
      bufferRef.current = command;
      setLiveText(command);

      if (!command) {
        // Pure stop/wait command — pause and wait for the user's next utterance.
        pausedRef.current = true;
        setStatus('paused');
        beginListeningRef.current();
      } else {
        setStatus('listening');
        // Schedule the turn so the meaningful remainder is processed.
        silenceTimerRef.current = setTimeout(() => takeTurnRef.current(), silenceMs);
      }
    },
    [cancel, silenceMs],
  );

  const handleResult = useCallback(
    (text: string) => {
      if (!activeRef.current) return;

      if (speakingRef.current) {
        // ── FIX: use word-level echo detection instead of substring match ──
        // The old .includes() was far too broad: if LUSY's speech contained the
        // word "wait" anywhere, a user saying "wait" would be silently dropped.
        // Now we only treat it as an echo if >60% of the user's words appear in
        // the spoken text AND the utterance is very short (≤4 words).
        const userWords = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const spokenLower = lastSpokenRef.current.toLowerCase();
        const matchCount = userWords.filter((w) => spokenLower.includes(w)).length;
        const isEcho =
          userWords.length <= 4 &&
          userWords.length > 0 &&
          matchCount / userWords.length > 0.6;

        if (isEcho || !text.trim()) return;

        handleBargein(text);
        return;
      }

      if (busyRef.current) return;
      bufferRef.current = `${bufferRef.current} ${text}`.trim();
      setLiveText(bufferRef.current);
      scheduleTurn();
    },
    [handleBargein, scheduleTurn],
  );

  const {
    isListening,
    interimTranscript,
    startListening: startRecognition,
    stopListening: stopRecognition,
    resetTranscript,
    isSupported,
  } = useSpeechRecognition({ onResult: handleResult, continuous: true, interimResults: true, language });

  // Keep the turn alive while the user is still mid-sentence.
  useEffect(() => {
    if (!interimTranscript || !activeRef.current || busyRef.current) return;
    if (speakingRef.current) {
      // ── FIX: apply the same improved echo check for interim results ──
      const userWords = interimTranscript.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const spokenLower = lastSpokenRef.current.toLowerCase();
      const matchCount = userWords.filter((w) => spokenLower.includes(w)).length;
      const isEcho =
        userWords.length <= 4 &&
        userWords.length > 0 &&
        matchCount / userWords.length > 0.6;
      if (isEcho) return;

      // Stop the moment we hear the user, before the whole phrase arrives.
      // Reset busyRef here too so the turn can proceed.
      cancel();
      busyRef.current = false;
      setStatus('listening');
      return;
    }
    scheduleTurn();
  }, [interimTranscript, scheduleTurn, cancel]);

  const beginListening = useCallback(() => {
    if (!activeRef.current || !isSupported) return;
    bufferRef.current = '';
    setLiveText('');
    resetTranscript();
    startRecognition();
    setStatus(pausedRef.current ? 'paused' : 'listening');
  }, [isSupported, resetTranscript, startRecognition]);
  const beginListeningRef = useRef(beginListening);
  beginListeningRef.current = beginListening;

  const say = useCallback(
    async (text: string) => {
      if (!text) return;
      clearSilenceTimer();
      bufferRef.current = '';
      setLiveText('');
      lastSpokenRef.current = text;
      optionsRef.current.onAssistantSpeech?.(text);
      setStatus('speaking');
      // The mic stays on so the user can cut in with "lusy stop".
      if (activeRef.current && isSupported) startRecognition();
      await speak(text, {
        persona: personaRef.current,
        voiceId: voiceIdRef.current,
        speed: 1,
        language: optionsRef.current.language,
      });
      // speak() now always resolves (even on cancel), so code here is safe to reach.
    },
    [speak, isSupported, startRecognition],
  );

  // When the assistant finishes speaking, hand the mic back automatically.
  useEffect(() => {
    const wasSpeaking = wasSpeakingRef.current;
    wasSpeakingRef.current = isSpeaking;

    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }

    if (wasSpeaking && !isSpeaking && activeRef.current && !busyRef.current) {
      resumeTimerRef.current = setTimeout(() => {
        if (activeRef.current && !busyRef.current) beginListening();
      }, 100);
    }
  }, [isSpeaking, beginListening]);

  takeTurnRef.current = () => {
    clearSilenceTimer();
    const text = bufferRef.current.trim();
    bufferRef.current = '';
    setLiveText('');
    if (!text || !activeRef.current || busyRef.current) return;

    const words = text.split(/\s+/).filter(Boolean);
    const isShort = words.length <= 10;

    void (async () => {
      if (pausedRef.current) {
        if (RESUME_RE.test(text) && words.length <= 6) {
          pausedRef.current = false;
          await say(optionsRef.current.resumedPhrase ?? "Perfect, let's continue where we left off.");
          if (activeRef.current) beginListeningRef.current();
          return;
        }
        // Anything else said while paused is a real instruction: answer it and resume.
        // Allow single-word instructions (e.g. "hello", "why") — only skip truly empty.
        if (!text) return;
        pausedRef.current = false;
      }

      // Only treat it as a pause command when the utterance is solely a pause phrase.
      if (isShort && isPurePause(text)) {
        pausedRef.current = true;
        setStatus('paused');
        beginListeningRef.current();
        return;
      }

      // Drop utterances that are empty after trimming, but allow single words —
      // short questions and commands are valid conversational inputs.
      if (!text) return;

      busyRef.current = true;
      setStatus('thinking');
      optionsRef.current.onUserSpeech?.(text);
      try {
        const reply = await optionsRef.current.getReply(text);
        // Clear busyRef before say() so a barge-in during speech can ungate correctly.
        busyRef.current = false;
        if (activeRef.current) {
          await say(reply);
          // After finishing a reply, restart listening explicitly.
          // The isSpeaking→false useEffect also does this, but being explicit
          // here eliminates the race where the effect fires before activeRef updates.
          if (activeRef.current) beginListeningRef.current();
        }
      } catch (err) {
        console.error('[voice-conversation] reply failed', err);
        optionsRef.current.onError?.(err);
        busyRef.current = false;
        if (activeRef.current) {
          beginListeningRef.current();
        }
      }
    })();
  };

  const start = useCallback(
    async (intro?: string) => {
      activeRef.current = true;
      pausedRef.current = false;
      busyRef.current = false;
      setIsActive(true);
      if (intro) {
        await say(intro);
      } else {
        beginListening();
      }
    },
    [say, beginListening],
  );

  const stop = useCallback(() => {
    activeRef.current = false;
    pausedRef.current = false;
    busyRef.current = false;
    bufferRef.current = '';
    clearSilenceTimer();
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
    cancel();
    stopRecognition();
    setLiveText('');
    setIsActive(false);
    setStatus('idle');
  }, [cancel, stopRecognition]);

  useEffect(() => stop, [stop]);

  return {
    status,
    isActive,
    isPaused: status === 'paused',
    isSpeaking,
    isListening,
    liveText,
    isSupported,
    start,
    stop,
    say,
  };
}
