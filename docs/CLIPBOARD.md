# Shared clipboard

One clipboard shared by the browsers that open the dashboard and, through a device
agent, the desktops of the fleet. It keeps the newest 10 copies of text, an image or
files. Off by default: **Settings → Shared clipboard** turns it on. While it is off,
every `/api/clipboard` route answers `404`, nothing is written to disk and the page
has no sidebar, mobile or command-palette entry.

## Access

Clipboard content is more private than telemetry, so it asks for more than the
dashboard's read routes do:

- With `SPARKDASH_TOKEN` set, every clipboard request must carry it
  (`Authorization: Bearer …`), reads included and on a loopback bind too.
- Without a token, the clipboard answers only on a loopback bind. A non-loopback
  bind without a token answers `403`, whatever `SPARKDASH_ALLOW_OPEN_REMOTE` says.

Open dashboards hear about changes on the existing `/ws` socket as
`{"type":"clipboard","revision":N}` and then read the clipboard over the API, so the
socket never carries clipboard content.

## Storage and limits

Content lives under `config/clipboard/` (`CLIPBOARD_DIR` overrides it): `entries.json`
holds the metadata and the revision, `blobs/<sha256>` the text, images and files. The
content of an entry leaves the disk as soon as it drops out of the history or is
deleted. Staged uploads that no entry claims are removed after 10 minutes and on start.

| Limit | Value |
| --- | --- |
| Entries kept | 10 |
| Text | 1 MiB (UTF-8) |
| One image or file | 25 MiB |
| Files per entry | 20 |
| One entry | 50 MiB |

Going over a limit answers `413`.

## API

All routes are under `/api/clipboard` and answer `Cache-Control: no-store`.
A device agent adds `X-Clipboard-Device: <name>` (letters, digits, `.`, `_`, `-`,
at most 64) to its writes so the history shows where a copy came from; without it
the source is `browser`. The name is a label, not an identity.

```ts
interface ClipboardEntry {
  id: string;                       // UUID
  type: "text" | "image" | "files";
  textSize: number;                 // UTF-8 bytes of a text entry, else 0
  textPreview: string | null;       // first 4000 characters of a text entry
  textTruncated: boolean;
  parts: { id: string; name: string; mimeType: string; size: number; sha256: string }[];
  size: number;                     // total bytes
  contentKey: string;               // see "Content key"
  source: { kind: "browser" | "device"; device: string | null };
  createdAt: number;                // epoch ms
}
```

| Call | Reply |
| --- | --- |
| `GET /api/clipboard` | `{ revision, latest: ClipboardEntry \| null, limits }` |
| `GET /api/clipboard/history` | `{ revision, entries: ClipboardEntry[] }`, newest first |
| `GET /api/clipboard/changes?since=<revision>&timeoutMs=<ms>` | Long poll: answers `{ revision, latest }` at once when `since` differs from the current revision, otherwise on the next change or after `timeoutMs` (at most 30000, the default) |
| `GET /api/clipboard/<id>` | `{ entry }` |
| `GET /api/clipboard/<id>/text` | The full text, `text/plain; charset=utf-8` |
| `GET /api/clipboard/<id>/parts/<partId>` | The image or file. Images are served inline (except SVG); `?download=1` forces an attachment |
| `POST /api/clipboard/text` | Body: the text as `text/plain`. `201 { entry, revision }` |
| `POST /api/clipboard/uploads` | Body: the raw bytes, `Content-Type` the file's type, `X-Clipboard-Name` its URI-encoded name. `201 { upload: { id, name, mimeType, size, sha256 } }` |
| `POST /api/clipboard` | JSON `{ uploads: [uploadId…], type?: "image" \| "files" }`. One image becomes an `image` entry, anything else `files`. `201 { entry, revision }` |
| `DELETE /api/clipboard/<id>` | `{ removed: true, revision }` |
| `DELETE /api/clipboard` | Clears the history: `{ removed: <count>, revision }` |

A write whose content equals the latest entry's adds nothing and answers
`200 { entry, revision, duplicate: true }` with the existing entry. The revision
increases with every change and survives restarts; compare it for equality only.

### Content key

`contentKey` identifies content independently of where and when it was copied:

- text: the SHA-256 (hex) of its UTF-8 bytes;
- image: the SHA-256 (hex) of `"image:" + <the image's sha256>`;
- files: the SHA-256 (hex) of `"files:" + <"<name>/<sha256>" of each file, joined by ",">`.
  Names count: copying `a.txt` and then `b.txt` with the same bytes is two copies.

An agent computes the same key for what it reads from its OS clipboard, so it can
tell its own copies from new ones without downloading anything.

## Device agents

A device agent keeps one desktop's OS clipboard in step with the shared one. It is
opt-in on each device and off by default; headless machines have no clipboard and do
not run it. It needs the dashboard URL, the dashboard's `SPARKDASH_TOKEN` and a device
name.

1. **Shared → local.** Long-poll `GET /api/clipboard/changes?since=<last revision>`.
   When `latest` changes and its `contentKey` is not the key of what this device last
   read or wrote, fetch it (`/text` for text, `/parts/<partId>` for images and files)
   and put it on the OS clipboard: text as text, an image as an image, files saved
   to a local folder and placed on the clipboard as file references. Remember its key.
2. **Local → shared.** Watch the OS clipboard. When its content key differs from the
   remembered one, remember it and send it: `POST /text`, or one `POST /uploads` per
   image or file and then `POST /api/clipboard`. Skip content over the limits.
3. **Errors.** `404` means the feature is off and `401`/`403` that the token or bind
   is wrong: wait at least a minute before trying again. A network error waits a few
   seconds, doubling up to a minute. Never retry a write that answered `413`.

Remembering one key in both directions is what stops a copy from bouncing back and
forth: writing an entry to the OS clipboard changes the clipboard, and the watcher
must see that change as already known.
