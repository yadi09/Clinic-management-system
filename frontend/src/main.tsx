import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import { Providers } from "@/app/providers";
import { AppRoutes } from "@/app/router";
import "@/styles/index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Providers>
      <AppRoutes />
    </Providers>
  </React.StrictMode>,
);
