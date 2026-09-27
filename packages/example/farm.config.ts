import { defineConfig } from '@farmfe/core';

export default defineConfig({
  plugins: ['@farmfe/plugin-react'],
  compilation: {
    input: {
      index: './index.html',
      peer: './peer.html',
    },
    presetEnv: false,
  },
});
