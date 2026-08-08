import { defineConfig } from "vite";

// GitHub Pages serves project sites under /<repo>/, so production builds need a
// base path — but dev should stay at the root so local URLs stay simple.
// Anything referencing a public/ asset must use import.meta.env.BASE_URL.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/mtg-rotisserie/" : "/",
  // allowedHosts: this dev server is reached over the private Tailscale tailnet
  // (e.g. http://desktop-j05412i:5180 from a phone), so permit the tailnet
  // hostname and any MagicDNS *.ts.net name in addition to localhost.
  server: {
    host: "0.0.0.0",
    port: 5180,
    allowedHosts: ["desktop-j05412i", "localhost", ".ts.net"],
  },
  preview: {
    host: "0.0.0.0",
    port: 5180,
    allowedHosts: ["desktop-j05412i", "localhost", ".ts.net"],
  },
}));
