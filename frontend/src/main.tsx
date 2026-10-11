import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import { installChunkRecovery } from "@/app/chunkRecovery";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { Providers } from "@/app/providers";
import { AppRoutes } from "@/app/router";
import "@/styles/index.css";

installChunkRecovery();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Providers>
        <AppRoutes />
      </Providers>
    </ErrorBoundary>
  </React.StrictMode>,
);
