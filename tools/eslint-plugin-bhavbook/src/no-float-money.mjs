// Bans floating-point money handling (ADR-0004, domain.md "Money").
//  1. Calls that coerce or round through IEEE-754 floats: parseFloat, Number.parseFloat, Number(), Math.round, .toFixed().
//  2. With type information: identifiers ending in "Micro" must be typed bigint (optionally | null | undefined).
import ts from 'typescript';

const MICRO_NAME = /Micro$/;

/** @param {any} callee (an ESTree call callee) */
function bannedCallName(callee) {
  if (callee.type === 'Identifier') {
    if (callee.name === 'parseFloat' || callee.name === 'Number') return callee.name;
    return null;
  }
  if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier')
    return null;
  const method = callee.property.name;
  if (method === 'toFixed') return '.toFixed()';
  if (callee.object.type !== 'Identifier') return null;
  const owner = callee.object.name;
  if (owner === 'Number' && method === 'parseFloat') return 'Number.parseFloat';
  if (owner === 'Math' && method === 'round') return 'Math.round';
  return null;
}

/** @param {ts.Type} type */
function isBigintOnly(type) {
  const parts = type.isUnion() ? type.types : [type];
  const nonNullish = parts.filter(
    (part) => (part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) === 0,
  );
  return nonNullish.length > 0 && nonNullish.every((part) => (part.flags & ts.TypeFlags.BigIntLike) !== 0);
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Ban floating-point money handling; *Micro values must be bigint.' },
    schema: [],
    messages: {
      bannedCall:
        '{{name}} goes through floating point. Parse decimal strings to bigint micro-rupees with @bhavbook/core money helpers.',
      microMustBeBigint: '"{{name}}" is a micro-rupee amount and must be typed bigint, not {{type}}.',
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    const hasTypes = Boolean(services && 'program' in services && services.program);

    /** @param {any} node @param {string} name */
    function checkMicro(node, name) {
      if (!hasTypes || !MICRO_NAME.test(name)) return;
      const checker = services.program.getTypeChecker();
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      const type = checker.getTypeAtLocation(tsNode);
      if (isBigintOnly(type)) return;
      context.report({
        node,
        messageId: 'microMustBeBigint',
        data: { name, type: checker.typeToString(type) },
      });
    }

    return {
      CallExpression(node) {
        const name = bannedCallName(node.callee);
        if (name) context.report({ node, messageId: 'bannedCall', data: { name } });
      },
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier') checkMicro(node.id, node.id.name);
      },
      /** @param {any} node */
      'FunctionDeclaration, FunctionExpression, ArrowFunctionExpression'(node) {
        for (const param of node.params) {
          const target = param.type === 'AssignmentPattern' ? param.left : param;
          if (target.type === 'Identifier') checkMicro(target, target.name);
        }
      },
      /** @param {any} node */
      'PropertyDefinition, TSPropertySignature'(node) {
        if (node.key.type === 'Identifier' && !node.computed) checkMicro(node.key, node.key.name);
      },
    };
  },
};

export default rule;
