const path = require('node:path');
const webpack = require('webpack');
const packageJson = require('./package.json');

module.exports = {
    target: 'node',
    mode: 'production',
    entry: {
        index: './src/index.ts',
        'bin/camunda-cli': './src/bin/camunda-cli.ts',
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: '[name].js',
        libraryTarget: 'commonjs2',
        clean: true,
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
        ],
    },
    plugins: [
        new webpack.DefinePlugin({
            CAMUNDA_CLI_VERSION: JSON.stringify(packageJson.version),
        }),
        new webpack.BannerPlugin({
            banner: '#!/usr/bin/env node',
            raw: true,
            entryOnly: true,
            include: /bin\/camunda-cli\.js$/,
        }),
    ],
};
