import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";
import { handleLibraryRequest } from "../../sync/worker.mjs";
import { handleReleaseRequest } from "../../sync/release.mjs";
import releaseManifest from "./release-manifest.json";
import { handleSiteMcpRequest } from "../lib/site-mcp.mjs";
import { handleCloudBackupRequest } from "../lib/cloud-backups.mjs";
import backupRunnerSource from "../../tools/cloud_backup_runner.py?raw";

const worker = {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    if (new URL(request.url).pathname === '/cloud-backup-runner.py' && request.method === 'GET') {
      return new Response(backupRunnerSource, {headers: {'content-type': 'text/x-python; charset=utf-8', 'cache-control': 'no-store, private', 'x-content-type-options': 'nosniff'}});
    }
    const mcp = await handleSiteMcpRequest(request, env, {backupRunnerSource});
    if (mcp) return mcp;
    const backup = await handleCloudBackupRequest(request, env);
    if (backup) return backup;
    const release = await handleReleaseRequest(request, env, releaseManifest);
    if (release) return release;
    const library = await handleLibraryRequest(request, env);
    if (library) return library;
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return { status: "request_context_expired", message: "This request has expired. Please try again." };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    return runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));
  },
};

export default worker;
