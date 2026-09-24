import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

export default defineConfig({
  adapter: cloudflare({
    configPath: process.env.SAQI_WRANGLER_CONFIG ?? "wrangler.jsonc",
    imageService: "passthrough",
  }),
  integrations: [react()],
  build: {
    inlineStylesheets: "never",
  },
  output: "server",
  session: false,
  site: "https://saqi.app",
  trailingSlash: "never",
  vite: {
    build: {
      assetsInlineLimit: 0,
    },
  },
});
