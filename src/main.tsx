import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@glideapps/glide-data-grid/dist/index.css";
import "./styles.css";
import "./app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
