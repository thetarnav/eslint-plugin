const eslint = require("@typescript-eslint/utils")
const ts     = require("typescript")

/** 
 @param {ts.Type     } type 
 @param {ts.TypeFlags} flag 
 @returns {boolean}
*/
function returnTypeEquals(type, flag) {
	if (type.flags === ts.TypeFlags.Any) return true

	/* if is an union, check all types */
	if (type.isUnion()) {
		for (const component of type.types) {
			if (!returnTypeEquals(component, flag)) return false
		}
		return true
	}

	const call_signatures = type.getCallSignatures()
	if (call_signatures.length === 0) return false

	for (const call_signature of call_signatures) {
		const return_type = call_signature.getReturnType()

		if (return_type.isUnion() || return_type.flags !== flag) return false
	}

	return true
}

/**
 @param {eslint.TSESTree.Node} node
 @param {ts.TypeChecker} checker
 @param {eslint.ParserServices} services
 @returns {ts.Type}
*/
function getType(node, checker, services) {
	return checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node))
}

/** @type {Record<string, Set<string>>} */
const MUTATING_METHODS = {
	Array: new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse"]),
	Map: new Set(["set", "delete"]),
	Set: new Set(["add", "delete"]),
}

const no_ignored_return = eslint.ESLintUtils.RuleCreator.withoutDocs({
	meta: {
		type: "problem",
		schema: [],
		messages: {
			use_return_value:
				"Return value from function with non-void return type should be used.",
		},
	},
	defaultOptions: [],
	create(ctx) {
		const services = ctx.sourceCode.parserServices

		if (!services.program) return {}

		const checker = services.program.getTypeChecker()

		return {
			CallExpression(node) {

				/** @type {eslint.TSESTree.Expression} */
				let callee = node.callee
				const parent = node.parent

				/*
                For <object>.call() and <object>.apply() use the <object> type instead
                as the return type for callee will be `any` for some reason
                */
				if (
					callee.type === eslint.AST_NODE_TYPES.MemberExpression &&
					callee.property.type === eslint.AST_NODE_TYPES.Identifier &&
					(callee.property.name === "apply" || callee.property.name === "call")
				) {
					callee = callee.object
				}

				/* focus only on expresion statements */
				if (
					parent.type !== eslint.AST_NODE_TYPES.ExpressionStatement &&
					/* `a() && b()` case */
					(parent.type !== eslint.AST_NODE_TYPES.LogicalExpression ||
						parent.parent.type !== eslint.AST_NODE_TYPES.ExpressionStatement)
				) {
					return
				}

				const type = getType(callee, checker, services)
				if (
					returnTypeEquals(type, ts.TypeFlags.Void) ||
					returnTypeEquals(type, ts.TypeFlags.Never)
				) {
					return
				}

				/*
                Exclude mutating array methods
                */
				if (
					callee.type === eslint.AST_NODE_TYPES.MemberExpression &&
					callee.property.type === eslint.AST_NODE_TYPES.Identifier
				) {
					const obj_type = getType(callee.object, checker, services)
					if (
						// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
						!obj_type.symbol ||
						MUTATING_METHODS[obj_type.symbol.name]?.has(callee.property.name)
					)
						return
				}

				ctx.report({node, messageId: "use_return_value"})
			},
		}
	},
})

const no_return_to_void = eslint.ESLintUtils.RuleCreator.withoutDocs({
	meta: {
		type: "problem",
		schema: [],
		messages: {
			no_return_to_void:
				"This callback is expected to not return anything, but it returns a value.",
		},
	},
	defaultOptions: [],
	create(ctx) {
		const services = ctx.sourceCode.parserServices

		if (!services.program) return {}

		const checker = services.program.getTypeChecker()

		/** @type {eslint.TSESLint.RuleFunction<eslint.TSESTree.ArrowFunctionExpression | eslint.TSESTree.FunctionExpression>} */
		const handleFunction = node => {
			const {parent} = node
			if (parent.type !== eslint.AST_NODE_TYPES.CallExpression) return

			const arg_index = parent.arguments.indexOf(node)
			if (arg_index === -1) return

			const callee_ts_node = services.esTreeNodeToTSNodeMap.get(parent)
			if (!ts.isCallLikeExpression(callee_ts_node)) return

			/* Care only about the active call signature */
			const call_signature = checker.getResolvedSignature(callee_ts_node)
			if (!call_signature) return

			const arg = call_signature.getParameters()[arg_index]
			if (!arg) return

			const arg_type = arg.valueDeclaration
			if (!arg_type) return

			const arg_return_type = checker.getTypeAtLocation(arg_type)
			if (!returnTypeEquals(arg_return_type, ts.TypeFlags.Void)) return

			const type = getType(node, checker, services)
			if (returnTypeEquals(type, ts.TypeFlags.Void)) return

			ctx.report({node, messageId: "no_return_to_void"})
		}

		return {
			ArrowFunctionExpression: handleFunction,
			FunctionExpression: handleFunction,
		}
	},
})

const no_unnecessary_instanceof = eslint.ESLintUtils.RuleCreator.withoutDocs({
	meta: {
		type: "problem",
		schema: [],
		messages: {
			not_a_union: "Left side of `instanceof` should be a union type.",
			not_a_class: "Right side of `instanceof` should be a class.",
			no_unnecessary_instanceof:
				"Values tested with `instanceof` should have a union type including the tested class as a member.",
		},
	},
	defaultOptions: [],
	create(ctx) {
		const services = ctx.sourceCode.parserServices
		if (!services.program) return {}

		const checker = services.program.getTypeChecker()

		return {
			BinaryExpression(node) {
				if (node.operator !== "instanceof") return

				const left_type = getType(node.left, checker, services)
				if (left_type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return

				if (!left_type.isUnion()) {
					ctx.report({node: node.left, messageId: "not_a_union"})
					return
				}

				const right_type = getType(node.right, checker, services)
				if (left_type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return

				const constructs = right_type.getConstructSignatures()
				if (constructs.length === 0) {
					ctx.report({node: node.right, messageId: "not_a_class"})
					return
				}

				for (const c of constructs) {
					const ct = c.getReturnType()

					for (const ut of left_type.types) {
						if (
							ut.symbol === ct.symbol &&
							// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
							ut.symbol !== undefined
						) {
							return
						}
					}
				}

				ctx.report({node, messageId: "no_unnecessary_instanceof"})
			},
		}
	},
})

const rules = {
	"no-ignored-return": no_ignored_return,
	"no-return-to-void": no_return_to_void,
	/** @deprecated */
	"require-instanceof-member": no_unnecessary_instanceof,
	"no-unnecessary-instanceof": no_unnecessary_instanceof,
}

module.exports = rules
