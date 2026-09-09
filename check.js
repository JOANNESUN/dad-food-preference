// Extracts the inline <script> from public/index.html and parses it, so a
// broken edit fails here instead of shipping a blank app.
const fs = require("fs"), vm = require("vm");
const html = fs.readFileSync("public/index.html", "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error("no inline script found"); process.exit(1); }
try { new vm.Script(m[1]); } catch (e) { console.error("index.html script: " + e.message); process.exit(1); }
console.log("index.html script parses");
