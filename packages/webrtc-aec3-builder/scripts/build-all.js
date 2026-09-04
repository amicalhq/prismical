const { parsePlatform, run } = require("./common");
const path = require("node:path");

const platform = parsePlatform(process.argv);

run("node", [path.join(__dirname, "fetch-checkout.js")]);

if (platform === "windows") {
  run("node", [
    path.join(__dirname, "gen.js"),
    "--platform",
    "windows",
    "--arch",
    "x64",
  ]);
  run("node", [
    path.join(__dirname, "build.js"),
    "--platform",
    "windows",
    "--arch",
    "x64",
  ]);
  run("node", [
    path.join(__dirname, "bundle.js"),
    "--platform",
    "windows",
    "--arch",
    "x64",
  ]);
} else {
  run("node", [
    path.join(__dirname, "gen.js"),
    "--platform",
    "macos",
    "--arch",
    "arm64",
  ]);
  run("node", [
    path.join(__dirname, "gen.js"),
    "--platform",
    "macos",
    "--arch",
    "x64",
  ]);
  run("node", [
    path.join(__dirname, "build.js"),
    "--platform",
    "macos",
    "--arch",
    "arm64",
  ]);
  run("node", [
    path.join(__dirname, "build.js"),
    "--platform",
    "macos",
    "--arch",
    "x64",
  ]);
  run("node", [path.join(__dirname, "bundle.js"), "--platform", "macos"]);
}
