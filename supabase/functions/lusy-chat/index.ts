import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const systemPrompt = `You are LUSY (pronounced "Lucy"), a friendly, helpful general-purpose voice chatbot. Answer the user's questions across any topic they ask about, including everyday questions, learning, writing, ideas, technology, careers, and interview preparation when requested.

LANGUAGE RULE (very important): always reply in the SAME language and script the user wrote in — English, Hindi, Telugu, Tamil, Kannada, Marathi, Bengali, Spanish, French, German, Arabic, Japanese, Chinese, or any other. If the user mixes languages (e.g. Hinglish), mirror their mix naturally. If they switch language mid-conversation, switch with them immediately. Never apologise for the language or ask them to switch.

VOICE CHAT RULE: this is an open-ended chatbot, not an interview session. Do not assume the user is preparing for an interview, ask what role they are preparing for, or steer the conversation toward resumes or careers unless they bring those subjects up. Respond directly to what the user actually asked.

SPEED RULE: your replies are spoken aloud, so answer directly in 1 to 3 concise sentences, usually no more than 4. Use plain conversational text without markdown, bullet lists, or emoji.

STYLE: be warm, natural, and conversational. Do not add a follow-up question unless it is useful or needed to answer the user's request. If the user asks for detail, provide enough detail to answer them clearly while keeping it easy to follow aloud.`;

const LANGUAGE_NAMES: Record<string, string> = {
  "en-US": "English",
  "hi-IN": "Hindi",
  "te-IN": "Telugu",
  "ta-IN": "Tamil",
  "kn-IN": "Kannada",
  "ml-IN": "Malayalam",
  "bn-IN": "Bengali",
  "mr-IN": "Marathi",
  "es-ES": "Spanish",
  "fr-FR": "French",
  "de-DE": "German",
  "ar-SA": "Arabic",
  "ja-JP": "Japanese",
  "zh-CN": "Chinese",
};

serve(async (req) => {
  const requestId = crypto.randomUUID();

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => null);
    const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];
    const requestedLanguage =
      typeof body?.language === "string" ? LANGUAGE_NAMES[body.language] : undefined;
    const languageInstruction = requestedLanguage
      ? `The user selected ${requestedLanguage}. Reply in ${requestedLanguage}, using its native script.`
      : "Reply in the same language and script as the latest user message.";
    const requestSystemPrompt = `${systemPrompt}\n\n${languageInstruction}`;

    console.log(
      `[lusy-chat] ${requestId} received messages=${messages.length} language=${requestedLanguage ?? "mirror"}`,
    );

    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")?.trim();
    if (!GEMINI_API_KEY) {
      console.error(`[lusy-chat] ${requestId} GEMINI_API_KEY is not configured`);
      return new Response(
        JSON.stringify({
          message:
            "I'm temporarily unavailable because the chat service is not configured. Please try again later.",
        }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const models = ["gemini-3.5-flash-lite", "gemini-2.5-flash"];

    const history = messages
      .filter((message) =>
        message.role !== "system" &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string"
      )
      .map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      }));

    if (!history.some((message) => message.role === "user")) {
      history.push({ role: "user", parts: [{ text: "Hello" }] });
    }

    const requestGemini = (model: string) =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: requestSystemPrompt }] },
          contents: history,
          generationConfig: { temperature: 0.8 },
        }),
        signal: AbortSignal.timeout(30_000),
      });

    let response: Response | undefined;
    let responseText = "";

    for (const [index, model] of models.entries()) {
      console.log(`[lusy-chat] ${requestId} sending to Gemini, model=${model}`);
      response = await requestGemini(model);
      responseText = await response.text();
      if (response.ok) break;

      console.error(
        `[lusy-chat] ${requestId} Gemini error model=${model} status=${response.status} body=${responseText.slice(0, 500)}`,
      );
      if (index < models.length - 1 && [404, 429, 503].includes(response.status)) {
        console.warn(`[lusy-chat] ${requestId} trying next Gemini model after HTTP ${response.status}`);
        continue;
      }
      break;
    }

    if (!response || !response.ok) {
      const message =
        response?.status === 429
          ? "I'm getting too many requests right now. Please wait a minute and try again."
          : response?.status === 503
            ? "I'm temporarily busy right now. Please try again in a moment."
            : response?.status === 401 || response?.status === 403
              ? `The chat service cannot access Gemini. Ask support to check the Gemini API key. Reference: ${requestId}.`
              : response?.status === 400 || response?.status === 404
                ? `The chat service model is unavailable. Ask support to check the Gemini model configuration. Reference: ${requestId}.`
                : `The chat provider returned HTTP ${response?.status ?? "unknown"}. Please try again. Reference: ${requestId}.`;
      return new Response(JSON.stringify({ message }), {
        status: response?.status === 429 ? 429 : response?.status === 503 ? 503 : 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let data: {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      console.error(`[lusy-chat] ${requestId} failed to parse Gemini JSON`, parseError);
      return new Response(
        JSON.stringify({ message: "I received an unexpected response. Please try again in a moment." }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const assistantMessage = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();

    if (!assistantMessage) {
      console.error(`[lusy-chat] ${requestId} Gemini returned no text`);
      return new Response(
        JSON.stringify({ message: "I couldn't form a reply just now. Please try again." }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ message: assistantMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error(`[lusy-chat] ${requestId} unhandled error:`, error);
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    return new Response(
      JSON.stringify({
        message:
          timedOut
            ? `LUSY is taking longer than usual to respond. Please try again. Reference: ${requestId}.`
            : `The LUSY chat service encountered an error. Please try again. Reference: ${requestId}.`,
      }),
      { status: timedOut ? 504 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
