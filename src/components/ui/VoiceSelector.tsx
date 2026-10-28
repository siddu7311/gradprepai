/**
 * VoiceSelector — lets users preview and choose between the Piper male/female
 * voices before an interview.
 *
 * Reads available voices from the voice-tts Edge Function's /voices proxy, or
 * shows a static list when the service is not configured.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Volume2, Loader2, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { getVoiceTtsEndpoints, isPiperWav, type PiperVoiceId } from '@/lib/voiceTts';

export type VoiceGender = 'female' | 'male';
export type { PiperVoiceId } from '@/lib/voiceTts';

interface VoiceOption {
  voice_id: PiperVoiceId;
  name: string;
  gender: VoiceGender;
  language_name: string;
  description: string;
  available: boolean;
  licence: string;
}

// Static fallback catalogue — shown before the service responds or when it
// is unreachable.  Matches what main.py declares.
const STATIC_VOICES: VoiceOption[] = [
  {
    voice_id: 'en_female',
    name: 'HFC Female',
    gender: 'female',
    language_name: 'English (US)',
    description: 'Clear, natural American female voice — warm and articulate.',
    available: true,
    licence: 'MIT',
  },
  {
    voice_id: 'en_male',
    name: 'HFC Male',
    gender: 'male',
    language_name: 'English (US)',
    description: 'Natural, confident American male voice — professional and clear.',
    available: true,
    licence: 'MIT',
  },
];

interface VoiceSelectorProps {
  selected: PiperVoiceId;
  onChange: (voiceId: PiperVoiceId) => void;
  /** If true, show compact cards (for InterviewSetup); otherwise full detail. */
  compact?: boolean;
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
const TTS_ENDPOINTS = getVoiceTtsEndpoints(
  SUPABASE_URL,
  import.meta.env.DEV ? import.meta.env.VITE_VOICE_SERVICE_URL : undefined,
  import.meta.env.DEV,
);

export function VoiceSelector({ selected, onChange, compact = false }: VoiceSelectorProps) {
  const [voices, setVoices] = useState<VoiceOption[]>(STATIC_VOICES);
  const [previewPlaying, setPreviewPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  // Load live voice availability from the selected Piper provider.
  useEffect(() => {
    fetch(TTS_ENDPOINTS.voicesUrl, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: VoiceOption[] | null) => {
        if (Array.isArray(data) && data.length > 0) setVoices(data);
      })
      .catch((error: unknown) => {
        console.error('[VoiceSelector] Could not load Piper voice catalogue:', error);
      });
  }, []);

  const playPreview = useCallback(async (voiceId: PiperVoiceId) => {
    // Stop any currently playing preview
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    if (previewPlaying === voiceId) {
      setPreviewPlaying(null);
      return;
    }

    setPreviewPlaying(voiceId);

    try {
      // Ask the Edge Function for a preview by synthesising the voice's preview text
      const previewTexts: Record<PiperVoiceId, string> = {
        en_female: "Hello! I am Lusy, your AI interview coach. Let's prepare you for success!",
        en_male:   "Hey there! I am Siddu, your AI interviewer. Ready to ace that interview?",
      };

      const resp = await fetch(TTS_ENDPOINTS.synthesizeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({
          text: previewTexts[voiceId],
          voice_id: voiceId,
          persona: voiceId === 'en_male' ? 'siddu' : 'lusy',
          speed: 1.0,
        }),
      });

      if (resp.ok) {
        if (resp.headers.get('x-voice-id') !== voiceId) {
          throw new Error('Piper returned an unexpected voice ID');
        }
        const contentType = resp.headers.get('content-type') || '';
        if (contentType.toLowerCase().includes('audio/wav')) {
          const blob  = await resp.blob();
          if (!isPiperWav(await blob.slice(0, 12).arrayBuffer())) {
            throw new Error('Piper returned an invalid WAV response');
          }
          const url   = URL.createObjectURL(blob);
          audioUrlRef.current = url;
          const audio = new Audio(url);
          audioRef.current = audio;

          audio.onended = () => {
            URL.revokeObjectURL(url);
            audioUrlRef.current = null;
            audioRef.current = null;
            setPreviewPlaying(null);
          };
          audio.onerror = () => {
            URL.revokeObjectURL(url);
            audioUrlRef.current = null;
            audioRef.current = null;
            setPreviewPlaying(null);
            console.error(`[VoiceSelector] Piper preview playback failed voice=${voiceId}`);
            toast.error('Piper voice preview could not be played.');
          };

          await audio.play().catch(() => {
            URL.revokeObjectURL(url);
            audioUrlRef.current = null;
            audioRef.current = null;
            throw new Error('Piper voice preview playback was blocked');
          });
          return;
        }
        throw new Error('Piper returned a non-WAV response');
      }
      throw new Error(`Piper service returned HTTP ${resp.status}`);
    } catch (error) {
      console.error(`[VoiceSelector] Piper preview failed voice=${voiceId}`);
      setPreviewPlaying(null);
      toast.error('Piper voice preview failed. Check that the Piper voice service is available.');
    }
  }, [previewPlaying]);

  // Stop audio on unmount
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  return (
    <div className="space-y-3">
      <div className={`grid gap-3 ${compact ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
        {voices.map((voice) => {
          const isSelected = selected === voice.voice_id;
          const isPreviewing = previewPlaying === voice.voice_id;

          return (
            <button
              key={voice.voice_id}
              type="button"
              onClick={() => onChange(voice.voice_id)}
              className={`relative flex items-start gap-3 rounded-lg border-2 p-4 text-left transition-all
                ${isSelected
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-muted-foreground/50'
                }
                ${!voice.available ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
              `}
              disabled={!voice.available}
              aria-pressed={isSelected}
              aria-label={`Select ${voice.name} voice`}
            >
              {/* Selection indicator */}
              <span className="mt-0.5 shrink-0">
                {isSelected ? (
                  <CheckCircle2 className="h-5 w-5 text-primary" />
                ) : (
                  <span className="block h-5 w-5 rounded-full border-2 border-border" />
                )}
              </span>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-foreground">{voice.name}</span>
                  <Badge variant="secondary" className="text-xs">
                    {voice.gender === 'female' ? '♀ Female' : '♂ Male'}
                  </Badge>
                  <Badge variant="outline" className="text-xs">
                    {voice.language_name}
                  </Badge>
                </div>
                {!compact && (
                  <p className="mt-1 text-sm text-muted-foreground">{voice.description}</p>
                )}
                {!compact && (
                  <p className="mt-1 text-xs text-muted-foreground">Licence: {voice.licence}</p>
                )}
                {!voice.available && (
                  <p className="mt-1 text-xs text-destructive">Model not installed — run setup_models.ps1</p>
                )}
              </div>

              {/* Preview button */}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0 gap-1"
                onClick={(e) => {
                  e.stopPropagation();
                  void playPreview(voice.voice_id);
                }}
                aria-label={isPreviewing ? `Stop ${voice.name} preview` : `Preview ${voice.name}`}
              >
                {isPreviewing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Volume2 className="h-3.5 w-3.5" />
                )}
                {compact ? null : (isPreviewing ? 'Playing…' : 'Preview')}
              </Button>
            </button>
          );
        })}
      </div>
    </div>
  );
}
