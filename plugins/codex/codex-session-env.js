import os from "node:os";
import path from "node:path";

export const CodexSessionEnv = async () => {
  const stateBase = path.join(
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
    "codex-plugin-oc"
  );

  return {
    "shell.env": async (input, output) => {
      output.env.CODEX_PLUGIN_DATA = stateBase
      if (input.sessionID) {
        output.env.CODEX_COMPANION_SESSION_ID = input.sessionID
      }
    }
  }
}
