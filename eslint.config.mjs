import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        ignores: ['.dev-server/', '.vscode/', '*.test.js', 'test/**/*.js', '*.config.mjs', 'admin/'],
    },
    {
        rules: {
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/require-param-description': 'off',
            'jsdoc/require-returns-description': 'off',
        },
    },
];
