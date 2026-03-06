# Dungeon Fates

## Arena (Multiplayer)

Die Arena nutzt einen kleinen Node.js Server (Socket.IO) für Matchmaking und die Würfel-Synchronisation.

### Starten

```bash
npm install
npm start
```

Dann im Browser öffnen:

- `http://localhost:3000` (oder den Port, den der Server im Terminal ausgibt)

### Testen

- Öffne die Seite in **zwei Tabs/Fenstern**.
- In beiden: **⚔️ Arena** → **Search for Player**.
- Ihr werdet automatisch gematcht, es werden **3 Würfel pro Spieler** nacheinander gerollt.
- Der Sieger erhält **Gold + Items** des Verlierers (überschüssige Items werden fallengelassen, wenn der Beutel voll ist).
