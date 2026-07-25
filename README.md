# precision-server — Party Game de Précision

Serveur arbitre (Node + `ws`). Tout le monde joue en même temps : le serveur
génère la cible, tient les timers de phase (c'est ça, la difficulté) et calcule
la précision de chacun de 0 à 100 %.

## Lancer
```
npm install     # ws
npm start       # écoute sur :8080 (PORT modifiable)
```

## Tester
```
node test-engine.js                        # 60 assertions, règles pures
PORT=8145 node src/server.js &             # puis :
PORT=8145 node test-e2e.js                 # partie complète, 2 clients ws
```

## Architecture
- `src/engine-precision.js` : RÈGLES pures (difficultés, génération des cibles,
  validation, les 4 calculs de précision). Aucun socket / timer. 100 % testable.
- `src/server.js` : transport `ws`, lobby, machine à états et `setTimeout` de
  phase. C'est l'arbitre absolu.

## Boucle
```
lobby → memorize → play → reveal → (le MJ enchaîne) → … → end
```
`memorize` et `play` sont chronométrés par le serveur (durées = difficulté).
Entre deux manches, c'est le MJ qui relance. `reveal` part aussi dès que **tout
le monde a validé**, sans attendre la fin du chrono.

## Zéro confiance
- La cible n'est envoyée qu'en `memorize` (pour `time`, c'est juste la consigne).
- Pendant `play`, le serveur n'envoie **rien** : impossible de relire la réponse.
- Pour `time`, le chrono annoncé est recoupé à l'horloge serveur (±400 ms).
- Les données reçues sont validées ET clampées (h:400 → 40, s:150 → 100).

## Réglages
Durées + tolérances dans `DIFFICULTY` (engine). `PORT`, `LEAD_MS` en env.
