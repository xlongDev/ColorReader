import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppRouter } from "@/app/router";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import "@/styles/globals.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root container #root not found");

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary scope="应用">
      <AppRouter />
    </ErrorBoundary>
  </StrictMode>,
);
