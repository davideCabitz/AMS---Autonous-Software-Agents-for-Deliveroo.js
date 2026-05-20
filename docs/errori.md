# Errori e note sull'agente:

- ricompensa molto alta dei pacchi: c'è ancora tempo per esplorare e fottere i pacchi agli altri, continua esplorazione invece di consegnare subito

**Puntatori al codice:**
- `agent.js:87-93`: quando l'agente porta già parcelle continua a raccogliere altre `worthwhileInRange` senza limite. Fix: aggiungere un tetto `MAX_CARRY` — se `carrying.length >= MAX_CARRY` saltare il blocco di pickup e andare direttamente al `go_deliver` di riga 96.
- `agent.js:36-41` (`estimatedRewardAtDelivery`): la formula non penalizza il costo di deviazione per raccogliere un'ulteriore parcella mentre si è già in viaggio verso il delivery. Fix: aggiungere alla formula la distanza di deviazione `distance(me, newParcel) + distance(newParcel, delivery) - distance(me, delivery)` invece di solo `toParcel + toDelivery`.

## Mappa con sensing-area elevata:

- il pacco "impazzisce" andando avanti e indietro senza prendere una decisione chiara sul percorso -> in caso di stalling forzare una "direzione" di percorrenza

**Puntatori al codice:**
- `astar.js:83-133` (`navigateTo`): il while-loop ripianifica ad ogni blocco senza memoria delle posizioni recenti. Fix: aggiungere un array circolare delle ultime N posizioni; se la posizione corrente si ripete più di K volte, lanciare `['stalled']` per forzare un'uscita dall'intenzione e ripartire da `optionsGeneration`.

- l'agente sta trasportando delle parcelle, vede altre parcelle troppo accattivanti per non andare a prenderle. Tuttavia sul percorso incontra un blocco (agente o altro) e inizia a fare avanti e indietro come un matto senza consegnare mai quelle che ha già raccolto (poiché "sensa" le parcelle da prendere) -> con parcelle agli sgoccioli forzare il delivery/forzare una singola decisione topo tot mosse uguali (=indecisione)

**Puntatori al codice:**
- `agent.js:89-93`: quando porta parcelle e trova una `worthwhileInRange`, pusha sempre `go_pick_up`. Se questo fallisce, `optionsGeneration` si ri-triggera (da `agent.js:22-25`) e pusha di nuovo lo stesso pickup → loop. Fix: aggiungere un contatore di fallimenti consecutivi per lo stesso parcel id; dopo N fallimenti, blacklistare temporaneamente quella parcel e cadere nel ramo `go_deliver` a riga 96.
- `agent.js:36-41`: verificare se il reward residuo delle parcelle già portate è sotto soglia critica — se sì, forzare `go_deliver` indipendentemente da cosa c'è in range.

- l'agente con tante tante tante parcelle raccolte ha come unica priorità il delivery, incontrando un blocco prima di un delivery l'agente si blocca COMPLETAMENTE finché una parcella non scade (il che modifica l'intention)

**Puntatori al codice:**
- `astar.js:118-124`: dopo 6 retry lancia `['goal blocked', x, y]`, catturato in `IntentionRevision.js:29-32` e loggato. Poi `optionsGeneration` pusha `go_deliver` allo stesso tile tramite `nearestDelivery()` a `agent.js:28` → loop identico.
- `agent.js:27-29` (`nearestDelivery`): non esclude mai delivery tile già falliti. Fix: mantenere un `Set blockedDeliveries` module-level; `nearestDelivery()` filtra quelli bloccati; dopo un `['goal blocked']` su un delivery tile, aggiungerlo al set (con TTL di ~5 s per poi riprovarci).
- `agent.js:96-101`: se tutti i delivery tile sono bloccati, la funzione non ha fallback. Fix: se `nearestDelivery()` restituisce `undefined`, chiamare `exploreIfIdle()` così l'agente si muove invece di congelare.


## Mappa con solo Spaw e Delivery Tiles:
l'agente perde molto tempo ad aspettare delle parcelle quando potrebbe continuare l'esplorazione ininterrottamente (strategia migliore per questa mappa) -> capire se va bene obbligarlo a muoversi in continuazione quando percepisce troppe spawn tiles.

**Puntatori al codice:**
- `agent.js:9-10`: `IDLE_WAIT_MS = 2000` è il tempo di attesa sullo spawner. Fix: rilevare a startup se `spawnerTiles.length / walkableTiles.length` supera una soglia (es. 0.4) e impostare `IDLE_WAIT_MS = 0` o ridurlo drasticamente.
- `agent.js:206-217` (`exploreIfIdle`): il blocco `onSpawner` può essere condizionato da una variabile di configurazione mappa calcolata una volta sola in `context.js`.

il blocco sul delivery blocca completamente l'agente -> l'agente deve esplorare e trovare un altro delivery

**Puntatori al codice:**
- Stessa catena di `sensing-area elevata / blocco delivery` sopra: `agent.js:27-29` + `agent.js:96-101`. In questa mappa è più grave perché può esistere un solo delivery tile: il fallback a `exploreIfIdle()` quando `nearestDelivery()` è bloccato è indispensabile.

## Mappa ENORME, pochi spawn, delivery lontano:

Non so bene cosa dire, da una parte direi che l'agente deve prioritizzare l'attesa perché non incontra parcelle lungo il viaggio verso il delivery. D'altra parte, se l'agente non si sbriga i pacchi scadono in fretta perché spawnano con punteggio basso. RAGIONARE sull'approccio

**Puntatori al codice:**
- `agent.js:9` (`MIN_DELIVERY_REWARD = 5`) e `agent.js:10` (`IDLE_WAIT_MS = 2000`): su questa mappa conviene alzare `MIN_DELIVERY_REWARD` (non vale la pena raccogliere parcelle con reward basso se il viaggio le azzera) e ridurre `IDLE_WAIT_MS` (non conviene aspettare a lungo se le parcelle spawnano con score basso).
- `agent.js:36-41` (`estimatedRewardAtDelivery`): la formula già tiene conto del decay durante il viaggio; su mappe enormi il `toDelivery` è alto e il filtro `>= MIN_DELIVERY_REWARD` dovrebbe già escludere pacchi inutili — verificare che `DECAY_STEPS_PER_REWARD` sia calibrato correttamente dal config (`context.js:21-31`).
- Strategia da valutare: aggiungere un controllo esplicito "se sto già portando parcelle il cui reward totale supera soglia X, consegna subito senza aspettare altri pickup" — da inserire in `agent.js:87` prima del blocco `worthwhileInRange`.

## Wide paths

Nel caso in cui l'gente si trovi su uno spawn e raccoglie una parcella, ed esiste un altro spawn molto vicino, l'agente dovrebbe almeno far entrare il secondo spawn nella propria area di sensing invece di precipitarsi al delivery della parcella.

**Puntatori al codice:**
- La logica di detour esiste già ma è in `strategyNotTooGreedy()` a `agent.js:144-160`, che è **commentata/disabilitata** (`agent.js:237`). La strategia attiva è `strategyGreedy()` che non ha nessun detour.
- Fix più semplice: in `agent.js:236` sostituire `strategyGreedy()` con `strategyNotTooGreedy()`.
- In alternativa, copiare il blocco detour (`agent.js:144-160`) dentro `strategyGreedy()` tra le righe 93 e 96 (dopo aver esaurito i pickup in range, prima di pushare `go_deliver`).
- Verificare anche il parametro `DETOUR_SPAWNER_MAX_DIST = 5` a `agent.js:11`: su mappe wide path potrebbe essere troppo piccolo — aumentarlo a 8-10.

## Chaotic Maze

No sensing area, questo blocca completamente l'agente se si posiziona su una spawn parcel poichè aspetta all'infinito che esca una parcella. Tra l'altro sembrerebbe che una volta scelto un target spawn tile, l'agente punti sempre a quello anche se viene spostato.

**Puntatori al codice:**
- Attesa infinita su spawner → `agent.js:206-217` (`exploreIfIdle`): il timer scade solo se arriva una parcella; con `OBSERVATION_DISTANCE = 0` non ne arriverà mai nessuna. Fix: se `OBSERVATION_DISTANCE <= 1`, saltare il blocco di attesa completamente.
- Lock sul target spawn tile già scelto → `agent.js:199-202`: si ritorna early se l'intent corrente è `go_explore` e il target è fuori range; il target non viene mai rivalutato. Fix: limitare questo early-return a un timeout massimo (es. tempo trascorso dall'ultima push), oppure confrontare anche se l'agente è stato spostato rispetto all'ultima posizione registrata.
- Stessa causa in `IntentionRevisionReplace.js:7`: la push viene ignorata se il predicato è identico — quindi `go_explore X Y` non viene mai sostituito. Fix: aggiungere un tempo di vita massimo all'intenzione corrente di tipo `go_explore`.

## 25c1_8

Troppi agenti, lagga troppo per capire cosa non va ma la penalità cresce a dismisura

**Puntatori al codice:**
- Con molti agenti il set `agentBlocked` in `astar.js:83,127` cresce rapidamente e può escludere troppi tile dal replan, costringendo a percorsi molto lunghi o fallimenti in cascata.
- Le sostituzioni rapide di intenzione in `IntentionRevisionReplace.js:11-12` (stop + nuovo push) ad alta frequenza di sensing possono generare thrashing; con lag elevato ogni sensing event arriva in batch e scatena molteplici `optionsGeneration` consecutive (`agent.js:22-25`).
- Da investigare una volta ridotto il lag: loggare quante volte `optionsGeneration` viene chiamata per secondo e quante stop() vengono eseguite.

## Small path

L'agente ha una pacella, vuole consegnarla e si avvia al delivery. Vicino al delivery sensa da un lontano (ma in visuale) spawn point che è nata una parcella golosa. L'agente cambia intention e cerca di andare a prendere la parcella MA appena si avvia lo spawn con parcella golosa esce dal sensing, l'agente cambia dunque intention per consegnare ma avanzando sensa nuovamente la parcella. Il risultato è che l'agente continua a fare avanti e indietro fino a che una delle due parcelle (quella allo spawn o quella addosso) non scadono.

**Puntatori al codice:**
- La radice è in `IntentionRevisionReplace.js:11-12`: ogni nuova push stoppa immediatamente l'intenzione corrente, senza nessuna isteresi. La parcel al confine del sensing entra/esce ad ogni step e scatena push alternate tra `go_pick_up` e `go_deliver`.
- Il trigger è `agent.js:22-25`: `socket.onSensing` chiama `optionsGeneration` ad ogni evento, anche se la lista parcelle è cambiata solo di 1 elemento sul boundary.
- Il controllo che decide il cambio di intenzione è `agent.js:87-93` (carrying + worthwhileInRange → push go_pick_up) vs `agent.js:96-101` (worthwhileInRange vuoto → push go_deliver): le due branch si alternano ogni sensing frame.
- Fix: aggiungere isteresi — una volta che è stato pushato `go_pick_up` verso una parcel specifica, non sostituirlo con `go_deliver` finché la distanza verso la parcel non supera una soglia (es. 1.5× la distanza al delivery), oppure introdurre un "commitment timer" (es. 1-2 s) durante cui l'intenzione corrente non può essere rimpiazzata da una opposta.