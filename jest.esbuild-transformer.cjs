const esbuild = require('esbuild')
const babel = require('@babel/core')
const crypto = require('crypto')

const extractStatement = (code, startIndex) => {
  let depth = 0
  let quote = null
  let escaped = false

  for (let index = startIndex; index < code.length; index += 1) {
    const char = code[index]
    const next = code[index + 1]

    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }

    if (char === '(' || char === '{' || char === '[') depth += 1
    if (char === ')' || char === '}' || char === ']') depth -= 1

    if (char === ';' && depth === 0) {
      return {
        statement: code.slice(startIndex, index + 1),
        endIndex: next === '\n' ? index + 2 : index + 1
      }
    }
  }

  return {
    statement: code.slice(startIndex),
    endIndex: code.length
  }
}

const extractTopLevelMocks = code => {
  const mocks = []
  let output = code
  let startIndex = output.indexOf('_getJestObj().mock(')

  while (startIndex !== -1) {
    const { statement, endIndex } = extractStatement(output, startIndex)
    mocks.push(statement)
    output = output.slice(0, startIndex) + output.slice(endIndex)
    startIndex = output.indexOf('_getJestObj().mock(')
  }

  return { code: output, mocks }
}

const extractMockVariables = code => {
  const declarations = []
  const pattern = /^(?:const|let|var)\s+mock[A-Za-z0-9_$]*\s*=.*;\n/gm
  const output = code.replace(pattern, declaration => {
    declarations.push(declaration.trimEnd())
    return ''
  })

  return { code: output, declarations }
}

const insertBeforeModuleRequires = (code, statements) => {
  if (statements.length === 0) return code

  const jsxRuntimeRequire = /var import_jsx_runtime = require\("react\/jsx-runtime"\);\n/
  const jsxMatch = jsxRuntimeRequire.exec(code)
  const insertionIndex = jsxMatch
    ? jsxMatch.index + jsxMatch[0].length
    : code.search(/^var import_.*require\(/m)

  const index = insertionIndex === -1 ? 0 : insertionIndex
  return `${code.slice(0, index)}${statements.join('\n')}\n${code.slice(index)}`
}

const preserveJestMockOrder = code => {
  const { code: withoutMocks, mocks } = extractTopLevelMocks(code)
  const { code: withoutMockVariables, declarations } = extractMockVariables(withoutMocks)

  return insertBeforeModuleRequires(withoutMockVariables, [...declarations, ...mocks])
}

module.exports = {
  process(sourceText, sourcePath) {
    const loader = sourcePath.endsWith('.tsx') ? 'tsx' : 'ts'
    const isTsx = loader === 'tsx'
    const hoisted = babel.transformSync(sourceText, {
      filename: sourcePath,
      babelrc: false,
      configFile: false,
      plugins: [
        'babel-plugin-jest-hoist',
        ['@babel/plugin-syntax-typescript', { isTSX: isTsx }],
        '@babel/plugin-syntax-jsx'
      ]
    })?.code ?? sourceText

    const { code, map } = esbuild.transformSync(hoisted, {
      loader,
      format: 'cjs',
      target: 'es2022',
      sourcemap: 'inline',
      sourcefile: sourcePath,
      jsx: 'automatic',
      define: {
        'process.env.NODE_ENV': '"test"'
      },
      supported: {
        'dynamic-import': false
      }
    })

    return { code: preserveJestMockOrder(code), map }
  },

  getCacheKey(sourceText, sourcePath, transformOptions) {
    return crypto
      .createHash('sha256')
      .update(sourceText)
      .update(sourcePath)
      .update(transformOptions.configString)
      .update(__filename)
      .digest('hex')
  }
}
