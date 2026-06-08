module.exports = {
    testEnvironment: 'node',
    roots: ['<rootDir>/test/'],
    testMatch: ['**/?(*.)+(test|spec).ts'],
    transform: {
        '^.+[.]tsx?$': ['ts-jest', { tsconfig: 'tsconfig.spec.json' }],
    },
};
