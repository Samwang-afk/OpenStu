import solidPlugin from "@opentui/solid/bun-plugin"

const name = process.env.OPENSTU_OUTPUT || `openstu${process.platform === "win32" ? ".exe" : ""}`

await Bun.build({
  entrypoints: ["./src/index.tsx"],
  plugins: [solidPlugin],
  minify: true,
  compile: {
    outfile: `./dist/${name}`,
    autoloadBunfig: false,
  },
})

console.log(`Built dist/${name}`)
