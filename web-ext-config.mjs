export default {
  verbose: true,
  ignoreFiles: [
    "ariang-git/**",
    "node_modules/**",
    "web-ext-config.mjs",
    ".git/**",
    ".vscode/**",
  ],
  build: { overwriteDest: true },
  sign: {
    apiKey: "user:19967361:132",
    apiSecret:
      "68132d48b9be391f793aec93033c8d8442046157a37735cdb475f9fe968567dd",
  },
};
