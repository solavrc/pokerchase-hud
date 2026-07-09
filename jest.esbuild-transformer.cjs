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

// 行頭（カラム0）の呼び出しのみ抽出する。esbuildの整形出力ではトップレベル文は
// インデントされないため、describe/it内やコールバック内のjest.mock()（ブロック
// スコープのモック）はインデントされており対象外になる。それらをモジュール
// スコープへ巻き上げるとモックの適用範囲が変わってしまう。
const TOP_LEVEL_MOCK_CALL = /^_getJestObj\(\)\.mock\(/m

const extractTopLevelMocks = code => {
  const mocks = []
  let output = code
  let match = TOP_LEVEL_MOCK_CALL.exec(output)

  while (match) {
    const { statement, endIndex } = extractStatement(output, match.index)
    mocks.push(statement)
    output = output.slice(0, match.index) + output.slice(endIndex)
    match = TOP_LEVEL_MOCK_CALL.exec(output)
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

// jest.mock()呼び出し（とmock変数宣言）は、テスト対象モジュールのrequireより前に
// 実行されなければモックが適用されない。esbuildが自動注入するreact/jsx-runtimeの
// requireも一緒に先頭へ巻き上げ、emit順（jsx-runtimeが先頭に来るか否か）への
// 依存を無くす。mockファクトリは遅延評価のため、jsx_runtimeバインディングが
// ファクトリ実行（= モック対象モジュールのrequire時）より前にあれば十分。
const insertBeforeModuleRequires = (code, statements) => {
  if (statements.length === 0) return code

  const jsxRuntimeRequire = /var import_jsx_runtime = require\("react\/jsx-runtime"\);\n/
  const jsxMatch = jsxRuntimeRequire.exec(code)
  let output = code
  if (jsxMatch) {
    output = output.slice(0, jsxMatch.index) + output.slice(jsxMatch.index + jsxMatch[0].length)
    statements = [jsxMatch[0].trimEnd(), ...statements]
  }

  const insertionIndex = output.search(/^var import_.*require\(/m)
  const index = insertionIndex === -1 ? 0 : insertionIndex
  return `${output.slice(0, index)}${statements.join('\n')}\n${output.slice(index)}`
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
        // Babel 7では isTSX: true がJSXパースも有効化する（syntax-jsxの併用は不要）
        ['@babel/plugin-syntax-typescript', { isTSX: isTsx }]
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
      // 計装（--coverage）の有無で変換結果が異なるためキーに含める。
      // 含めないと通常実行のキャッシュがcoverage実行で再利用され得る
      .update(transformOptions.instrument ? 'instrument' : 'no-instrument')
      .update(__filename)
      .digest('hex')
  }
}
