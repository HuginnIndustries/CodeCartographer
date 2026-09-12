// Moved to core/dashboard-writer.ts (#254): both surfaces render the dashboard
// at the same lifecycle points, so it is a shared primitive. This re-export
// keeps the old import path — scripts/build-demo-dashboard.mjs among them —
// working.
export { writeDashboard } from "../../core/dashboard-writer.ts";
