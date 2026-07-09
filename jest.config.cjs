module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.{ts,tsx}'],
  transform: {
    // babel-jest標準経路: babel-preset-jest（jest.mock巻き上げ）・キャッシュキー・
    // カバレッジ計装（canInstrument）はbabel-jest本体の実装に任せる。
    // Node 18+はES2022を直接実行できるため構文の下方変換（preset-env）は不要で、
    // TS/JSXの除去とESM→CJS変換のみ行う
    '^.+\\.tsx?$': ['babel-jest', {
      babelrc: false,
      configFile: false,
      presets: [
        '@babel/preset-typescript',
        ['@babel/preset-react', { runtime: 'automatic' }]
      ],
      plugins: [
        '@babel/plugin-transform-modules-commonjs',
        '@babel/plugin-transform-dynamic-import'
      ]
    }]
  },
  setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy'
  },
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/test-setup.ts',
    '!src/tools/**'
  ]
}
