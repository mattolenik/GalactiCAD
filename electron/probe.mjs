import * as eMain from "electron/main"
import * as eCommon from "electron/common"
console.log("electron/main keys:", Object.keys(eMain).slice(0, 30))
console.log("electron/common keys:", Object.keys(eCommon).slice(0, 30))
console.log("default?", typeof eMain.default, eMain.default && Object.keys(eMain.default).slice(0, 10))
process.exit(0)
