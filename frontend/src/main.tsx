import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "maplibre-gl/dist/maplibre-gl.css";
import { App } from "./App.js";
import "./styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Missing #root application element");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
