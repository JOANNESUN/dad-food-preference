// Writes a build id that the running app polls, so a phone that keeps the
// home-screen app suspended still picks up a new deploy when reopened.
const fs = require("fs"), { execSync } = require("child_process");
let sha = "";
try { sha = execSync("git rev-parse --short HEAD").toString().trim(); } catch {}
const build = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12)}-${sha || "local"}`;
fs.writeFileSync("public/version.json", JSON.stringify({ build }) + "\n");
console.log("build id " + build);
