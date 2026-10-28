import { describe, expect, test } from 'bun:test';
import { findVoiceForLanguage, getVoiceTtsEndpoints } from '../src/lib/voiceTts';

describe('multilingual voice selection', () => {
  const voices = [
    { name: 'English', lang: 'en-US' },
    { name: 'Hindi', lang: 'hi-IN' },
    { name: 'Telugu', lang: 'te-IN' },
  ];

  test('prefers an exact locale match', () => {
    expect(findVoiceForLanguage(voices, 'hi-IN')).toEqual(voices[1]);
  });

  test('matches a language when the installed voice uses another region', () => {
    expect(findVoiceForLanguage(voices, 'te-GB')).toEqual(voices[2]);
  });

  test('does not silently select an English voice for another language', () => {
    expect(findVoiceForLanguage(voices, 'ta-IN')).toBeUndefined();
  });
});

describe('voice TTS provider selection', () => {
  test('uses the Vite proxy path for the local Piper service in development', () => {
    expect(getVoiceTtsEndpoints(
      'https://example.supabase.co/',
      'http://localhost:8001/',
      true,
    )).toEqual({
      provider: 'local',
      synthesizeUrl: '/api/voice-tts/synthesize',
      voicesUrl: '/api/voice-tts/voices',
    });
  });

  test('uses the Supabase proxy when no local service is configured', () => {
    expect(getVoiceTtsEndpoints('https://example.supabase.co/')).toEqual({
      provider: 'supabase',
      synthesizeUrl: 'https://example.supabase.co/functions/v1/voice-tts',
      voicesUrl: 'https://example.supabase.co/functions/v1/voice-tts/voices',
    });
  });

  test('does not embed the local service URL in a production build', () => {
    expect(getVoiceTtsEndpoints(
      'https://example.supabase.co',
      'http://localhost:8001',
      false,
    )).toEqual({
      provider: 'supabase',
      synthesizeUrl: 'https://example.supabase.co/functions/v1/voice-tts',
      voicesUrl: 'https://example.supabase.co/functions/v1/voice-tts/voices',
    });
  });
});
