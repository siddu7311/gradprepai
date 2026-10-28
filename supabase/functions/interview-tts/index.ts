import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { text, persona } = await req.json();

    if (!text) {
      throw new Error('Text is required');
    }

    const voiceSettings = persona === 'amds'
      ? { pitch: 0.9, rate: 1.0, gender: 'male' }
      : { pitch: 1.1, rate: 0.95, gender: 'female' };

    return new Response(
      JSON.stringify({
        text,
        voiceSettings,
        persona,
        useWebSpeech: true,
        success: true,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    console.error('TTS Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
