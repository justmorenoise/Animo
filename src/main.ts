import "@/styles/theme.css";
import "@/styles/layout.css";
import "@/styles/panels.css";
import "@/styles/timeline.css";
import "@/styles/settings.css";
import { App } from "@/app/App";
import { valueFreeze } from "@/core/doc/freeze";

const root = document.getElementById("app");
if (!root) throw new Error("#app not found");

// Opt-in: see core/doc/freeze.ts.
if (import.meta.env.DEV && localStorage.getItem("animo.freezeValues") === "1") valueFreeze.enabled = true;

const app = new App(root);

// Handy while building; harmless in production.
(window as unknown as Record<string, unknown>).animo = app;
