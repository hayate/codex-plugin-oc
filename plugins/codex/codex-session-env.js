import os from "node:os";
import path from "node:path";

function resolveStateBase(env = process.env) {
  const xdg = env.XDG_STATE_HOME
  if (xdg && path.isAbsolute(xdg)) {
    return path.join(xdg, "codex-plugin-oc")
  }
  return path.join(os.homedir(), ".local", "state", "codex-plugin-oc")
}

export const CodexSessionEnv = async () => {
  const stateBase = resolveStateBase()

  return {
    "shell.env": async (input, output) => {
      if (output.env.CODEX_PLUGIN_DATA === undefined) {
        output.env.CODEX_PLUGIN_DATA = stateBase
      }
      if (input.sessionID) {
        output.env.CODEX_COMPANION_SESSION_ID = input.sessionID
      }
    }
  }
}
