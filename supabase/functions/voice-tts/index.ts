/**
 * voice-tts — Piper TTS Edge Function
 *
 * POST body: { text: string, voice_id?: string, persona?: string, speed?: number }
 *
 * Proxies synthesis and voice catalogue requests to Piper. Missing or
 * unavailable Piper is reported as an error, never as browser-speech fallback.
 *
 * Required secret (for Piper path):  PIPER_SERVICE_URL   e.g. http://your-host:8001
 * Optional secret:                   PIPER_API_KEY       bearer token matching voice-service API_SECRET_KEY
 *
 * Persona → gender mapping (preserved from previous ElevenLabs implementation):
 *   lusy / female / lucy  →  en_female  (HFC Female — female, American English)
 *   amds / siddu / male   →  en_male    (HFC Male   — male,   American English)
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PERSONA_VOICE_IDS: Record<string, string> = {
  female: "en_female",
  lusy: "en_female",
  lucy: "en_female",
  male: "en_male",
  amds: "en_male",
  siddu: "en_male",
};

const personaToVoiceId = (persona: string): string | undefined =>
  PERSONA_VOICE_IDS[persona.toLowerCase()];

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (req.method === "GET" && new URL(req.url).pathname.endsWith("/voices")) {
      const serviceUrl = Deno.env.get("PIPER_SERVICE_URL")?.replace(/\/$/, "");
      if (!serviceUrl) {
        return new Response(JSON.stringify({ error: "Piper voice service is not configured." }), {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const voicesResp = await fetch(`${serviceUrl}/voices`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!voicesResp.ok) {
        console.error(`[voice-tts] Piper catalogue request failed: ${voicesResp.status}`);
        return new Response(JSON.stringify({ error: "Piper voice catalogue is unavailable." }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(voicesResp.body, {
        headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => null);
    const text: string   = typeof body?.text     === "string" ? body.text.trim()     : "";
    const persona: string = typeof body?.persona === "string" ? body.persona.trim() : "female";
    const mappedVoiceId = personaToVoiceId(persona);
    const voiceId: string = typeof body?.voice_id === "string" ? body.voice_id
                            : mappedVoiceId || "";
    const speed: number  = typeof body?.speed === "number"
      ? Math.min(2.0, Math.max(0.5, body.speed))
      : 1.0;

    if (!text) {
      return new Response(JSON.stringify({ error: "text is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (text.length > 4000) {
      return new Response(JSON.stringify({ error: "text too long (max 4000 chars)" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!mappedVoiceId && typeof body?.voice_id !== "string") {
      return new Response(JSON.stringify({ error: `Unknown voice persona: ${persona}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const PIPER_SERVICE_URL = Deno.env.get("PIPER_SERVICE_URL")?.replace(/\/$/, "");

    if (!PIPER_SERVICE_URL) {
      console.error("[voice-tts] PIPER_SERVICE_URL is not configured");
      return new Response(JSON.stringify({ error: "Piper voice service is not configured." }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Proxy to Piper voice service ───────────────────────────────────────
    const PIPER_API_KEY = Deno.env.get("PIPER_API_KEY") || "";

    const piperHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (PIPER_API_KEY) {
      piperHeaders["Authorization"] = `Bearer ${PIPER_API_KEY}`;
    }

    console.log(`[voice-tts] persona=${persona} voice=${voiceId} chars=${text.length} speed=${speed}`);

    const piperResp = await fetch(`${PIPER_SERVICE_URL}/synthesize`, {
      method: "POST",
      headers: piperHeaders,
      body: JSON.stringify({ text, voice_id: voiceId, persona, speed }),
      signal: AbortSignal.timeout(25_000), // 25-second max
    });

    if (!piperResp.ok) {
      const errText = await piperResp.text();
      console.error(`[voice-tts] Piper service error ${piperResp.status}:`, errText.slice(0, 300));

      if (piperResp.status === 503) {
        // Model not yet downloaded — tell the client
        return new Response(
          JSON.stringify({ error: "Voice model is not yet installed on the server." }),
          { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ error: `Piper service returned HTTP ${piperResp.status}.` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Stream the WAV audio back to the browser
    return new Response(piperResp.body, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "audio/wav",
        "Cache-Control": "no-store",
        "X-Voice-Id": voiceId,
        "X-Persona": persona,
      },
    });
  } catch (err) {
    console.error("[voice-tts] unhandled error:", err);
    return new Response(JSON.stringify({ error: "Unexpected TTS error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
