export type PiperVoiceId = 'en_female' | 'en_male';

export interface LanguageVoice {
  lang: string;
}

export function findVoiceForLanguage<T extends LanguageVoice>(
  voices: readonly T[],
  language: string,
): T | undefined {
  const normalizedLanguage = language.toLowerCase();
  const exactMatch = voices.find(voice => voice.lang.toLowerCase() === normalizedLanguage);
  if (exactMatch) return exactMatch;

  const baseLanguage = normalizedLanguage.split('-')[0];
  return voices.find(voice => voice.lang.toLowerCase().split('-')[0] === baseLanguage);
}

const PERSONA_VOICE_IDS: Record<string, PiperVoiceId> = {
  amds: 'en_male',
  siddu: 'en_male',
  lusy: 'en_female',
  lucy: 'en_female',
  male: 'en_male',
  female: 'en_female',
};

export function resolvePiperVoiceId(
  persona?: string,
  requestedVoiceId?: PiperVoiceId,
): PiperVoiceId {
  const normalizedPersona = persona?.trim().toLowerCase();
  const personaVoiceId = normalizedPersona ? PERSONA_VOICE_IDS[normalizedPersona] : undefined;
  const isFixedPersona = normalizedPersona
    ? ['amds', 'siddu', 'lusy', 'lucy'].includes(normalizedPersona)
    : false;

  if (isFixedPersona && personaVoiceId) return personaVoiceId;
  return requestedVoiceId ?? personaVoiceId ?? 'en_female';
}

export function isPiperWav(data: ArrayBuffer): boolean {
  const header = new Uint8Array(data, 0, Math.min(data.byteLength, 12));
  return (
    header.length === 12 &&
    String.fromCharCode(...header.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...header.slice(8, 12)) === 'WAVE'
  );
}

export interface VoiceTtsEndpoints {
  provider: 'local' | 'supabase';
  synthesizeUrl: string;
  voicesUrl: string;
}

export function getVoiceTtsEndpoints(
  supabaseUrl: string,
  voiceServiceUrl?: string,
  isDevelopment = false,
): VoiceTtsEndpoints {
  const localBaseUrl = voiceServiceUrl?.trim().replace(/\/+$/, '');
  if (isDevelopment && localBaseUrl) {
    // Use the Vite dev-server proxy path (/api/voice-tts → localhost:PORT)
    // so the browser never makes a direct cross-origin request to localhost:PORT.
    // This avoids CORS issues regardless of the voice service's ALLOWED_ORIGINS.
    return {
      provider: 'local',
      synthesizeUrl: '/api/voice-tts/synthesize',
      voicesUrl: '/api/voice-tts/voices',
    };
  }

  const edgeFunctionUrl = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/voice-tts`;
  return {
    provider: 'supabase',
    synthesizeUrl: edgeFunctionUrl,
    voicesUrl: `${edgeFunctionUrl}/voices`,
  };
}
