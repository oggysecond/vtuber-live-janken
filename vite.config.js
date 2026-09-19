import { defineConfig } from "vite";
import { jankenRelay } from "./relay-plugin.js";

export default defineConfig({
  base: "./",
  plugins: [jankenRelay()],
  server: {
    host: true,
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
  },
});
