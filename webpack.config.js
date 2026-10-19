const path = require('node:path');
const fs = require('node:fs');
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
            { test: /\.yaml$/, type: 'asset/source' },
            {
                test: /\.ts$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
        ],
    },
    plugins: [
        {
            apply(compiler) {
                compiler.hooks.thisCompilation.tap('OperateApiNotices', (compilation) => {
                    compilation.hooks.processAssets.tap({
                        name: 'OperateApiNotices', stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
                    }, () => {
                        for (const file of ['LICENSE.txt', 'GENERATOR-LICENSE.txt', 'README.md', 'operate-openapi.yaml']) {
                            compilation.emitAsset(`operate-8.7/${file}`, new webpack.sources.RawSource(
                                fs.readFileSync(path.resolve(__dirname, 'resources/operate-8.7', file)),
                            ));
                        }
                    });
                });
            },
        },
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
