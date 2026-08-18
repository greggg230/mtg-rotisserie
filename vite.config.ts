import { defineConfig } from "vite";

// GitHub Pages serves project sites under /<repo>/, so production builds need a
// base path — but dev should stay at the root so local URLs stay simple.
// Anything referencing a public/ asset must use import.meta.env.BASE_URL.
// `vite preview` serves the built output but runs as command === "serve", so it
// has to opt into the base path too or it 404s every asset in index.html.
export default defineConfig(({ command, isPreview }) => ({
  base: command === "build" || isPreview ? "/mtg-rotisserie/" : "/",
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
