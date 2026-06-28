import { chmodSync, copyFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const name = `openstu${process.platform === "win32" ? ".exe" : ""}`
const bin = process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, "bin") : join(homedir(), ".bun", "bin")
const target = join(bin, name)

mkdirSync(bin, { recursive: true })
copyFileSync(join(import.meta.dir, "..", "dist", name), target)
if (process.platform !== "win32") chmodSync(target, 0o755)
console.log(`Installed ${target}`)
