module.exports = (api) => {
  api.cache(true)
  return {
    presets: [
      [
        'babel-preset-expo',
        {
          'react-compiler': {
            // Enable for all files initially
            // Can restrict with: sources: (filename) => filename.includes('src/')
          },
        },
      ],
    ],
    plugins: [
      [
        'react-native-unistyles/plugin',
        {
          root: __dirname,
        },
      ],
      [
        'formatjs',
        {
          // All messages must have explicit IDs matching catalog keys.
          // idInterpolationPattern is intentionally omitted: auto-generated
          // hash IDs would never match the human-readable catalog keys
          // (e.g. 'common.buttons.cancel'), causing silent fallback to
          // defaultMessage for every translated string.
          ast: true,
        },
      ],
    ],
  }
}
