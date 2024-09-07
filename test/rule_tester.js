const {RuleTester} = require("@typescript-eslint/rule-tester")
const path         = require("node:path")
const t            = require("node:test")

RuleTester.afterAll = t.after
RuleTester.describe = t.describe
RuleTester.it       = t.it
RuleTester.itOnly   = t.it.only

module.exports = new RuleTester({
	parser: "@typescript-eslint/parser",
	parserOptions: {
		project: path.resolve(__dirname, "resources", "tsconfig.json"),
		tsconfigRootDir: path.resolve(__dirname, "resources"),
	},
})
