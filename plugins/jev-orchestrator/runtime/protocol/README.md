# Installed App Server protocol snapshot

codex-app-server.v2.schemas.json was generated locally with:

    codex app-server generate-json-schema --experimental --out <temporary-directory>

Observed native executable: codex-cli 0.154.0-alpha.6.2 on native Windows.
The PATH shim separately reported 0.154.0. The snapshot is evidence for the
adapter's wire fields, not a promise that a future installed CLI will remain
compatible. Refresh it with npm run generate:protocol and rerun the offline
suite after a CLI upgrade.

The adapter uses the v2 method names and shapes in this file. It does not read
the Codex auth file or copy credentials into worker context.
