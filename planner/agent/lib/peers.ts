import { defineConnection, type ConnectionConfig, type ConnectionDefinition } from "@cursor/july/connections";

// In-process `{ agent }` peers need every factory project mounted on one
// host. Managed v2 hosting is one slug per app. From July 0.2.15 a
// single-agent serve omits a peer with a warning instead of failing boot,
// and from 0.2.17 `deploy` lists each declared peer's slug in the
// manifest's `peers` for hosted peers, which the factory does not use (the
// local slugs here are not the hosted `factory-*` ones). Unset means
// hosted-safe: the file still exports a connection (July errors on a
// missing defineConnection), but not a peer, so the manifest's `peers`
// stays empty. Local `serve --dir .` sets FACTORY_INPROCESS_PEERS=1.

export const INPROCESS_PEERS_ENV = "FACTORY_INPROCESS_PEERS";

export function inProcessPeers(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[INPROCESS_PEERS_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function peerConnection(config: ConnectionConfig): ConnectionDefinition {
  if (inProcessPeers()) {
    return defineConnection(config);
  }
  return defineConnection({
    description:
      config.description ??
      "In-process peer is not mounted. Set FACTORY_INPROCESS_PEERS=1 and serve the factory from its root.",
    tools: {
      unmounted: {
        description:
          "In-process peer is not mounted on this host. Set FACTORY_INPROCESS_PEERS=1 and serve every factory project from the factory root.",
        async execute() {
          return {
            ok: false,
            error: "Set FACTORY_INPROCESS_PEERS=1 and serve every factory project from the factory root.",
          };
        },
      },
    },
  });
}
