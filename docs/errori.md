# Errori e note sull'agente:

- ricompensa molto alta dei pacchi: c'è ancora tempo per esplorare e fottere i pacchi agli altri, continua esplorazione invece di consegnare subito

## Mappa con sensing-area elevata:

- il pacco "impazzisce" andando avanti e indietro senza prendere una decisione chiara sul percorso -> in caso di stalling forzare una "direzione" di percorrenza
- l'agente sta trasportando delle parcelle, vede altre parcelle troppo accattivanti per non andare a prenderle. Tuttavia sul percorso incontra un blocco (agente o altro) e inizia a fare avanti e indietro come un matto senza consegnare mai quelle che ha già raccolto (poiché "sensa" le parcelle da prendere) -> con parcelle agli sgoccioli forzare il delivery/forzare una singola decisione topo tot mosse uguali (=indecisione)
- l'agente con tante tante tante parcelle raccolte ha come unica priorità il delivery, incontrando un blocco prima di un delivery l'agente si blocca COMPLETAMENTE finché una parcella non scade (il che modifica l'intention)


## Mappa con solo Spaw e Delivery Tiles:
l'agente perde molto tempo ad aspettare delle parcelle quando potrebbe continuare l'esplorazione ininterrottamente (strategia migliore per questa mappa) -> capire se va bene obbligarlo a muoversi in continuazione quando percepisce troppe spawn tiles.
il blocco sul delivery blocca completamente l'agente -> l'agente deve esplorare e trovare un altro delivery

## Mappa ENORME, pochi spawn, delivery lontano:

Non so bene cosa dire, da una parte direi che l'agente deve prioritizzare l'attesa perché non incontra parcelle lungo il viaggio verso il delivery. D'altra parte, se l'agente non si sbriga i pacchi scadono in fretta perché spawnano con punteggio basso. RAGIONARE sull'approccio

## Wide paths

Nel caso in cui l'gente si trovi su uno spawn e raccoglie una parcella, ed esiste un altro spawn molto vicino, l'agente dovrebbe almeno far entrare il secondo spawn nella propria area di sensing invece di precipitarsi al delivery della parcella.