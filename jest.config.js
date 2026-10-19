module.exports = {
    testEnvironment: 'node',
    roots: ['<rootDir>/test/'],
    testMatch: ['**/?(*.)+(test|spec).ts'],
    transform: {
        '^.+[.]yaml$': '<rootDir>/test/yamlTransformer.cjs',
        '^.+[.]tsx?$': ['ts-jest', { tsconfig: 'tsconfig.spec.json' }],
    },
};
