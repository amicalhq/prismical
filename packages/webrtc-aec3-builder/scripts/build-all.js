const { run } = require("./common");

run("node", [require("node:path").join(__dirname, "fetch-checkout.js")]);
run("node", [require("node:path").join(__dirname, "gen.js"), "--arch", "arm64"]);
run("node", [require("node:path").join(__dirname, "gen.js"), "--arch", "x64"]);
run("node", [require("node:path").join(__dirname, "build.js"), "--arch", "arm64"]);
run("node", [require("node:path").join(__dirname, "build.js"), "--arch", "x64"]);
run("node", [require("node:path").join(__dirname, "bundle.js")]);
