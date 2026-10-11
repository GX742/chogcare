import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/manrope";
import "./styles.css";
import "./landing.css";

// Deposit checkout never connects, reconnects or asks an injected wallet to sign.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
