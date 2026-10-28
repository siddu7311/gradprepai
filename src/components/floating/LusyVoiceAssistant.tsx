import { useCallback, useRef, useState } from 'react';
import type { PiperVoiceId } from '@/hooks/useAIVoice';
import { Mic, MicOff, Sparkles, X, ChevronDown } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { useVoiceConversation } from '@/hooks/useVoiceConversation';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface LusyVoiceAssistantProps {
  onClose: () => void;
}

type VoiceMessage = { role: 'user' | 'assistant'; content: string };

// BCP-47 codes supported by the browser's speech-recognition engine.
const LANGUAGES = [
  { label: 'Auto-detect',  code: '',       flag: '🌐' },
  { label: 'English',      code: 'en-US',  flag: '🇺🇸' },
  { label: 'Hindi',        code: 'hi-IN',  flag: '🇮🇳' },
  { label: 'Telugu',       code: 'te-IN',  flag: '🇮🇳' },
  { label: 'Tamil',        code: 'ta-IN',  flag: '🇮🇳' },
  { label: 'Kannada',      code: 'kn-IN',  flag: '🇮🇳' },
  { label: 'Malayalam',    code: 'ml-IN',  flag: '🇮🇳' },
  { label: 'Bengali',      code: 'bn-IN',  flag: '🇮🇳' },
  { label: 'Marathi',      code: 'mr-IN',  flag: '🇮🇳' },
  { label: 'Spanish',      code: 'es-ES',  flag: '🇪🇸' },
  { label: 'French',       code: 'fr-FR',  flag: '🇫🇷' },
  { label: 'German',       code: 'de-DE',  flag: '🇩🇪' },
  { label: 'Arabic',       code: 'ar-SA',  flag: '🇸🇦' },
  { label: 'Japanese',     code: 'ja-JP',  flag: '🇯🇵' },
  { label: 'Chinese',      code: 'zh-CN',  flag: '🇨🇳' },
];

// Languages where Piper's English voice will produce unnatural output.
// We show a note for these so users know what to expect.
const NON_ENGLISH_CODES = new Set(
  LANGUAGES.filter(l => l.code && !l.code.startsWith('en')).map(l => l.code),
);

const GREETINGS: Record<string, string> = {
  '': "Hi! I'm LUSY! How can I help you today?",
  'en-US': "Hi! I'm LUSY! How can I help you today?",
  'hi-IN': 'नमस्ते! मैं लूसी हूँ। आज मैं आपकी कैसे मदद कर सकती हूँ?',
  'te-IN': 'నమస్కారం! నేను లూసీని. ఈరోజు మీకు ఎలా సహాయం చేయగలను?',
  'ta-IN': 'வணக்கம்! நான் லூசி. இன்று நான் உங்களுக்கு எப்படி உதவலாம்?',
  'kn-IN': 'ನಮಸ್ಕಾರ! ನಾನು ಲೂಸಿ. ಇಂದು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಲಿ?',
  'ml-IN': 'നമസ്കാരം! ഞാൻ ലൂസിയാണ്. ഇന്ന് നിങ്ങളെ എങ്ങനെ സഹായിക്കാം?',
  'bn-IN': 'নমস্কার! আমি লুসি। আজ আপনাকে কীভাবে সাহায্য করতে முடியும்?',
  'mr-IN': 'नमस्कार! मी लुसी आहे. आज मी तुम्हाला कशी मदत करू?',
  'es-ES': '¡Hola! Soy LUSY. ¿Cómo puedo ayudarte hoy?',
  'fr-FR': 'Bonjour ! Je suis LUSY. Comment puis-je vous aider aujourd’hui ?',
  'de-DE': 'Hallo! Ich bin LUSY. Wie kann ich dir heute helfen?',
  'ar-SA': 'مرحبًا! أنا لوسي. كيف يمكنني مساعدتك اليوم؟',
  'ja-JP': 'こんにちは！LUSYです。今日はどのようにお手伝いできますか？',
  'zh-CN': '你好！我是 LUSY。今天我能为你做些什么？',
};

export default function LusyVoiceAssistant({ onClose }: LusyVoiceAssistantProps) {
  const [history, setHistory] = useState<VoiceMessage[]>([]);
  const historyRef = useRef<VoiceMessage[]>([]);
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  const [selectedLang, setSelectedLang] = useState(LANGUAGES[0]);
  const [showLangPicker, setShowLangPicker] = useState(false);

  const remember = useCallback((message: VoiceMessage) => {
    historyRef.current = [...historyRef.current, message].slice(-12);
    setHistory(historyRef.current);
  }, []);

  const getReply = useCallback(async (text: string) => {
    const messages = [...historyRef.current, { role: 'user' as const, content: text }];
    remember({ role: 'user', content: text });

    const { data, error } = await supabase.functions.invoke('lusy-chat', {
      body: { messages, language: selectedLang.code },
    });

    // HTTP errors may still include a friendly response body. Never treat that
    // error message as LUSY's reply; surface it through the conversation error path.
    let reply: string | undefined;

    if (error) {
      try {
        const ctx = (error as { context?: unknown }).context;
        if (ctx instanceof Response) {
          const body = await ctx.clone().json().catch(() => null);
          reply = body?.message ?? undefined;
        } else if (ctx && typeof ctx === 'object' && 'message' in ctx) {
          reply = String((ctx as { message: unknown }).message);
        }
      } catch {
        // ignore parse failures
      }
      throw new Error(reply || error.message);
    }

    if (!reply && data?.message) {
      reply = String(data.message);
    }

    if (!reply) {
      throw new Error('LUSY could not respond');
    }

    remember({ role: 'assistant', content: reply });
    return reply;
  }, [remember, selectedLang.code]);

  // Keep the LUSY persona voice for English; non-English voices use the
  // browser's installed voice matching the selected language.
  const LUSY_VOICE_ID: PiperVoiceId = 'en_female';

  const voice = useVoiceConversation({
    persona: 'lusy',
    voiceId: LUSY_VOICE_ID,
    silenceMs: 1100,
    getReply,
    language: selectedLang.code,
    onError: (error) => {
      console.error('[LUSY] Chat request failed:', error);
      const message = error instanceof Error ? error.message : 'Unknown chat service error';
      toast.error(`LUSY could not respond: ${message}`);
    },
  });

  const handleLangSelect = (lang: typeof LANGUAGES[0]) => {
    if (voice.isActive) {
      toast.info('Stop the conversation first to change language.');
      return;
    }
    setSelectedLang(lang);
    setShowLangPicker(false);
  };

  const toggle = async () => {
    if (loading) return;
    if (!user) {
      toast.error('Please sign in to talk with LUSY.');
      navigate('/signin');
      return;
    }
    if (!voice.isSupported) {
      toast.error('Voice conversations are not supported in this browser.');
      return;
    }
    setShowLangPicker(false);
    if (voice.isActive) voice.stop();
    else await voice.start(GREETINGS[selectedLang.code] ?? GREETINGS['en-US']);
  };

  const statusText = voice.status === 'speaking'
    ? 'Speaking — say "stop" anytime'
    : voice.status === 'thinking'
      ? 'Thinking…'
      : voice.status === 'paused'
        ? 'Paused — say "continue"'
        : voice.isActive
          ? `Listening · ${selectedLang.label}`
          : 'Tap to start a hands-free conversation';

  const showVoiceNote = !selectedLang.code || NON_ENGLISH_CODES.has(selectedLang.code);

  return (
    <section
      className="overflow-hidden rounded-lg border border-border bg-card shadow-xl"
      aria-label="LUSY voice assistant"
    >
      {/* Header */}
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Sparkles className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">LUSY</h2>
            <p className="text-xs text-muted-foreground">Multilingual voice assistant</p>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close LUSY">
          <X />
        </Button>
      </header>

      {/* Language picker */}
      <div className="relative border-b border-border px-4 py-2">
        <button
          onClick={() => setShowLangPicker(v => !v)}
          disabled={voice.isActive}
          className="flex w-full items-center justify-between rounded-md px-2 py-1 text-xs hover:bg-muted/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          aria-label="Select spoken language"
        >
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span>{selectedLang.flag}</span>
            <span>{selectedLang.label}</span>
          </span>
          <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${showLangPicker ? 'rotate-180' : ''}`} />
        </button>

        {showLangPicker && (
          <div className="absolute left-0 right-0 top-full z-10 max-h-52 overflow-y-auto border border-border bg-card shadow-lg rounded-b-lg">
            {LANGUAGES.map(lang => (
              <button
                key={lang.code}
                onClick={() => handleLangSelect(lang)}
                className={`flex w-full items-center gap-2 px-4 py-2 text-xs hover:bg-muted/50 transition-colors text-left ${
                  selectedLang.code === lang.code ? 'bg-primary/10 text-primary font-medium' : 'text-foreground'
                }`}
              >
                <span>{lang.flag}</span>
                <span>{lang.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Main area */}
      <div className="flex min-h-52 flex-col items-center justify-center gap-4 p-6 text-center">
        <Button
          size="icon"
          variant={voice.isActive ? 'default' : 'outline'}
          onClick={() => void toggle()}
          disabled={loading}
          className="h-20 w-20 rounded-full"
          aria-label={voice.isActive ? 'End voice conversation' : 'Start voice conversation'}
        >
          {voice.isActive ? <MicOff className="h-8 w-8" /> : <Mic className="h-8 w-8" />}
        </Button>

        <div className="space-y-1">
          <p className="font-medium text-foreground">{statusText}</p>
          {voice.liveText && (
            <p className="line-clamp-2 text-sm text-muted-foreground">"{voice.liveText}"</p>
          )}
          {!voice.liveText && history.length > 0 && (
            <p className="line-clamp-2 text-sm text-muted-foreground">
              {history[history.length - 1].content}
            </p>
          )}
        </div>

        {/* Explain the browser-default recognition mode and multilingual voices. */}
        {showVoiceNote && (
          <p className="text-[11px] text-muted-foreground/70 max-w-[220px] leading-snug">
            {selectedLang.code
              ? `LUSY replies in ${selectedLang.label} using an installed ${selectedLang.label} voice on your device.`
              : 'Auto-detect uses your browser’s default speech language. LUSY replies in the language it recognizes; choose a language above for more accurate recognition.'}
          </p>
        )}
      </div>
    </section>
  );
}
