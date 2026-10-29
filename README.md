# Rest Client

A small, quiet REST client that runs in your browser. Think Postman without the clutter: one screen, a dark muted
theme, and nothing you don't need.

No dependencies, no build step, no account. Just Node.

## Features

- **Requests**: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`
- **Query params** editor that stays in sync with the URL in both directions; switch params off without deleting them
- **Headers** editor with per-row on/off toggles
- **Body**: JSON (with one-click formatting), plain text, or URL-encoded form
- **Auth**: Bearer token or Basic auth
- **Environments**: define variables and use them anywhere (URL, headers, body, auth) as `{{name}}`
- **Saved requests** in the sidebar, with search; unsaved edits are kept per request and marked with `•`
- **History** of the last 100 requests sent; click one to reopen it
- **Response viewer**: status, time and size, pretty-printed and highlighted JSON (or raw), response headers, image preview
- **Save response to a file**: pretty JSON stays pretty, binary files are saved as received
- **cURL import**: paste a `curl …` command into the URL bar (or use *Import cURL*), e.g. straight from your browser's dev tools
- **Copy as cURL**: export the current request as a ready-to-run command, with variables resolved
- **No CORS problems**: requests are sent by the local Node server, not the browser
- **Resizable** request/response split

## Run locally

Requires [Node.js](https://nodejs.org) 20 or newer.

```sh
git clone https://github.com/combi17/rest-client.git
cd rest-client
npm start
```

Then open <http://localhost:4380>.

There's no `npm install` step because the project has no dependencies. `node server.js` works too.

### Options

Set these as environment variables:

| Variable           | Default                  | Description                          |
| ------------------ | ------------------------ | ------------------------------------ |
| `PORT`             | `4380`                   | Port to serve the app on             |
| `HOST`             | `127.0.0.1`              | Interface to listen on               |
| `REST_CLIENT_DATA` | `./data.json`            | Where saved requests, history and environments are stored |

```sh
PORT=8080 npm start
REST_CLIENT_DATA=~/rest-client-data.json npm start
```

## Keyboard shortcuts

| Shortcut       | Action                          |
| -------------- | ------------------------------- |
| `Ctrl + Enter` | Send the request (again to cancel) |
| `Ctrl + S`     | Save the request                |
| `Tab`          | Indent in the body editor       |

## How it works

```
server.js        Node server: serves the UI, forwards requests, reads/writes data.json
public/
  index.html     Page layout
  style.css      Theme and layout
  app.js         UI logic
  curl.js        cURL import/export
```

The browser sends each request to the local server, which makes the real HTTP call and returns the status, headers,
body and timing. Everything you save lives in a single JSON file on your machine.

## Security

This is a local tool. It can send requests to any address your machine can reach, so it's built to only take orders from you:

- The server listens on `127.0.0.1` only.
- The API requires a custom header and a `localhost` Host header. Other websites open in your browser can't call it,
  and DNS-rebinding attacks don't work.
- The UI is served with a strict Content Security Policy (scripts, styles and connections only from the app itself, no framing).
- Response bodies are always shown as text and never rendered as HTML.
- `data.json` is written with `600` permissions, so other users on the machine can't read it. It stores your tokens
  and passwords **in plain text**, so don't commit or share it (it's already in `.gitignore`).

Don't run it with `HOST=0.0.0.0` on a network you don't trust. The server prints a warning if you do.

## Limitations

- Multipart / file uploads aren't supported. cURL `-F` fields are imported as a URL-encoded form.
- cURL bodies read from a file (`-d @file.json`) are skipped on import.
