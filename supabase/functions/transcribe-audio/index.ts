/**
 * transcribe-audio — OpenAI Whisper speech-to-text Edge Function
 *
 * POST multipart/form-data:
 *   audio  : audio file (webm, mp4, mp3, wav, ogg, m4a — max 25 MB)
 *   language? : BCP-47 hint e.g. "en", "hi" (optional — Whisper auto-detects)
 *
 * Returns: { text: string, language?: string, duration?: number }
 *
 * Required secret: OPENAI_API_KEY
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — Whisper hard limit
const SUPPORTED_TYPES = new Set([
  "audio/webm",
  "audio/webm;codecs=opus",
  "audio/ogg",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/m4a",
  "video/webm", // Chrome records as video/webm but contains audio
]);

function isSupported(mime: string): boolean {
  const base = mime.split(";")[0].trim().toLowerCase();
  return SUPPORTED_TYPES.has(mime.toLowerCase()) || SUPPORTED_TYPES.has(base);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  if (!OPENAI_API_KEY) {
    console.error("[transcribe-audio] OPENAI_API_KEY is not configured");
    return new Response(
      JSON.stringify({ error: "Transcription service not configured. Please add OPENAI_API_KEY to Edge Function secrets." }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const contentType = req.headers.get("content-type") || "";

    // Accept multipart/form-data (preferred) or raw audio body
    let audioBlob: Blob;
    let audioType: string;
    let languageHint: string | null = null;

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const audioField = form.get("audio");
      if (!audioField || !(audioField instanceof File)) {
        return new Response(
          JSON.stringify({ error: "Missing 'audio' field in form data" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      audioBlob = audioField;
      audioType = audioField.type || "audio/webm";
      languageHint = typeof form.get("language") === "string" ? String(form.get("language")) : null;
    } else if (contentType.startsWith("audio/") || contentType.startsWith("video/")) {
      // Raw body upload
      const buf = await req.arrayBuffer();
      audioBlob = new Blob([buf], { type: contentType });
      audioType = contentType;
    } else {
      return new Response(
        JSON.stringify({ error: "Send audio as multipart/form-data with an 'audio' field, or as a raw audio body." }),
        { status: 415, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (audioBlob.size === 0) {
      return new Response(
        JSON.stringify({ error: "Audio file is empty" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (audioBlob.size > MAX_BYTES) {
      return new Response(
        JSON.stringify({ error: `Audio too large (${Math.round(audioBlob.size / 1024 / 1024)} MB). Maximum is 25 MB.` }),
        { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!isSupported(audioType)) {
      console.warn(`[transcribe-audio] Unrecognised MIME type: ${audioType} — sending anyway, Whisper may still handle it`);
    }

    // Map MIME to a filename extension Whisper accepts
    const extMap: Record<string, string> = {
      "audio/webm": "webm",
      "video/webm": "webm",
      "audio/ogg":  "ogg",
      "audio/mp4":  "mp4",
      "audio/mpeg": "mp3",
      "audio/wav":  "wav",
      "audio/x-wav":"wav",
      "audio/m4a":  "m4a",
    };
    const base = audioType.split(";")[0].trim().toLowerCase();
    const ext  = extMap[base] || "webm";

    const whisperForm = new FormData();
    whisperForm.append("file", new File([audioBlob], `recording.${ext}`, { type: audioType }));
    whisperForm.append("model", "whisper-1");
    whisperForm.append("response_format", "verbose_json");
    if (languageHint) whisperForm.append("language", languageHint);

    console.log(`[transcribe-audio] sending ${Math.round(audioBlob.size / 1024)} KB ${ext} to Whisper`);

    const whisperResp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: whisperForm,
    });

    if (!whisperResp.ok) {
      const errBody = await whisperResp.text();
      console.error(`[transcribe-audio] Whisper error ${whisperResp.status}:`, errBody.slice(0, 400));

      if (whisperResp.status === 401) {
        return new Response(
          JSON.stringify({ error: "OpenAI API key invalid or expired" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (whisperResp.status === 429) {
        return new Response(
          JSON.stringify({ error: "OpenAI rate limit reached. Please try again in a moment." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ error: `Whisper returned ${whisperResp.status}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const result = await whisperResp.json();
    const text: string = (result.text || "").trim();
    const detectedLang: string | undefined = result.language;
    const duration: number | undefined = result.duration;

    console.log(`[transcribe-audio] transcribed ${text.length} chars, lang=${detectedLang}, dur=${duration}s`);

    return new Response(
      JSON.stringify({ text, language: detectedLang, duration }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[transcribe-audio] unhandled error:", err);
    return new Response(
      JSON.stringify({ error: "Unexpected transcription error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
