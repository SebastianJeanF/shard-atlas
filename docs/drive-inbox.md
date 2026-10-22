# Capture through Google Drive

**The Drive inbox lets a connected AI chat queue technical knowledge while the Mac is off.** The web app can read those additions directly from Drive. The Mac imports the same files through Google Drive for desktop.

Every collection keeps its own import receipts. Your existing Mac notes remain in SQLite, and the web app keeps its collection in this browser. The inbox carries additions between them. It does not copy all existing knowledge or synchronize later edits and deletions.

## Set up the inbox

Create or select **ChatGPT → Shard Atlas → Inbox** in the Google account used for capture. Keep it private. Record its folder URL in the web app's Google Drive settings and make the folder available through Google Drive for desktop on the Mac.

In an AI chat, say **“Add this to Shard Atlas.”** A client with local access can continue using the local integration. A client without local access can upload an addition to your configured Drive inbox when it has a connected Google Drive tool. Give a new client the current [contribution guide](../static/ai-instructions.md) and the inbox location if it does not already have them. A client without either connection can still prepare a downloadable portable archive for manual import.

**Queued in Drive** means the JSON upload was verified. It does not mean the notes have been imported. Open **Use with AI → Google Drive**, connect when needed, and choose **Sync inbox** on the web or **Sync additions** on the Mac in each collection that should receive the additions.

## Connect the web app to Google

The browser uses Google Identity Services and direct Google Drive API reads. It needs a public OAuth web client ID created for your deployment. This ID identifies the application and is not a client secret.

1. Select a Google Cloud project and [enable the Google Drive API](https://developers.google.com/workspace/drive/api/quickstart/js).
2. Configure Google Auth Platform for the intended users. For a personal Gmail account, choose External and add that account as a test user while the app is in Testing.
3. [Create an OAuth client](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid) with application type **Web application**.
4. Add the web app's exact HTTPS origin under **Authorized JavaScript origins**. Include only the scheme and host, without a path or trailing slash. Add a separate exact localhost origin for development if needed.
5. Enter the public client ID and inbox folder in Shard Atlas's Google Drive settings. A deployed private configuration file can also supply these defaults. Never put a client secret or access token into the site source.
6. Choose **Connect Google Drive**, select the intended account, and review Google's permission screen. Then choose **Sync inbox**.

The required scope is `https://www.googleapis.com/auth/drive.readonly`. **Google grants read access to Drive files, rather than to just one folder.** Shard Atlas restricts its actual queries to the configured inbox. Google does not provide a folder-only read scope. The narrower `drive.file` scope cannot automatically discover future files uploaded by an AI client's separate Google connection. See [Google's scope definitions](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

The browser keeps the access token in memory. It is not stored with notes, receipts, or settings. Google tokens expire, and the [token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model) requires another user action to reconnect. The Mac can remain off during browser imports, but the browser must be open and authorized. This feature does not run an unattended cloud importer.

Google's verification rules depend on the app's audience and scopes. Personal apps with a small user base may qualify for an [exception to verification](https://support.google.com/cloud/answer/13464323?hl=en), while still showing Google's warning screen. Review the current requirements before sharing the integration beyond personal use.

## Receive additions on the Mac

The Mac reads a local folder through its existing Python service. It does not sign into Google inside the app window. The default folder is:

```text
~/My Drive/ChatGPT/Shard Atlas/Inbox
```

If Drive uses another location, set `SHARD_ATLAS_DRIVE_INBOX` in the environment that launches the storage service. The value is the local folder path, not its Drive URL. Restart the storage service after changing it. **Use with AI → Google Drive** displays the path being scanned and explains when it is unavailable. Files must finish syncing to this Mac before they can be imported.

Sync reads JSON files without moving, editing, or deleting them. The importer rejects symbolic links and unsupported envelopes. It processes at most 500 JSON files per scan and at most 64 MB of file content per sync. Split an oversized queue into bounded folders and select the next folder when needed. Every collection that should receive an older batch must import it before that file is removed or archived elsewhere.

## Prepare a capture file

A Drive capture uses this exact transport:

```json
{
  "format": "shard-atlas-inbox",
  "version": 1,
  "batch": {
    "requestId": "capture-format-example",
    "shards": [
      {
        "id": "capture-format-note",
        "title": "Replace with a technical explanation",
        "content": "Replace with the supported mechanism, example, caveats, and sources."
      }
    ],
    "links": []
  }
}
```

This is a format example, not content to import. Every request, note, and connection needs a stable ID. Use the [contribution schema and authoring rules](../static/ai-instructions.md), with at most 1,000 notes, 2,000 connections, and an 8 MB batch. Do not include archive assets, image bytes, revisions, Trash, settings, edits, or deletions. Portable archives remain the route for embedded image assets and manual card-by-card review.

The command-line helper can validate and wrap a batch without starting the app or reading a collection:

```sh
python3 tools/shard_atlas_client.py inbox --file batch.json --output capture-request-id.json
```

Omit `--output` to print the envelope. A completed output file appears atomically. The helper reuses identical content and refuses to overwrite an existing file with different content. Upload the `.json` file to the verified inbox through your connected Drive client. A file written into a local synced folder still needs a successful Drive upload before another device can read it.

## Read sync results

- **Imported:** this collection saved the batch and recorded its receipt.
- **Replayed:** this collection had already saved the unchanged request. Another copy was not added.
- **Error:** the batch was not accepted. Read the per-file message. Other valid files can still import.
- **Replay warning:** a previously imported note is now missing. The importer preserves that deletion. Replays also preserve later edits instead of replacing them with the original batch.

Keep each batch immutable. If an upload or sync times out, inspect the existing file or receipt and retry the **same request ID and payload**. A changed payload with the same request ID is rejected. An incoming stable ID cannot overwrite a different saved note. Fix a conflicting proposal by inspecting the saved record and preparing a separate, genuinely new addition when appropriate.

Leave files in the inbox so other collections can import them. Do not move them into a shared Processed folder after one device succeeds. Browser storage and Mac database backups keep receipts for that collection, while a portable knowledge archive does not promise to preserve import receipts. Keep normal backups and exports, especially before clearing browser data or changing devices.
