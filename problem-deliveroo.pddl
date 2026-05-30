;; problem file: problem-deliveroo.pddl
;; Placeholders are substituted at runtime by PddlMove.js #buildProblem().
;;
;; {{OBJECTS}}        – "me <crate-ids…> <tile-ids…>"
;; {{MY_TILE}}        – agent's current tile  (t<x>_<y>)
;; {{CRATE_FACTS}}    – "(crate c<x>_<y>) (at c<x>_<y> t<x>_<y>)  …"
;; {{TOPOLOGY_FACTS}} – tile / delivery / right / left / up / down facts (beliefset)
;; {{FREE_FACTS}}     – "(free t<x>_<y>) … (pushable t<x>_<y>) …"
;; {{GOAL_TILE}}      – target tile  (t<x>_<y>)
(define (problem deliveroo)
    (:domain default)
    (:objects {{OBJECTS}})
    (:init
        (me me) (agent me) (at me {{MY_TILE}})
        {{CRATE_FACTS}}
        {{TOPOLOGY_FACTS}}
        {{FREE_FACTS}}
    )
    (:goal (at me {{GOAL_TILE}}))
)
