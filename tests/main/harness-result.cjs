/* eslint-disable */
/**
 * How an Electron test harness hands its result back (see
 * tests/main/electron-harness.ts): written to the file named by its last
 * argument, synchronously, before the app exits. Not printed: the main
 * process writes stdout to a pipe asynchronously, and app.exit drops what a
 * busy reader has not taken yet, so under load the line came through cut.
 */
const { writeFileSync } = require('fs')

/** The harness's own arguments, without the result file the runner adds last. */
const harnessArgs = (n) => process.argv.slice(-n - 1, -1)

function writeResult(value) {
  writeFileSync(process.argv[process.argv.length - 1], JSON.stringify(value))
}

module.exports = { harnessArgs, writeResult }
