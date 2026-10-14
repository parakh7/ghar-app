import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { drainQueue } from "./lib/offline-queue";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, staleTime: 30_000 }, mutations: { retry: 0 } },
});

window.addEventListener("online", () => void drainQueue(queryClient));
void drainQueue(queryClient);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
