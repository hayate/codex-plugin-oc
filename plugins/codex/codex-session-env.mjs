export const CodexSessionEnv = async () => {
  return {
    "shell.env": async (input, output) => {
      if (input.sessionID) {
        output.env.CODEX_COMPANION_SESSION_ID = input.sessionID
      }
    }
  }
}
