# Morse-Relais

Morse-Chat Server (Single Server Edition). Teilnehmer keyen Morse über Leertaste oder Touch — die Signale laufen als `on`/`off`-Zeitstempel über WebSocket zu einem Server. Niemand tippt Text; Text entsteht erst beim Empfänger durch Dekodierung der Timing-Signale. Open Source.

**Artefakte:**
- Server: `morse-relais.ts` (TypeScript, Ein-Datei-Node-Server)
- Client: React-App (`morse-chat-browser-client.tsx`, **pures JS/JSX — keine TS-Syntax**)

---

## Architektur

```
Browser-Client ──WebSocket──▶ Server
                                  │
                                  ▼
                            lokale Clients
```

- **Ein Server.** Alle Clients verbinden sich mit demselben Server über WebSocket.
- **Räume sind implizit.** Join erschafft den Raum notfalls.
- **Räume mit `@bpm`-Suffix** (`lobby@300`) setzen beim Join das Tempo beim Client.

### Start

```
tsx morse-relais.ts server --port 7002 --name my-server [--admin-token secret]
```

Browser-Client verbindet sich mit `ws://host:7002`.

---

## Protokoll

**Client → Server:** `hello {nick}`, `join {room, pass?}`, `leave {room}`, `signal {room, on, ts}`, `list`, `auth {token}`, `create-room {room, pass?}`, `delete-room {room}`

**Server → Client:** `welcome {id, rooms}`, `signal {room, on, ts, nick, srv}`, `presence {room, nicks}`, `rooms`, `error`, `admin-ok`, `room-deleted {room}`

Alle Nachrichten laufen über WebSocket durch den Message-Handler (`handleClient`).

---

## Timing-Architektur (kritisch — nicht regredieren)

Alles leitet sich von **einer Einheit** ab, der Dit-Länge in Millisekunden:

```js
const DEFAULT_UNIT = 160; // ms pro Dit → 375 BPM
const timingFromUnit = (u) => ({
  ditDah: u,           // Haltedauer < ditDah → Dit, sonst Dah
  letterGap: u * 1.6,  // Pause, die einen Buchstaben beendet
  wordGap: u * 7,      // Pause, die ein Wort beendet (Standard: 7 Einheiten)
});
const MSG_FLUSH_MS = 3000; // Idle, bevor die akkumulierte Nachricht abgeschickt erscheint
```

- `BPM = 60000 / unit`, persistiert in `localStorage` (`morse-unit`).
- **Kalibrierung:** 8 Dits tippen → Durchschnitt → neue Unit/BPM.
- Jeder `MorseDecoder` (lokal + einer pro Remote-Nick) trägt sein eigenes `timing`-Objekt — Remote-Nutzer mit anderem Tempo dekodieren trotzdem korrekt, weil beim Empfänger mit dessen unit dekodiert wird.

### MorseDecoder-Kern

```js
feed(on, ts) {
  if (this.wordTimer) { clearTimeout(this.wordTimer); this.wordTimer = null; }
  if (on) {
    // Gap-Auswertung beim nächsten keydown (falls der Nutzer schneller weitertippt)
    if (this.lastUp > 0) {
      const gap = ts - this.lastUp;
      if (gap >= this.timing.wordGap) { this.flushLetter(); this.out(" "); this.onGap("word"); }
      else if (gap >= this.timing.letterGap) { this.flushLetter(); this.onGap("letter"); }
    }
    this.lastUp = 0;
  } else {
    this.lastUp = ts;
    // Wort-Gap feuert genau dann, wenn die Pause wordGap erreicht (Meter voll).
    // Kein Idle-Flush-Timer mehr nötig — der Wort-Timer übernimmt auch den
    // letzten Buchstaben und konsumiert die Pause (lastUp = 0).
    this.wordTimer = setTimeout(() => {
      this.wordTimer = null;
      this.flushLetter();
      this.out(" ");
      this.onGap("word");
      this.lastUp = 0; // Gap konsumiert — nächster keydown startet frisch
    }, this.timing.wordGap);
  }
}
```

### Die fünf Fixes, die das Timing überhaupt funktionsfähig machen

1. **`decRef.current?.feed(true, now)` in `doKeyDown`** — ohne den fehlt die Gap-Erkennung, Buchstaben verschmelzen.
2. **Wort-Gap-Timer beim keyup** — feuert die Worttrennung genau wenn die Pause `wordGap` erreicht (Meter voll), auch ohne weiteren keydown. `lastUp = 0` konsumiert die Pause, damit der nächste keydown nicht doppelt trennt. Der alte Idle-Flush-Timer ist damit entfallen.
3. **`doKeyDown` cancelt den MSG_FLUSH-Timers** (`clearTimeout(localMsgTimerRef.current)`) — sonst wird die Nachricht weggespült, während der Nutzer noch tippt.
4. **Remote-Flush-Timer-Cancel bei Remote-Signal `on: true`** — derselbe Fehler, andere Seite.
5. **Akkumulator-Block VOR `connect` deklarieren** — `useCallback`-TDZ: `connect` referenziert die Flush-Funktionen, sonst ReferenceError beim ersten Aufruf.

Diese Punkte sind Debugging-Ergebnis mehrerer Sitzungen. Bei Timing-Anpassungen zuerst hier nachlesen.

---

## Entscheidende Codestellen

### Server (`morse-relais.ts`)

**Join mit Passwort-Schutz** — Passwort nur bei Raum-Neuerstellung setzbar, kein Hijack bestehender Räume:

```ts
const wanted = sha256(m.pass ?? "");
const existing = this.roomPasses.get(m.room);
if (existing !== undefined) {
  if (wanted !== existing) { this.send(socket, { t: "error", msg: `wrong password for #${m.room}` }); break; }
} else if (m.pass && !this.rooms.has(m.room)) {
  this.roomPasses.set(m.room, wanted);
}
```

**Raum löschen** — kickt lokale Clients, entfernt Passwort:

```ts
private destroyRoom(room: string) {
  const set = this.rooms.get(room);
  if (set) {
    for (const c of [...set]) {
      this.clients.get(c)?.rooms.delete(room);
      this.send(c, { t: "room-deleted", room });
    }
    this.rooms.delete(room);
  }
  this.roomPasses.delete(room);
}
```

**Admin-Handler** (`case "auth" / "create-room" / "delete-room"` in `handleClient`): `--admin-token` am Server aktiviert den Admin-Modus; authentifizierte Sockets landen im `admins`-Set; `removeClient` entfernt sie wieder.

- Räume sind server-lokal sichtbar; die Welcome-Nachricht listet nur die Räume des eigenen Servers.

### Client (React-App)

**Morse-Tabelle** — inkl. Umlaute, deutscher Sonderzeichen und Prosignalen; Dekodierung läuft über die Umkehrung:

```js
const MORSE = {
  A: ".-", /* ... */ "9": "----.",
  "?": "..--..", /* ... */ "@": ".--.-.",
  ";": "-.-.-.", "=": "-...-", "+": ".-.-.", "\"": ".-..-.",
  "(": "-.--.", ")": "-.--.-", "$": "...-..-", "_": "..--.-",
  "Ä": ".-.-", "Ö": "---.", "Ü": "..--", "ß": "...--..", "CH": "----",
  "SOS": "...---...", "SK": "...-.-", "VE": "...-.",
};
const MORSE_REV = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));
```

Wichtig: Codes dürfen sich nicht doppeln (`+` ist `.-.-.`, `Ä` ist `.-.-` — verschieden lang, kein Konflikt). `AR`/`BT`/`AS`/`KN` sind identisch mit `+`/`=`/`&`/`(` und wurden deshalb bewusst weggelassen.

**Tasteneingabe** — echte `keydown`/`keyup`-Events (Leertaste), `e.repeat`-Guard, Fokus-Guard gegen INPUT/TEXTAREA; mobil per Touch-Button mit `onTouchStart`/`onMouseDown`. Kalibrierungsmessung hängt in `doKeyUp` (`recordCalTap`).

**Nachrichten-Akkumulation:** `localMsg`/`remoteMsgs` sammeln dekodierte Buchstaben; `MSG_FLUSH_MS` Idle schiebt sie als Zeile ins Transkript. Replay (`▶`) spielt aufgezeichnete Signale via WebAudio exakt nach Zeitstempeln ab.

---

## Admin & Raumverwaltung

- Server mit `--admin-token secret` starten → Client-Admin-Login in der Sidebar.
- `delete-room` entfernt den Raum und kickt alle Clients in diesem Raum.
- `create-room` setzt/ändert Passwörter.

**Bekannte Grenze (bewusst akzeptiert):** Join kann nicht an Nichtexistenz scheitern, weil Räume implizit sind — ein erneuter Join nach Löschung erschafft den Raum neu.

---

## Konventionen & Constraints

| Regel | Grund |
|---|---|
| Client-Canvas: **niemals TypeScript-Syntax** | Runtime parst als `.js` → „Expected ; but found :" |
| Server-Canvas: TypeScript erlaubt | `type: code`, wird als `.ts` behandelt |
| Keine Emojis außer etablierten UI-Labeln (📱 🔑 ▶ ✕) | UI-Konvention |
| Passwort: sha256 ungesalzen, Klartext bis TLS | Einschränkung, dokumentiert |

## Deployment

nginx terminiert TLS und proxied WebSocket (`/ws` → ws-Port, mit `Upgrade`/`Connection`-Headern). Die vollständige Config steht als Kommentar am Ende des Server-Canvas. Browser-Client verbindet sich dann mit `wss://domain/ws`.

## Test (Kurzfassung)

1. Server starten: `tsx morse-relais.ts server --port 7002 --name my-server`
2. Browser-Tab auf `ws://localhost:7002`, Raum joinen (z.B. `lobby`).
3. Zweiten Browser-Tab öffnen und denselben Raum joinen.
4. Presence prüfen, dann Signale in beide Richtungen keyen.

Fehlersuche: kein Ton im Empfangs-Tab ist meist Browser-Autoplay-Policy (erst irgendwo klicken); Räume nicht identisch heißt meist `@bpm`-Suffix mitgejoint — `lobby` und `lobby@300` sind verschiedene Räume.