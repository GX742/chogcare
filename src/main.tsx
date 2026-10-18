import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/manrope";
import "./styles.css";
import "./landing.css";
import App from "./App";

const OpsDashboard = React.lazy(() => import("./OpsDashboard"));
const dashboardPath = window.location.pathname.replace(/\/+$/, "") === "/dashboard";

// Deposit checkout never connects, reconnects or asks an injected wallet to sign.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <React.Suspense fallback={null}>
      {dashboardPath ? <OpsDashboard/> : <App/>}
    </React.Suspense>
  </React.StrictMode>,
);
