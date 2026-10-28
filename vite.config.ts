import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // In dev mode, proxy /api/voice-tts → local Piper service so CORS is never
  // an issue and the frontend doesn't need to know the Piper port directly.
  const voiceServiceUrl = env.VITE_VOICE_SERVICE_URL?.trim().replace(/\/+$/, '');

  return {
    server: {
      host: "::",
      port: 8080,
      proxy: voiceServiceUrl
        ? {
            '/api/voice-tts': {
              target: voiceServiceUrl,
              changeOrigin: true,
              rewrite: (p) => p.replace(/^\/api\/voice-tts/, ''),
            },
          }
        : undefined,
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalizedId = id.replace(/\\/g, '/');
            if (
              normalizedId.includes('/node_modules/tesseract.js/') ||
              normalizedId.includes('/node_modules/tesseract.js-core/')
            ) {
              return 'ocr';
            }
          },
        },
      },
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
