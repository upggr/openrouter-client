import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
	{ ignores: ['out/**', 'node_modules/**', '.vscode-test/**', 'media/**', 'scripts/**'] },
	{
		files: ['src/**/*.ts'],
		languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
		plugins: { '@typescript-eslint': tsPlugin },
		rules: {
			'@typescript-eslint/naming-convention': ['warn', { selector: 'import', format: ['camelCase', 'PascalCase'] }],
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
			curly: 'error',
			eqeqeq: 'error',
			'no-throw-literal': 'error',
			semi: 'error',
		},
	},
];
